/**
 * NetClient — connection layer for online multiplayer.
 *
 * Talks to the signaling server (server/signal.js) over WebSocket to create,
 * list and join rooms, then opens direct WebRTC data channels between players.
 * Topology is a star: every joiner has one channel to the HOST, and the host
 * relays messages between joiners. Game code above this only sees:
 *
 *   hostRoom() / joinRoom(code) / listRooms()
 *   send(obj) — client: to host · host: broadcast to all peers
 *   onPeer(id) / onPeerGone(id) / onData(fromId, msg) / onClosed(reason)
 *
 * SIGNAL URL: set DEFAULT_SIGNAL_URL after deploying server/ (see server/README).
 * From localhost it falls back to ws://localhost:8765 for development, and a
 * `?signal=wss://...` query param overrides everything (handy for testing).
 */

const DEFAULT_SIGNAL_URL = 'wss://whiteout-signal.onrender.com'; // deployed on Render

// TURN relays traffic when a direct P2P connection can't form (strict NATs,
// some campus/corporate networks). These are the Open Relay Project's free
// community servers — best-effort. For guaranteed relay capacity, create a
// free metered.ca account and paste its ICE servers here instead.
const TURN_SERVERS = [
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    ...TURN_SERVERS,
  ],
};

export function signalUrl() {
  const q = new URLSearchParams(location.search).get('signal');
  if (q) return q;
  if (DEFAULT_SIGNAL_URL) return DEFAULT_SIGNAL_URL;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return 'ws://localhost:8765';
  }
  return ''; // not configured — UI shows "online not available yet"
}

export class NetClient {
  constructor() {
    this.ws = null;
    this.role = null;      // 'host' | 'client'
    this.code = null;
    this.myId = null;      // joiners get an id from the server; host is 'host'
    this.peers = new Map(); // host: id -> {pc, dc} · client: 'host' -> {pc, dc}

    // events (assigned by game code)
    this.onPeer = () => {};
    this.onPeerGone = () => {};
    this.onData = () => {};
    this.onClosed = () => {};

    this._pending = new Map(); // reply routing for created/join/list
  }

  get active() { return this.role !== null; }

  _connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    const url = signalUrl();
    if (!url) return Promise.reject(new Error('no-signal-url'));
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const fail = () => reject(new Error('signal-unreachable'));
      ws.onerror = fail;
      ws.onclose = () => {
        // signaling loss doesn't kill live P2P channels; new joins just stop
        if (this.ws === ws) this.ws = null;
      };
      ws.onopen = () => { ws.onerror = null; this.ws = ws; resolve(); };
      // Serialize handling: SDP processing awaits internally, and ICE
      // candidates that interleave mid-await would arrive before the remote
      // description exists and be dropped — killing the connection.
      this._queue = Promise.resolve();
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        this._queue = this._queue
          .then(() => this._onSignalMessage(msg))
          .catch((err) => console.warn('signal handling error:', err));
      };
    });
  }

  _expect(type) {
    return new Promise((resolve) => this._pending.set(type, resolve));
  }

  _resolve(type, value) {
    const fn = this._pending.get(type);
    if (fn) { this._pending.delete(type); fn(value); }
  }

  async hostRoom({ isPublic = false, name = 'Paintball Match' } = {}) {
    await this._connect();
    this.ws.send(JSON.stringify({ t: 'create', public: isPublic, name }));
    const code = await this._expect('created');
    this.role = 'host';
    this.myId = 'host';
    this.code = code;
    return code;
  }

  async joinRoom(code) {
    await this._connect();
    this.ws.send(JSON.stringify({ t: 'join', code }));
    const res = await this._expect('join');
    if (!res.ok) throw new Error(res.reason || 'join-failed');
    this.role = 'client';
    this.myId = res.id;
    this.code = res.code;
    // wait for the host's data channel to actually open
    await new Promise((resolve, reject) => {
      this._dcOpenResolve = resolve;
      setTimeout(() => reject(new Error('peer-timeout')), 15000);
    });
    return this.code;
  }

  async listRooms() {
    await this._connect();
    this.ws.send(JSON.stringify({ t: 'list' }));
    return this._expect('rooms');
  }

  async _onSignalMessage(msg) {
    switch (msg.t) {
      case 'created': this._resolve('created', msg.code); break;
      case 'rooms':   this._resolve('rooms', msg.rooms); break;
      case 'join-ok': this._resolve('join', { ok: true, code: msg.code, id: msg.id }); break;
      case 'join-fail': this._resolve('join', { ok: false, reason: msg.reason }); break;

      case 'peer-join': { // host: a joiner arrived — offer them a channel
        const id = msg.id;
        const pc = new RTCPeerConnection(RTC_CONFIG);
        const entry = { pc, dc: null };
        this.peers.set(id, entry);
        const dc = pc.createDataChannel('game');
        this._bindChannel(id, entry, dc);
        pc.onicecandidate = (e) => {
          if (e.candidate) this._signal(id, { ice: e.candidate });
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this._signal(id, { sdp: pc.localDescription });
        break;
      }

      case 'peer-leave': this._dropPeer(msg.id); break;

      case 'signal': {
        const from = msg.from;
        let entry = this.peers.get(from);
        if (!entry && this.role === 'client' && from === 'host') {
          const pc = new RTCPeerConnection(RTC_CONFIG);
          entry = { pc, dc: null };
          this.peers.set('host', entry);
          pc.onicecandidate = (e) => {
            if (e.candidate) this._signal('host', { ice: e.candidate });
          };
          pc.ondatachannel = (e) => this._bindChannel('host', entry, e.channel);
        }
        if (!entry) return;
        if (msg.data.sdp) {
          await entry.pc.setRemoteDescription(msg.data.sdp);
          if (msg.data.sdp.type === 'offer') {
            const answer = await entry.pc.createAnswer();
            await entry.pc.setLocalDescription(answer);
            this._signal(from, { sdp: entry.pc.localDescription });
          }
        } else if (msg.data.ice) {
          try { await entry.pc.addIceCandidate(msg.data.ice); } catch (_) { /* late ICE */ }
        }
        break;
      }

      case 'host-gone': this.close('Host left the game.'); break;
    }
  }

  _signal(to, data) {
    if (this.ws) this.ws.send(JSON.stringify({ t: 'signal', to, data }));
  }

  _bindChannel(id, entry, dc) {
    entry.dc = dc;
    dc.onopen = () => {
      if (this.role === 'client' && this._dcOpenResolve) {
        this._dcOpenResolve();
        this._dcOpenResolve = null;
      }
      this.onPeer(id);
    };
    dc.onclose = () => this._dropPeer(id);
    dc.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.onData(id, msg);
    };
  }

  _dropPeer(id) {
    const entry = this.peers.get(id);
    if (!entry) return;
    this.peers.delete(id);
    try { entry.dc && entry.dc.close(); } catch (_) {}
    try { entry.pc.close(); } catch (_) {}
    if (this.role === 'client' && id === 'host') this.close('Lost connection to host.');
    else this.onPeerGone(id);
  }

  /** Client: send to host. Host: broadcast to every peer (optionally skip one). */
  send(obj, skipId = null) {
    const raw = JSON.stringify(obj);
    for (const [id, entry] of this.peers) {
      if (id === skipId) continue;
      if (entry.dc && entry.dc.readyState === 'open') entry.dc.send(raw);
    }
  }

  /** Host: send to one specific peer. */
  sendTo(id, obj) {
    const entry = this.peers.get(id);
    if (entry && entry.dc && entry.dc.readyState === 'open') {
      entry.dc.send(JSON.stringify(obj));
    }
  }

  close(reason = '') {
    if (!this.active && !this.ws) return;
    for (const id of [...this.peers.keys()]) {
      const entry = this.peers.get(id);
      this.peers.delete(id);
      try { entry.dc && entry.dc.close(); } catch (_) {}
      try { entry.pc.close(); } catch (_) {}
    }
    if (this.ws) { try { this.ws.close(); } catch (_) {} this.ws = null; }
    const wasActive = this.active;
    this.role = null; this.code = null; this.myId = null;
    if (wasActive) this.onClosed(reason);
  }
}

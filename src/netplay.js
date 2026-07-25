import * as THREE from 'three';

/**
 * NetPlay — in-game multiplayer session on top of NetClient.
 *
 * v1 scope (drop-in skirmish):
 *  - remote players render as avatars (capsule + team ring + name label)
 *  - position/look sync at ~12Hz with smoothing on the receiving side
 *  - shots replicate as real projectiles in everyone's world
 *  - tags: shooter's client detects the hit, victim takes the paint-hit +
 *    respawn, team score updates for everyone, shooter gets the kill feed
 *  - host is the hub: joiner messages go to the host, which relays them on
 *  - bots sit out while a net session is live (PvP only, endless skirmish)
 *
 * Messages (over the data channels):
 *   welcome {you:{id,name,team}, roster:[{id,name,team}], scores:[b,r]}
 *   add     {p:{id,name,team}}          (host -> others when someone joins)
 *   remove  {id}
 *   s       {p:[x,y,z], ry}             (state, throttled)
 *   shot    {o:[x,y,z], d:[x,y,z], hex}
 *   tag     {victim, hex}               (shooter announces a confirmed hit)
 * Host relays joiner messages to the other peers with `from` stamped on.
 */

const TEAM_HEX = [0x2f7bff, 0xff3b3b]; // BLUE, RED — matches the game palette
const SEND_HZ = 12;
const EYE_HEIGHT = 1.7;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeNameSprite(text, hex) {
  const fs = 44, padX = 16, padY = 8;
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = `700 ${fs}px Inter, system-ui, sans-serif`;
  const w = Math.ceil(meas.measureText(text).width) + padX * 2;
  const h = fs + padY * 2;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.font = `700 ${fs}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  roundRect(ctx, 2, 2, w - 4, h - 4, 14); ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#' + hex.toString(16).padStart(6, '0');
  roundRect(ctx, 3, 3, w - 6, h - 6, 13); ctx.stroke();
  ctx.fillStyle = '#1c1f24';
  ctx.fillText(text, w / 2, h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.0045;
  sprite.scale.set(w * scale, h * scale, 1);
  sprite.position.y = 2.55;
  return sprite;
}

function makeAvatar(name, teamHex) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
  const teamMat = new THREE.MeshStandardMaterial({
    color: teamHex, roughness: 0.5, metalness: 0,
    emissive: new THREE.Color(teamHex), emissiveIntensity: 0.25,
  });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 6, 12), bodyMat);
  body.position.y = 1.0; body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), bodyMat);
  head.position.y = 1.78; head.castShadow = true;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.08, 10, 24), teamMat);
  ring.position.y = 1.25; ring.rotation.x = Math.PI / 2;
  const label = makeNameSprite(name, teamHex);
  group.add(body, head, ring, label);
  group.userData = { bodyMat, teamMat, label };
  return group;
}

// nearest positive ray-sphere hit distance, or -1
function raySphere(origin, dir, center, radius) {
  const ox = origin.x - center.x, oy = origin.y - center.y, oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? (c <= 0 ? 0 : -1) : t;
}

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _center = new THREE.Vector3();

export class NetPlay {
  /**
   * @param {import('./net.js').NetClient} net
   * @param {{scene, camera, spawnProjectile, onTagged, showKill,
   *          onRosterChange, onEnded}} deps
   */
  constructor(net, deps) {
    this.net = net;
    this.deps = deps;
    this.roster = new Map();   // id -> {id, name, team}
    this.remotes = new Map();  // id -> {group, cur:{...}, target:{...}}
    this.scores = [0, 0];
    this.me = null;            // {id, name, team}
    this._sendT = 0;
    this._botT = 0;
    this._nextIdx = 2;         // host is Player 1

    // lobby/match state: rooms open in the lobby; the host starts the match,
    // optionally backfilling empty slots with host-simulated bots
    this.started = false;
    this.botRoster = [];       // [{name, team}] — what the host filled with
    this.ghostBots = [];       // client-side visuals of the host's bots

    // win condition (host picks in the lobby, synced to everyone)
    this.matchConfig = { mode: 'score', value: 25 }; // 'score' tags | 'time' minutes
    this.matchOver = false;
    this._matchStartAt = 0;    // host clock origin
    this._clockT = 0;
    this._statTally = null;    // host: id -> {name,team,kills,deaths,shots} at end

    net.onPeer = (id, name) => this._onPeer(id, name);
    net.onPeerGone = (id) => this._onPeerGone(id);
    net.onData = (id, msg) => this._onData(id, msg);
    net.onClosed = (reason) => this._teardown(reason);
  }

  get active() { return this.net.active && this.me !== null; }
  get isHost() { return this.net.role === 'host'; }

  /** My team's spawn point (BLUE side z=26, RED side z=-26). */
  mySpawnZ() { return this.me && this.me.team === 1 ? -26 : 26; }

  beginHost() {
    this.me = { id: 'host', name: this.deps.getPlayerName(), team: 0 };
    this.roster.set('host', this.me);
    this.scores = [0, 0];
    this._nextIdx = 2;
    this.deps.onRosterChange();
  }

  beginClient() {
    // roster arrives in the host's `welcome`; me is set there
  }

  playerCount() { return this.roster.size; }

  // ---------------------------------------------------------------- host side
  _onPeer(id, name) {
    if (this.net.role !== 'host') return; // clients get `welcome` instead
    const clean = (name || '').trim().slice(0, 14);
    const p = { id, name: clean || `Player ${this._nextIdx}`, team: (this._nextIdx - 1) % 2 };
    this._nextIdx++;
    this.roster.set(id, p);
    this._addRemote(p);
    this.net.sendTo(id, {
      t: 'welcome',
      you: p,
      roster: [...this.roster.values()],
      scores: this.scores,
      started: this.started && !this.matchOver, // only "live" counts as in-progress
      cfg: this.matchConfig,
      bots: this.botRoster,
    });
    this.net.send({ t: 'add', p }, id);
    this.deps.onRosterChange();
  }

  /** Host: begin the match for everyone, with the bot slots it filled. */
  hostStart(botRoster) {
    this.started = true;
    this.matchOver = false;
    this.scores = [0, 0];              // fresh scoreline (also covers rematches)
    this.botRoster = botRoster;
    this._matchStartAt = performance.now();
    this.net.send({ t: 'start', bots: botRoster, cfg: this.matchConfig });
  }

  _onPeerGone(id) {
    if (this.net.role !== 'host') return;
    this.roster.delete(id);
    this._removeRemote(id);
    this.net.send({ t: 'remove', id });
    this.deps.onRosterChange();
  }

  // ------------------------------------------------------------------- shared
  _onData(fromId, msg) {
    // host relays joiner traffic to everyone else, stamped with the sender
    // ('bothit' is host-directed: the host resolves it and broadcasts 'botdied')
    if (this.net.role === 'host' && msg.t !== 'welcome' && msg.t !== 'bothit') {
      this.net.send({ ...msg, from: fromId }, fromId);
    }
    const senderId = this.net.role === 'host' ? fromId : (msg.from || 'host');

    switch (msg.t) {
      case 'welcome': {
        this.me = msg.you;
        this.scores = [...msg.scores];
        this.roster.clear();
        for (const p of msg.roster) {
          this.roster.set(p.id, p);
          if (p.id !== this.me.id) this._addRemote(p);
        }
        if (msg.cfg) this.matchConfig = msg.cfg;
        if (msg.started) { // match already running — drop in
          this.started = true;
          this.matchOver = false;
          this.botRoster = msg.bots || [];
          this._createGhosts();
          this.deps.onStart();
        }
        this.deps.onRosterChange();
        break;
      }
      case 'start': { // host began the match (also a rematch from the lobby)
        this.started = true;
        this.matchOver = false;
        this.scores = [0, 0];
        this.botRoster = msg.bots || [];
        if (msg.cfg) this.matchConfig = msg.cfg;
        this._createGhosts();
        this.deps.onStart();
        break;
      }
      case 'clock': { // host's authoritative countdown (time mode)
        this.deps.onClock(msg.left);
        break;
      }
      case 'end': { // host called the match — report my stats, then wait
        this.matchOver = true;
        this.net.send({ t: 'stats', s: this.deps.getLocalStats() });
        break;
      }
      case 'stats': { // host: collect a player's final numbers
        if (this._statTally) {
          const p = this.roster.get(senderId);
          this._statTally.set(senderId, {
            name: p ? p.name : '?', team: p ? p.team : 0,
            kills: msg.s.kills, deaths: msg.s.deaths, shots: msg.s.shots,
          });
        }
        break;
      }
      case 'result': { // final report from the host
        this.matchOver = true;
        this.deps.onMatchEnd(msg.winner, msg.scores, msg.rows);
        break;
      }
      case 'bsync': { // host-simulated bot states
        for (let i = 0; i < msg.b.length && i < this.ghostBots.length; i++) {
          const [x, z, ry, alive] = msg.b[i];
          const g = this.ghostBots[i];
          g.target.x = x; g.target.z = z; g.target.ry = ry;
          g.alive = !!alive;
          g.group.visible = g.alive;
        }
        break;
      }
      case 'bothit': { // (host only) a client's paintball hit one of my bots
        if (this.isHost && !this.matchOver) {
          const shooter = this.roster.get(senderId);
          this.deps.tagBot(msg.i, shooter ? shooter.team : 0);
        }
        break;
      }
      case 'botdied': {
        if (this.matchOver) break;
        this.scores[msg.team]++;
        const g = this.ghostBots[msg.i];
        if (g) { g.alive = false; g.group.visible = false; }
        break;
      }
      case 'add': {
        this.roster.set(msg.p.id, msg.p);
        this._addRemote(msg.p);
        this.deps.onRosterChange();
        break;
      }
      case 'remove': {
        this.roster.delete(msg.id);
        this._removeRemote(msg.id);
        this.deps.onRosterChange();
        break;
      }
      case 's': {
        const r = this.remotes.get(senderId);
        if (r) {
          r.target.x = msg.p[0]; r.target.y = msg.p[1]; r.target.z = msg.p[2];
          r.target.ry = msg.ry;
        }
        break;
      }
      case 'shot': {
        const p = this.roster.get(senderId);
        const team = msg.team ?? (p ? p.team : 0);
        // netGhost: visual only — the authoritative shooter already did hits
        this.deps.spawnProjectile(
          new THREE.Vector3(...msg.o), new THREE.Vector3(...msg.d),
          msg.hex, team, 70, false, { netGhost: true });
        break;
      }
      case 'tag': {
        if (this.matchOver) break;
        const shooter = this.roster.get(senderId);
        const team = msg.team ?? (shooter ? shooter.team : 0);
        this.scores[team]++;
        if (this.me && msg.victim === this.me.id) {
          this.deps.onTagged(team, msg.hex, msg.by || '');
        }
        break;
      }
    }
  }

  _addRemote(p) {
    if (this.remotes.has(p.id)) return;
    const group = makeAvatar(p.name, TEAM_HEX[p.team]);
    group.position.set(0, 0, p.team === 0 ? 26 : -26);
    this.deps.scene.add(group);
    this.remotes.set(p.id, {
      group,
      target: { x: group.position.x, y: EYE_HEIGHT, z: group.position.z, ry: 0 },
    });
  }

  _removeRemote(id) {
    const r = this.remotes.get(id);
    if (!r) return;
    this.remotes.delete(id);
    this._disposeAvatar(r.group);
  }

  _disposeAvatar(group) {
    this.deps.scene.remove(group);
    group.userData.bodyMat.dispose();
    group.userData.teamMat.dispose();
    const label = group.userData.label;
    label.material.map.dispose(); label.material.dispose();
    group.traverse((o) => o.geometry && o.geometry.dispose());
  }

  // Clients render the host's bots as interpolated "ghost" avatars driven by
  // the host's `bsync` snapshots (the host owns the real AI + hit detection).
  _createGhosts() {
    if (this.isHost) return; // host shows its own real bots
    this._clearGhosts();
    for (const b of this.botRoster) {
      const group = makeAvatar(b.name, TEAM_HEX[b.team]);
      group.position.set(0, 0, b.team === 0 ? 26 : -26);
      this.deps.scene.add(group);
      this.ghostBots.push({
        group, alive: true,
        target: { x: group.position.x, z: group.position.z, ry: 0 },
      });
    }
  }

  _clearGhosts() {
    for (const g of this.ghostBots) this._disposeAvatar(g.group);
    this.ghostBots.length = 0;
  }

  /** Called every frame from the main loop. */
  update(dt) {
    if (!this.active) return;

    // smooth remote avatars toward their latest network state
    const k = Math.min(1, dt * 10);
    for (const r of this.remotes.values()) {
      const g = r.group;
      g.position.x += (r.target.x - g.position.x) * k;
      g.position.z += (r.target.z - g.position.z) * k;
      g.position.y += ((r.target.y - EYE_HEIGHT) - g.position.y) * k; // eye -> feet
      let d = r.target.ry - g.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      g.rotation.y += d * k;
    }
    // smooth the host's bots on clients (ghosts)
    for (const g of this.ghostBots) {
      if (!g.alive) continue;
      g.group.position.x += (g.target.x - g.group.position.x) * k;
      g.group.position.z += (g.target.z - g.group.position.z) * k;
      let d = g.target.ry - g.group.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      g.group.rotation.y += d * k;
    }

    // broadcast my own state at SEND_HZ
    this._sendT += dt;
    if (this._sendT >= 1 / SEND_HZ) {
      this._sendT = 0;
      const cam = this.deps.camera;
      _euler.setFromQuaternion(cam.quaternion);
      this.net.send({
        t: 's',
        p: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
        ry: +_euler.y.toFixed(3),
      });
    }

    // host streams its bots' positions to everyone
    if (this.isHost && this.started) {
      this._botT += dt;
      if (this._botT >= 1 / SEND_HZ) {
        this._botT = 0;
        const snap = this.deps.getBotSnapshot(); // [[x,z,ry,alive], ...]
        if (snap && snap.length) this.net.send({ t: 'bsync', b: snap });
      }
    }

    // host owns the win condition
    if (this.isHost && this.started && !this.matchOver) {
      if (this.matchConfig.mode === 'score') {
        if (this.scores[0] >= this.matchConfig.value) this._endOnline(0);
        else if (this.scores[1] >= this.matchConfig.value) this._endOnline(1);
      } else { // time
        const left = Math.max(0, this.matchConfig.value * 60 - (performance.now() - this._matchStartAt) / 1000);
        this._clockT += dt;
        if (this._clockT >= 1) {
          this._clockT = 0;
          this.net.send({ t: 'clock', left: Math.ceil(left) });
          this.deps.onClock(Math.ceil(left));
        }
        if (left <= 0) {
          const w = this.scores[0] === this.scores[1] ? -1 : (this.scores[0] > this.scores[1] ? 0 : 1);
          this._endOnline(w);
        }
      }
    }
  }

  /** Host: freeze the match, gather everyone's stats, then publish the report. */
  _endOnline(winner) {
    if (this.matchOver) return;
    this.matchOver = true;
    this._statTally = new Map();
    // seed with my own numbers
    const meP = this.roster.get(this.me.id);
    this._statTally.set(this.me.id, {
      name: meP ? meP.name : 'Player 1', team: meP ? meP.team : 0,
      ...this.deps.getLocalStats(),
    });
    this.net.send({ t: 'end' });               // clients reply with 'stats'
    setTimeout(() => this._finalizeReport(winner), 900); // wait for replies
  }

  _finalizeReport(winner) {
    const rows = [...this._statTally.values()]
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    const scores = [...this.scores];
    this.net.send({ t: 'result', winner, scores, rows });
    this.deps.onMatchEnd(winner, scores, rows);
    this._statTally = null;
  }

  /** Announce a shot so everyone else sees the paintball (team drives color). */
  sendShot(origin, dir, hex, team) {
    if (!this.active) return;
    this.net.send({
      t: 'shot',
      o: [+origin.x.toFixed(2), +origin.y.toFixed(2), +origin.z.toFixed(2)],
      d: [+dir.x.toFixed(3), +dir.y.toFixed(3), +dir.z.toFixed(3)],
      hex,
      team: team ?? (this.me ? this.me.team : 0),
    });
  }

  /**
   * Shooter-side hit test of my projectile segment against remote players AND
   * the host's ghost bots. Returns what was hit (or null).
   * @returns {{kind:'player',id,name}|{kind:'bot',index}|null}
   */
  testHit(origin, dir, maxDist) {
    if (!this.active) return null;
    let best = null, bestT = maxDist;
    for (const [id, r] of this.remotes) {
      const p = this.roster.get(id);
      if (this.me && p && p.team === this.me.team) continue; // no friendly fire
      _center.copy(r.group.position); _center.y += 1.2;
      const t = raySphere(origin, dir, _center, 0.7);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = { kind: 'player', id, name: (p || { name: '?' }).name };
      }
    }
    // only enemy ghost bots are hittable
    for (let i = 0; i < this.ghostBots.length; i++) {
      const g = this.ghostBots[i];
      if (!g.alive) continue;
      const bteam = this.botRoster[i] ? this.botRoster[i].team : -1;
      if (this.me && bteam === this.me.team) continue;
      _center.copy(g.group.position); _center.y += 1.2;
      const t = raySphere(origin, dir, _center, 0.7);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = { kind: 'bot', index: i, name: (this.botRoster[i] || { name: 'Bot' }).name };
      }
    }
    return best;
  }

  _myName() { return (this.roster.get(this.me.id) || {}).name || 'A player'; }

  /** Broadcast a confirmed tag on a remote player (scores my team). */
  sendTag(victimId, hex) {
    if (!this.active || !this.me || this.matchOver) return;
    this.scores[this.me.team]++;
    this.net.send({ t: 'tag', victim: victimId, hex, team: this.me.team, by: this._myName() });
  }

  /** Report hitting one of the host's bots. Host resolves & broadcasts the kill. */
  sendBotHit(botIndex) {
    if (!this.active || this.matchOver) return;
    if (this.isHost) {
      this.deps.tagBot(botIndex, this.me.team); // host resolves locally
    } else {
      this.net.send({ t: 'bothit', i: botIndex });
    }
  }

  /** Host: a bot died (any cause) — score it and tell everyone. */
  hostBotDied(botIndex, byTeamId) {
    if (!this.isHost || !this.active || this.matchOver) return;
    this.scores[byTeamId]++;
    this.net.send({ t: 'botdied', i: botIndex, team: byTeamId });
  }

  /** Host: enemy-team remote players the bots should hunt (feet positions). */
  getBotTargets() {
    const out = [];
    for (const [id, r] of this.remotes) {
      const p = this.roster.get(id);
      if (p) out.push({ pos: r.group.position, team: p.team, alive: true });
    }
    return out;
  }

  /** Host: does this bot projectile hit a remote human on the other team? */
  hostTestRemoteHit(origin, dir, maxDist, shooterTeam) {
    let best = null, bestT = maxDist;
    for (const [id, r] of this.remotes) {
      const p = this.roster.get(id);
      if (!p || p.team === shooterTeam) continue;
      _center.copy(r.group.position); _center.y += 1.2;
      const t = raySphere(origin, dir, _center, 0.7);
      if (t >= 0 && t < bestT) { bestT = t; best = { id }; }
    }
    return best;
  }

  /** Broadcast a tag by a bot on a remote player (scores the bot's team). */
  broadcastTag(victimId, hex, team, byName = 'A bot') {
    if (!this.active || this.matchOver) return;
    this.scores[team]++;
    if (this.me && victimId === this.me.id) this.deps.onTagged(team, hex, byName);
    this.net.send({ t: 'tag', victim: victimId, hex, team, by: byName });
  }

  leave() { this.net.close(''); }

  _teardown(reason) {
    for (const id of [...this.remotes.keys()]) this._removeRemote(id);
    this._clearGhosts();
    this.roster.clear();
    this.me = null;
    this.scores = [0, 0];
    this.started = false;
    this.matchOver = false;
    this.botRoster = [];
    this._statTally = null;
    this.deps.onEnded(reason);
  }
}

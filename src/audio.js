/**
 * AudioManager — lightweight WebAudio sound player.
 *
 * Decodes short clips once, then plays them through pooled buffer sources so
 * many overlapping shots/hits can ring at the same time without cutting each
 * other off (which an HTMLAudioElement would do). Master volume is wired to the
 * Settings menu and persisted there.
 *
 * The AudioContext is created up front (in a suspended state, which browsers
 * allow) and resumed from the first user gesture via resume().
 */
export class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffers = {};
    this.masterVolume = 0.8;
    this.volumes = { combat: 0.85, movement: 0.65, ui: 0.55, ambient: 0.15 };
    this.buses = {}; this.voices = new Set(); this.unlocked = false; this.room = null;
    this.position = { x: 0, y: 0, z: 0 };
    this._spatialActive = 0; // live positional voices (for culling)
    this.maxSpatial = 12;     // hard cap so a firefight can't turn to mush
  }

  _ensureCtx() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // no WebAudio support — play() becomes a no-op
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterVolume;
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -12; limiter.knee.value = 18; limiter.ratio.value = 3.5;
    limiter.attack.value = 0.004; limiter.release.value = 0.15;
    this.master.connect(limiter); limiter.connect(this.ctx.destination);
    for (const [name, volume] of Object.entries(this.volumes)) {
      const bus = this.ctx.createGain(); bus.gain.value = volume; bus.connect(this.master); this.buses[name] = bus;
    }
    const delay = this.ctx.createDelay(0.1), tone = this.ctx.createBiquadFilter(), wet = this.ctx.createGain();
    delay.delayTime.value = 0.045; tone.type = 'lowpass'; tone.frequency.value = 1800; wet.gain.value = 0.12;
    this.buses.combat.connect(delay); delay.connect(tone); tone.connect(wet); wet.connect(this.master);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.ctx.suspend().catch(() => {});
      else if (this.unlocked) this.resume();
    });
  }

  /** Load & decode a map of {name: url}. Safe to call before any user gesture. */
  async load(map) {
    this._ensureCtx();
    if (!this.ctx) return;
    await Promise.all(Object.entries(map).map(async ([name, url]) => {
      try {
        const res = await fetch(url);
        const arr = await res.arrayBuffer();
        this.buffers[name] = await this.ctx.decodeAudioData(arr);
      } catch (e) {
        console.warn('audio: failed to load', name, e);
      }
    }));
  }

  /** Register synthesized clips: build(ctx) -> {name: AudioBuffer}. */
  addBuffers(build) {
    this._ensureCtx();
    if (!this.ctx) return;
    try { Object.assign(this.buffers, build(this.ctx)); } catch (e) { console.warn('audio: synth failed', e); }
  }

  /** Resume the context. Call from a user gesture (click / key / gamepad). */
  resume() {
    this._ensureCtx();
    this.unlocked = true;
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    if (!this.room && this.buffers.room) this.room = this.playLoop('room', { volume: 0.6 });
  }

  setMasterVolume(v) {
    this.masterVolume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
    if (this.unlocked && !this.room && v > 0) this.resume();
  }

  setVolume(name, value) {
    this.volumes[name] = value;
    this.buses[name]?.gain.setTargetAtTime(value, this.ctx.currentTime, 0.03);
  }

  channel(name) {
    if (name === 'room') return 'ambient';
    if (/^(jump|foot|land|slide|bodyFall)$/.test(name)) return 'movement';
    if (/^(killConfirm|countdownBeep|countdownGo|heal|uiClick)$/.test(name)) return 'ui';
    return 'combat';
  }

  voice(name, { volume = 1, rate = 1, loop = false, refDistance = 6, maxDistance = 90, rolloff = 1.1 } = {}, pos = null) {
    if (!this.ctx || !this.buffers[name] || this.masterVolume <= 0 || volume <= 0) return null;
    const channel = this.channel(name);
    const distance = pos ? Math.hypot(pos.x - this.position.x, pos.y - this.position.y, pos.z - this.position.z) : 0;
    if (pos && distance > maxDistance) return null;
    if (this.voices.size >= 24 || pos && this._spatialActive >= this.maxSpatial) {
      const candidates = [...this.voices].filter((voice) => !voice.loop && (!pos || voice.panner));
      const quiet = candidates.find((voice) => voice.channel === 'movement');
      const distant = candidates.sort((a, b) => b.distance - a.distance)[0];
      const victim = channel === 'combat' ? quiet || (distant?.distance > distance ? distant : null) : null;
      if (!victim) return null;
      victim.src.stop(); victim.close();
    }
    const src = this.ctx.createBufferSource(), gain = this.ctx.createGain();
    src.buffer = this.buffers[name]; src.playbackRate.value = rate; src.loop = loop; gain.gain.value = volume;
    src.connect(gain);
    let panner = null;
    if (pos) {
      panner = this.ctx.createPanner(); panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse';
      panner.refDistance = refDistance; panner.maxDistance = maxDistance; panner.rolloffFactor = rolloff;
      if (panner.positionX) { panner.positionX.value = pos.x; panner.positionY.value = pos.y; panner.positionZ.value = pos.z; }
      else panner.setPosition(pos.x, pos.y, pos.z);
      gain.connect(panner); panner.connect(this.buses[channel]); this._spatialActive++;
    } else gain.connect(this.buses[channel]);
    const voice = { src, gain, panner, channel, distance, loop, close: () => {
      if (!this.voices.delete(voice)) return;
      src.disconnect(); gain.disconnect(); panner?.disconnect();
      if (panner) this._spatialActive--;
    } };
    this.voices.add(voice); src.onended = voice.close; src.start();
    return voice;
  }

  /**
   * Play a loaded clip.
   * @param {string} name
   * @param {{volume?:number, rate?:number}} opts  volume 0..1 relative to master,
   *   rate is a playback-speed / pitch multiplier.
   */
  play(name, { volume = 1, rate = 1 } = {}) {
    return this.voice(name, { volume, rate });
  }

  /**
   * Start a looping clip and return a handle. Keep the handle and pass it to
   * stopLoop() to stop it. Returns null if audio is unavailable.
   */
  playLoop(name, { volume = 1, rate = 1 } = {}) {
    return this.voice(name, { volume, rate, loop: true });
  }

  /** Stop a loop from playLoop(), with a tiny fade so it doesn't click. */
  stopLoop(handle) {
    if (!handle || !this.ctx) return;
    const { src, gain } = handle;
    const t = this.ctx.currentTime;
    try {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + 0.05);
      src.stop(t + 0.06);
    } catch (e) {
      try { src.stop(); } catch (_) {}
    }
  }

  /** Sync the 3D listener to the camera (read from its world matrix). */
  updateListener(camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    camera.updateWorldMatrix(true, false);
    const e = camera.matrixWorld.elements;
    const px = e[12], py = e[13], pz = e[14];
    Object.assign(this.position, { x: px, y: py, z: pz });
    const fx = -e[8], fy = -e[9], fz = -e[10]; // camera looks down -Z
    const ux = e[4], uy = e[5], uz = e[6];
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setValueAtTime(px, t); l.positionY.setValueAtTime(py, t); l.positionZ.setValueAtTime(pz, t);
      l.forwardX.setValueAtTime(fx, t); l.forwardY.setValueAtTime(fy, t); l.forwardZ.setValueAtTime(fz, t);
      l.upX.setValueAtTime(ux, t); l.upY.setValueAtTime(uy, t); l.upZ.setValueAtTime(uz, t);
    } else {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  /**
   * Play a clip positioned in the world (panned + distance-attenuated).
   * Dropped when the voice cap is reached, so many distant shots stay tidy.
   * @param {{x:number,y:number,z:number}} pos
   */
  playAt(name, pos, { volume = 1, rate = 1, refDistance = 6, maxDistance = 90, rolloff = 1.1 } = {}) {
    return this.voice(name, { volume, rate, refDistance, maxDistance, rolloff }, pos);
  }
}

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
    this._spatialActive = 0; // live positional voices (for culling)
    this.maxSpatial = 8;     // hard cap so a firefight can't turn to mush
  }

  _ensureCtx() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return; // no WebAudio support — play() becomes a no-op
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterVolume;
    this.master.connect(this.ctx.destination);
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
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMasterVolume(v) {
    this.masterVolume = v;
    if (this.master) this.master.gain.value = v;
  }

  /**
   * Play a loaded clip.
   * @param {string} name
   * @param {{volume?:number, rate?:number}} opts  volume 0..1 relative to master,
   *   rate is a playback-speed / pitch multiplier.
   */
  play(name, { volume = 1, rate = 1 } = {}) {
    if (!this.ctx || !this.buffers[name] || this.masterVolume <= 0 || volume <= 0) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[name];
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g);
    g.connect(this.master);
    src.start();
  }

  /**
   * Start a looping clip and return a handle. Keep the handle and pass it to
   * stopLoop() to stop it. Returns null if audio is unavailable.
   */
  playLoop(name, { volume = 1, rate = 1 } = {}) {
    if (!this.ctx || !this.buffers[name] || this.masterVolume <= 0) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[name];
    src.loop = true;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g);
    g.connect(this.master);
    src.start();
    return { src, gain: g };
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
    const e = camera.matrixWorld.elements;
    const px = e[12], py = e[13], pz = e[14];
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
    if (!this.ctx || !this.buffers[name] || this.masterVolume <= 0) return;
    if (this._spatialActive >= this.maxSpatial) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[name];
    src.playbackRate.value = rate;

    const panner = this.ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    panner.rolloffFactor = rolloff;
    if (panner.positionX) {
      const t = this.ctx.currentTime;
      panner.positionX.setValueAtTime(pos.x, t);
      panner.positionY.setValueAtTime(pos.y, t);
      panner.positionZ.setValueAtTime(pos.z, t);
    } else {
      panner.setPosition(pos.x, pos.y, pos.z);
    }

    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g); g.connect(panner); panner.connect(this.master);

    this._spatialActive++;
    src.onended = () => {
      this._spatialActive--;
      try { src.disconnect(); g.disconnect(); panner.disconnect(); } catch (_) {}
    };
    src.start();
  }
}

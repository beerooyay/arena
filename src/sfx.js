/**
 * Procedural combat sounds, synthesized once into AudioBuffers at boot (no
 * asset downloads). Each generator mixes a few simple layers — filtered noise
 * bursts, pitch-dropping sine thumps, metallic partials — with fast envelopes.
 *
 * Usage: audio.addBuffers(buildCombatSfx)  (see audio.js)
 */

// ---- tiny DSP helpers (operate on Float32Array in place) --------------------
const TAU = Math.PI * 2;
function rng(seed) { // deterministic noise so every session sounds the same
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s / 4294967296) * 2 - 1; };
}
function lowpass(buf, sr, hz) {
  const a = 1 - Math.exp(-TAU * hz / sr); let y = 0;
  for (let i = 0; i < buf.length; i++) { y += a * (buf[i] - y); buf[i] = y; }
  return buf;
}
function highpass(buf, sr, hz) {
  const a = Math.exp(-TAU * hz / sr); let x1 = 0, y = 0;
  for (let i = 0; i < buf.length; i++) { const x = buf[i]; y = a * (y + x - x1); x1 = x; buf[i] = y; }
  return buf;
}
const env = (t, attack, decay) => (t < attack ? t / attack : Math.exp(-(t - attack) / decay));

/** Mix layer fns (t, i) -> sample into one buffer, then normalise to `peak`. */
function render(ctx, seconds, layers, peak = 0.9) {
  const sr = ctx.sampleRate, n = Math.ceil(seconds * sr);
  const out = new Float32Array(n);
  for (const layer of layers) {
    const l = layer(sr, n);
    for (let i = 0; i < n; i++) out[i] += l[i];
  }
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(out[i]));
  const g = m > 0 ? peak / m : 1;
  // soft clip for a little punch, then fade the last 5 ms to avoid clicks
  const fade = Math.floor(sr * 0.005);
  for (let i = 0; i < n; i++) {
    let v = Math.tanh(out[i] * g * 1.2) / Math.tanh(1.2);
    if (i > n - fade) v *= (n - i) / fade;
    out[i] = v;
  }
  const b = ctx.createBuffer(1, n, sr);
  b.copyToChannel(out, 0);
  return b;
}

// layer builders
function noiseLayer(seed, { attack = 0.001, decay = 0.05, gain = 1, lp = 0, hp = 0, delay = 0 } = {}) {
  return (sr, n) => {
    const r = rng(seed), b = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / sr - delay; b[i] = t < 0 ? 0 : r() * env(t, attack, decay) * gain; }
    if (hp) highpass(b, sr, hp);
    if (lp) lowpass(b, sr, lp);
    return b;
  };
}
function thumpLayer({ f0 = 120, f1 = 45, drop = 0.06, decay = 0.1, gain = 1, delay = 0 } = {}) {
  return (sr, n) => {
    const b = new Float32Array(n); let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr - delay; if (t < 0) continue;
      const f = f1 + (f0 - f1) * Math.exp(-t / drop);
      ph += TAU * f / sr;
      b[i] = Math.sin(ph) * env(t, 0.002, decay) * gain;
    }
    return b;
  };
}
function pingLayer(partials, { decay = 0.12, gain = 1, delay = 0 } = {}) {
  return (sr, n) => {
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr - delay; if (t < 0) continue;
      let v = 0;
      partials.forEach(([f, a], k) => { v += Math.sin(TAU * f * t) * a * Math.exp(-t / (decay * (1 - k * 0.12))); });
      b[i] = v * Math.min(1, t / 0.0015) * gain;
    }
    return b;
  };
}
function clickLayer(seed, at, { gain = 1, hp = 1800, decay = 0.006 } = {}) {
  return noiseLayer(seed, { attack: 0.0005, decay, gain, hp, delay: at });
}

// ---- the sound set -----------------------------------------------------------
export function buildCombatSfx(ctx) {
  return {
    // battle rifle: supersonic crack, powder blast, chest thump, short room
    // tail, then a delayed bolt snap — no ringing partials (that's what made it
    // sound like a toy)
    rifleShot: render(ctx, 0.34, [
      noiseLayer(311, { attack: 0.0004, decay: 0.003, gain: 1.15, hp: 3400 }),
      noiseLayer(312, { attack: 0.001, decay: 0.03, gain: 0.8, hp: 620, lp: 3300 }),
      thumpLayer({ f0: 170, f1: 58, drop: 0.014, decay: 0.055, gain: 0.95 }),
      noiseLayer(314, { attack: 0.006, decay: 0.14, gain: 0.2, hp: 340, lp: 1500 }),
      clickLayer(315, 0.075, { gain: 0.16, hp: 1200, decay: 0.005 }),
    ], 0.85),
    // rocket launch: pop + rising hiss that thins out as it leaves
    rocketLaunch: render(ctx, 0.52, [
      thumpLayer({ f0: 145, f1: 42, drop: 0.035, decay: 0.09, gain: 1 }),
      noiseLayer(321, { attack: 0.015, decay: 0.16, gain: 0.65, lp: 2300, hp: 170 }),
      clickLayer(322, 0.015, { gain: 0.2, hp: 1000 }),
    ], 0.8),
    // explosion: crack, big dropping boom, long rumble, a few crackles
    explosion: render(ctx, 0.95, [
      noiseLayer(331, { decay: 0.01, gain: 0.7, hp: 900, lp: 4800 }),
      thumpLayer({ f0: 105, f1: 34, drop: 0.08, decay: 0.25, gain: 1.3 }),
      noiseLayer(332, { attack: 0.015, decay: 0.24, gain: 0.65, lp: 700 }),
      clickLayer(333, 0.16, { gain: 0.12, hp: 1800 }),
    ], 0.88),
    plasma: render(ctx, 0.7, [
      thumpLayer({ f0: 1400, f1: 95, drop: 0.035, decay: 0.09, gain: 0.6 }),
      thumpLayer({ f0: 130, f1: 42, drop: 0.055, decay: 0.15, gain: 0.85 }),
      noiseLayer(334, { attack: 0.004, decay: 0.16, gain: 0.6, hp: 800, lp: 4000 }),
    ], 0.82),
    // round striking the arena shell: tick + tiny ricochet ping
    impact: render(ctx, 0.14, [
      clickLayer(341, 0, { gain: 1, hp: 2800, decay: 0.004 }),
      pingLayer([[2400, 0.4], [3900, 0.12]], { decay: 0.025, gain: 0.25 }),
    ], 0.45),
    // you hit someone's armour: bright shield ping (Halo-style tick)
    hitArmor: render(ctx, 0.14, [
      thumpLayer({ f0: 175, f1: 65, drop: 0.012, decay: 0.035, gain: 0.65 }),
      noiseLayer(351, { decay: 0.022, gain: 0.4, hp: 650, lp: 2200 }),
      pingLayer([[1050, 0.6], [1830, 0.2]], { decay: 0.022, gain: 0.18 }),
    ], 0.6),
    // headshot: higher, crunchier ping
    hitHead: render(ctx, 0.18, [
      noiseLayer(361, { decay: 0.015, gain: 0.65, hp: 1800, lp: 5200 }),
      pingLayer([[2300, 0.8], [3450, 0.2]], { decay: 0.026, gain: 0.3 }),
      thumpLayer({ f0: 190, f1: 85, drop: 0.012, decay: 0.04, gain: 0.5 }),
    ], 0.62),
    // you took a hit: dull thud + shield crackle
    hitTaken: render(ctx, 0.25, [
      thumpLayer({ f0: 105, f1: 48, drop: 0.02, decay: 0.07, gain: 0.8 }),
      noiseLayer(371, { decay: 0.045, gain: 0.3, lp: 1700, hp: 250 }),
      clickLayer(372, 0.035, { gain: 0.1, hp: 1400 }),
    ], 0.6),
    down: render(ctx, 0.32, [
      noiseLayer(373, { attack: 0.015, decay: 0.09, gain: 0.5, hp: 150, lp: 900 }),
      thumpLayer({ f0: 180, f1: 55, drop: 0.12, decay: 0.08, gain: 0.3 }),
    ], 0.35),
    // a body hitting the floor
    bodyFall: render(ctx, 0.35, [
      thumpLayer({ f0: 125, f1: 52, drop: 0.02, decay: 0.07, gain: 1 }),
      noiseLayer(381, { decay: 0.04, gain: 0.35, lp: 1300, hp: 150 }),
      clickLayer(382, 0.045, { gain: 0.2, hp: 950, decay: 0.012 }),
    ], 0.58),
    // reload: mag release + pull, mag seat, charging-handle rack
    reloadOut: render(ctx, 0.22, [
      clickLayer(391, 0, { gain: 0.7, hp: 1700, decay: 0.006 }),
      noiseLayer(392, { attack: 0.005, decay: 0.045, gain: 0.25, hp: 350, lp: 1800, delay: 0.05 }),
    ], 0.4),
    reloadIn: render(ctx, 0.18, [
      thumpLayer({ f0: 240, f1: 115, drop: 0.009, decay: 0.025, gain: 0.7 }),
      clickLayer(393, 0.025, { gain: 0.35, hp: 1100, decay: 0.006 }),
    ], 0.45),
    reloadRack: render(ctx, 0.24, [
      noiseLayer(394, { attack: 0.007, decay: 0.03, gain: 0.45, hp: 500, lp: 2700 }),
      clickLayer(395, 0.075, { gain: 0.65, hp: 1400, decay: 0.007 }),
    ], 0.45),
    dryFire: render(ctx, 0.07, [clickLayer(396, 0, { gain: 0.6, hp: 1600, decay: 0.003 })], 0.3),
    nadeReady: render(ctx, 0.2, [
      clickLayer(411, 0, { gain: 0.4, hp: 1100 }),
      thumpLayer({ f0: 420, f1: 780, drop: 0.05, decay: 0.065, gain: 0.3 }),
    ], 0.35),
    // grenade throw: short arm whoosh
    nadeThrow: render(ctx, 0.2, [
      noiseLayer(412, { attack: 0.015, decay: 0.07, gain: 0.65, lp: 1900, hp: 300 }),
      clickLayer(413, 0.04, { gain: 0.15, hp: 800 }),
    ], 0.4),
    // sticky landing: tacky thunk + a little squelch
    nadeStick: render(ctx, 0.18, [
      thumpLayer({ f0: 190, f1: 88, drop: 0.012, decay: 0.03, gain: 0.7 }),
      noiseLayer(421, { decay: 0.025, gain: 0.35, lp: 1500 }),
      pingLayer([[640, 0.4], [1280, 0.12]], { decay: 0.035, gain: 0.15 }),
    ], 0.55),
    // fuse ping: bright warning beep
    nadeBeep: render(ctx, 0.1, [
      pingLayer([[1320, 1], [2640, 0.12]], { decay: 0.025, gain: 0.5 }),
    ], 0.45),
    // weapon swap: cloth + metal rattle
    weaponSwap: render(ctx, 0.22, [
      noiseLayer(431, { attack: 0.02, decay: 0.055, gain: 0.5, lp: 1400, hp: 220 }),
      clickLayer(432, 0.09, { gain: 0.3, hp: 900, decay: 0.007 }),
    ], 0.35),
    jump: render(ctx, 0.18, [
      noiseLayer(441, { attack: 0.01, decay: 0.04, gain: 0.35, hp: 300, lp: 1700 }),
      thumpLayer({ f0: 100, f1: 60, drop: 0.015, decay: 0.03, gain: 0.5 }),
    ], 0.35),
    foot: render(ctx, 0.15, [
      thumpLayer({ f0: 150, f1: 72, drop: 0.012, decay: 0.025, gain: 0.8 }),
      noiseLayer(442, { decay: 0.018, gain: 0.35, lp: 1500, hp: 240 }),
    ], 0.4),
    land: render(ctx, 0.24, [
      thumpLayer({ f0: 125, f1: 52, drop: 0.015, decay: 0.05, gain: 0.8 }),
      noiseLayer(443, { decay: 0.025, gain: 0.3, lp: 1900, hp: 200 }),
    ], 0.45),
    slide: render(ctx, 1, [noiseLayer(444, { attack: 0.015, decay: 10, gain: 0.6, hp: 140, lp: 1700 })], 0.25),
    killConfirm: render(ctx, 0.18, [pingLayer([[880, 0.7], [1320, 0.3]], { decay: 0.035, delay: 0.02, gain: 0.5 })], 0.3),
    countdownBeep: render(ctx, 0.12, [pingLayer([[660, 1]], { decay: 0.025, gain: 0.4 })], 0.3),
    countdownGo: render(ctx, 0.24, [pingLayer([[660, 0.6], [990, 0.3]], { decay: 0.05, gain: 0.5 })], 0.35),
    uiClick: render(ctx, 0.08, [clickLayer(446, 0, { gain: 0.4, hp: 1500, decay: 0.004 })], 0.2),
    heal: render(ctx, 0.36, [thumpLayer({ f0: 340, f1: 780, drop: 0.1, decay: 0.09, gain: 0.3 })], 0.22),
    room: render(ctx, 4, [
      noiseLayer(451, { attack: 0.3, decay: 30, gain: 0.18, hp: 80, lp: 450 }),
      pingLayer([[60, 0.15], [120, 0.04], [240, 0.01]], { decay: 20, gain: 0.4 }),
    ], 0.15),
  };
}

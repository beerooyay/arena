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
    // battle rifle: supersonic crack + chesty body + low punch + short room tail
    rifleShot: render(ctx, 0.42, [
      noiseLayer(11, { decay: 0.012, gain: 1.0, hp: 2500 }),
      noiseLayer(12, { decay: 0.07, gain: 0.8, lp: 1800, hp: 180 }),
      thumpLayer({ f0: 160, f1: 55, drop: 0.03, decay: 0.07, gain: 0.9 }),
      noiseLayer(13, { attack: 0.01, decay: 0.16, gain: 0.18, lp: 900, delay: 0.02 }),
    ], 0.95),
    // rocket launch: pop + rising hiss that thins out as it leaves
    rocketLaunch: render(ctx, 0.9, [
      thumpLayer({ f0: 110, f1: 40, drop: 0.05, decay: 0.12, gain: 1 }),
      noiseLayer(21, { attack: 0.02, decay: 0.35, gain: 0.9, lp: 3200, hp: 400 }),
      noiseLayer(22, { decay: 0.02, gain: 0.6, hp: 1500 }),
    ], 0.9),
    // explosion: crack, big dropping boom, long rumble, a few crackles
    explosion: render(ctx, 1.7, [
      noiseLayer(31, { decay: 0.02, gain: 1, hp: 1200 }),
      thumpLayer({ f0: 90, f1: 28, drop: 0.12, decay: 0.45, gain: 1.4 }),
      noiseLayer(32, { attack: 0.005, decay: 0.5, gain: 1.0, lp: 500 }),
      noiseLayer(33, { attack: 0.05, decay: 0.7, gain: 0.35, lp: 1400, hp: 200, delay: 0.05 }),
      clickLayer(34, 0.18, { gain: 0.35 }), clickLayer(35, 0.31, { gain: 0.25 }), clickLayer(36, 0.47, { gain: 0.2 }),
    ], 0.98),
    // round striking the arena shell: tick + tiny ricochet ping
    impact: render(ctx, 0.2, [
      noiseLayer(41, { decay: 0.01, gain: 1, hp: 2000 }),
      pingLayer([[3100, 0.3], [4700, 0.15]], { decay: 0.04, gain: 0.4 }),
    ], 0.7),
    // you hit someone's armour: bright shield ping (Halo-style tick)
    hitArmor: render(ctx, 0.22, [
      pingLayer([[1750, 1], [2630, 0.55], [3900, 0.3]], { decay: 0.06, gain: 1 }),
      noiseLayer(51, { decay: 0.015, gain: 0.35, hp: 3000 }),
    ], 0.8),
    // headshot: higher, crunchier ping
    hitHead: render(ctx, 0.28, [
      pingLayer([[2400, 1], [3600, 0.6], [5200, 0.35]], { decay: 0.07, gain: 1 }),
      noiseLayer(61, { decay: 0.02, gain: 0.6, hp: 1500 }),
      thumpLayer({ f0: 220, f1: 90, drop: 0.02, decay: 0.05, gain: 0.5 }),
    ], 0.85),
    // you took a hit: dull thud + shield crackle
    hitTaken: render(ctx, 0.35, [
      thumpLayer({ f0: 140, f1: 60, drop: 0.03, decay: 0.08, gain: 1 }),
      noiseLayer(71, { attack: 0.005, decay: 0.09, gain: 0.5, lp: 4200, hp: 1400 }),
      clickLayer(72, 0.04, { gain: 0.3 }), clickLayer(73, 0.09, { gain: 0.2 }),
    ], 0.85),
    // a body hitting the floor
    bodyFall: render(ctx, 0.5, [
      thumpLayer({ f0: 95, f1: 45, drop: 0.04, decay: 0.12, gain: 1 }),
      noiseLayer(81, { decay: 0.06, gain: 0.5, lp: 700 }),
      thumpLayer({ f0: 80, f1: 40, drop: 0.03, decay: 0.08, gain: 0.5, delay: 0.12 }),
    ], 0.8),
    // reload: mag release + pull, mag seat, charging-handle rack
    reloadOut: render(ctx, 0.3, [
      clickLayer(91, 0, { gain: 1, hp: 1400 }), clickLayer(92, 0.07, { gain: 0.7, hp: 900, decay: 0.02 }),
      noiseLayer(93, { attack: 0.02, decay: 0.05, gain: 0.25, lp: 2500, hp: 300, delay: 0.1 }),
    ], 0.7),
    reloadIn: render(ctx, 0.25, [
      clickLayer(94, 0, { gain: 1, hp: 800, decay: 0.012 }),
      thumpLayer({ f0: 300, f1: 140, drop: 0.01, decay: 0.03, gain: 0.5 }),
      clickLayer(95, 0.05, { gain: 0.5, hp: 2000 }),
    ], 0.75),
    reloadRack: render(ctx, 0.3, [
      clickLayer(96, 0, { gain: 0.8, hp: 1600 }),
      noiseLayer(97, { attack: 0.01, decay: 0.03, gain: 0.3, lp: 3000, hp: 600, delay: 0.02 }),
      clickLayer(98, 0.11, { gain: 1, hp: 1200, decay: 0.01 }),
    ], 0.75),
    dryFire: render(ctx, 0.08, [clickLayer(99, 0, { gain: 1, hp: 2500, decay: 0.004 })], 0.5),
    // weapon swap: cloth + metal rattle
    weaponSwap: render(ctx, 0.32, [
      noiseLayer(101, { attack: 0.03, decay: 0.08, gain: 0.5, lp: 2000, hp: 250 }),
      clickLayer(102, 0.12, { gain: 0.6 }), clickLayer(103, 0.2, { gain: 0.8, hp: 1000 }),
    ], 0.6),
  };
}

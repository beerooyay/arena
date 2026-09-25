import * as THREE from 'three';

/**
 * Transient lighting FX: a fixed pool of point lights reused for muzzle
 * flashes, bullet impacts and rocket blasts. The light COUNT never changes
 * (only intensities), so materials never recompile mid-match.
 */
export class FlashLights {
  constructor(scene, count = 4) {
    this.slots = [];
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xff6000, 0, 8, 2);
      light.castShadow = false;
      scene.add(light);
      this.slots.push({ light, t: 0, dur: 1, peak: 0 });
    }
    this._next = 0;
    this.scale = 1; // Lights Out pushes this up
  }

  /** Flash a light at `pos`. dur in seconds, range in metres. */
  flash(pos, hex = 0xff6000, peak = 6, range = 7, dur = 0.08) {
    // take the dimmest slot so a big blast isn't stolen by the next muzzle flash
    let s = this.slots[this._next];
    for (const c of this.slots) if (c.light.intensity < s.light.intensity) s = c;
    this._next = (this._next + 1) % this.slots.length;
    s.light.position.copy(pos);
    s.light.color.setHex(hex);
    s.light.distance = range;
    s.peak = peak * this.scale;
    s.dur = dur;
    s.t = 0;
    s.light.intensity = s.peak;
  }

  update(dt) {
    for (const s of this.slots) {
      if (s.light.intensity <= 0) continue;
      s.t += dt;
      const k = 1 - s.t / s.dur;
      s.light.intensity = k > 0 ? s.peak * k * k : 0;
    }
  }
}

let _shadowTex = null;
/** Soft radial blob used as a contact shadow under characters. */
export function contactShadowTexture() {
  if (_shadowTex) return _shadowTex;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.3)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  _shadowTex = new THREE.CanvasTexture(c);
  return _shadowTex;
}

let _flashTex = null;
/** Star-burst muzzle flash sprite (white core, tinted by the material). */
export function muzzleFlashTexture() {
  if (_flashTex) return _flashTex;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'lighter';
  ctx.translate(S / 2, S / 2);
  for (let i = 0; i < 6; i++) {
    ctx.rotate(Math.PI / 3);
    const sg = ctx.createLinearGradient(0, 0, S / 2, 0);
    sg.addColorStop(0, 'rgba(255,255,255,0.9)');
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.moveTo(0, -4); ctx.lineTo(S / 2, 0); ctx.lineTo(0, 4);
    ctx.fill();
  }
  _flashTex = new THREE.CanvasTexture(c);
  _flashTex.colorSpace = THREE.SRGBColorSpace;
  return _flashTex;
}

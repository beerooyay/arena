import * as THREE from 'three';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

/**
 * Paint splatter system.
 * - Generates a few grayscale "blob" alpha textures on canvas so splats vary.
 * - On a surface hit, projects a DecalGeometry onto the hit mesh so the paint
 *   wraps to the surface and looks stuck to it.
 * - Supports random rotation / scale, tinting per color, and optional fade.
 */

function makeBlobTexture(seed) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  // simple seeded RNG
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };

  const cx = size / 2, cy = size / 2;

  // Solid, opaque fills + a single soft blur for a clean edge. (Overlapping
  // semi-transparent radial gradients used to leave a speckled partial-alpha
  // ring inside the rim, which read as tiny dots once tinted.)
  ctx.fillStyle = '#fff';
  ctx.filter = 'blur(3px)';

  // main irregular splat body via overlapping solid blobs
  const blobs = 5 + Math.floor(rnd() * 4);
  for (let i = 0; i < blobs; i++) {
    const ang = rnd() * Math.PI * 2;
    const dist = rnd() * size * 0.16;
    const bx = cx + Math.cos(ang) * dist;
    const by = cy + Math.sin(ang) * dist;
    const r = size * (0.16 + rnd() * 0.18);
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // outward droplets / splatter dots (solid too)
  const dots = 8 + Math.floor(rnd() * 8);
  for (let i = 0; i < dots; i++) {
    const ang = rnd() * Math.PI * 2;
    const dist = size * (0.24 + rnd() * 0.22);
    const dx = cx + Math.cos(ang) * dist;
    const dy = cy + Math.sin(ang) * dist;
    const r = size * (0.015 + rnd() * 0.04);
    ctx.beginPath();
    ctx.arc(dx, dy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.filter = 'none';

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearFilter; // no mipmaps -> no shimmering speckle
  tex.generateMipmaps = false;
  return tex;
}

// Vertical "drip" streak: a source blob at the top with 1-2 trails that run
// down and end in a rounded droplet. Used for paint running down walls.
function makeDripTexture(seed) {
  const w = 128, h = 256;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const cx = w / 2;

  // source blob near the top (aligns with the splat)
  const topR = w * 0.34;
  let g = ctx.createRadialGradient(cx, topR, 0, cx, topR, topR);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.75, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, topR, topR, 0, Math.PI * 2); ctx.fill();

  const streaks = 1 + Math.floor(rnd() * 2);
  for (let i = 0; i < streaks; i++) {
    const ox = cx + (rnd() * 2 - 1) * w * 0.16;
    const width = w * (0.05 + rnd() * 0.06);
    const endY = h * (0.62 + rnd() * 0.36);
    const bulbR = width * (1.1 + rnd() * 0.8);

    const grad = ctx.createLinearGradient(0, topR, 0, endY);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0.82)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(ox - width, topR);
    ctx.lineTo(ox + width, topR);
    ctx.lineTo(ox + width * 0.55, endY);
    ctx.lineTo(ox - width * 0.55, endY);
    ctx.closePath(); ctx.fill();

    const bg = ctx.createRadialGradient(ox, endY, 0, ox, endY, bulbR);
    bg.addColorStop(0, 'rgba(255,255,255,1)');
    bg.addColorStop(0.7, 'rgba(255,255,255,1)');
    bg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.arc(ox, endY, bulbR, 0, Math.PI * 2); ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

export class PaintSystem {
  constructor(scene) {
    this.scene = scene;
    this.decals = [];
    this._neon = false;  // "Lights Out": splats glow in their own colour
    this.growing = [];   // drips currently extending downward
    this.textures = [1, 2, 3, 4, 5].map(makeBlobTexture);
    this.dripTextures = [1, 2, 3].map(makeDripTexture);
    this.customTexture = null; // player-designed full-color splatter (or null)

    // developer-tunable settings (wired to GUI in main.js)
    this.settings = {
      size: 1.4,
      sizeVariation: 0.5,
      opacity: 0.92,
      fadeEnabled: false,
      lifetime: 20,   // seconds until fully faded (when fade enabled)
      maxDecals: 5000,   // effectively "keep everything" for the prototype
      // paint drips (run down vertical surfaces, animated over time)
      dripsEnabled: true,
      dripAmount: 0.5,   // 0..1 chance/count of drips per splat
      dripLength: 1.6,   // multiplier on splat scale (final length)
      dripSpeed: 1.6,    // world units/sec the drip extends downward
    };
  }

  get count() { return this.decals.length; }

  /**
   * Set (or clear) the player's custom full-color splatter from an image source
   * (data URL). Pass null/empty to revert to the generated blob splats.
   */
  setCustomTexture(src) {
    if (this.customTexture) { this.customTexture.dispose(); this.customTexture = null; }
    if (!src) return;
    const img = new Image();
    img.onload = () => {
      const t = new THREE.Texture(img);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      t.needsUpdate = true;
      this.customTexture = t;
    };
    img.src = src;
  }

  /**
   * Place a splat on a mesh at a world-space point with a world-space normal.
   * @param {number} scaleMult - optional size multiplier (1 = normal wall/floor splat)
   * @param {boolean} useCustom - use the player's designed splatter if one is set
   * @returns {THREE.Mesh|null} the created decal, or null if projection failed
   */
  splat(mesh, point, normal, colorHex, scaleMult = 1, useCustom = false) {
    const s = this.settings;
    const scale = s.size * scaleMult * (1 + (Math.random() * 2 - 1) * s.sizeVariation);

    // main splat: face along normal, random roll for variety
    const orienter = new THREE.Object3D();
    orienter.position.copy(point);
    orienter.lookAt(point.clone().add(normal));
    orienter.rotateZ(Math.random() * Math.PI * 2);

    const custom = useCustom && this.customTexture;
    const tex = custom
      ? this.customTexture
      : this.textures[(Math.random() * this.textures.length) | 0];
    // depth (z) stays shallow so the projector box can't wrap around an edge
    // onto the neighbouring face and leave a hard square patch
    const decal = this._addDecal(mesh, point, orienter.rotation,
      new THREE.Vector3(scale, scale, Math.min(scale, 0.7)), colorHex, tex, custom);

    // drips use the blob drip textures, so skip them for custom designs
    if (s.dripsEnabled && !custom) this._spawnDrips(mesh, point, normal, colorHex, scale);
    return decal;
  }

  /**
   * Build a splat decal on `mesh` at a world point/normal and RETURN it without
   * adding it to the scene (caller owns it). Used to paint moving objects (the
   * tank): the caller bakes it into the object's local space and parents it.
   */
  buildDecal(mesh, point, normal, colorHex, scaleMult = 1) {
    const s = this.settings;
    const scale = s.size * scaleMult * (1 + (Math.random() * 2 - 1) * s.sizeVariation);
    const orienter = new THREE.Object3D();
    orienter.position.copy(point);
    orienter.lookAt(point.clone().add(normal));
    orienter.rotateZ(Math.random() * Math.PI * 2);
    const tex = this.textures[(Math.random() * this.textures.length) | 0];
    let geom;
    try {
      geom = new DecalGeometry(mesh, point, orienter.rotation, new THREE.Vector3(scale, scale, Math.min(scale, 0.7)));
    } catch (e) { return null; }
    if (!geom || geom.attributes.position.count === 0) return null;
    const mat = new THREE.MeshStandardMaterial({
      transparent: true, opacity: s.opacity, roughness: 0.55, metalness: 0,
      depthTest: true, depthWrite: false, polygonOffset: true,
      polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      alphaMap: tex, color: new THREE.Color(colorHex),
    });
    this._neonify(mat);
    const decal = new THREE.Mesh(geom, mat);
    decal.renderOrder = 2;
    return decal;
  }

  /** Give a splat material a neon self-glow (or clear it), for Lights Out mode. */
  _neonify(mat) {
    if (!mat || !mat.emissive) return;
    if (this._neon) {
      mat.emissive.copy(mat.color);
      mat.emissiveIntensity = 1.6;
      mat.toneMapped = false; // full neon brightness (skip ACES compression)
    } else {
      mat.emissive.setRGB(0, 0, 0);
      mat.emissiveIntensity = 0;
      mat.toneMapped = true;
    }
    mat.needsUpdate = true;
  }

  /** Toggle the neon glow on every splat (existing + future). */
  setNeon(on) {
    this._neon = on;
    for (const d of this.decals) this._neonify(d.material);
    for (const g of this.growing) if (g.mesh) this._neonify(g.mesh.material);
  }

  /** Build + register one decal mesh on the target surface. */
  _addDecal(mesh, point, euler, sizeVec, colorHex, texture, asMap = false) {
    let geom;
    try {
      geom = new DecalGeometry(mesh, point, euler, sizeVec);
    } catch (e) {
      return null; // decal projection can rarely fail on odd geometry
    }
    if (!geom || geom.attributes.position.count === 0) return null;

    const matOpts = {
      transparent: true,
      opacity: this.settings.opacity,
      roughness: 0.55,
      metalness: 0.0,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    };
    if (asMap) {
      // full-color custom design: the texture's own RGBA is the splat
      matOpts.map = texture;
      matOpts.color = new THREE.Color(0xffffff);
    } else {
      // generated blob: grayscale shape tinted by the paint color
      matOpts.alphaMap = texture;
      matOpts.color = new THREE.Color(colorHex);
    }
    const mat = new THREE.MeshStandardMaterial(matOpts);
    this._neonify(mat);

    const decal = new THREE.Mesh(geom, mat);
    decal.renderOrder = 2;
    decal.userData.born = performance.now();
    this.scene.add(decal);
    this.decals.push(decal);

    if (this.decals.length > this.settings.maxDecals) {
      this._dispose(this.decals.shift());
    }
    return decal;
  }

  /**
   * Queue paint drips that will run down a (near-)vertical surface over time.
   * Each drip grows from length 0 toward its target in `update()`.
   */
  _spawnDrips(mesh, point, normal, colorHex, splatScale) {
    const s = this.settings;
    if (Math.abs(normal.y) > 0.6) return; // skip floors / ceilings

    const down = new THREE.Vector3(0, -1, 0);
    const surfaceDown = down.clone().addScaledVector(normal, -down.dot(normal));
    if (surfaceDown.lengthSq() < 1e-4) return;
    surfaceDown.normalize();
    const surfaceUp = surfaceDown.clone().negate();
    const tangent = new THREE.Vector3().crossVectors(surfaceDown, normal).normalize();

    const count = 1 + Math.floor(Math.random() * (1 + Math.round(s.dripAmount * 3)));
    for (let i = 0; i < count; i++) {
      const targetLength = s.dripLength * splatScale * (0.6 + Math.random() * 0.7);
      const width = splatScale * (0.16 + Math.random() * 0.12);
      const offX = (Math.random() * 2 - 1) * splatScale * 0.35;
      const top = point.clone().addScaledVector(tangent, offX);

      const orienter = new THREE.Object3D();
      orienter.up.copy(surfaceUp);
      orienter.position.copy(top);
      orienter.lookAt(top.clone().add(normal));

      const tex = this.dripTextures[(Math.random() * this.dripTextures.length) | 0];
      this.growing.push({
        mesh,
        top,
        surfaceDown: surfaceDown.clone(),
        euler: orienter.rotation.clone(),
        width,
        depth: Math.max(splatScale, 1.2),
        targetLength,
        length: 0,
        speed: s.dripSpeed * (0.7 + Math.random() * 0.6),
        delay: Math.random() * 0.45, // stagger so drips don't move in lockstep
        material: this._makeDripMaterial(colorHex, tex),
        decal: null,
      });
    }
  }

  _makeDripMaterial(colorHex, texture) {
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(colorHex),
      alphaMap: texture,
      transparent: true,
      opacity: this.settings.opacity,
      roughness: 0.55,
      metalness: 0.0,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this._neonify(mat);
    return mat;
  }

  /** Rebuild a growing drip's decal geometry for its current length. */
  _rebuildDrip(anim) {
    if (anim.length <= 1e-3) return; // nothing to show yet
    const center = anim.top.clone().addScaledVector(anim.surfaceDown, anim.length * 0.5);
    const size = new THREE.Vector3(anim.width, anim.length, anim.depth);
    let geom;
    try {
      geom = new DecalGeometry(anim.mesh, center, anim.euler, size);
    } catch (e) {
      return;
    }
    if (!geom || geom.attributes.position.count === 0) return;

    if (anim.decal) {
      anim.decal.geometry.dispose();
      anim.decal.geometry = geom;
    } else {
      const d = new THREE.Mesh(geom, anim.material);
      d.renderOrder = 2;
      d.userData.born = performance.now();
      anim.decal = d;
      this.scene.add(d);
      this.decals.push(d);
      if (this.decals.length > this.settings.maxDecals) {
        this._dispose(this.decals.shift());
      }
    }
  }

  update(dt = 0) {
    const s = this.settings;

    // animate drips extending downward over time
    for (let i = this.growing.length - 1; i >= 0; i--) {
      const a = this.growing[i];
      if (a.delay > 0) { a.delay -= dt; continue; }
      a.length = Math.min(a.targetLength, a.length + a.speed * dt);
      this._rebuildDrip(a);
      if (a.length >= a.targetLength - 1e-3) this.growing.splice(i, 1);
    }

    // keep live opacity in sync with slider + handle optional fade
    const now = performance.now();
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      if (s.fadeEnabled) {
        const age = (now - d.userData.born) / 1000;
        const k = Math.max(0, 1 - age / s.lifetime);
        d.material.opacity = s.opacity * k;
        if (k <= 0) {
          this._dispose(d);
          this.decals.splice(i, 1);
        }
      } else {
        d.material.opacity = s.opacity;
      }
    }
  }

  /** Dispose a single decal and remove it from the live list. */
  removeDecal(decal) {
    const i = this.decals.indexOf(decal);
    if (i >= 0) this.decals.splice(i, 1);
    this._dispose(decal);
  }

  clear() {
    for (const d of this.decals) this._dispose(d);
    this.decals.length = 0;
    // dispose materials of drips that haven't created a decal yet
    for (const a of this.growing) if (!a.decal) a.material.dispose();
    this.growing.length = 0;
  }

  _dispose(mesh) {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
  }
}

import * as THREE from 'three';
import { rbox, profileGeo, lathe } from './geo.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Free Fire twin-tube rifle — shared by the first-person viewmodel and the
 * third-person avatars so both read as the same weapon.
 *
 * Built in "gun space": origin at the top of the pistol grip, forward = -Z,
 * up = +Y, roughly metre scale (~1.1 long). Side silhouettes are extruded 2D
 * profiles so the chamfered shroud/stock read like the concept art instead of
 * stacked boxes.
 */

let _flameTex = null;

/** Orange flame emblem (team logo) on a transparent canvas. Cached. */
export function flameTexture() {
  if (_flameTex) return _flameTex;
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const grad = ctx.createLinearGradient(0, S, 0, 0);
  grad.addColorStop(0, '#ff4848');
  grad.addColorStop(0.6, '#ff6000');
  grad.addColorStop(1, '#ff6000');
  ctx.fillStyle = grad;
  // outer flame
  ctx.beginPath();
  ctx.moveTo(64, 122);
  ctx.bezierCurveTo(26, 122, 14, 92, 24, 68);
  ctx.bezierCurveTo(32, 50, 50, 44, 52, 22);
  ctx.bezierCurveTo(66, 34, 70, 48, 66, 60);
  ctx.bezierCurveTo(78, 52, 82, 36, 80, 8);
  ctx.bezierCurveTo(104, 30, 116, 58, 110, 86);
  ctx.bezierCurveTo(104, 110, 86, 122, 64, 122);
  ctx.closePath();
  ctx.fill();
  // inner cut-out swirl, gives the emblem its "S" read
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.moveTo(62, 110);
  ctx.bezierCurveTo(44, 108, 40, 92, 48, 80);
  ctx.bezierCurveTo(56, 70, 70, 74, 72, 64);
  ctx.bezierCurveTo(88, 76, 90, 104, 62, 110);
  ctx.closePath();
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  _flameTex = tex;
  return tex;
}

/** Palette: the only non-neutral colours in the game. */
export const ORANGE = 0xff6000;
export const RED = 0xff4848;

/**
 * Glow material for lit rings/visors. Kept at a modest intensity so tone
 * mapping leaves the hue on-palette; the bloom pass keys on saturation, so it
 * still glows without being over-driven.
 */
export function makeGlowMat(hex = ORANGE, intensity = 1.6) {
  const m = new THREE.MeshStandardMaterial({
    color: hex, roughness: 0.3, metalness: 0,
    emissive: hex, emissiveIntensity: intensity,
  });
  m.userData.baseEmissive = intensity;
  return m;
}

/**
 * Build the rifle. Returns { group, rifleGroup, rocketGroup, materials, glowMats, muzzles }.
 * opts.detail=false skips small parts (third-person avatars).
 */
export function buildGun(opts = {}) {
  const detail = opts.detail !== false;
  const seg = detail ? 32 : 18;
  const group = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.3, metalness: 0.0 });
  const shellShade = new THREE.MeshStandardMaterial({ color: 0xd9dde2, roughness: 0.38, metalness: 0.0 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.36, metalness: 0.35 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.85, metalness: 0 });
  const glow = makeGlowMat(ORANGE, 1.6);
  const glowRed = makeGlowMat(RED, 1.5);
  const decal = new THREE.MeshBasicMaterial({ map: flameTexture(), transparent: true, depthWrite: false });
  const materials = [shell, shellShade, dark, rubber, glow, glowRed, decal];
  const glowMats = [glow, glowRed];

  const H = Math.PI / 2;
  const add = (geo, mat, parent = group) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m); return m;
  };
  const box = (w, h, d, mat, u, v, x = 0, parent = group, r = null) => {
    const m = add(rbox(w, h, d, r), mat, parent);
    m.position.set(x, v, -u);
    return m;
  };
  // cylinder running along the barrel axis, centred at forward distance u
  const tube = (r, len, mat, u, v, x = 0, parent = group) => {
    const m = add(new THREE.CylinderGeometry(r, r, len, seg), mat, parent);
    m.rotation.x = H;
    m.position.set(x, v, -u);
    return m;
  };
  const ring = (r, t, mat, u, v, x = 0, parent = group) => {
    const m = add(new THREE.TorusGeometry(r, t, 10, seg), mat, parent);
    m.position.set(x, v, -u);
    return m;
  };
  // lathe-turned part along the barrel axis; profile y runs forward from u0
  const turned = (pairs, mat, u0, v, parent = group) => {
    const m = add(lathe(pairs, seg), mat, parent);
    m.rotation.x = -H; // +y (lathe axis) -> -z (forward)
    m.position.set(0, v, -u0);
    return m;
  };
  const side = (pts, width, mat, o = {}) => add(profileGeo(pts, width, o), mat);

  // --- stock with thumbhole + butt pad ---
  side([
    [-0.36, 0.105], [-0.05, 0.12], [-0.05, -0.03], [-0.17, -0.03],
    [-0.25, -0.11], [-0.36, -0.11],
  ], 0.072, shell, { fillet: 0.03, holes: [[
    [-0.27, 0.06], [-0.10, 0.07], [-0.10, 0.015], [-0.19, 0.015], [-0.24, -0.05], [-0.27, -0.05],
  ]] });
  box(0.07, 0.2, 0.03, rubber, -0.37, 0.0, 0, group, 0.012);
  if (detail) box(0.075, 0.05, 0.10, shellShade, -0.20, 0.135);  // cheek riser

  // --- lower receiver ---
  side([[-0.06, 0.12], [0.24, 0.12], [0.24, -0.06], [0.08, -0.06], [0.04, -0.035], [-0.06, -0.035]], 0.11, shell, { fillet: 0.018 });
  // --- upper shroud, chamfered nose ---
  side([
    [0.0, 0.12], [0.03, 0.175], [0.40, 0.175], [0.48, 0.13], [0.48, 0.03], [0.42, 0.0], [0.20, 0.0], [0.20, 0.12],
  ], 0.135, shell, { fillet: 0.022, bevel: 0.01 });
  // top armour slabs with dark gaps, rail block at the back
  for (let i = 0; i < 3; i++) box(0.11, 0.024, 0.095, shell, 0.11 + i * 0.105, 0.19, 0, group, 0.009);
  box(0.118, 0.012, 0.32, dark, 0.215, 0.18, 0, group, 0.005);
  box(0.09, 0.04, 0.06, dark, 0.03, 0.19);
  // side vent slots + flame emblem, both sides
  for (const s of [-1, 1]) {
    box(0.006, 0.016, 0.10, dark, 0.17, 0.12, s * 0.069, group, 0.003);
    box(0.006, 0.016, 0.10, dark, 0.29, 0.12, s * 0.069, group, 0.003);
    const logo = add(new THREE.PlaneGeometry(0.07, 0.07), decal);
    logo.castShadow = false;
    logo.position.set(s * 0.0775, 0.095, -0.41);
    logo.rotation.y = s * H;
    if (detail) box(0.005, 0.007, 0.05, glow, 0.08, 0.02, s * 0.0565, group, 0.002); // ejection-port glow tick
  }

  // --- grip, trigger guard, magazine ---
  side([[-0.03, -0.03], [0.03, -0.03], [0.0, -0.20], [-0.065, -0.20]], 0.052, rubber, { fillet: 0.02, bevel: 0.01 });
  if (detail) {
    const guard = add(new THREE.TorusGeometry(0.035, 0.007, 8, 18, Math.PI), dark);
    guard.rotation.set(0, H, Math.PI);
    guard.position.set(0, -0.06, -0.075);
    box(0.012, 0.035, 0.012, dark, 0.07, -0.07);
  }
  side([[0.12, -0.05], [0.20, -0.05], [0.195, -0.17], [0.125, -0.17]], 0.07, rubber, { fillet: 0.014 }); // magazine
  box(0.078, 0.018, 0.085, dark, 0.16, -0.175, 0, group, 0.008);

  // --- front collar with lit slits ---
  box(0.15, 0.18, 0.10, shell, 0.29, -0.027, 0, group, 0.035);
  for (const s of [-1, 1]) {
    box(0.005, 0.13, 0.009, glow, 0.255, -0.027, s * 0.076, group, 0.002);
    box(0.005, 0.13, 0.009, glow, 0.325, -0.027, s * 0.076, group, 0.002);
  }

  // --- stacked twin rocket tubes ---
  const TUBE_R = 0.054;
  const muzzles = [];
  for (const v of [0.03, -0.083]) {
    tube(TUBE_R, 0.44, dark, 0.56, v);
    ring(TUBE_R + 0.001, 0.005, glow, 0.355, v);           // collar ring
    ring(TUBE_R + 0.004, 0.005, glow, 0.70, v);            // lit band near the muzzle
    // turned muzzle cap: flared lip rolling into the bore
    turned([[TUBE_R, 0], [TUBE_R + 0.007, 0.012], [TUBE_R + 0.007, 0.06], [TUBE_R + 0.002, 0.074],
      [TUBE_R - 0.006, 0.078], [TUBE_R - 0.012, 0.07]], dark, 0.71, v);
    ring(TUBE_R - 0.009, 0.006, glowRed, 0.784, v);        // glowing bore rim
    if (detail) {
      const bore = add(new THREE.CircleGeometry(TUBE_R - 0.012, 24), rubber);
      bore.position.set(0, v, -0.77);
      bore.rotation.y = Math.PI; // face down-range
    }
    muzzles.push(new THREE.Vector3(0, v, -0.80));
  }

  // --- top barrel + turned muzzle brake + bracket ---
  tube(0.017, 0.34, dark, 0.64, 0.125);
  turned([[0.02, 0], [0.03, 0.01], [0.031, 0.06], [0.026, 0.075], [0.014, 0.078]], dark, 0.77, 0.125);
  if (detail) {
    for (const s of [-1, 1]) box(0.006, 0.02, 0.04, rubber, 0.80, 0.125, s * 0.031, group, 0.002); // brake ports
    ring(0.013, 0.004, glowRed, 0.846, 0.125);
    box(0.03, 0.06, 0.03, dark, 0.74, 0.09);
  }
  const topMuzzle = new THREE.Vector3(0, 0.125, -0.86);

  // --- rifle optic (hidden in rocket mode) ---
  const rifleGroup = new THREE.Group();
  group.add(rifleGroup);
  box(0.052, 0.052, 0.12, dark, 0.14, 0.235, 0, rifleGroup, 0.018);
  const hood = add(lathe([[0.024, 0], [0.028, 0.006], [0.028, 0.03], [0.022, 0.034]], seg), dark, rifleGroup);
  hood.rotation.x = -H; hood.position.set(0, 0.24, -0.198);
  const lens = add(new THREE.CircleGeometry(0.02, 24), glowRed, rifleGroup);
  lens.position.set(0, 0.24, -0.229);
  lens.rotation.y = Math.PI;
  box(0.005, 0.022, 0.005, glow, 0.08, 0.265, 0, rifleGroup, 0.002); // rear sight post
  box(0.03, 0.02, 0.03, dark, 0.10, 0.205, 0, rifleGroup);
  box(0.03, 0.02, 0.03, dark, 0.18, 0.205, 0, rifleGroup);

  // --- rocket-mode charge indicators ---
  const rocketGroup = new THREE.Group();
  rocketGroup.visible = false;
  group.add(rocketGroup);
  for (const s of [-1, 1]) box(0.005, 0.01, 0.20, glowRed, 0.25, 0.155, s * 0.07, rocketGroup, 0.002);
  box(0.03, 0.007, 0.28, glowRed, 0.24, 0.204, 0, rocketGroup, 0.003);

  return { group, rifleGroup, rocketGroup, materials, glowMats, muzzles, topMuzzle };
}

// ---------------------------------------------------------------------------
// Authored rocket rifle (assets/models/rr.glb). Loaded once and shared by the
// viewmodel and every avatar; the procedural gun above stays as the fallback
// until it arrives (or if it fails to load).
//
// Source asset: 1.0 long along +X (muzzle), +Y up, grip at x≈-0.28 / y≈0.12.
// RR_FIT maps it into gun space: grip at the origin, muzzle down -Z, and the
// same ~1.2 length as the procedural gun so every pose/aim value carries over.
// ---------------------------------------------------------------------------
const RR_SCALE = 1.2;
const RR_GRIP = new THREE.Vector3(-0.28, 0.12, 0);
export const RR_MUZZLES = {
  top: new THREE.Vector3(0, 0.245 * RR_SCALE - RR_GRIP.y * RR_SCALE, -(0.5 - RR_GRIP.x) * RR_SCALE - 0.01),
  tubes: [0.167, 0.114].map((y) => new THREE.Vector3(0, (y - RR_GRIP.y) * RR_SCALE, -(0.5 - RR_GRIP.x) * RR_SCALE - 0.01)),
};
export const RR_TOP = (0.3 - RR_GRIP.y) * RR_SCALE; // height of the top line above the grip

let _rrPromise = null;
/** Resolves to { geometry, material } (shared), or null if the asset is unavailable. */
export function loadRocketRifle() {
  if (_rrPromise) return _rrPromise;
  const loader = new GLTFLoader();
  // .glb first; hosts that won't serve binary glTF (e.g. preview artifacts)
  // get the same model as embedded JSON glTF
  _rrPromise = loader.loadAsync('./assets/models/rr.glb')
    .catch(() => loader.loadAsync('./assets/models/rr.gltf.json'))
    .then((gltf) => {
    let src = null;
    gltf.scene.traverse((o) => { if (!src && o.isMesh) src = o; });
    if (!src) return null;
    const geometry = src.geometry.clone();
    // bake the fit into the geometry: grip → origin, +X → -Z, scale
    geometry.translate(-RR_GRIP.x, -RR_GRIP.y, -RR_GRIP.z);
    geometry.rotateY(Math.PI / 2);
    geometry.scale(RR_SCALE, RR_SCALE, RR_SCALE);
    geometry.computeBoundingSphere();
    const map = src.material.map || null;
    if (map) { map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8; }
    const material = new THREE.MeshStandardMaterial({ map, roughness: 0.42, metalness: 0.05 });
    // The lit rings are baked into the texture: make only strongly saturated
    // (orange/red) texels emissive so bloom picks them up and nothing else glows.
    material.userData.glow = { value: 1.8 };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uGlow = material.userData.glow;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uGlow;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          {
            vec3 t = diffuseColor.rgb;
            float mx = max(t.r, max(t.g, t.b)), mn = min(t.r, min(t.g, t.b));
            float sat = (mx - mn) / max(mx, 1e-4);
            totalEmissiveRadiance += t * smoothstep(0.55, 0.8, sat) * smoothstep(0.25, 0.5, mx) * uGlow;
          }`);
    };
    return { geometry, material };
  }).catch((err) => { console.warn('rr.glb unavailable, keeping procedural rifle', err); return null; });
  return _rrPromise;
}

/**
 * Swap a buildGun() result over to the authored model once it loads: hides the
 * procedural parts (except anything listed in `keep`) and adds the RR mesh.
 */
export function upgradeToRocketRifle(gun, { keep = [], castShadow = true } = {}) {
  return loadRocketRifle().then((rr) => {
    if (!rr) return false;
    for (const child of gun.group.children) if (!keep.includes(child)) child.visible = false;
    gun.rifleGroup.visible = false;
    gun.rocketGroup.visible = false;
    gun.rifleGroup.userData.retired = gun.rocketGroup.userData.retired = true;
    const mesh = new THREE.Mesh(rr.geometry, rr.material);
    mesh.castShadow = castShadow; mesh.receiveShadow = true;
    mesh.name = 'rr';
    gun.group.add(mesh);
    gun.rr = mesh;
    return true;
  });
}

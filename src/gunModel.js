import * as THREE from 'three';

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
  grad.addColorStop(0, '#ff3a1a');
  grad.addColorStop(0.55, '#ff6000');
  grad.addColorStop(1, '#ffa040');
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

/** Shared glow material for the orange light rings (bloom picks these up). */
export function makeGlowMat(hex = 0xff2a00, intensity = 14) {
  const m = new THREE.MeshStandardMaterial({
    color: hex, roughness: 0.3, metalness: 0,
    emissive: hex, emissiveIntensity: intensity,
  });
  m.toneMapped = false;
  m.userData.baseEmissive = intensity;
  return m;
}

// Side profile (u = forward distance, v = up) extruded across X, centred.
function profile(points, width, mat, holes = [], bevel = 0.006) {
  const shape = new THREE.Shape(points.map(([u, v]) => new THREE.Vector2(u, v)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([u, v]) => new THREE.Vector2(u, v))));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel,
    bevelSize: bevel, bevelSegments: 1, curveSegments: 6,
  });
  geo.translate(0, 0, -(width - bevel * 2) / 2);
  geo.rotateY(Math.PI / 2); // shape +u → -Z (forward)
  return new THREE.Mesh(geo, mat);
}

/**
 * Build the rifle. Returns { group, rifleGroup, rocketGroup, materials, glowMats }.
 * opts.detail=false skips small parts (third-person avatars).
 */
export function buildGun(opts = {}) {
  const detail = opts.detail !== false;
  const group = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.34, metalness: 0.0 });
  const shellShade = new THREE.MeshStandardMaterial({ color: 0xd9dde2, roughness: 0.4, metalness: 0.0 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x121418, roughness: 0.42, metalness: 0.25 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0b0c0f, roughness: 0.85, metalness: 0 });
  const glow = makeGlowMat();
  const decal = new THREE.MeshBasicMaterial({ map: flameTexture(), transparent: true, depthWrite: false });
  const materials = [shell, shellShade, dark, rubber, glow, decal];
  const glowMats = [glow];

  const H = Math.PI / 2;
  const add = (mesh, parent = group) => { mesh.castShadow = true; parent.add(mesh); return mesh; };
  const box = (w, h, d, mat, u, v, x = 0, parent = group) => {
    const m = add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat), parent);
    m.position.set(x, v, -u);
    return m;
  };
  // cylinder running along the barrel axis, centred at forward distance u
  const tube = (r, len, mat, u, v, x = 0, seg = 20, parent = group) => {
    const m = add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat), parent);
    m.rotation.x = H;
    m.position.set(x, v, -u);
    return m;
  };
  const ring = (r, t, mat, u, v, x = 0, parent = group) => {
    const m = add(new THREE.Mesh(new THREE.TorusGeometry(r, t, 8, 24), mat), parent);
    m.position.set(x, v, -u);
    return m;
  };

  // --- stock with thumbhole + butt pad ---
  add(profile([
    [-0.36, 0.105], [-0.05, 0.12], [-0.05, -0.03], [-0.17, -0.03],
    [-0.25, -0.11], [-0.36, -0.11],
  ], 0.072, shell, [[
    [-0.27, 0.06], [-0.10, 0.07], [-0.10, 0.015], [-0.19, 0.015], [-0.24, -0.05], [-0.27, -0.05],
  ]]));
  box(0.07, 0.2, 0.025, rubber, -0.37, 0.0);
  if (detail) box(0.075, 0.05, 0.10, shellShade, -0.20, 0.135); // cheek riser

  // --- lower receiver ---
  add(profile([
    [-0.06, 0.12], [0.24, 0.12], [0.24, -0.06], [0.08, -0.06], [0.04, -0.035], [-0.06, -0.035],
  ], 0.11, shell));
  // --- upper shroud, chamfered nose ---
  add(profile([
    [0.0, 0.12], [0.03, 0.175], [0.40, 0.175], [0.48, 0.13], [0.48, 0.03], [0.42, 0.0], [0.20, 0.0], [0.20, 0.12],
  ], 0.135, shell));
  // top armour slabs with dark gaps, rail block at the back
  for (let i = 0; i < 3; i++) box(0.11, 0.022, 0.095, shell, 0.11 + i * 0.105, 0.19);
  box(0.12, 0.012, 0.32, dark, 0.215, 0.178);
  box(0.09, 0.04, 0.06, dark, 0.03, 0.19);
  // side vent slots + flame emblem, both sides
  for (const s of [-1, 1]) {
    box(0.004, 0.014, 0.10, dark, 0.17, 0.12, s * 0.069);
    box(0.004, 0.014, 0.10, dark, 0.29, 0.12, s * 0.069);
    const logo = add(new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.07), decal));
    logo.castShadow = false;
    logo.position.set(s * 0.0705, 0.095, -0.41);
    logo.rotation.y = s * H;
    if (detail) {
      box(0.004, 0.006, 0.05, glow, 0.08, 0.02, s * 0.0565); // ejection-port glow tick
    }
  }

  // --- grip, trigger guard, magazine ---
  add(profile([[-0.03, -0.03], [0.03, -0.03], [0.0, -0.20], [-0.065, -0.20]], 0.052, rubber, [], 0.008));
  if (detail) {
    const guard = add(new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.007, 6, 14, Math.PI), dark));
    guard.rotation.set(0, H, Math.PI);
    guard.position.set(0, -0.06, -0.075);
    box(0.012, 0.035, 0.012, dark, 0.07, -0.07);
  }
  box(0.075, 0.12, 0.085, rubber, 0.155, -0.11);
  box(0.08, 0.018, 0.09, dark, 0.155, -0.175);

  // --- front collar with lit slits ---
  box(0.15, 0.18, 0.10, shell, 0.29, -0.027);
  for (const s of [-1, 1]) {
    box(0.004, 0.13, 0.008, glow, 0.255, -0.027, s * 0.076);
    box(0.004, 0.13, 0.008, glow, 0.325, -0.027, s * 0.076);
  }

  // --- stacked twin rocket tubes ---
  const TUBE_R = 0.054;
  for (const v of [0.03, -0.083]) {
    tube(TUBE_R, 0.44, dark, 0.56, v, 0, 22);
    ring(TUBE_R + 0.001, 0.005, glow, 0.355, v);           // collar ring
    tube(TUBE_R + 0.006, 0.07, dark, 0.74, v, 0, 22);      // muzzle cap
    ring(TUBE_R + 0.004, 0.005, glow, 0.70, v);            // lit band near the muzzle
    ring(TUBE_R - 0.008, 0.006, glow, 0.777, v);           // glowing bore rim
    if (detail) {
      const bore = add(new THREE.Mesh(new THREE.CircleGeometry(TUBE_R - 0.01, 18), rubber));
      bore.position.set(0, v, -0.772);
      bore.rotation.y = Math.PI; // face down-range
    }
  }

  // --- top barrel + muzzle brake + bracket ---
  tube(0.017, 0.34, dark, 0.64, 0.125, 0, 14);
  tube(0.03, 0.075, dark, 0.80, 0.125, 0, 12);
  if (detail) {
    for (const s of [-1, 1]) box(0.006, 0.02, 0.04, rubber, 0.80, 0.125, s * 0.031); // brake ports
    ring(0.014, 0.004, glow, 0.84, 0.125);
    box(0.03, 0.06, 0.03, dark, 0.74, 0.09);
  }

  // --- rifle optic (hidden in rocket mode) ---
  const rifleGroup = new THREE.Group();
  group.add(rifleGroup);
  box(0.05, 0.05, 0.12, dark, 0.14, 0.235, 0, rifleGroup);
  tube(0.026, 0.03, dark, 0.215, 0.24, 0, 16, rifleGroup);
  const lens = add(new THREE.Mesh(new THREE.CircleGeometry(0.02, 16), glow), rifleGroup);
  lens.position.set(0, 0.24, -0.231);
  lens.rotation.y = Math.PI;
  box(0.004, 0.022, 0.004, glow, 0.08, 0.265, 0, rifleGroup); // rear sight post
  box(0.03, 0.02, 0.03, dark, 0.10, 0.205, 0, rifleGroup);
  box(0.03, 0.02, 0.03, dark, 0.18, 0.205, 0, rifleGroup);

  // --- rocket-mode charge indicators ---
  const rocketGroup = new THREE.Group();
  rocketGroup.visible = false;
  group.add(rocketGroup);
  for (const s of [-1, 1]) box(0.004, 0.01, 0.20, glow, 0.25, 0.155, s * 0.069, rocketGroup);
  box(0.03, 0.006, 0.28, glow, 0.24, 0.203, 0, rocketGroup);

  return { group, rifleGroup, rocketGroup, materials, glowMats };
}

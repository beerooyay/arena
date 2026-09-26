/**
 * Team-colored rim glow around players, for contrast against the white arena.
 *
 * Each player (bot, remote human, ghost bot) gets two slightly-enlarged "shell"
 * meshes hugging the body capsule + head. A fresnel shader makes the shell
 * transparent where it faces the camera and opaque toward the silhouette edge,
 * so it reads as a soft glowing outline in the team colour rather than a hard
 * band. Depth-tested, so it's correctly hidden behind walls (no wallhack).
 *
 * Values are live-tunable from the dev panel via setGlow(); defaults here are
 * the shipped look.
 */

import * as THREE from 'three';
import { buildGun, flameTexture, makeGlowMat, ORANGE, RED } from './gunModel.js';
import { rbox, lathe, limbGeo } from './geo.js';
import { contactShadowTexture } from './fx.js';

// Shipped defaults (tune live in the dev panel, then hardcode the winners here).
// Off by default: black vs white armour carries the team read now.
export const GLOW = { scale: 1.12, intensity: 0.28, power: 3.6, enabled: false };

const _shells = new Set(); // live shell meshes, for global re-tuning

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const NAME_FONT = '700 40px "Google Sans", system-ui, sans-serif';

// Nameplate: dark glass pill; FIRE gets the fire-gradient rim, WHITE a white rim.
function drawNamePlate(canvas, text, hex) {
  const fs = 40, padX = 22, padY = 10;
  const ctx = canvas.getContext('2d');
  ctx.font = NAME_FONT;
  const w = Math.ceil(ctx.measureText(text.toUpperCase()).width + text.length * 2.4) + padX * 2;
  const h = fs + padY * 2;
  canvas.width = w; canvas.height = h;
  ctx.font = NAME_FONT;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(10,12,16,0.72)';
  roundRect(ctx, 2, 2, w - 4, h - 4, h / 2 - 2); ctx.fill();
  const fire = hex === 0xff6000;
  let rim = 'rgba(244,246,248,0.9)';
  if (fire) { rim = ctx.createLinearGradient(0, 0, w, h); rim.addColorStop(0, '#FF6000'); rim.addColorStop(1, '#FF4848'); }
  ctx.lineWidth = 3; ctx.strokeStyle = rim;
  roundRect(ctx, 3, 3, w - 6, h - 6, h / 2 - 3); ctx.stroke();
  ctx.fillStyle = '#f4f6f8';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '2px';
  ctx.fillText(text.toUpperCase(), w / 2, h / 2 + 2);
  return { w, h };
}

export function makeNameSprite(text, hex) {
  const c = document.createElement('canvas');
  const { w, h } = drawNamePlate(c, text, hex);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.0042;
  sprite.scale.set(w * scale, h * scale, 1);
  sprite.position.y = 2.48;
  // the web font may still be loading: redraw once it's ready
  if (document.fonts && !document.fonts.check(NAME_FONT)) {
    document.fonts.load(NAME_FONT).then(() => {
      const r = drawNamePlate(c, text, hex);
      tex.dispose(); // canvas size may change → re-upload
      tex.needsUpdate = true;
      sprite.scale.set(r.w * scale, r.h * scale, 1);
    }).catch(() => {});
  }
  return sprite;
}

function makeWeapon(mats) {
  const gun = buildGun({ detail: false });
  mats.push(...gun.materials);
  gun.group.rotation.y = Math.PI; // gun space faces -Z; avatars face +Z
  const g = new THREE.Group();
  g.add(gun.group);
  return g;
}

// Armour palettes from the concept art: FIRE wears black plates, WHITE wears
// white plates over a graphite undersuit. Visors carry the squad accent.
const ARMOR = {
  fire:  { plate: 0x1c1f24, suit: 0x101216, joint: 0x08090b, trim: 0x33373e, accent: ORANGE },
  white: { plate: 0xe9ecef, suit: 0x2a2e35, joint: 0x17191d, trim: 0xb9bfc7, accent: RED },
};

// Skeleton landmarks (avatar-local, feet at y=0; the group is scaled ×1.1 in
// Y). Everything above HEAD_LINE counts as a headshot in bots.js (1.72 world),
// so shoulders/pauldrons stay under it and the neck starts right at it.
const HIP_Y = 0.94, SHOULDER_Y = 1.43, SHOULDER_X = 0.215, HEAD_Y = 1.705;

export function makeAvatar(name, hex) {
  const group = new THREE.Group();
  const pal = hex === ORANGE ? ARMOR.fire : ARMOR.white;
  // bodyMat = undersuit (flashes on hit), plateMat = armour shells
  const bodyMat = new THREE.MeshStandardMaterial({ color: pal.suit, roughness: 0.72, metalness: 0 });
  const plateMat = new THREE.MeshStandardMaterial({ color: pal.plate, roughness: 0.32, metalness: 0.06, side: THREE.DoubleSide });
  const trimMat = new THREE.MeshStandardMaterial({ color: pal.trim, roughness: 0.45, metalness: 0.15 });
  const jointMat = new THREE.MeshStandardMaterial({ color: pal.joint, roughness: 0.6, metalness: 0.1 });
  const visorMat = makeGlowMat(pal.accent, 1.8);
  const teamMat = makeGlowMat(pal.accent, 1.3);
  const decalMat = new THREE.MeshBasicMaterial({ map: flameTexture(), transparent: true, depthWrite: false });
  const blobMat = new THREE.MeshBasicMaterial({
    map: contactShadowTexture(), transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2,
  });
  bodyMat.userData.baseColor = bodyMat.color.clone();
  const mats = [bodyMat, plateMat, trimMat, jointMat, visorMat, teamMat, decalMat, blobMat];
  const put = (parent, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  const add = (...a) => put(group, ...a);
  const _up = new THREE.Vector3(0, 1, 0);
  // geometry built along +Y from its origin, laid from point a toward point b
  const along = (parent, geo, mat, a, b) => {
    const m = put(parent, geo, mat, a.x, a.y, a.z);
    m.quaternion.setFromUnitVectors(_up, b.clone().sub(a).normalize());
    return m;
  };
  // armour sleeve: a turned band with rolled edges, hugging a limb of radius r
  const sleeve = (len, r0, r1, t = 0.012) => lathe([
    [r0 - 0.002, 0], [r0 + t, 0.012], [r1 + t, len - 0.012], [r1 - 0.002, len],
  ], 16);
  // curved front/back plate: a partial turned shell (phi 0 = +Z / front)
  const shell = (pairs, phiStart, phiLen, segs = 20) => lathe(pairs, segs, phiStart, phiLen);

  // --- contact shadow ---
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.15), blobMat);
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.012;
  blob.renderOrder = 1;
  group.add(blob);

  // --- torso: one turned undersuit form (hips → waist → ribcage → neck) ---
  const TORSO = [
    [0.001, 0.86], [0.13, 0.875], [0.165, 0.93], [0.168, 1.0], [0.148, 1.08], [0.15, 1.16],
    [0.172, 1.25], [0.19, 1.33], [0.19, 1.40], [0.165, 1.455], [0.105, 1.5], [0.06, 1.53],
    [0.056, 1.6], [0.001, 1.61],
  ];
  const body = add(lathe(TORSO, 24), bodyMat);
  body.scale.set(1, 1, 0.64);

  // chest + back plates: turned shells slightly proud of the ribcage
  const chest = add(shell([[0.168, 1.19], [0.19, 1.22], [0.212, 1.31], [0.212, 1.39], [0.19, 1.445], [0.16, 1.47]], -1.3, 2.6), plateMat);
  chest.scale.set(1, 1, 0.74);
  const back = add(shell([[0.17, 1.2], [0.2, 1.24], [0.208, 1.4], [0.18, 1.46]], Math.PI - 1.2, 2.4), plateMat);
  back.scale.set(1, 1, 0.72);
  add(rbox(0.16, 0.035, 0.03, 0.012), trimMat, 0, 1.43, 0.155, -0.35);         // collar ridge
  add(rbox(0.10, 0.05, 0.02, 0.008), jointMat, 0, 1.33, 0.158);                // chest vent
  add(rbox(0.06, 0.012, 0.012, 0.005), teamMat, 0, 1.305, 0.16);              // chest light
  // segmented abdomen bands
  for (const [y0, y1] of [[1.02, 1.085], [1.095, 1.16]]) {
    const band = add(shell([[0.15, y0], [0.162, y0 + 0.01], [0.162, y1 - 0.01], [0.15, y1]], -1.05, 2.1), plateMat);
    band.scale.set(1, 1, 0.72);
  }
  // belt, buckle, pouches, holster
  const belt = add(lathe([[0.168, 0.915], [0.178, 0.925], [0.178, 0.975], [0.166, 0.985]], 24), jointMat);
  belt.scale.set(1, 1, 0.68);
  add(rbox(0.07, 0.05, 0.02, 0.008), trimMat, 0, 0.95, 0.12);
  add(rbox(0.07, 0.09, 0.045, 0.015), jointMat, -0.11, 0.93, 0.1, 0, -0.35);
  add(rbox(0.07, 0.09, 0.045, 0.015), jointMat, 0.11, 0.93, 0.1, 0, 0.35);
  add(rbox(0.055, 0.15, 0.07, 0.02), jointMat, 0.19, 0.84, 0.0);
  // backpack
  add(rbox(0.3, 0.36, 0.12, 0.035), plateMat, 0, 1.27, -0.19);
  add(rbox(0.22, 0.24, 0.04, 0.015), trimMat, 0, 1.26, -0.255);
  add(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 18), jointMat, 0.1, 1.37, -0.27, Math.PI / 2);
  add(rbox(0.012, 0.16, 0.012, 0.005), teamMat, -0.09, 1.26, -0.277);

  // --- helmet: sculpted shell, dark face mask, swept V visor ---
  const HS = new THREE.Vector3(1.0, 1.08, 1.12); // helmet ellipsoid scale
  const HR = 0.145;
  const helmet = add(new THREE.SphereGeometry(HR, 28, 22), plateMat, 0, HEAD_Y, 0);
  helmet.scale.copy(HS);
  const head = helmet;
  // face mask: lower-front patch of a slightly larger ellipsoid
  const mask = add(new THREE.SphereGeometry(HR + 0.006, 24, 14, Math.PI / 2 - 0.95, 1.9, 1.35, 1.1), jointMat, 0, HEAD_Y, 0);
  mask.scale.copy(HS);
  add(rbox(0.12, 0.05, 0.05, 0.02), plateMat, 0, HEAD_Y - 0.115, 0.115, 0.35); // jaw guard
  add(rbox(0.03, 0.035, 0.3, 0.012), trimMat, 0, HEAD_Y + HR * HS.y - 0.005, -0.01); // crest
  // point on the helmet surface at azimuth az (0 = front) and elevation el
  const onHelmet = (az, el, lift = 0.012) => new THREE.Vector3(
    Math.sin(az) * Math.cos(el) * (HR + lift) * HS.x,
    HEAD_Y + Math.sin(el) * (HR + lift) * HS.y,
    Math.cos(az) * Math.cos(el) * (HR + lift) * HS.z);
  for (const s of [-1, 1]) {
    const brow = new THREE.CatmullRomCurve3([onHelmet(0, -0.02), onHelmet(s * 0.35, 0.07), onHelmet(s * 0.72, 0.12)]);
    add(new THREE.TubeGeometry(brow, 12, 0.013, 8), visorMat);
    const cheek = new THREE.CatmullRomCurve3([onHelmet(s * 0.72, 0.1), onHelmet(s * 0.8, -0.06), onHelmet(s * 0.74, -0.2)]);
    add(new THREE.TubeGeometry(cheek, 8, 0.008, 8), visorMat);
    // ear pods: turned discs
    const pod = add(lathe([[0.001, 0], [0.05, 0], [0.056, 0.012], [0.05, 0.03], [0.02, 0.036], [0.001, 0.036]], 20), trimMat,
      s * (HR * HS.x - 0.012), HEAD_Y - 0.005, -0.01, 0, 0, -s * Math.PI / 2);
    pod.castShadow = false;
  }

  // --- rifle, held across the chest ---
  const marker = makeWeapon(mats);
  marker.position.set(0.0, 1.14, 0.17);
  marker.rotation.set(-0.04, -0.03, 0);
  marker.scale.setScalar(0.8);
  group.add(marker);

  // Arms live in shoulder pivots (bots.js swings them a touch while running).
  // Two-bone IK lands the gloves on the grip and under the front collar.
  const L1 = 0.3, L2 = 0.29;
  const elbowFor = (t, pole) => {
    const d = Math.min(t.length(), L1 + L2 - 0.002);
    const dir = t.clone().normalize();
    const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(L1 * L1 - a * a, 0));
    const p = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
    return { elbow: dir.clone().multiplyScalar(a).addScaledVector(p, h), hand: dir.multiplyScalar(d) };
  };
  const makeArm = (side, handAt, pole) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * SHOULDER_X, SHOULDER_Y, -0.01);
    group.add(pivot);
    const { elbow, hand } = elbowFor(handAt.clone().sub(pivot.position), pole);
    const o = new THREE.Vector3();
    put(pivot, new THREE.SphereGeometry(0.068, 16, 12), bodyMat);                              // deltoid
    // pauldron: domed shell capping the shoulder, rolled rim, flame emblem
    const pg = new THREE.Group();
    pg.position.set(side * 0.012, -0.005, 0);
    pg.rotation.z = side * -0.5;
    pivot.add(pg);
    const cap = put(pg, new THREE.SphereGeometry(0.085, 20, 14, 0, Math.PI * 2, 0, 1.75), plateMat);
    cap.scale.set(1.0, 1.05, 1.2);
    const rim = put(pg, new THREE.TorusGeometry(0.084, 0.007, 6, 24), trimMat, 0, Math.cos(1.75) * 0.085 * 1.05, 0, Math.PI / 2);
    rim.scale.set(1.0, 1.2, 1);
    const emblem = new THREE.Mesh(new THREE.PlaneGeometry(0.075, 0.075), decalMat);
    emblem.position.set(side * 0.087, 0.0, 0);
    emblem.rotation.y = side * Math.PI / 2;
    pg.add(emblem);
    // upper arm (bicep bulge) + sleeve plate, elbow, forearm + vambrace
    along(pivot, limbGeo(L1, 0.056, 0.046, 0.012, 0.4), bodyMat, o, elbow);
    along(pivot, sleeve(L1 * 0.5, 0.058, 0.05), plateMat, elbow.clone().multiplyScalar(0.35), elbow);
    put(pivot, new THREE.SphereGeometry(0.05, 14, 10), jointMat, elbow.x, elbow.y, elbow.z);
    along(pivot, limbGeo(L2, 0.047, 0.036, 0.012, 0.3), jointMat, elbow, hand);
    const vA = elbow.clone().lerp(hand, 0.18), vB = elbow.clone().lerp(hand, 0.8);
    along(pivot, sleeve(vA.distanceTo(vB), 0.052, 0.042, 0.014), plateMat, vA, vB);
    along(pivot, rbox(0.01, vA.distanceTo(vB) * 0.6, 0.01, 0.004), teamMat,
      vA.clone().lerp(vB, 0.2).add(new THREE.Vector3(side * 0.06, 0, 0)), vB.clone().add(new THREE.Vector3(side * 0.06, 0, 0)));
    // glove: palm + knuckles, oriented down the forearm
    const glove = put(pivot, rbox(0.072, 0.1, 0.05, 0.02), jointMat, hand.x, hand.y, hand.z);
    glove.quaternion.setFromUnitVectors(_up, hand.clone().sub(elbow).normalize());
    return pivot;
  };
  // right hand on the pistol grip, left hand under the front collar
  const armR = makeArm(1, new THREE.Vector3(0.0, 1.06, 0.17), new THREE.Vector3(1, -0.6, -0.4));
  const armL = makeArm(-1, new THREE.Vector3(0.0, 1.035, 0.4), new THREE.Vector3(-1, -0.8, -0.2));

  // Legs hang from hip pivots (bots.js swings them for the walk cycle).
  const makeLeg = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.1, HIP_Y, 0);
    group.add(pivot);
    // thigh (quad bulge high), knee, shin (calf bulge high), ankle
    put(pivot, limbGeo(0.45, 0.058, 0.088, 0.016, 0.62).translate(0, -0.45, 0), bodyMat);
    put(pivot, new THREE.SphereGeometry(0.05, 14, 10), bodyMat, 0, -0.45, 0.0);
    put(pivot, limbGeo(0.44, 0.042, 0.058, 0.02, 0.72).translate(0, -0.87, 0), bodyMat);
    // thigh plate + outer hip plate (front shells)
    const tp = put(pivot, shell([[0.086, -0.36], [0.1, -0.34], [0.105, -0.16], [0.097, -0.07], [0.085, -0.05]], -1.2, 2.4, 16), plateMat);
    tp.scale.set(1, 1, 1.05);
    put(pivot, shell([[0.092, -0.2], [0.105, -0.18], [0.108, 0.03], [0.095, 0.05]], side * Math.PI / 2 - 0.7, 1.4, 12), trimMat);
    // knee pad: domed cap facing forward
    const kp = put(pivot, new THREE.SphereGeometry(0.06, 18, 12, 0, Math.PI * 2, 0, 1.35), plateMat, 0, -0.45, 0.022, Math.PI / 2);
    kp.scale.set(1.0, 1.3, 1.1);
    // shin guard
    const sg = put(pivot, shell([[0.05, -0.84], [0.064, -0.82], [0.074, -0.6], [0.068, -0.53], [0.058, -0.515]], -1.1, 2.2, 16), plateMat);
    sg.scale.set(1, 1, 1.15);
    put(pivot, rbox(0.012, 0.12, 0.012, 0.005), teamMat, 0, -0.66, 0.084);
    // boot: rounded shell, toe cap, sole
    put(pivot, rbox(0.115, 0.12, 0.25, 0.045), plateMat, 0, -0.875, 0.035);
    put(pivot, rbox(0.105, 0.07, 0.08, 0.03), trimMat, 0, -0.9, 0.14);
    put(pivot, rbox(0.125, 0.03, 0.27, 0.012), jointMat, 0, -0.925, 0.035);
    return pivot;
  };
  const legL = makeLeg(-1), legR = makeLeg(1);

  const label = makeNameSprite(name, hex);
  group.add(label);
  group.scale.set(1.06, 1.1, 1.06); // feet stay at y=0
  group.userData = {
    group, body, head, bodyMat, plateMat, visorMat, teamMat, label, marker, mats,
    armL, armR, legL, legR, blob,
  };
  return group.userData;
}

export function disposeAvatar(group) {
  const u = group.userData || {};
  disposeGlow(group);
  if (u.label) { u.label.material.map.dispose(); u.label.material.dispose(); }
  for (const m of u.mats || []) m.dispose();
  group.traverse((o) => o.geometry && o.geometry.dispose());
}

const VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uPower;
  varying vec3 vN;
  varying vec3 vView;
  void main() {
    float rim = 1.0 - max(dot(normalize(vN), normalize(vView)), 0.0);
    rim = pow(rim, uPower);
    gl_FragColor = vec4(uColor, clamp(rim * uIntensity, 0.0, 1.0));
  }
`;

function makeGlowMaterial(hex) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(hex) },
      uIntensity: { value: GLOW.intensity },
      uPower: { value: GLOW.power },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

/**
 * Add rim-glow shells to a player group built in the standard avatar layout
 * (body CapsuleGeometry(0.35,0.9) at y=1.0, head SphereGeometry(0.28) at y=1.78).
 * Both shells share one material. Stores refs on group.userData.glow.
 */
export function addPlayerGlow(group, hex) {
  const mat = makeGlowMaterial(hex);

  const bodyShell = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 6, 12), mat);
  bodyShell.position.y = 1.0;
  const headShell = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), mat);
  headShell.position.y = 1.78;

  for (const m of [bodyShell, headShell]) {
    m.scale.setScalar(GLOW.scale);
    m.visible = GLOW.enabled;
    m.renderOrder = 2; // after the opaque body
    _shells.add(m);
  }

  group.add(bodyShell, headShell);
  group.userData.glow = { mat, meshes: [bodyShell, headShell] };
  return group.userData.glow;
}

/** Release a group's glow (call from the group's existing dispose path). */
export function disposeGlow(group) {
  const glow = group.userData && group.userData.glow;
  if (!glow) return;
  for (const m of glow.meshes) _shells.delete(m);
  glow.mat.dispose();
  group.userData.glow = null;
}

/** Live-tune every glow currently in the scene (dev panel). */
export function setGlow({ scale, intensity, power, enabled } = {}) {
  if (scale != null) GLOW.scale = scale;
  if (intensity != null) GLOW.intensity = intensity;
  if (power != null) GLOW.power = power;
  if (enabled != null) GLOW.enabled = enabled;
  for (const m of _shells) {
    if (scale != null) m.scale.setScalar(GLOW.scale);
    if (enabled != null) m.visible = GLOW.enabled;
    if (intensity != null) m.material.uniforms.uIntensity.value = GLOW.intensity;
    if (power != null) m.material.uniforms.uPower.value = GLOW.power;
  }
}

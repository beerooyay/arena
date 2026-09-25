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
import { buildGun, flameTexture, makeGlowMat } from './gunModel.js';

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

export function makeNameSprite(text, hex) {
  const fs = 40, padX = 18, padY = 8;
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = `800 ${fs}px Inter, system-ui, sans-serif`;
  const w = Math.ceil(meas.measureText(text).width) + padX * 2;
  const h = fs + padY * 2;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.font = `800 ${fs}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(12,16,22,0.78)';
  roundRect(ctx, 2, 2, w - 4, h - 4, 12); ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#' + hex.toString(16).padStart(6, '0');
  roundRect(ctx, 3, 3, w - 6, h - 6, 11); ctx.stroke();
  ctx.fillStyle = '#f4f6f8';
  ctx.fillText(text, w / 2, h / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.0042;
  sprite.scale.set(w * scale, h * scale, 1);
  sprite.position.y = 2.48;
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
// white plates over a graphite undersuit. Both squads share the orange visor.
const ARMOR = {
  fire:  { plate: 0x1c1f24, suit: 0x0f1114, joint: 0x08090b, trim: 0x2c3036 },
  white: { plate: 0xe9ecef, suit: 0x2a2e35, joint: 0x17191d, trim: 0xb9bfc7 },
};

export function makeAvatar(name, hex) {
  const group = new THREE.Group();
  const pal = hex === 0xff6000 ? ARMOR.fire : ARMOR.white;
  // bodyMat = undersuit (flashes on hit), plateMat = armour shells
  const bodyMat = new THREE.MeshStandardMaterial({ color: pal.suit, roughness: 0.78, metalness: 0 });
  const plateMat = new THREE.MeshStandardMaterial({ color: pal.plate, roughness: 0.38, metalness: 0.05 });
  const trimMat = new THREE.MeshStandardMaterial({ color: pal.trim, roughness: 0.5, metalness: 0.1 });
  const jointMat = new THREE.MeshStandardMaterial({ color: pal.joint, roughness: 0.7, metalness: 0 });
  const visorMat = makeGlowMat(0xff1c00, 4.5);
  const teamMat = makeGlowMat(0xff2a00, 7);
  const decalMat = new THREE.MeshBasicMaterial({ map: flameTexture(), transparent: true, depthWrite: false });
  bodyMat.userData.baseColor = bodyMat.color.clone();
  const mats = [bodyMat, plateMat, trimMat, jointMat, visorMat, teamMat, decalMat];
  const addTo = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  const add = (...a) => addTo(group, ...a);
  const decal = (parent, size, x, y, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), decalMat);
    m.position.set(x, y, z); m.rotation.y = ry; parent.add(m); return m;
  };

  // capsule / box spanning two points (limb segments)
  const _up = new THREE.Vector3(0, 1, 0);
  const span = (parent, a, b, geoFor, mat) => {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    const m = new THREE.Mesh(geoFor(len), mat);
    m.position.copy(a).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(_up, d.normalize());
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  // two-bone IK: elbow for a shoulder at the origin reaching `t`, bent toward `pole`
  const elbowFor = (t, l1, l2, pole) => {
    const d = Math.min(t.length(), l1 + l2 - 0.002);
    const dir = t.clone().normalize();
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
    const p = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
    return { elbow: dir.clone().multiplyScalar(a).addScaledVector(p, h), hand: dir.multiplyScalar(d) };
  };

  // --- torso: undersuit core under a layered plate rig, backpack ---
  const body = add(new THREE.CapsuleGeometry(0.17, 0.56, 6, 14), bodyMat, 0, 1.15, 0);
  add(new THREE.BoxGeometry(0.52, 0.34, 0.34), plateMat, 0, 1.36, 0.02);           // chest plate
  add(new THREE.BoxGeometry(0.44, 0.10, 0.30), trimMat, 0, 1.18, 0.02);            // chest lower band
  add(new THREE.BoxGeometry(0.36, 0.08, 0.06), trimMat, 0, 1.52, 0.16, -0.3);      // collar ridge
  add(new THREE.BoxGeometry(0.20, 0.10, 0.03), jointMat, 0, 1.38, 0.195);          // chest vent
  add(new THREE.BoxGeometry(0.36, 0.20, 0.26), bodyMat, 0, 1.06, 0.01);            // abdomen suit
  add(new THREE.BoxGeometry(0.26, 0.16, 0.05), plateMat, 0, 1.07, 0.14);           // ab plate
  add(new THREE.BoxGeometry(0.46, 0.07, 0.30), jointMat, 0, 0.95, 0.01);           // belt
  add(new THREE.BoxGeometry(0.09, 0.12, 0.05), jointMat, -0.14, 0.95, 0.17);       // pouches
  add(new THREE.BoxGeometry(0.09, 0.12, 0.05), jointMat, 0.14, 0.95, 0.17);
  add(new THREE.BoxGeometry(0.08, 0.18, 0.08), jointMat, 0.27, 0.82, 0.02);        // thigh holster
  add(new THREE.BoxGeometry(0.38, 0.16, 0.26), bodyMat, 0, 0.86, 0.0);             // hips
  add(new THREE.BoxGeometry(0.40, 0.44, 0.16), plateMat, 0, 1.32, -0.22);          // backpack
  add(new THREE.BoxGeometry(0.28, 0.30, 0.05), trimMat, 0, 1.30, -0.31);
  add(new THREE.CylinderGeometry(0.07, 0.07, 0.06, 14), jointMat, 0.12, 1.42, -0.33, Math.PI / 2);

  // --- helmet: rounded shell, crest, V visor, ear pods ---
  add(new THREE.CylinderGeometry(0.10, 0.12, 0.14, 12), jointMat, 0, 1.58, 0);
  const head = add(new THREE.SphereGeometry(0.23, 20, 18), plateMat, 0, 1.81, 0);
  head.scale.set(1.0, 1.02, 1.1);
  add(new THREE.BoxGeometry(0.06, 0.05, 0.38), trimMat, 0, 2.03, -0.01);           // crest ridge
  add(new THREE.BoxGeometry(0.30, 0.17, 0.10), jointMat, 0, 1.79, 0.19);           // face plate
  add(new THREE.BoxGeometry(0.22, 0.10, 0.10), plateMat, 0, 1.68, 0.19, 0.3);      // jaw guard
  add(new THREE.BoxGeometry(0.03, 0.14, 0.05), plateMat, 0, 1.80, 0.245);          // nose ridge
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.13, 0.032, 0.03), visorMat, s * 0.075, 1.835, 0.245, 0, 0, s * 0.3); // V visor
    add(new THREE.BoxGeometry(0.025, 0.07, 0.03), visorMat, s * 0.132, 1.79, 0.235, 0, 0, s * 0.15); // cheek line
    add(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 16), trimMat, s * 0.23, 1.82, -0.02, 0, 0, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.035, 0.035, 0.052, 12), jointMat, s * 0.235, 1.82, -0.02, 0, 0, Math.PI / 2);
  }

  // --- rifle, held across the chest ---
  const marker = makeWeapon(mats);
  marker.position.set(0.03, 1.18, 0.14);
  marker.rotation.set(-0.04, -0.03, 0);
  marker.scale.setScalar(0.82);
  group.add(marker);

  // Arms live in shoulder pivots (bots.js swings them a touch while running).
  // Each is posed by IK so the gloves land on the grip and the front collar.
  const L1 = 0.32, L2 = 0.34;
  const makeArm = (side, handAt, pole) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.30, 1.50, 0.0);
    group.add(pivot);
    const t = handAt.clone().sub(pivot.position);
    const { elbow, hand } = elbowFor(t, L1, L2, pole);
    const o = new THREE.Vector3();
    addTo(pivot, new THREE.BoxGeometry(0.22, 0.14, 0.26), plateMat, side * 0.03, 0.02, -0.01, 0, 0, side * -0.1); // pauldron
    addTo(pivot, new THREE.BoxGeometry(0.20, 0.04, 0.24), trimMat, side * 0.05, -0.06, -0.01, 0, 0, side * -0.1);
    decal(pivot, 0.1, side * 0.142, 0.02, -0.01, side * Math.PI / 2).rotation.z = side * -0.1; // flame emblem
    span(pivot, o, elbow, (l) => new THREE.CapsuleGeometry(0.075, Math.max(0.01, l - 0.1), 4, 10), bodyMat);
    const upperMid = elbow.clone().multiplyScalar(0.5);
    span(pivot, upperMid.clone().multiplyScalar(0.4), upperMid.clone().multiplyScalar(1.6),
      (l) => new THREE.BoxGeometry(0.15, l, 0.15), plateMat);                                  // bicep plate
    addTo(pivot, new THREE.SphereGeometry(0.075, 10, 10), jointMat, elbow.x, elbow.y, elbow.z); // elbow
    span(pivot, elbow, hand, (l) => new THREE.CapsuleGeometry(0.065, Math.max(0.01, l - 0.1), 4, 10), jointMat);
    const foreA = elbow.clone().lerp(hand, 0.2), foreB = elbow.clone().lerp(hand, 0.75);
    span(pivot, foreA, foreB, (l) => new THREE.BoxGeometry(0.13, l, 0.13), plateMat);          // vambrace
    const g = addTo(pivot, new THREE.BoxGeometry(0.09, 0.10, 0.11), jointMat, hand.x, hand.y, hand.z); // glove
    g.quaternion.setFromUnitVectors(_up, hand.clone().sub(elbow).normalize());
    return pivot;
  };
  // right hand on the pistol grip, left hand under the front collar
  const armR = makeArm(1, new THREE.Vector3(0.03, 1.10, 0.15), new THREE.Vector3(1, -0.5, -0.7));
  const armL = makeArm(-1, new THREE.Vector3(0.03, 1.07, 0.39), new THREE.Vector3(-1, -0.6, -0.2));

  const makeLeg = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.13, 0.64, 0);
    addTo(pivot, new THREE.CapsuleGeometry(0.11, 0.40, 4, 10), bodyMat, 0, -0.06, 0, 0.04, 0, side * 0.04);
    addTo(pivot, new THREE.BoxGeometry(0.19, 0.28, 0.16), plateMat, side * 0.01, -0.05, 0.04, 0.04);    // thigh plate
    addTo(pivot, new THREE.CylinderGeometry(0.07, 0.07, 0.12, 14), jointMat, 0, -0.29, 0.09, 0, 0, Math.PI / 2);
    addTo(pivot, new THREE.BoxGeometry(0.14, 0.14, 0.08), plateMat, 0, -0.29, 0.12);                    // knee pad
    addTo(pivot, new THREE.CapsuleGeometry(0.095, 0.30, 4, 10), bodyMat, 0, -0.42, 0, -0.04, 0, side * -0.02);
    addTo(pivot, new THREE.BoxGeometry(0.18, 0.28, 0.16), plateMat, 0, -0.43, 0.035, -0.04);             // shin guard
    addTo(pivot, new THREE.BoxGeometry(0.21, 0.13, 0.33), plateMat, 0, -0.585, 0.06);                    // boot
    addTo(pivot, new THREE.BoxGeometry(0.22, 0.04, 0.34), jointMat, 0, -0.645, 0.06);                    // sole
    addTo(pivot, new THREE.BoxGeometry(0.09, 0.02, 0.02), teamMat, 0, -0.43, 0.12);
    group.add(pivot);
    return pivot;
  };
  const legL = makeLeg(-1), legR = makeLeg(1);

  const label = makeNameSprite(name, hex);
  group.add(label);
  // slightly taller + broader than the old capsule build; feet stay at y=0
  group.scale.set(1.06, 1.1, 1.06);
  group.userData = {
    group, body, head, bodyMat, plateMat, visorMat, teamMat, label, marker, mats,
    armL, armR, legL, legR,
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

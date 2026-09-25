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

// Shipped defaults (tune live in the dev panel, then hardcode the winners here).
export const GLOW = { scale: 1.15, intensity: 0.85, power: 2.4, enabled: true };

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
  const g = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0xe8ebef, roughness: 0.5, metalness: 0 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x11151b, roughness: 0.58, metalness: 0 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x333a44, roughness: 0.48, metalness: 0 });
  const accent = new THREE.MeshStandardMaterial({ color: 0xff6000, roughness: 0.4, emissive: 0xff6000, emissiveIntensity: 0.45 });
  mats.push(shell, dark, metal, accent);
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = true; g.add(m); return m;
  };
  const H = Math.PI / 2;
  add(new THREE.BoxGeometry(0.15, 0.13, 0.34), shell, 0, 0.02, 0.02);
  add(new THREE.BoxGeometry(0.11, 0.08, 0.18), shell, 0, 0.09, -0.02);
  add(new THREE.BoxGeometry(0.16, 0.045, 0.14), dark, 0, 0.135, -0.02);
  add(new THREE.BoxGeometry(0.06, 0.08, 0.16), shell, -0.09, -0.02, 0.05);
  add(new THREE.BoxGeometry(0.06, 0.08, 0.16), shell, 0.09, -0.02, 0.05);
  add(new THREE.CylinderGeometry(0.018, 0.018, 0.56, 14), dark, 0, 0.055, 0.36, H);
  add(new THREE.CylinderGeometry(0.024, 0.024, 0.54, 14), dark, -0.038, -0.055, 0.35, H);
  add(new THREE.CylinderGeometry(0.024, 0.024, 0.54, 14), dark, 0.038, -0.055, 0.35, H);
  for (const x of [-0.038, 0.038]) {
    add(new THREE.TorusGeometry(0.028, 0.006, 8, 16), accent, x, -0.055, 0.61);
    add(new THREE.CylinderGeometry(0.031, 0.031, 0.028, 14), metal, x, -0.055, 0.62, H);
  }
  add(new THREE.TorusGeometry(0.024, 0.005, 8, 16), accent, 0, 0.055, 0.62);
  add(new THREE.CylinderGeometry(0.024, 0.024, 0.12, 14), dark, 0, 0.145, -0.04, H);
  add(new THREE.BoxGeometry(0.05, 0.05, 0.07), dark, 0, 0.115, -0.13);
  add(new THREE.BoxGeometry(0.055, 0.16, 0.07), dark, 0, -0.12, -0.08, -0.18);
  add(new THREE.BoxGeometry(0.08, 0.11, 0.13), shell, 0, -0.015, -0.24);
  add(new THREE.BoxGeometry(0.09, 0.09, 0.08), dark, 0, -0.02, -0.32);
  add(new THREE.BoxGeometry(0.006, 0.02, 0.15), accent, -0.078, 0.025, 0.01);
  add(new THREE.BoxGeometry(0.006, 0.02, 0.15), accent, 0.078, 0.025, 0.01);
  return g;
}

export function makeAvatar(name, hex) {
  const group = new THREE.Group();
  const fire = hex === 0xff6000;
  const bodyMat = new THREE.MeshStandardMaterial({ color: fire ? 0x59616c : 0x11151b, roughness: 0.64, metalness: 0 });
  const plateMat = new THREE.MeshStandardMaterial({ color: fire ? 0x343a44 : 0x080a0e, roughness: 0.54, metalness: 0 });
  const jointMat = new THREE.MeshStandardMaterial({ color: fire ? 0x20252d : 0x050609, roughness: 0.72, metalness: 0 });
  const visorMat = new THREE.MeshStandardMaterial({
    color: hex, roughness: 0.24, metalness: 0,
    emissive: new THREE.Color(hex), emissiveIntensity: 0.6,
  });
  const teamMat = new THREE.MeshStandardMaterial({
    color: hex, roughness: 0.42, metalness: 0,
    emissive: new THREE.Color(hex), emissiveIntensity: 0.32,
  });
  bodyMat.userData.baseColor = bodyMat.color.clone();
  const mats = [bodyMat, plateMat, jointMat, visorMat, teamMat];
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = true; m.receiveShadow = true; group.add(m); return m;
  };

  const body = add(new THREE.CapsuleGeometry(0.27, 0.58, 6, 14), jointMat, 0, 1.15, 0);
  add(new THREE.BoxGeometry(0.5, 0.44, 0.17), plateMat, 0, 1.30, 0.14);
  add(new THREE.BoxGeometry(0.34, 0.20, 0.04), bodyMat, 0, 1.38, 0.235);
  add(new THREE.BoxGeometry(0.28, 0.12, 0.035), plateMat, 0, 1.22, 0.245);
  add(new THREE.BoxGeometry(0.26, 0.045, 0.03), teamMat, 0, 1.39, 0.27);
  add(new THREE.BoxGeometry(0.34, 0.16, 0.20), plateMat, 0, 0.88, 0.02);
  add(new THREE.BoxGeometry(0.44, 0.07, 0.18), jointMat, 0, 0.96, 0.04);
  add(new THREE.BoxGeometry(0.30, 0.34, 0.12), plateMat, 0, 1.36, -0.18);
  add(new THREE.BoxGeometry(0.22, 0.08, 0.04), teamMat, 0, 1.48, -0.25);

  add(new THREE.CylinderGeometry(0.12, 0.14, 0.14, 12), jointMat, 0, 1.59, 0);
  const head = add(new THREE.SphereGeometry(0.255, 18, 18), plateMat, 0, 1.82, 0);
  head.scale.set(1, 0.92, 1.04);
  add(new THREE.BoxGeometry(0.30, 0.09, 0.055), visorMat, 0, 1.84, 0.245);
  add(new THREE.BoxGeometry(0.25, 0.12, 0.07), plateMat, 0, 1.73, 0.22, 0.12);
  add(new THREE.BoxGeometry(0.32, 0.06, 0.16), bodyMat, 0, 1.96, 0.01);
  add(new THREE.CylinderGeometry(0.055, 0.055, 0.035, 12), jointMat, -0.25, 1.84, 0, 0, 0, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.055, 0.055, 0.035, 12), jointMat, 0.25, 1.84, 0, 0, 0, Math.PI / 2);

  // Arms and legs are built inside pivot groups anchored at the shoulder/hip,
  // so swinging the pivot animates the whole limb (walk cycle in bots.js).
  const addTo = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };
  const makeArm = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.42, 1.52, 0.02);
    addTo(pivot, new THREE.BoxGeometry(0.2, 0.15, 0.21), plateMat, side * -0.02, -0.03, -0.01, 0, 0, side * -0.12);
    addTo(pivot, new THREE.CapsuleGeometry(0.09, 0.34, 4, 10), bodyMat, side * -0.01, -0.32, 0.01, 0.15, 0, side * -0.10);
    addTo(pivot, new THREE.CapsuleGeometry(0.075, 0.32, 4, 10), jointMat, side * 0.06, -0.42, 0.22, 1.18, 0, side * -0.10);
    addTo(pivot, new THREE.SphereGeometry(0.08, 10, 10), jointMat, side * 0.15, -0.46, 0.40);
    addTo(pivot, new THREE.BoxGeometry(0.10, 0.07, 0.04), teamMat, side * -0.03, -0.02, 0.10);
    group.add(pivot);
    return pivot;
  };
  const makeLeg = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.15, 0.64, 0);
    addTo(pivot, new THREE.CapsuleGeometry(0.12, 0.42, 4, 10), bodyMat, 0, -0.06, 0, 0.04, 0, side * 0.04);
    addTo(pivot, new THREE.BoxGeometry(0.18, 0.15, 0.13), plateMat, 0, -0.19, 0.04);
    addTo(pivot, new THREE.CapsuleGeometry(0.10, 0.34, 4, 10), bodyMat, 0, -0.40, 0, -0.04, 0, side * -0.02);
    addTo(pivot, new THREE.BoxGeometry(0.19, 0.11, 0.30), plateMat, 0, -0.57, 0.06);
    addTo(pivot, new THREE.BoxGeometry(0.10, 0.035, 0.02), teamMat, 0, -0.18, 0.11);
    group.add(pivot);
    return pivot;
  };
  const armL = makeArm(-1), armR = makeArm(1);
  const legL = makeLeg(-1), legR = makeLeg(1);

  const marker = makeWeapon(mats);
  marker.position.set(0.16, 1.14, 0.36);
  marker.rotation.set(-0.05, -0.04, -0.03);
  marker.scale.setScalar(0.9);
  group.add(marker);
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

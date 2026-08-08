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

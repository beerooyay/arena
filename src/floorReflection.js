import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

/**
 * Polished-floor reflection: a planar mirror of the arena drawn as a thin,
 * transparent layer just above the floor tiles, blended by a Fresnel term so
 * it's faint looking down and strong at glancing angles (LED strips, pillar
 * and players streak across the floor like polished tile).
 *
 * Rendered at reduced resolution, at most 30 times per second, and only for
 * the main camera — the outline normal pass and the scope camera reuse it.
 */
const VERT = /* glsl */`
  uniform mat4 textureMatrix;
  varying vec4 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = textureMatrix * vec4(position, 1.0);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const FRAG = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform float uStrength;
  uniform float uBase;
  varying vec4 vUv;
  varying vec3 vWorld;
  void main() {
    vec3 refl = texture2DProj(tDiffuse, vUv).rgb;
    vec3 V = normalize(cameraPosition - vWorld);
    float fres = uBase + (1.0 - uBase) * pow(1.0 - clamp(V.y, 0.0, 1.0), 4.0);
    gl_FragColor = vec4(refl, clamp(fres * uStrength, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

export function createFloorReflection(renderer, camera, { radius, y = 0.004, strength = 0.55, base = 0.12, scale = 0.35, layer = null } = {}) {
  const res = () => {
    const s = renderer.getSize(new THREE.Vector2()).multiplyScalar(renderer.getPixelRatio() * scale);
    return [Math.max(256, Math.round(s.x)), Math.max(256, Math.round(s.y))];
  };
  const [w, h] = res();
  // a disc a little larger than the floor: anything past the walls is hidden by them
  const refl = new Reflector(new THREE.CircleGeometry(radius + 1, 64), {
    textureWidth: w, textureHeight: h, clipBias: 0.003, multisample: 0,
  });
  refl.rotation.x = -Math.PI / 2;
  refl.position.y = y;
  refl.renderOrder = 1;
  if (layer != null) refl.layers.set(layer);

  const baseMat = refl.material;
  refl.material = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: baseMat.uniforms.tDiffuse,
      textureMatrix: baseMat.uniforms.textureMatrix,
      uStrength: { value: strength },
      uBase: { value: base },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
  });
  baseMat.dispose();

  // one reflection render per frame, for the main camera only
  const render = refl.onBeforeRender;
  let lastT = -1;
  refl.onBeforeRender = (r, s, c) => {
    if (c !== camera) return;
    const now = performance.now();
    if (now - lastT < 33) return;
    lastT = now;
    render(r, s, c);
  };

  return {
    mesh: refl,
    setStrength(v) { refl.material.uniforms.uStrength.value = v; },
    resize() { const [rw, rh] = res(); refl.getRenderTarget().setSize(rw, rh); },
    dispose() { refl.getRenderTarget().dispose(); refl.material.dispose(); refl.geometry.dispose(); },
  };
}

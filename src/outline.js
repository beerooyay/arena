import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/**
 * Screen-space contour outline.
 * Renders the scene once with a normal material into a buffer (with a depth
 * texture), then a full-screen pass detects edges via depth + normal
 * discontinuities and blends a faint contour over the beauty pass.
 *
 * This keeps the clean white look while making geometry readable, and gives
 * us adjustable strength / thickness / color as developer sliders.
 */

const OutlineShader = {
  uniforms: {
    tDiffuse:      { value: null },
    tNormal:       { value: null },
    tDepth:        { value: null },
    resolution:    { value: new THREE.Vector2() },
    cameraNear:    { value: 0.1 },
    cameraFar:     { value: 200.0 },
    outlineColor:  { value: new THREE.Color(0x3a3f47) },
    strength:      { value: 0.6 },   // overall visibility 0..1
    thickness:     { value: 1.2 },   // sample offset in pixels
    depthBias:     { value: 0.6 },   // sensitivity to depth edges
    normalBias:    { value: 0.9 },   // sensitivity to normal edges
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    #include <packing>
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform sampler2D tNormal;
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform vec3 outlineColor;
    uniform float strength;
    uniform float thickness;
    uniform float depthBias;
    uniform float normalBias;

    float readDepth(vec2 coord) {
      float fragCoordZ = texture2D(tDepth, coord).x;
      float viewZ = perspectiveDepthToViewZ(fragCoordZ, cameraNear, cameraFar);
      return viewZToOrthographicDepth(viewZ, cameraNear, cameraFar);
    }

    void main() {
      vec4 sceneColor = texture2D(tDiffuse, vUv);
      vec2 texel = thickness / resolution;

      // --- depth edges ---
      float dC = readDepth(vUv);

      // Sky guard: at the far plane there's no geometry (sky/clouds/sun are drawn
      // in the beauty pass but excluded from this prepass). Depth-buffer
      // quantisation there is tiny but gets amplified into speckle by the edge
      // term below — invisible on the old white sky, but obvious on blue sky and
      // clouds. Skip the outline entirely for far-plane pixels. Real geometry sits
      // well under 0.5 orthographic depth, so nothing wanted is lost.
      if (dC > 0.99) { gl_FragColor = sceneColor; return; }

      // 4 neighbour offsets (cross)
      vec2 uvN = vUv + vec2(0.0,  texel.y);
      vec2 uvS = vUv + vec2(0.0, -texel.y);
      vec2 uvE = vUv + vec2( texel.x, 0.0);
      vec2 uvW = vUv + vec2(-texel.x, 0.0);
      float dEdge =
        abs(dC - readDepth(uvN)) + abs(dC - readDepth(uvS)) +
        abs(dC - readDepth(uvE)) + abs(dC - readDepth(uvW));
      dEdge = dEdge * 40.0 * depthBias;

      // --- normal edges ---
      vec3 nC = texture2D(tNormal, vUv).rgb * 2.0 - 1.0;
      vec3 nN = texture2D(tNormal, uvN).rgb * 2.0 - 1.0;
      vec3 nS = texture2D(tNormal, uvS).rgb * 2.0 - 1.0;
      vec3 nE = texture2D(tNormal, uvE).rgb * 2.0 - 1.0;
      vec3 nW = texture2D(tNormal, uvW).rgb * 2.0 - 1.0;
      float nEdge =
        (1.0 - max(dot(nC, nN), 0.0)) + (1.0 - max(dot(nC, nS), 0.0)) +
        (1.0 - max(dot(nC, nE), 0.0)) + (1.0 - max(dot(nC, nW), 0.0));
      nEdge = nEdge * normalBias;

      float edge = clamp(max(dEdge, nEdge), 0.0, 1.0);
      edge *= strength;

      vec3 outColor = mix(sceneColor.rgb, outlineColor, edge);
      gl_FragColor = vec4(outColor, sceneColor.a);
    }
  `,
};

// Objects on this layer are drawn in the beauty pass but skipped by the
// normal/depth prepass, so they get no contour outline (e.g. smoke sprites).
export const NO_OUTLINE_LAYER = 11;

export function createOutline(renderer, scene, camera) {
  camera.layers.enable(NO_OUTLINE_LAYER); // so the beauty pass still shows them
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  const w = Math.floor(size.x * pr);
  const h = Math.floor(size.y * pr);

  // Buffer that captures view-space normals (rgb) + depth texture.
  const normalRT = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  normalRT.depthTexture = new THREE.DepthTexture(w, h);
  normalRT.depthTexture.type = THREE.UnsignedIntType;

  const normalMaterial = new THREE.MeshNormalMaterial();

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const outlinePass = new ShaderPass(OutlineShader);
  outlinePass.uniforms.tNormal.value = normalRT.texture;
  outlinePass.uniforms.tDepth.value = normalRT.depthTexture;
  outlinePass.uniforms.resolution.value.set(w, h);
  outlinePass.uniforms.cameraNear.value = camera.near;
  outlinePass.uniforms.cameraFar.value = camera.far;
  composer.addPass(outlinePass);

  function setSize(width, height) {
    composer.setSize(width, height);
    const pr2 = renderer.getPixelRatio();
    const bw = Math.floor(width * pr2);
    const bh = Math.floor(height * pr2);
    normalRT.setSize(bw, bh);
    outlinePass.uniforms.resolution.value.set(bw, bh);
  }

  function render() {
    // Pass 1: normals + depth
    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    const prevFog = scene.fog;
    scene.overrideMaterial = normalMaterial;
    scene.background = null;
    scene.fog = null;
    camera.layers.disable(NO_OUTLINE_LAYER); // keep smoke etc. out of the edge pass
    renderer.setRenderTarget(normalRT);
    renderer.clear();
    renderer.render(scene, camera);
    camera.layers.enable(NO_OUTLINE_LAYER);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    scene.fog = prevFog;
    renderer.setRenderTarget(null);

    // Pass 2: beauty + outline composite
    composer.render();
  }

  const uniforms = outlinePass.uniforms;
  return { render, setSize, uniforms };
}

import * as THREE from 'three';
import { NO_OUTLINE_LAYER } from './outline.js';

/**
 * Daytime sky: a blue gradient dome, a glowing sun and a scatter of drifting
 * clouds. Mirrors nightSky.js — everything is fog-free, sits on the
 * NO_OUTLINE_LAYER so the contour pass ignores it, writes NO depth (so world
 * geometry always draws over it), and the whole group is re-centred on the
 * camera each frame so the sky reads as infinitely far (no parallax).
 *
 * The dome's horizon is deliberately pale so it blends into the arena's white
 * fog where the 8m walls meet the sky.
 */
function cloudTexture() {
  const S = 256;
  // 1. Build the puff SHAPE as an alpha mask (union of soft radial blobs).
  const m = document.createElement('canvas'); m.width = m.height = S;
  const mx = m.getContext('2d');
  const blob = (cx, cy, r, a) => {
    const g = mx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.6, `rgba(255,255,255,${a * 0.5})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    mx.fillStyle = g;
    mx.beginPath(); mx.arc(cx, cy, r, 0, Math.PI * 2); mx.fill();
  };
  blob(128, 150, 74, 0.95); blob(84, 160, 54, 0.9); blob(172, 158, 58, 0.9);
  blob(108, 128, 48, 0.85); blob(152, 132, 44, 0.85); blob(196, 168, 40, 0.8); blob(60, 170, 38, 0.8);

  // 2. Final texture: OPAQUE WHITE rgb everywhere, alpha taken from the mask.
  // Keeping rgb white in the transparent regions stops mipmap generation (esp.
  // in Safari) from bleeding the see-through pixels' undefined/black rgb into
  // the cloud edges as coloured speckle.
  const c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, S, S);
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(m, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  return t;
}

export function createDaySky(scene, sunDir) {
  const group = new THREE.Group();
  scene.add(group);

  // --- gradient sky dome (blue zenith -> pale horizon) ---
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x2f7ad4) },     // deep sky blue overhead
      bottom: { value: new THREE.Color(0xe6eef7) },  // pale haze at the horizon
      offset: { value: 40 },
      exponent: { value: 0.9 },
    },
    vertexShader: `
      varying vec3 vP;
      void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform vec3 top; uniform vec3 bottom; uniform float offset; uniform float exponent;
      varying vec3 vP;
      void main() {
        float h = normalize(vP + vec3(0.0, offset, 0.0)).y;
        float t = pow(max(h, 0.0), exponent);
        gl_FragColor = vec4(mix(bottom, top, t), 1.0);
      }
    `,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(290, 32, 20), skyMat);
  dome.layers.set(NO_OUTLINE_LAYER);
  dome.renderOrder = -3;
  dome.frustumCulled = false;
  group.add(dome);

  // --- sun: a bright core disc + a soft additive glow, along the light dir ---
  const dir = (sunDir ? sunDir.clone() : new THREE.Vector3(0.5, 0.8, 0.34)).normalize();
  const sunPos = dir.multiplyScalar(250);

  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,247,214,0.95)');
    g.addColorStop(0.3, 'rgba(255,238,176,0.55)');
    g.addColorStop(1, 'rgba(255,236,160,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xfff3c8, transparent: true, opacity: 0.9,
    depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  }));
  glow.scale.setScalar(90);
  glow.position.copy(sunPos);
  glow.renderOrder = -2;
  glow.layers.set(NO_OUTLINE_LAYER);
  group.add(glow);

  const core = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xfffdf3, transparent: true, opacity: 1,
    depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  }));
  core.scale.setScalar(34);
  core.position.copy(sunPos);
  core.renderOrder = -2;
  core.layers.set(NO_OUTLINE_LAYER);
  group.add(core);

  // --- clouds: soft billboards drifting slowly across the upper sky ---
  const cloudTex = cloudTexture();
  const clouds = [];
  const CLOUD_COUNT = 14;
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: cloudTex, color: 0xffffff, transparent: true,
      opacity: 0.72 + Math.random() * 0.2, depthWrite: false, fog: false,
    }));
    const w = 60 + Math.random() * 70;
    spr.scale.set(w, w * (0.5 + Math.random() * 0.15), 1);
    spr.renderOrder = -1;
    spr.layers.set(NO_OUTLINE_LAYER);
    group.add(spr);
    clouds.push({
      spr,
      a: Math.random() * Math.PI * 2,            // azimuth
      rad: 150 + Math.random() * 110,            // distance from centre
      y: 70 + Math.random() * 80,                // height in the sky
      speed: (0.006 + Math.random() * 0.012) * (Math.random() < 0.5 ? 1 : -1),
    });
  }
  const place = (cl) => cl.spr.position.set(Math.cos(cl.a) * cl.rad, cl.y, Math.sin(cl.a) * cl.rad);
  for (const cl of clouds) place(cl);

  return {
    group,
    update(dt, camera) {
      if (!group.visible) return;
      group.position.copy(camera.position); // keep the sky centred → feels infinite
      for (const cl of clouds) { cl.a += cl.speed * dt; place(cl); }
    },
  };
}

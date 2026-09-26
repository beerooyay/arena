import * as THREE from 'three';
import { NO_OUTLINE_LAYER } from './outline.js';

/**
 * Night sky for "Lights Out": stars + a glowing cratered moon. Everything sits
 * on the NO_OUTLINE_LAYER so the contour pass leaves it alone, and the group
 * re-centres on the camera each frame so it reads as infinitely far.
 */
function haloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.25, 'rgba(230,233,236,0.5)');
  g.addColorStop(1, 'rgba(210,214,220,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export function createNightSky(scene) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  // --- stars ---
  const N = 900, R = 190;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const u = Math.random() * Math.PI * 2;
    const phi = Math.acos(1 - Math.random() * 1.15);
    const st = R * Math.sin(phi);
    pos[i * 3] = st * Math.cos(u);
    pos[i * 3 + 1] = R * Math.cos(phi) + 30;
    pos[i * 3 + 2] = st * Math.sin(u);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xffffff, size: 1.6, sizeAttenuation: false,
    fog: false, transparent: true, opacity: 0.95, depthWrite: false,
  });
  const stars = new THREE.Points(geo, starMat);
  stars.layers.set(NO_OUTLINE_LAYER);
  stars.frustumCulled = false;
  group.add(stars);

  // --- moon ---
  const moonPos = new THREE.Vector3(-64, 96, -128);
  const MOON_R = 9;
  const moonPivot = new THREE.Group();
  moonPivot.position.copy(moonPos);
  group.add(moonPivot);

  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(MOON_R, 40, 30),
    new THREE.MeshBasicMaterial({ color: 0xeceef1, fog: false }));
  moon.layers.set(NO_OUTLINE_LAYER);
  moonPivot.add(moon);

  // a few craters so the moon isn't a blank ball
  const craterMat = new THREE.MeshBasicMaterial({ color: 0xd2d6dc, fog: false });
  for (const [cx, cy, cr] of [[2.5, 3, 1.5], [-3, -1.5, 2.1], [1.5, -3.5, 1.2], [4, -2, 1.0]]) {
    const cm = new THREE.Mesh(new THREE.CircleGeometry(cr, 18), craterMat);
    const p = new THREE.Vector3(cx, cy, MOON_R).normalize().multiplyScalar(MOON_R - 0.04);
    cm.position.copy(p); cm.lookAt(p.clone().multiplyScalar(2)); cm.layers.set(NO_OUTLINE_LAYER);
    moonPivot.add(cm);
  }

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture(), color: 0xdfe3e8, transparent: true,
    opacity: 0.6, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  }));
  halo.scale.setScalar(54);
  halo.position.copy(moonPos);
  halo.layers.set(NO_OUTLINE_LAYER);
  group.add(halo);

  let t = 0;
  return {
    group,
    update(dt, camera) {
      if (!group.visible) return;
      group.position.copy(camera.position);
      t += dt;
      starMat.opacity = 0.72 + 0.24 * Math.sin(t * 1.7);
    },
  };
}

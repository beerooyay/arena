import * as THREE from 'three';
import { NO_OUTLINE_LAYER } from './outline.js';

/**
 * Night sky for "Lights Out": stars + a glowing moon. Everything sits on the
 * NO_OUTLINE_LAYER so the contour pass leaves it alone, and the group re-centres
 * on the camera each frame so it reads as infinitely far.
 *
 * EASTER EGG: paint the moon enough times and it rotates around to reveal an
 * angry face, opens its mouth and spews paintballs onto the arena for ~10s,
 * then closes up and turns away. Hit detection + the barrage live in main.js;
 * this module owns the moon geometry, splats, the face and the state machine.
 */
function haloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.25, 'rgba(200,215,255,0.5)');
  g.addColorStop(1, 'rgba(160,190,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

// irregular paint-blob alpha for moon splats
function splatTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const blob = (cx, cy, r) => { x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill(); };
  x.fillStyle = '#fff';
  blob(64, 64, 34);
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2, d = 28 + Math.random() * 24;
    blob(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 8 + Math.random() * 12);
  }
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

  // --- moon (spins in place around moonPivot) ---
  const moonPos = new THREE.Vector3(-64, 96, -128);
  const MOON_R = 9;
  const moonPivot = new THREE.Group();
  moonPivot.position.copy(moonPos);
  group.add(moonPivot);

  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(MOON_R, 40, 30),
    new THREE.MeshBasicMaterial({ color: 0xe6ecff, fog: false }));
  moon.layers.set(NO_OUTLINE_LAYER);
  moonPivot.add(moon);

  // a few craters on the calm (+Z) side so the idle moon isn't a blank ball
  const craterMat = new THREE.MeshBasicMaterial({ color: 0xccd5ea, fog: false });
  for (const [cx, cy, cr] of [[2.5, 3, 1.5], [-3, -1.5, 2.1], [1.5, -3.5, 1.2], [4, -2, 1.0]]) {
    const cm = new THREE.Mesh(new THREE.CircleGeometry(cr, 18), craterMat);
    const p = new THREE.Vector3(cx, cy, MOON_R).normalize().multiplyScalar(MOON_R - 0.04);
    cm.position.copy(p); cm.lookAt(p.clone().multiplyScalar(2)); cm.layers.set(NO_OUTLINE_LAYER);
    moonPivot.add(cm);
  }

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTexture(), color: 0xc4d6ff, transparent: true,
    opacity: 0.6, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
  }));
  halo.scale.setScalar(54);
  halo.position.copy(moonPos);
  halo.layers.set(NO_OUTLINE_LAYER);
  group.add(halo);

  // --- angry face on the -Z hemisphere (hidden until the moon turns around) ---
  const face = new THREE.Group();
  moonPivot.add(face);
  const darkM = new THREE.MeshBasicMaterial({ color: 0x141a26, fog: false });
  const whiteM = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
  const FZ = -(MOON_R - 0.2); // surface on the -Z side
  const faceAdd = (m, x, y, z, rz = 0) => {
    m.position.set(x, y, z); m.rotation.z = rz; m.layers.set(NO_OUTLINE_LAYER); face.add(m); return m;
  };
  for (const sx of [-1, 1]) {
    const eye = faceAdd(new THREE.Mesh(new THREE.SphereGeometry(1.7, 20, 16), whiteM), sx * 3.1, 1.7, FZ);
    eye.scale.z = 0.45;
    faceAdd(new THREE.Mesh(new THREE.SphereGeometry(0.85, 16, 12), darkM), sx * 2.9, 1.5, FZ - 0.9); // pupil (glaring inward)
    faceAdd(new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.0, 0.7), darkM), sx * 2.9, 3.6, FZ - 0.5, sx * 0.6); // angry brow
  }
  // mouth — a flat dark cavity hugging the surface; scale.y opens it like a jaw
  const mouth = faceAdd(new THREE.Mesh(new THREE.SphereGeometry(2.2, 24, 18), darkM), 0, -3.0, FZ + 0.2);
  mouth.scale.set(1.3, 0.14, 0.35);
  // a few jagged teeth on the upper lip
  for (const sx of [-1.3, 0, 1.3]) {
    const tooth = faceAdd(new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.8, 4), whiteM), sx, -2.15, FZ - 0.2);
    tooth.rotation.x = Math.PI;
  }

  // orientation: the face (-Z local) turns toward the camera when active. Because
  // the whole group re-centres on the camera, the moon->camera direction is a
  // CONSTANT (-moonPos), so idle/active are two fixed quaternions we slerp between.
  // Use lookAt (with world-up) so the face stays UPRIGHT, not rolled.
  const camDir = moonPos.clone().negate().normalize();
  const _aim = new THREE.Object3D();
  _aim.up.set(0, 1, 0);
  _aim.position.copy(moonPos);
  _aim.lookAt(moonPos.clone().sub(camDir));        // face turns toward the camera, upright
  const activeQuat = _aim.quaternion.clone();
  _aim.lookAt(moonPos.clone().add(camDir));        // idle: calm crater side toward the camera
  const idleQuat = _aim.quaternion.clone();
  moonPivot.quaternion.copy(idleQuat);

  const splatTex = splatTexture();
  const splats = [];

  // state machine: idle -> reveal -> fire (~10s) -> hide -> idle
  const HIT_THRESHOLD = 8, FIRE_SECONDS = 10;
  let hits = 0, state = 'idle', revealT = 0, fireT = 0, mouthOpen = 0, t = 0;
  const _v = new THREE.Vector3(), _oc = new THREE.Vector3(), _inv = new THREE.Matrix4();

  function clearSplats() {
    for (const s of splats) { if (s.parent) s.parent.remove(s); s.geometry.dispose(); s.material.dispose(); }
    splats.length = 0;
  }
  function placeSplat(local, hex) {
    const spl = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4),
      new THREE.MeshBasicMaterial({ map: splatTex, color: hex, transparent: true, depthWrite: false, fog: false, toneMapped: false }));
    spl.position.copy(local);
    spl.lookAt(local.clone().multiplyScalar(2));
    spl.rotateZ(Math.random() * Math.PI * 2);
    spl.layers.set(NO_OUTLINE_LAYER);
    spl.renderOrder = 2;
    moonPivot.add(spl);
    splats.push(spl);
    if (splats.length > 40) { const o = splats.shift(); if (o.parent) o.parent.remove(o); o.geometry.dispose(); o.material.dispose(); }
  }

  return {
    group,
    moon,
    moonRadius: MOON_R,
    hitThreshold: HIT_THRESHOLD,
    get hits() { return hits; },
    get active() { return state !== 'idle'; },
    /** true only while the mouth is open and spewing */
    get firing() { return state === 'fire' && mouthOpen > 0.4; },

    /** World-space centre of the moon (it tracks the camera). */
    getMoonWorld(out = new THREE.Vector3()) { return out.copy(moonPos).add(group.position); },
    /** World-space mouth position (barrage origin). */
    mouthWorld(out = new THREE.Vector3()) { moonPivot.updateWorldMatrix(true, false); return mouth.getWorldPosition(out); },

    /** Does a ray (origin + t*dir) point at the moon? Used to gate moon shots. */
    aimHitsMoon(origin, dir) {
      if (!group.visible || state !== 'idle') return false;
      this.getMoonWorld(_v);
      _oc.subVectors(origin, _v);
      const b = _oc.dot(dir);
      const c = _oc.dot(_oc) - (MOON_R + 2) * (MOON_R + 2);
      const disc = b * b - c;
      return disc >= 0 && (-b + Math.sqrt(disc)) > 0; // sphere is in front
    },

    /** Splat the moon at a world point; returns the moon-LOCAL point (to relay). */
    hitMoon(worldPoint, hex) {
      moonPivot.updateWorldMatrix(true, false);
      const local = _v.copy(worldPoint).applyMatrix4(_inv.copy(moonPivot.matrixWorld).invert());
      local.normalize().multiplyScalar(MOON_R - 0.05);
      placeSplat(local, hex);
      return [+local.x.toFixed(2), +local.y.toFixed(2), +local.z.toFixed(2)];
    },
    /** Splat at a given moon-local point (for network-relayed hits from peers). */
    hitMoonLocal(p, hex) { placeSplat(_v.set(p[0], p[1], p[2]), hex); },

    /** Count a moon hit. Returns true on the hit that triggers the easter egg. */
    registerHit() {
      if (state !== 'idle') return false;
      hits++;
      if (hits >= HIT_THRESHOLD) { state = 'reveal'; revealT = 0; return true; }
      return false;
    },

    /** Force the egg to wake (network-triggered by the host in multiplayer). */
    wake() { if (state === 'idle') { state = 'reveal'; revealT = 0; } },

    /** Force back to a calm idle moon (e.g. when leaving night mode). */
    resetEgg() { state = 'idle'; hits = 0; revealT = 0; mouthOpen = 0; fireT = 0; clearSplats(); moonPivot.quaternion.copy(idleQuat); mouth.scale.y = 0.14; },

    update(dt, camera) {
      if (!group.visible) return;
      group.position.copy(camera.position);
      t += dt;
      starMat.opacity = 0.72 + 0.24 * Math.sin(t * 1.7);

      if (state === 'reveal') {
        revealT = Math.min(1, revealT + dt / 1.6);
        if (revealT >= 1) { state = 'fire'; fireT = FIRE_SECONDS; }
      } else if (state === 'fire') {
        mouthOpen = Math.min(1, mouthOpen + dt * 4);
        fireT -= dt;
        if (fireT <= 0) state = 'hide';
      } else if (state === 'hide') {
        mouthOpen = Math.max(0, mouthOpen - dt * 4);
        if (mouthOpen <= 0.02) {
          revealT = Math.max(0, revealT - dt / 1.6);
          if (revealT <= 0) { state = 'idle'; hits = 0; clearSplats(); }
        }
      }
      moonPivot.quaternion.copy(idleQuat).slerp(activeQuat, revealT);
      mouth.scale.y = 0.14 + mouthOpen * 0.7; // jaw drop
    },
  };
}

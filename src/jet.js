import * as THREE from 'three';
import { NO_OUTLINE_LAYER } from './outline.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Jet — a player-flown fighter (free-play air support).
 *
 * Clean low-poly airframe in the same white/grey marker palette with a team
 * accent: swept delta wings, twin tail fins, a tinted canopy, afterburner
 * nozzles and wing-root machine-gun muzzles.
 *
 * Control model (driven from main.js while flying):
 *   - it always flies forward along its nose
 *   - the nose eases toward where you LOOK (mouse), banking into the turn
 *   - throttle (W/S) trims speed between a floor and a max
 *   - a 3rd-person chase camera trails behind and above
 *
 * The nose points along local +Z (same convention as the tank barrel), so the
 * orientation basis maps +Z → flight direction.
 */
export class Jet {
  constructor(scene, teamId = 0) {
    this.scene = scene;
    this.teamId = teamId;
    this.hex = teamId === 1 ? 0xff3b3b : 0x2f7bff;

    // --- flight tunables (public for the dev panel) ---
    this.minSpeed = 18;
    this.cruiseSpeed = 34;
    this.maxSpeed = 66;
    this.accel = 26;           // m/s^2 speed change toward the throttle target
    this.turnRate = 2.4;       // rad/s the nose steers toward the look direction
    this.bankGain = 2.6;       // how hard it rolls into a turn
    this.maxBank = 1.05;       // rad — max visual roll
    this.rollEase = 5;         // how fast the bank blends

    // camera rig — 3rd-person chase offset in the jet's own frame:
    //   camX = side (right +), camY = up, camZ = distance BEHIND the tail
    this.camX = 0;
    this.camY = 4.2;
    this.camZ = 12;
    this.camEase = 6;

    // gun / bombs
    this.mgSpeed = 150;
    this.fireInterval = 70;    // ms between MG rounds (rapid)
    this._lastMg = 0;
    this._mgSide = 1;          // alternate wing muzzles
    this.bombInterval = 900;   // ms between cluster drops
    this._lastBomb = 0;

    // --- state ---
    this.pos = new THREE.Vector3();
    this.dir = new THREE.Vector3(0, 0, 1);
    this.speed = this.cruiseSpeed;
    this.roll = 0;
    this.throttle = 0;         // -1..1 for the HUD
    this.alive = false;

    // scratch
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._r2 = new THREE.Vector3();
    this._u2 = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._camRay = new THREE.Raycaster();
    this._camHit = new THREE.Vector3();

    this._build();
    this.root.visible = false;
    scene.add(this.root);

    // afterburner + debris pools
    this._buildBurners(scene);
    this._buildDebris(scene);
  }

  _build() {
    this.root = new THREE.Group();

    const body = new THREE.MeshStandardMaterial({ color: 0xd2d7dd, roughness: 0.5, metalness: 0 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x8b9098, roughness: 0.7, metalness: 0 });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x2a3340, roughness: 0.15, metalness: 0, transparent: true, opacity: 0.6,
    });
    this._accent = new THREE.MeshStandardMaterial({
      color: this.hex, roughness: 0.45, metalness: 0,
      emissive: new THREE.Color(this.hex), emissiveIntensity: 0.25,
    });
    this.materials = [body, dark, glass, this._accent];

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = this.root) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
      m.castShadow = true; m.receiveShadow = false;
      parent.add(m); return m;
    };

    // --- fuselage: slim, tapered, slightly flattened body along +Z ---
    const fuse = add(new THREE.CylinderGeometry(0.30, 0.42, 3.6, 18), body, 0, 0, 0.0, Math.PI / 2);
    fuse.scale.set(1, 0.78, 1);
    // long pointed nose (flattened to match the fuselage, accent-coloured)
    const nose = add(new THREE.ConeGeometry(0.30, 1.7, 18), this._accent, 0, 0, 2.55, Math.PI / 2);
    nose.scale.set(1, 0.78, 1);
    // dorsal spine strake blending nose into the body
    add(new THREE.BoxGeometry(0.16, 0.12, 2.2), dark, 0, 0.2, 0.2);
    // rear exhaust housing
    add(new THREE.CylinderGeometry(0.42, 0.30, 0.9, 18), dark, 0, 0, -2.05, Math.PI / 2);

    // --- canopy: sleek tinted bubble just behind the nose ---
    const canopy = add(new THREE.SphereGeometry(0.30, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), glass, 0, 0.24, 0.85);
    canopy.scale.set(0.85, 0.8, 2.2);

    // --- delta wings (swept back) ---
    const wingGeo = new THREE.BoxGeometry(2.9, 0.08, 1.5);
    for (const side of [-1, 1]) {
      const wing = add(wingGeo, body, side * 1.55, -0.04, -0.35);
      wing.rotation.y = side * 0.42;   // sweep
      wing.rotation.z = side * -0.06;  // slight dihedral
      // wingtip accent + MG pod
      add(new THREE.BoxGeometry(0.5, 0.12, 0.6), this._accent, side * 2.75, -0.02, -0.75);
      // MG barrel poking forward from the wing root
      add(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 10), dark, side * 0.55, -0.05, 1.25, Math.PI / 2);
    }

    // --- tail: horizontal stabilizers + twin canted fins ---
    for (const side of [-1, 1]) {
      const stab = add(new THREE.BoxGeometry(1.1, 0.07, 0.7), body, side * 0.7, 0, -1.9);
      stab.rotation.y = side * 0.3;
      const fin = add(new THREE.BoxGeometry(0.08, 0.9, 0.8), body, side * 0.42, 0.42, -1.85);
      fin.rotation.z = side * 0.35; // canted outward (V-tail look)
      add(new THREE.BoxGeometry(0.09, 0.34, 0.3), this._accent, side * 0.62, 0.74, -1.95, 0, 0, side * 0.35);
    }

    // --- engine nozzles (afterburner anchors) ---
    this._nozzleLocal = [];
    for (const side of [-0.28, 0.28]) {
      add(new THREE.CylinderGeometry(0.22, 0.26, 0.35, 14), dark, side, 0, -2.2, Math.PI / 2);
      this._nozzleLocal.push(new THREE.Vector3(side, 0, -2.45));
    }

    // wing-root MG muzzle tips (local), for spawning paint rounds
    this._muzzleLocal = [new THREE.Vector3(-0.55, -0.05, 1.75), new THREE.Vector3(0.55, -0.05, 1.75)];
    // belly hardpoint where cluster bombs release
    this._bombLocal = new THREE.Vector3(0, -0.4, -0.2);
  }

  _buildBurners(scene) {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.35, 'rgba(120,190,255,0.6)');
    g.addColorStop(1, 'rgba(80,150,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    this._burners = [];
    for (let i = 0; i < 2; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, color: 0x9fd0ff, transparent: true, opacity: 0.9,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      }));
      s.layers.set(NO_OUTLINE_LAYER);
      this.root.add(s);
      this._burners.push(s);
    }
  }

  _buildDebris(scene) {
    this._debris = [];
    for (let i = 0; i < 16; i++) {
      const mat = new THREE.MeshStandardMaterial({
        color: (i % 3 === 0) ? this.hex : (i % 2 ? 0xd2d7dd : 0x8b9098),
        roughness: 0.6, metalness: 0,
      });
      const s = 0.25 + Math.random() * 0.4;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.6, s * 1.4), mat);
      mesh.visible = false;
      scene.add(mesh);
      this._debris.push({ mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), age: 0, life: 0 });
    }
    this._debrisActive = false;
  }

  setColor(hex) {
    this.hex = hex;
    this._accent.color.setHex(hex);
    this._accent.emissive.setHex(hex);
  }

  spawn(x, y, z, dir) {
    this.pos.set(x, y, z);
    this.dir.copy(dir); this.dir.y *= 0.4; this.dir.normalize(); // launch mostly level
    this.speed = this.cruiseSpeed;
    this.roll = 0;
    this.alive = true;
    this.root.visible = true;
    this._orient();
  }

  /**
   * @param dt seconds
   * @param lookDir  world look direction to steer toward (camera forward)
   * @param throttleIn  -1..1 (W/S)
   */
  update(dt, lookDir, throttleIn) {
    if (!this.alive) return;

    // --- steer the nose toward the look direction, capped by the turn rate ---
    this._look.copy(lookDir).normalize();
    const maxTurn = this.turnRate * dt;
    const dot = THREE.MathUtils.clamp(this.dir.dot(this._look), -1, 1);
    const ang = Math.acos(dot);
    // signed horizontal turn (for banking): +ve = turning right
    const turnSign = Math.sign(this.dir.x * this._look.z - this.dir.z * this._look.x);
    if (ang > 1e-4) {
      const t = Math.min(1, maxTurn / ang);
      this.dir.lerp(this._look, t).normalize();
    }

    // --- bank into the turn ---
    const turnAmt = Math.min(ang, maxTurn) / Math.max(dt, 1e-4); // rad/s actually turning
    const bankTarget = THREE.MathUtils.clamp(-turnSign * turnAmt * this.bankGain * 0.15, -this.maxBank, this.maxBank);
    this.roll += (bankTarget - this.roll) * Math.min(1, dt * this.rollEase);

    // --- throttle / speed ---
    this.throttle = throttleIn;
    const targetSpeed = throttleIn > 0 ? THREE.MathUtils.lerp(this.cruiseSpeed, this.maxSpeed, throttleIn)
      : throttleIn < 0 ? THREE.MathUtils.lerp(this.cruiseSpeed, this.minSpeed, -throttleIn)
      : this.cruiseSpeed;
    this.speed += THREE.MathUtils.clamp(targetSpeed - this.speed, -this.accel * dt, this.accel * dt);

    // --- integrate position ---
    this.pos.addScaledVector(this.dir, this.speed * dt);
    if (this.pos.y < 2) this.pos.y = 2; // never dive into the floor
    this._orient();

    // afterburner grows with throttle/speed
    const glow = 0.7 + 0.5 * Math.max(0, (this.speed - this.cruiseSpeed) / (this.maxSpeed - this.cruiseSpeed));
    for (let i = 0; i < this._burners.length; i++) {
      const b = this._burners[i];
      b.position.copy(this._nozzleLocal[i]);
      b.scale.setScalar(0.6 * glow + 0.15 * Math.sin(performance.now() / 40 + i));
      b.material.opacity = 0.85 * glow;
    }
  }

  _orient() {
    const f = this.dir;
    this._right.crossVectors(WORLD_UP, f);
    if (this._right.lengthSq() < 1e-5) this._right.set(1, 0, 0);
    this._right.normalize();
    this._up.crossVectors(f, this._right).normalize();
    const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
    this._r2.copy(this._right).multiplyScalar(cr).addScaledVector(this._up, sr);
    this._u2.copy(this._up).multiplyScalar(cr).addScaledVector(this._right, -sr);
    this._m.makeBasis(this._r2, this._u2, f);
    this.root.quaternion.setFromRotationMatrix(this._m);
    this.root.position.copy(this.pos);
  }

  /** World positions of the two MG muzzles + the shared forward direction. */
  getMuzzle() {
    this.root.updateWorldMatrix(true, false);
    this._mgSide *= -1;
    const local = this._muzzleLocal[this._mgSide > 0 ? 0 : 1];
    const origin = this._v.copy(local).applyMatrix4(this.root.matrixWorld).clone();
    return { origin, dir: this.dir.clone() };
  }

  /** World release point for a cluster bomb. */
  getBombPoint() {
    this.root.updateWorldMatrix(true, false);
    return this._v.copy(this._bombLocal).applyMatrix4(this.root.matrixWorld).clone();
  }

  canFireMg(now) { return now - this._lastMg >= this.fireInterval; }
  markMg(now) { this._lastMg = now; }
  canDropBomb(now) { return now - this._lastBomb >= this.bombInterval; }
  markBomb(now) { this._lastBomb = now; }

  /** 3rd-person chase camera: trail behind + above the jet, look stays free. */
  updateCamera(camera, dt) {
    // offset in the jet's frame: behind along -nose (camZ), side (camX), up (camY).
    // this._right is the horizontal right vector set during _orient().
    const behind = this._v.copy(this.pos)
      .addScaledVector(this.dir, -this.camZ)
      .addScaledVector(this._right, this.camX);
    behind.y += this.camY;

    // pull in if a wall is between the jet and the camera spot
    const toCam = this._look.subVectors(behind, this.pos);
    const dist = toCam.length();
    if (dist > 0.01) {
      toCam.multiplyScalar(1 / dist);
      this._camRay.set(this.pos, toCam);
      let closest = dist;
      for (const box of (this.arenaBlockers || [])) {
        if (this._camRay.ray.intersectBox(box, this._camHit)) {
          const d = this._camHit.distanceTo(this.pos);
          if (d < closest) closest = d;
        }
      }
      if (closest < dist) behind.copy(this.pos).addScaledVector(toCam, Math.max(2, closest - 0.6));
    }
    if (behind.y < 2.4) behind.y = 2.4;
    camera.position.lerp(behind, Math.min(1, dt * this.camEase));
  }

  /** Blow the airframe into tumbling debris; hide the intact jet. */
  explode() {
    this.alive = false;
    this.root.visible = false;
    for (const b of this._burners) b.material.opacity = 0;
    for (const d of this._debris) {
      d.mesh.position.copy(this.pos).add(new THREE.Vector3(
        (Math.random() - 0.5) * 1.5, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.5));
      d.vel.set((Math.random() - 0.5) * 14, 3 + Math.random() * 9, (Math.random() - 0.5) * 14)
        .addScaledVector(this.dir, this.speed * 0.35);
      d.spin.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12);
      d.age = 0; d.life = 2.2 + Math.random() * 1.2;
      d.mesh.visible = true;
    }
    this._debrisActive = true;
  }

  /** Advance tumbling debris (called every frame; cheap no-op when idle). */
  updateDebris(dt) {
    if (!this._debrisActive) return;
    let any = false;
    for (const d of this._debris) {
      if (!d.mesh.visible) continue;
      d.age += dt;
      if (d.age >= d.life) { d.mesh.visible = false; continue; }
      any = true;
      d.vel.y -= 24 * dt;             // gravity
      d.vel.multiplyScalar(1 - 0.25 * dt);
      d.mesh.position.addScaledVector(d.vel, dt);
      if (d.mesh.position.y < 0.2) { d.mesh.position.y = 0.2; d.vel.y = Math.abs(d.vel.y) * 0.35; d.vel.multiplyScalar(0.6); }
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
    }
    this._debrisActive = any;
  }

  hide() {
    this.alive = false;
    this.root.visible = false;
    for (const b of this._burners) b.material.opacity = 0;
  }
}

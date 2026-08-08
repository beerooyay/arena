import * as THREE from 'three';
import { NO_OUTLINE_LAYER } from './outline.js';

const DOWN = new THREE.Vector3(0, -1, 0);

/**
 * Tank — a drivable paintball tank.
 *
 * Model: hull + two tracks (scrolling tread texture) with rolling road wheels,
 * a turret that traverses a full 360 degrees, and a barrel that elevates.
 *
 * Control model (wired from main.js while "driving"):
 *   - forward/turn drive the hull (WASD)
 *   - an aim direction (from the mouse-look camera) is what the turret + barrel
 *     traverse toward, each at its own tunable speed, so the turret lags like a
 *     real one and the shot leaves along the barrel, not the crosshair
 *   - the camera is placed by the tank: 3rd-person chase, or a zoomed gunner
 *     view with the barrel in frame
 *
 * All the feel values are public so the dev panel can tune them live.
 */

function treadTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#26292d'; x.fillRect(0, 0, 64, 64);
  x.fillStyle = '#474b52';
  for (let i = 0; i < 8; i++) x.fillRect(0, i * 8, 64, 4);   // track links
  x.fillStyle = '#1c1e21';
  for (let i = 0; i < 8; i++) x.fillRect(0, i * 8 + 5, 64, 2); // shadow line
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 5);
  return t;
}

function smokeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Tank {
  constructor(scene, arena, teamId = 0) {
    this.scene = scene;
    this.arena = arena;
    this.teamId = teamId;
    this.hex = teamId === 1 ? 0xff3b3b : 0x2f7bff;

    // armor / life
    this.maxHp = 40;
    this.hp = 40;
    this.alive = true;
    this.respawnAt = 0;
    this._spawn = { x: 0, z: 0, heading: 0 };

    // --- tunables (dev panel; defaults hardcoded from live tuning) ---
    this.driveSpeed = 16;      // m/s forward
    this.reverseSpeed = 8;
    this.turnSpeed = 1.5;      // rad/s hull turn
    this.turretTraverse = 2.8; // rad/s turret yaw toward aim
    this.barrelTraverse = 4;   // rad/s barrel pitch toward aim
    this.barrelMin = -0.10;    // rad (down)
    this.barrelMax = 0.40;     // rad (up)
    this.accel = 22;           // m/s^2 (how fast it reaches drive speed)

    // camera rig (aim-space offsets)
    this.cam3rdDist = 5.5;
    this.cam3rdHeight = 4;
    this.camZoomDist = 0;
    this.camZoomHeight = 0.6;
    this.camZoomSide = 0.9;

    // projectile (big paintball + big splat)
    this.projSpeed = 160;
    this.projGravity = -6;     // per-shell gravity drop (0 = flat, more negative = drops faster)
    this.projRadius = 0.42;
    this.splatScale = 2.5;
    this.fireInterval = 2100;  // ms between shots
    this._lastShot = 0;

    // feel / audio (defaults hardcoded from live tuning)
    this.turretVolume = 0.15;  // turret + barrel traverse servo sound
    this.recoilAmount = 1;     // how far the barrel jolts back per shot (metres)
    this.zoomFov = 56;         // FOV while zoomed (bigger = wider view)
    this._recoil = 0;          // 1 right after a shot, eases to 0

    // boost (limited sprint with a cooldown)
    this.boostMult = 1.9;      // drive-speed multiplier while boosting
    this.boostDuration = 2.2;  // seconds a boost lasts
    this.boostCooldown = 6;    // seconds before it can be used again
    this._boosting = false;
    this._boostT = 0;          // remaining boost seconds
    this._boostCd = 0;         // remaining cooldown seconds
    this.boostReady = true;    // for the HUD
    this.boostFrac = 1;        // 0..1 fill for the HUD

    // --- state ---
    this.heading = 0;          // hull yaw
    this.speed = 0;
    this.turretYaw = 0;        // local to hull
    this.barrelPitch = 0.12;
    this._trackScroll = 0;
    this.pos = new THREE.Vector3(0, 0, 0);
    this._radius = 1.5;        // collision radius vs walls (hugs objects, not caught far off)
    this.enabled = false;

    // vertical physics — the tank follows the ground, climbs ramps, and launches
    // off their crests with real ballistic momentum
    this.velY = 0;
    this.onGround = true;
    this.gravity = -26;        // ramp-jump gravity (less negative = more hang time)
    this.maxLaunch = 22;       // cap on ramp launch speed (m/s)
    this.launchBoost = 2.2;    // how hard a ramp flings the tank (scales with drive speed)
    this.pitch = 0;            // hull tilt to match the slope (radians)
    this._climbV = 0;          // peak climb speed while on a ramp, spent on the launch
    this._prevGroundY = 0;
    this._groundRay = new THREE.Raycaster();
    this._groundRay.far = 260;
    this._groundOrigin = new THREE.Vector3();

    this._build();
    this.root.visible = false;
    scene.add(this.root);

    // --- exhaust smoke (world-space sprite pool so puffs trail behind) ---
    const smokeTex = smokeTexture();
    this.smoke = [];
    for (let i = 0; i < 20; i++) {
      const mat = new THREE.SpriteMaterial({
        map: smokeTex, color: 0x4a4d52, transparent: true,
        opacity: 0, depthWrite: false,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      s.layers.set(NO_OUTLINE_LAYER); // no contour box around the smoke
      scene.add(s);
      this.smoke.push({ sprite: s, age: 0, life: 1, size0: 0.3, vel: new THREE.Vector3() });
    }
    this._smokeAcc = 0;

    // --- black damage smoke (pours from the hull as armor drops) ---
    this.dmgSmoke = [];
    for (let i = 0; i < 26; i++) {
      const mat = new THREE.SpriteMaterial({
        map: smokeTex, color: 0x121317, transparent: true,
        opacity: 0, depthWrite: false,
      });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      s.layers.set(NO_OUTLINE_LAYER);
      scene.add(s);
      this.dmgSmoke.push({ sprite: s, age: 0, life: 1, size0: 0.6, o0: 0.6, vel: new THREE.Vector3() });
    }
    this._dmgAcc = 0;
    this.dmgSmokeMul = 1; // dev-tunable: how much black smoke pours out when hurt

    // paint decals stuck to the hull (move with the tank)
    this._splats = [];
    this._invMat = new THREE.Matrix4();

    // scratch
    this._v = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._camRay = new THREE.Raycaster();
    this._camHit = new THREE.Vector3();
    this._pivot = new THREE.Vector3();
  }

  _build() {
    this.root = new THREE.Group();
    this.root.rotation.order = 'YXZ'; // yaw (heading) then pitch (ramp tilt)

    const hullMat = new THREE.MeshStandardMaterial({ color: 0xcfd3d8, roughness: 0.6, metalness: 0 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x8b9098, roughness: 0.7, metalness: 0 });
    const accent = new THREE.MeshStandardMaterial({
      color: this.hex, roughness: 0.5, metalness: 0,
      emissive: new THREE.Color(this.hex), emissiveIntensity: 0.2,
    });
    this._accent = accent;

    // --- hull (slightly tapered top) ---
    const hull = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.7, 4.2), hullMat);
    hull.position.y = 1.15; hull.castShadow = true; hull.receiveShadow = true;
    const glacis = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.5, 1.0), hullMat);
    glacis.position.set(0, 0.95, 2.0); glacis.rotation.x = -0.5; glacis.castShadow = true;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.25, 3.0), darkMat);
    deck.position.y = 1.55;
    this.root.add(hull, glacis, deck);

    // exhaust pipe (rear-left, angled up/back) — smoke puffs spawn at its tip
    const exhaustMat = new THREE.MeshStandardMaterial({ color: 0x55585d, roughness: 0.85, metalness: 0 });
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.7, 12), exhaustMat);
    pipe.position.set(-1.05, 1.35, -1.9);
    pipe.rotation.x = -0.5;
    this.root.add(pipe);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.13, 0.12, 12), darkMat);
    cap.position.set(-1.05, 1.68, -2.06);
    cap.rotation.x = -0.5;
    this.root.add(cap);
    this._exhaustLocal = new THREE.Vector3(-1.05, 1.75, -2.15); // tip, local to hull

    // --- tracks + road wheels ---
    this.trackMats = [];
    this.wheels = [];
    for (const side of [-1, 1]) {
      const tex = treadTexture();
      const tMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 });
      this.trackMats.push({ mat: tMat, tex });
      // track belt (long slab down each side)
      const track = new THREE.Mesh(new THREE.BoxGeometry(0.62, 1.0, 4.6), tMat);
      track.position.set(side * 1.5, 0.5, 0);
      track.castShadow = true; track.receiveShadow = true;
      this.root.add(track);
      // fender over the top of the track
      const fender = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.12, 4.4), darkMat);
      fender.position.set(side * 1.5, 1.02, 0);
      this.root.add(fender);
      // road wheels — cylinder axis baked to X so mesh.rotation.x rolls them
      const wGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.5, 18);
      wGeo.rotateZ(Math.PI / 2);
      for (let i = 0; i < 5; i++) {
        const w = new THREE.Mesh(wGeo, darkMat);
        w.position.set(side * 1.55, 0.42, -1.7 + i * 0.85);
        w.castShadow = true;
        this.root.add(w);
        this.wheels.push(w);
      }
      // drive sprocket + idler (a touch bigger, at the ends)
      for (const z of [-2.1, 2.1]) {
        const s = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.52, 18), darkMat);
        s.geometry.rotateZ(Math.PI / 2);
        s.position.set(side * 1.55, 0.5, z);
        this.root.add(s);
        this.wheels.push(s);
      }
    }

    // --- turret (rotates 360) ---
    this.turret = new THREE.Group();
    this.turret.position.y = 1.58; // seated onto the deck (no gap above the hull)
    this.root.add(this.turret);
    // wide mount ring at the base bridges the turret to the deck
    const mountRing = new THREE.Mesh(new THREE.CylinderGeometry(1.16, 1.28, 0.24, 20), darkMat);
    mountRing.position.y = 0.04; mountRing.castShadow = true;
    const turretBody = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.2, 0.7, 20), hullMat);
    turretBody.position.y = 0.35; turretBody.castShadow = true;
    const turretRear = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.55, 1.1), hullMat);
    turretRear.position.set(0, 0.35, -0.95); turretRear.castShadow = true;
    const cupola = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 0.3, 16), darkMat);
    cupola.position.set(0.45, 0.78, -0.2);
    const teamStripe = new THREE.Mesh(new THREE.CylinderGeometry(1.06, 1.21, 0.14, 20), accent);
    teamStripe.position.y = 0.35;
    this.turret.add(mountRing, turretBody, turretRear, cupola, teamStripe);

    // --- barrel (elevates) — pivots at the turret front ---
    this.barrelPivot = new THREE.Group();
    this.barrelPivot.position.set(0, 0.35, 0.9);
    this.turret.add(this.barrelPivot);
    const mantlet = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.5), darkMat);
    mantlet.position.z = 0.1;
    this.barrelPivot.add(mantlet);
    // barrel + muzzle live in a recoil group that slides back on every shot
    this.recoilGroup = new THREE.Group();
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 2.8, 16), darkMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = 1.5;
    const muzzleBrake = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.4, 16), accent);
    muzzleBrake.rotation.x = Math.PI / 2;
    muzzleBrake.position.z = 2.8;
    this.recoilGroup.add(barrel, muzzleBrake);
    this.barrelPivot.add(this.recoilGroup);
    this._barrelLen = 3.05; // pivot -> muzzle tip along local +Z
  }

  setColor(hex) {
    this.hex = hex;
    this._accent.color.setHex(hex);
    this._accent.emissive.setHex(hex);
  }

  spawn(x, z, heading = 0) {
    this._spawn = { x, z, heading };
    this.pos.set(x, 0, z);
    this.heading = heading;
    this.speed = 0;
    this.velY = 0;
    this.onGround = true;
    this.pitch = 0;
    this._climbV = 0;
    this._prevGroundY = 0;
    this.turretYaw = 0;
    this.barrelPitch = 0.12;
    this.hp = this.maxHp;
    this.alive = true;
    this.respawnAt = 0;
    this._clearSplats();
    this.root.position.copy(this.pos);
    this.root.rotation.y = heading;
    this.root.visible = true;
    this.enabled = true;
  }

  /** Respawn at the tank's stored spawn point (armor refilled). */
  respawn() { this.spawn(this._spawn.x, this._spawn.z, this._spawn.heading); }

  /** Apply paint damage. Returns true on the hit that destroys it. */
  takeHit(dmg = 1) {
    if (!this.alive) return false;
    this.hp -= dmg;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.hide();
      return true;
    }
    return false;
  }

  /** Bounding sphere for shell/paint hit tests. */
  hitCenter(out) { return out.set(this.pos.x, this.pos.y + 1.4, this.pos.z); }
  get hitRadius() { return 2.4; }

  /**
   * Attach a paint decal (built by paint.buildDecal against a tank mesh, in
   * WORLD space) so it sticks to the exact PART that was hit — the hull, the
   * turret, or the barrel — and moves/rotates with it. We bake the inverse of
   * that part's world transform into the geometry, then parent it there.
   * @param hitObj the mesh the decal was projected onto (from the raycast)
   */
  addSplat(decal, hitObj) {
    const target = hitObj || this.root;
    target.updateWorldMatrix(true, false);
    decal.geometry.applyMatrix4(this._invMat.copy(target.matrixWorld).invert());
    target.add(decal);
    this._splats.push(decal);
    if (this._splats.length > 30) {
      const old = this._splats.shift();
      if (old.parent) old.parent.remove(old);
      old.geometry.dispose();
      old.material.dispose();
    }
  }

  _clearSplats() {
    for (const q of this._splats) { if (q.parent) q.parent.remove(q); q.geometry.dispose(); q.material.dispose(); }
    this._splats.length = 0;
  }

  /**
   * @param dt seconds
   * @param forward -1..1 (drive)
   * @param turn    -1..1 (hull steer)
   * @param aimDir  THREE.Vector3 world aim (from the look camera)
   */
  update(dt, forward, turn, aimDir, boost = false) {
    // --- boost (limited sprint on a cooldown) ---
    this._boostCd = Math.max(0, this._boostCd - dt);
    if (this._boosting) {
      this._boostT -= dt;
      if (this._boostT <= 0) { this._boosting = false; this._boostCd = this.boostCooldown; }
    } else if (boost && this._boostCd <= 0 && forward > 0) {
      this._boosting = true; this._boostT = this.boostDuration;
    }
    this.boostReady = !this._boosting && this._boostCd <= 0;
    this.boostFrac = this._boosting ? (this._boostT / this.boostDuration)
      : (this.boostCooldown > 0 ? 1 - this._boostCd / this.boostCooldown : 1);
    const boostMul = this._boosting ? this.boostMult : 1;

    // --- drive ---
    const targetSpeed = forward > 0 ? forward * this.driveSpeed * boostMul
      : forward < 0 ? forward * this.reverseSpeed : 0;
    this.speed += THREE.MathUtils.clamp(targetSpeed - this.speed, -this.accel * dt, this.accel * dt);
    // steering (a touch stronger the faster you go, but usable when creeping)
    this.heading -= turn * this.turnSpeed * dt * (0.4 + 0.6 * Math.min(1, Math.abs(this.speed) / this.driveSpeed));

    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const dist = this.speed * dt;
    this.pos.x += fx * dist;
    this.pos.z += fz * dist;
    this._collide();
    this._updateVertical(dt, fx, fz); // ground-follow, ramp climb + launch, pitch
    this.root.position.copy(this.pos);
    this.root.rotation.set(this.pitch, this.heading, 0);

    // --- turret + barrel traverse toward the aim ---
    const prevYaw = this.turretYaw, prevPitch = this.barrelPitch;
    if (aimDir) {
      const desiredYaw = Math.atan2(aimDir.x, aimDir.z) - this.heading;   // local to hull
      this.turretYaw = approachAngle(this.turretYaw, desiredYaw, this.turretTraverse * dt);
      const desiredPitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(aimDir.y, -1, 1)),
        this.barrelMin, this.barrelMax);
      this.barrelPitch += THREE.MathUtils.clamp(desiredPitch - this.barrelPitch,
        -this.barrelTraverse * dt, this.barrelTraverse * dt);
    }
    this.turret.rotation.y = this.turretYaw;
    this.barrelPivot.rotation.x = -this.barrelPitch;
    // true while the turret/barrel is actually traversing (drives the servo sound)
    this.turretMoving = dt > 0 &&
      (Math.abs(this.turretYaw - prevYaw) / dt > 0.05 || Math.abs(this.barrelPitch - prevPitch) / dt > 0.05);

    // barrel recoil: jolts back on fire, then eases home
    this._recoil = Math.max(0, this._recoil - dt * 6);
    this.recoilGroup.position.z = -this._recoil * this.recoilAmount;

    // --- animate tracks + wheels from actual travel ---
    const roll = dist / 0.42; // wheel radius
    for (const w of this.wheels) w.rotation.x += roll;
    this._trackScroll -= dist * 0.5;
    for (const { tex } of this.trackMats) tex.offset.y = this._trackScroll;

    this._updateSmoke(dt);
  }

  _updateSmoke(dt) {
    if (!this.root.visible) return;
    for (const p of this.smoke) {
      if (!p.sprite.visible) continue;
      p.age += dt;
      if (p.age >= p.life) { p.sprite.visible = false; continue; }
      p.sprite.position.addScaledVector(p.vel, dt);
      p.vel.y += 0.4 * dt;                 // keep rising
      p.vel.multiplyScalar(1 - 0.6 * dt);  // air drag
      const t = p.age / p.life;
      const scale = p.size0 * (1 + t * 3.2);
      p.sprite.scale.set(scale, scale, scale);
      p.sprite.material.opacity = (1 - t) * 0.5;
    }
    const throttle = Math.min(1, Math.abs(this.speed) / this.driveSpeed);
    const interval = 0.30 - 0.24 * throttle; // puff faster when driving hard
    this._smokeAcc += dt;
    while (this._smokeAcc >= interval) {
      this._smokeAcc -= interval;
      this._emitSmoke(throttle);
    }

    // black damage smoke — thicker the lower the armor
    for (const p of this.dmgSmoke) {
      if (!p.sprite.visible) continue;
      p.age += dt;
      if (p.age >= p.life) { p.sprite.visible = false; continue; }
      p.sprite.position.addScaledVector(p.vel, dt);
      p.vel.y += 0.5 * dt;
      p.vel.multiplyScalar(1 - 0.4 * dt);
      const t = p.age / p.life;
      const scale = p.size0 * (1 + t * 2.6);
      p.sprite.scale.set(scale, scale, scale);
      p.sprite.material.opacity = (1 - t) * p.o0;
    }
    const dmg = this.alive ? 1 - this.hp / this.maxHp : 0;
    if (dmg > 0.25) {
      const level = Math.min(1, (dmg - 0.25) / 0.75); // 0 at 25% dmg → 1 at destroyed
      const dInterval = (0.16 - 0.11 * level) / Math.max(0.15, this.dmgSmokeMul); // more = thicker
      this._dmgAcc += dt;
      while (this._dmgAcc >= dInterval) { this._dmgAcc -= dInterval; this._emitDamageSmoke(level); }
    }
  }

  _emitDamageSmoke(level) {
    const p = this.dmgSmoke.find((s) => !s.sprite.visible);
    if (!p) return;
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    // rise from the engine deck / hull top, biased to the rear
    const lx = (Math.random() - 0.5) * 1.4;
    const lz = -0.6 + (Math.random() - 0.5) * 1.6;
    const wx = this.pos.x + lx * c + lz * s;
    const wz = this.pos.z - lx * s + lz * c;
    p.sprite.position.set(wx, this.pos.y + 1.9 + Math.random() * 0.3, wz);
    p.vel.set((Math.random() - 0.5) * 0.6, 1.1 + Math.random() * 0.8 + level * 0.6, (Math.random() - 0.5) * 0.6);
    p.age = 0;
    p.life = 1.6 + Math.random() * 1.1;
    p.size0 = 0.55 + level * 0.7 + Math.random() * 0.3;
    p.o0 = 0.4 + level * 0.5;
    p.sprite.scale.set(p.size0, p.size0, p.size0);
    p.sprite.material.opacity = p.o0;
    p.sprite.visible = true;
  }

  _emitSmoke(throttle) {
    const p = this.smoke.find((s) => !s.sprite.visible);
    if (!p) return;
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    const e = this._exhaustLocal;
    const wx = this.pos.x + e.x * c + e.z * s;
    const wz = this.pos.z - e.x * s + e.z * c;
    p.sprite.position.set(wx + (Math.random() - 0.5) * 0.1, this.pos.y + e.y, wz + (Math.random() - 0.5) * 0.1);
    p.vel.set(-s * (0.4 + throttle) + (Math.random() - 0.5) * 0.3,
      0.9 + Math.random() * 0.4,
      -c * (0.4 + throttle) + (Math.random() - 0.5) * 0.3);
    p.age = 0;
    p.life = 1.1 + Math.random() * 0.7;
    p.size0 = 0.28 + Math.random() * 0.12;
    p.sprite.scale.set(p.size0, p.size0, p.size0);
    p.sprite.material.opacity = 0.5;
    p.sprite.visible = true;
  }

  /** Highest walkable ground under a point (floor / ramp / box tops). */
  _groundHeightAt(x, z) {
    this._groundRay.set(this._groundOrigin.set(x, 200, z), DOWN);
    const hits = this._groundRay.intersectObjects(this.arena.groundMeshes, false);
    let y = 0;
    for (const h of hits) if (h.point.y > y && h.point.y < 199) y = h.point.y;
    return y;
  }

  /**
   * Ground-follow + ballistic launch. While grounded the hull rides the surface
   * height; climbing a ramp builds upward speed so cresting it flings the tank
   * into a real arc, and gravity brings it back down to land.
   */
  _updateVertical(dt, fx, fz) {
    // Sample the ground under the front and rear of the tracks (plus the centre)
    // so the hull sits ON the ramp spanning its length, instead of clipping in
    // on a single centre point.
    const L = 2.1; // half the track length
    const fG = this._groundHeightAt(this.pos.x + fx * L, this.pos.z + fz * L);
    const rG = this._groundHeightAt(this.pos.x - fx * L, this.pos.z - fz * L);
    const cG = this._groundHeightAt(this.pos.x, this.pos.z);
    const surfaceY = Math.max((fG + rG) * 0.5, cG); // belly clears a crest
    const wasGrounded = this.onGround;

    // Match the EXACT rate the surface is rising under us while grounded, so the
    // tank hugs the ramp (no floating up). A one-frame spike at the ramp foot is
    // harmless — ny still lands exactly on the surface.
    const rawClimb = Math.max(0, (surfaceY - this._prevGroundY) / Math.max(dt, 1e-4));
    this._prevGroundY = surfaceY;
    // Smooth climb potential (slope under the hull × drive speed) — what a crest
    // launch is worth, free of the foot-of-ramp spike.
    const climbPotential = Math.max(0, this.speed * (fG - rG) / (2 * L));

    this.velY += this.gravity * dt;
    if (wasGrounded) {
      this.velY = rawClimb;                          // hug the surface exactly
      this._climbV = Math.max(this._climbV, Math.min(climbPotential, this.maxLaunch));
    }
    let ny = this.pos.y + this.velY * dt;
    if (ny <= surfaceY + 0.02) {                     // still riding the surface
      ny = surfaceY;
      this.onGround = true;
      if (!wasGrounded) { this.velY = 0; this._climbV = 0; } // just landed
    } else {
      this.onGround = false;
      if (wasGrounded) {                             // drove off a crest/edge → launch
        this.velY = Math.min(this.maxLaunch, this._climbV * this.launchBoost);
        this._climbV = 0;
      }
    }
    this.pos.y = ny;

    // pitch to the slope while grounded (nose UP climbing), ease level in the
    // air. rotation.x is negative for nose-up, so front-higher → negative pitch.
    const targetPitch = this.onGround ? Math.atan2(rG - fG, 2 * L) : 0;
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * 8);
  }

  _collide() {
    // Capsule-ish: three circles along the hull's length (front / middle / rear)
    // so the whole tank body stays out of objects, not just its centre.
    const r = 1.35;                       // ~half hull width
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const samples = [-2.0, 0, 2.0];       // local Z offsets along the hull
    for (const box of this.arena.tankBlockers) {
      const minX = box.min.x - r, maxX = box.max.x + r;
      const minZ = box.min.z - r, maxZ = box.max.z + r;
      for (const sz of samples) {
        const px = this.pos.x + fx * sz, pz = this.pos.z + fz * sz;
        if (px > minX && px < maxX && pz > minZ && pz < maxZ) {
          const dL = px - minX, dR = maxX - px, dB = pz - minZ, dF = maxZ - pz;
          const m = Math.min(dL, dR, dB, dF);
          if (m === dL) this.pos.x -= dL;
          else if (m === dR) this.pos.x += dR;
          else if (m === dB) this.pos.z -= dB;
          else this.pos.z += dF;
        }
      }
    }
    const A = 57; // keep the hull inside the arena perimeter
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -A, A);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -A, A);
  }

  /** World muzzle position + forward direction, from the barrel's real pose. */
  getMuzzle() {
    this.barrelPivot.updateWorldMatrix(true, false);
    const origin = this._muzzle.set(0, 0, this._barrelLen).applyMatrix4(this.barrelPivot.matrixWorld);
    const base = this._v.set(0, 0, 0).applyMatrix4(this.barrelPivot.matrixWorld);
    const dir = this._dir.subVectors(origin, base).normalize();
    return { origin: origin.clone(), dir: dir.clone() };
  }

  canFire(now) { return now - this._lastShot >= this.fireInterval; }
  markFired(now) { this._lastShot = now; }

  /** Fire: returns the muzzle pose and triggers barrel recoil + muzzle smoke. */
  fire(now) {
    const m = this.getMuzzle();
    this._lastShot = now;
    this._recoil = 1;
    this._emitMuzzleSmoke(m.origin, m.dir);
    return m;
  }

  _emitMuzzleSmoke(origin, dir) {
    for (let i = 0; i < 6; i++) {
      const p = this.smoke.find((s) => !s.sprite.visible);
      if (!p) break;
      p.sprite.position.copy(origin).addScaledVector(dir, 0.2 + Math.random() * 0.5);
      // blast forward along the barrel with spread + a little lift
      p.vel.copy(dir).multiplyScalar(3.5 + Math.random() * 3);
      p.vel.x += (Math.random() - 0.5) * 1.6;
      p.vel.y += 0.4 + Math.random() * 1.0;
      p.vel.z += (Math.random() - 0.5) * 1.6;
      p.age = 0;
      p.life = 0.5 + Math.random() * 0.4;   // quick puff
      p.size0 = 0.35 + Math.random() * 0.3;
      p.sprite.scale.set(p.size0, p.size0, p.size0);
      p.sprite.material.opacity = 0.65;
      p.sprite.visible = true;
    }
  }

  /**
   * Position the camera: 3rd-person chase sits behind the HULL (so "forward"
   * always drives into the screen), blended toward a gunner zoom that sits
   * behind the BARREL/aim (barrel in frame). Camera rotation stays with the
   * look controls; we only move the position.
   */
  updateCamera(camera, aimDir, zoomT, dt = 0.016) {
    // Both cams orbit with where you look (aim), so the camera pivots as you
    // rotate the turret. 3rd-person trails farther/higher; zoom drops near the
    // barrel with a side offset so the barrel stays in frame.
    const aimH = new THREE.Vector3(aimDir.x, 0, aimDir.z);
    if (aimH.lengthSq() < 1e-4) aimH.set(Math.sin(this.heading), 0, Math.cos(this.heading));
    aimH.normalize();
    const right = new THREE.Vector3(aimH.z, 0, -aimH.x);
    const turretPos = new THREE.Vector3();
    this.turret.getWorldPosition(turretPos);

    const third = new THREE.Vector3(this.pos.x, this.pos.y + this.cam3rdHeight, this.pos.z)
      .addScaledVector(aimH, -this.cam3rdDist);
    const zoom = turretPos.clone()
      .add(new THREE.Vector3(0, this.camZoomHeight, 0))
      .addScaledVector(aimH, -this.camZoomDist)
      .addScaledVector(right, this.camZoomSide);

    const target = third.lerp(zoom, zoomT);

    // Wall collision: cast from a pivot on the tank out to the desired camera
    // spot; if a wall is in the way, pull the camera in front of it.
    const pivot = this._pivot.set(this.pos.x, this.pos.y + 2.0, this.pos.z);
    const toCam = this._v.subVectors(target, pivot);
    const dist = toCam.length();
    if (dist > 0.01) {
      toCam.multiplyScalar(1 / dist);
      this._camRay.set(pivot, toCam);
      let closest = dist;
      for (const box of this.arena.blockers) {
        if (this._camRay.ray.intersectBox(box, this._camHit)) {
          const d = this._camHit.distanceTo(pivot);
          if (d < closest) closest = d;
        }
      }
      if (closest < dist) target.copy(pivot).addScaledVector(toCam, Math.max(1.2, closest - 0.5));
    }
    if (target.y < 1.2) target.y = 1.2; // never dip under the floor

    camera.position.lerp(target, Math.min(1, dt * 30)); // snappy, frame-rate independent
  }

  /** Client-side: smoothly follow a networked state from the host. */
  applyNetState(x, z, ry, ty, bp, hp, alive, y) {
    this.hp = hp;
    this.alive = alive;
    if (!alive) { this.root.visible = false; return; }
    this.root.visible = true;
    const k = 0.35;
    const px = this.pos.x, pz = this.pos.z;
    this.pos.x += (x - this.pos.x) * k;
    this.pos.z += (z - this.pos.z) * k;
    if (typeof y === 'number') this.pos.y += (y - this.pos.y) * k; // follow ramp jumps
    const dh = ((ry - this.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI; this.heading += dh * k;
    const dt = ((ty - this.turretYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI; this.turretYaw += dt * k;
    this.barrelPitch += (bp - this.barrelPitch) * k;
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.heading;
    this.turret.rotation.y = this.turretYaw;
    this.barrelPivot.rotation.x = -this.barrelPitch;
    // roll wheels + scroll tracks from the interpolated forward movement
    const fwd = Math.sin(this.heading) * (this.pos.x - px) + Math.cos(this.heading) * (this.pos.z - pz);
    for (const w of this.wheels) w.rotation.x += fwd / 0.42;
    this._trackScroll -= fwd * 0.5;
    for (const { tex } of this.trackMats) tex.offset.y = this._trackScroll;
    this._updateSmoke(0.016);
  }

  hide() {
    this.root.visible = false;
    this.enabled = false;
    for (const p of this.smoke) p.sprite.visible = false;
    for (const p of this.dmgSmoke) p.sprite.visible = false;
  }
}

// shortest-path angular approach
function approachAngle(cur, target, maxStep) {
  let d = ((target - cur + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}

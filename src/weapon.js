import * as THREE from 'three';
import { buildGun, ORANGE, upgradeToRocketRifle, RR_MUZZLES, RR_TOP, RR_SCALE, RR_GRIP } from './gunModel.js';
import { makeFirstPersonArms, duration, release, hold } from './avatarRig.js';
import { muzzleFlashTexture } from './fx.js';

const _lookEuler = new THREE.Euler();

export class Weapon {
  constructor() {
    // root = FOV rig parented to the camera. Scaling it by (k, k, 1) in camera
    // space makes the viewmodel project exactly as it would at refFov, whatever
    // the player's FOV — without pushing the stock through the near plane.
    // pose = the actual hip/aim/sprint transform inside it.
    this.root = new THREE.Group();
    this.pose = new THREE.Group();
    this.root.add(this.pose);

    this.mode = 0; // 0 = rifle, 1 = rocket

    this.hipX = 0.344; this.hipY = -0.455; this.hipZ = -0.3625; // classic FPS hold: low right, downrange, stock off-frame
    this.aimX = 0.00; this.aimY = -0.195; this.aimZ = -0.3825; // ~ -0.44 × viewScale keeps the sight picture
    this.wallPull = 0;
    this.cant = 0;
    this.wallPullZ = 0.32;
    this.wallPullY = -0.05;
    this.aimFov = 38; // sniper scope fov
    this.aimSpeed = 22;
    this.aimV = 0;
    this.recoilAmount = 0.25;

    this.sprintX = 0.26; this.sprintY = -0.44; this.sprintZ = -0.4; // tucks low instead of raising the gun
    this.sprintPitch = -0.52;
    this.sprintYaw = 0.4;
    this.sprintRoll = 0.3;
    this.sprintSpeed = 11;   // ease in/out, not a snap
    this.swaySpeed = 9.5;
    this.swayX = 0.045;
    this.swayY = 0.02;
    this.swayRoll = 0;

    this.slidePitch = 0.85;
    this.slideRoll = 0;
    this.slideX = 0.28;
    this.slideY = 0.04;
    this.slideZ = 0;
    this.slideBlend = 16;

    // recoil: a damped spring per channel (back, up-pitch, yaw, roll) kicked by
    // each shot; look sway: the gun lags a touch behind the camera's rotation
    this.recoil = { z: 0, vz: 0, p: 0, vp: 0, y: 0, vy: 0, r: 0, vr: 0 };
    this.recoilStiff = 180; this.recoilDamp = 17;
    this._lookPrev = null;
    this._look = { x: 0, y: 0 };
    this.lookSway = 0.9;
    this.aimT = 0;
    this.sprintT = 0;
    this.slideT = 0;
    this.swapT = 1;      // 1 = gun up; dips to 0 mid-swap
    this.reloadT = 0;    // 0..1 while a reload is in progress
    this._swapCb = null;
    this._swayPhase = 0;
    this._kick = 0;

    this.hipPitch = 0.02;  // stock stays up near the shoulder, not dipped out of frame
    this.hipYaw = 0.095;   // stock cants a touch inward — gun reads closer to the eye
    this.hipRoll = 0.06;
    this.viewScale = 1.45;
    this.refFov = 75;
    this.materials = [];

    this._build();
    this.throwing = 0;
    const anchor = RR_MUZZLES.top.clone().multiplyScalar(0.12)
      .applyEuler(new THREE.Euler(this.hipPitch, this.hipYaw, this.hipRoll));
    this.hipX -= anchor.x; this.hipY -= anchor.y; this.hipZ -= anchor.z;
    // swap in the authored rocket rifle once it loads (procedural gun until then)
    this._rrReady = upgradeToRocketRifle(this._gun, { keep: [this.arm, this.flash], castShadow: false }).then((ok) => {
      if (!ok) return;
      this.rr = this._gun.rr;
      this.rr.layers.mask = this._gun.group.layers.mask; // stay on the viewmodel layer
      this._muzzles = [RR_MUZZLES.top, ...RR_MUZZLES.tubes];
      this._rrAimY = -(RR_TOP + 0.012) * this.viewScale; // sight along the top line
      this.aimY = this._rrAimY;
      return true;
    });
    this.pose.scale.setScalar(this.viewScale);
    this.pose.position.set(this.hipX, this.hipY, this.hipZ);
    this.pose.rotation.set(this.hipPitch, this.hipYaw, this.hipRoll);
    this._fovComp(this.refFov);
  }

  setMode(m) {
    this.mode = m === 1 ? 1 : 0;
    this.aimFov = this.mode === 0 ? (this.zoom ?? 38) : 58;
    // rifle sights through the optic; rocket sights over the top slabs
    this.aimY = this.rr ? this._rrAimY : (this.mode === 0 ? -0.195 : -0.18);
    if (!this.rifleGroup.userData.retired) {
      this.rifleGroup.visible = this.mode === 0;
      this.rocketGroup.visible = this.mode === 1;
    }
    this._kick = 0.6;
  }

  _build() {
    const gun = buildGun();
    this.pose.add(gun.group);
    this.rifleGroup = gun.rifleGroup;
    this.rocketGroup = gun.rocketGroup;
    this.glowMats = gun.glowMats;
    this.materials.push(...gun.materials);

    // muzzle flash: additive star sprite at the firing barrel, bloom does the rest
    this._muzzles = [gun.topMuzzle, ...gun.muzzles];
    this._rocketSide = 0;
    this.flashMat = new THREE.SpriteMaterial({
      // normal blend: additive would vanish against the white arena
      map: muzzleFlashTexture(), color: ORANGE, transparent: true, opacity: 0, depthWrite: false,
    });
    this.materials.push(this.flashMat);
    this.flash = new THREE.Sprite(this.flashMat);
    this.flash.scale.setScalar(0.22);
    this.flash.renderOrder = 5;
    gun.group.add(this.flash);
    this._flashT = 0;

    // gloved trigger hand + armoured forearm running off the bottom-right edge
    const glove = new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.78, metalness: 0 });
    const plate = new THREE.MeshStandardMaterial({ color: 0x202329, roughness: 0.45, metalness: 0.15 });
    this.materials.push(glove, plate);
    const arm = new THREE.Group();
    gun.group.add(arm);
    this.arm = arm;
    this._gun = gun;
    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
      arm.add(m); return m;
    };
    add(new THREE.BoxGeometry(0.085, 0.095, 0.10), glove, 0.004, -0.095, 0.01, -0.22);      // palm around the grip
    add(new THREE.BoxGeometry(0.09, 0.03, 0.075), glove, 0.004, -0.045, -0.035, -0.1);      // knuckles
    add(new THREE.CapsuleGeometry(0.018, 0.04, 3, 8), glove, 0.02, -0.035, -0.07, 1.3);     // trigger finger
    add(new THREE.CapsuleGeometry(0.052, 0.20, 4, 10), glove, 0.045, -0.16, 0.14, 1.05, 0, -0.25);  // wrist / forearm
    add(new THREE.BoxGeometry(0.115, 0.08, 0.20), plate, 0.06, -0.19, 0.20, 1.05, 0, -0.25);   // vambrace
    add(new THREE.BoxGeometry(0.004, 0.012, 0.12), gun.glowMats[0], 0.12, -0.17, 0.19, 1.05, 0, -0.25);
  }

  /**
   * Swap the box glove for the team suit's real arms, posed on the rifle.
   * Call once the rigged avatars have loaded (and again if the team changes).
   */
  attachArms(hex) {
    return this._rrReady.then((ok) => {
      if (!ok) return false;
      const arms = makeFirstPersonArms(hex);
      if (!arms) return false;
      if (this.suitArms) { this._gun.group.remove(this.suitArms); }
      // rr geometry is baked as S(RR_SCALE) * RotY(90deg) * T(-RR_GRIP) (see
      // gunModel.js); place the suit so its rifle lands exactly on that
      const rrToGun = new THREE.Matrix4().makeScale(RR_SCALE, RR_SCALE, RR_SCALE)
        .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
        .multiply(new THREE.Matrix4().makeTranslation(-RR_GRIP.x, -RR_GRIP.y, -RR_GRIP.z));
      const m = arms.model;
      m.matrixAutoUpdate = false;
      m.matrix.copy(rrToGun).multiply(arms.rifleMatrix.clone().invert());
      m.traverse((o) => { o.layers.mask = this._gun.group.layers.mask; }); // viewmodel layer
      this._gun.group.add(m);
      this.suitArms = m;
      this.arms = arms;
      this.arm.visible = false; // retire the box glove
      return true;
    });
  }

  /** Dip the gun down, run cb at the bottom (model swap), raise it again. */
  swap(cb) { if (this._swapCb) this._swapCb(); this._swapCb = cb; }

  toss(callback, held = false) { this.throwing = duration; this.holding = held; this.release = callback; this.arms?.toss(held); }
  letgo() { this.holding = false; this.arms?.letgo(); }

  fov(base) {
    return THREE.MathUtils.radToDeg(2 * Math.atan(THREE.MathUtils.lerp(
      Math.tan(THREE.MathUtils.degToRad(base) / 2), Math.tan(THREE.MathUtils.degToRad(this.aimFov) / 2), this.aimT)));
  }

  reset() {
    this.throwing = 0; this.holding = false; this.release = null; this.aimV = 0;
    this.arms?.reset();
    this._swapCb = null;
    this.swapT = 1; this.reloadT = 0; this.aimT = 0;
    this.sprintT = 0; this.slideT = 0; this.wallPull = 0; this._kick = 0;
    for (const key of Object.keys(this.recoil)) this.recoil[key] = 0;
  }

  setNeon(on) {
    for (const m of this.glowMats) m.emissiveIntensity = m.userData.baseEmissive * (on ? 1.2 : 1);
  }

  _fovComp(fov) {
    const k = Math.tan(THREE.MathUtils.degToRad(fov) / 2) /
              Math.tan(THREE.MathUtils.degToRad(this.refFov) / 2);
    this.root.scale.set(k, k, 1);
    return k;
  }

  kick(amount = 1) {
    this._kick = amount;
    // spring impulses: shove back + muzzle climb, small random yaw/roll; much
    // lighter while aiming down sights
    const ads = 1 - 0.7 * this.aimT;
    const R = this.recoil;
    const rocket = this.mode === 1;
    R.vz += (rocket ? 3.2 : 1.2) * amount * ads;
    R.vp += (rocket ? 3.5 : 5.4) * amount * ads;
    R.vy += (rocket ? (this._rocketSide % 2 ? 0.9 : -0.9) : (Math.random() - 0.5) * 0.6) * amount * ads;
    R.vr += (rocket ? 1 : (Math.random() - 0.5) * 0.8) * amount * ads;
    // rifle fires from the top barrel; rockets alternate the lower tubes
    const m = this.mode === 0 ? this._muzzles[0] : this._muzzles[1 + (this._rocketSide++ % 2)];
    this.flash.position.copy(m);
    this.flash.material.rotation = Math.random() * Math.PI;
    this.flash.scale.setScalar(this.mode === 0 ? 0.34 + Math.random() * 0.1 : 0.5);
    this._flashT = 1;
  }

  /**
   * @param move 0..1 — player ground speed as a fraction of sprint speed; drives
   *   the walk bob (sprint has its own pose + sway)
   */
  update(dt, aiming, baseFov = 75, sprinting = false, sliding = false, move = 0, reloading = false) {
    this.throwing = Math.max(this.holding ? duration - hold : 0, this.throwing - dt);
    const gesture = Math.sin(Math.PI * this.throwing / duration);
    const target = aiming && !this.throwing && !reloading && this.swapT >= 1 ? 1 : 0;
    const error = this.aimT - target, decay = Math.exp(-this.aimSpeed * dt);
    const change = (this.aimV + this.aimSpeed * error) * dt;
    this.aimT = THREE.MathUtils.clamp(target + (error + change) * decay, 0, 1);
    this.aimV = (this.aimV - this.aimSpeed * change) * decay;
    const t = this.aimT;

    // weapon swap: dive to the bottom, swap models there, come back up
    if (this._swapCb || this.swapT < 1) {
      this.swapT = THREE.MathUtils.clamp(this.swapT + (this._swapCb ? -7 : 5.5) * dt, 0, 1);
      if (this.swapT === 0 && this._swapCb) { this._swapCb(); this._swapCb = null; }
    }
    const sw = 1 - this.swapT;
    this.reloadT += ((reloading ? 1 : 0) - this.reloadT) * Math.min(1, dt * 10);
    const rl = this.reloadT;

    const sTarget = (sprinting && !aiming) ? 1 : 0;
    this.sprintT += (sTarget - this.sprintT) * Math.min(1, dt * this.sprintSpeed);
    const s = this.sprintT;
    this._swayPhase += dt * this.swaySpeed;
    const swayPX = Math.sin(this._swayPhase) * this.swayX * s;
    const swayPY = Math.sin(this._swayPhase * 2) * this.swayY * s;
    const swayRz = Math.sin(this._swayPhase) * this.swayRoll * s;

    const slTarget = (sliding && !aiming) ? 1 : 0;
    this.slideT += (slTarget - this.slideT) * Math.min(1, dt * this.slideBlend);
    const sl = this.slideT;

    const curFov = this.fov(baseFov);
    const comp = this._fovComp(curFov);
    this.root.scale.set(comp, comp, 1);

    this._kick = Math.max(0, this._kick - dt * 6.5);
    this._flashT = Math.max(0, this._flashT - dt * 18);
    this.flashMat.opacity = this._flashT;
    const k = this._kick * this._kick * 0.014 * this.recoilAmount;

    // integrate the recoil springs (semi-implicit Euler, sub-stepped for stability)
    const R = this.recoil;
    for (let n = 0, h = Math.min(dt, 0.05) / 2; n < 2; n++) {
      for (const [x, v] of [['z', 'vz'], ['p', 'vp'], ['y', 'vy'], ['r', 'vr']]) {
        R[v] += (-this.recoilStiff * R[x] - this.recoilDamp * R[v]) * h;
        R[x] += R[v] * h;
      }
    }
    // look sway: follow camera yaw/pitch deltas with lag (the gun trails the view)
    const cam = this.root.parent;
    if (cam) {
      _lookEuler.setFromQuaternion(cam.quaternion, 'YXZ'); // yaw/pitch as the look controls define them
      const ex = _lookEuler.x, ey = _lookEuler.y;
      if (this._lookPrev) {
        let dyaw = ey - this._lookPrev.y; dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
        const dpitch = ex - this._lookPrev.x;
        const lim = 0.06;
        this._look.x = THREE.MathUtils.clamp(this._look.x - dyaw * this.lookSway, -lim, lim);
        this._look.y = THREE.MathUtils.clamp(this._look.y - dpitch * this.lookSway, -lim, lim);
      }
      this._lookPrev = { x: ex, y: ey };
      const back = Math.min(1, dt * 9);
      this._look.x -= this._look.x * back; this._look.y -= this._look.y * back;
    }
    const swayK = 1 - 0.8 * t; // steadier while aiming

    const wp = this.wallPull;
    let px = THREE.MathUtils.lerp(this.hipX, this.aimX, t);
    let py = THREE.MathUtils.lerp(this.hipY, this.aimY, t) - k * 0.35 + wp * this.wallPullY;
    let pz = THREE.MathUtils.lerp(this.hipZ, this.aimZ, t) + k * 1.8 + wp * this.wallPullZ;

    px = THREE.MathUtils.lerp(px, this.sprintX + swayPX, s);
    py = THREE.MathUtils.lerp(py, this.sprintY + swayPY, s);
    pz = THREE.MathUtils.lerp(pz, this.sprintZ, s);

    px += this.slideX * sl;
    py += this.slideY * sl;
    pz += this.slideZ * sl;
    // swap dip: the gun drops out of frame and returns with the other weapon
    px += sw * 0.06;
    py -= sw * 0.42 + gesture * 0.16;
    // reload pose: drops low and cants inboard, mag-well toward the camera
    px += rl * 0.05;
    py -= rl * 0.30;
    py = Math.max(py, this.hipY - 0.55); // never sink fully out of frame
    // walk bob (hip only, fades while aiming/sprinting) + slow breathing at rest
    this._walkPhase = (this._walkPhase || 0) + dt * (4 + move * 9);
    this._breath = (this._breath || 0) + dt;
    const hip = (1 - t) * (1 - s) * (1 - sl);
    const wb = Math.min(1, move * 1.6) * hip;
    px += Math.sin(this._walkPhase) * 0.009 * wb;
    py += -Math.abs(Math.cos(this._walkPhase)) * 0.012 * wb + Math.sin(this._breath * 1.7) * 0.0022 * (1 - t);
    px += this._look.x * 0.5 * swayK;
    py += this._look.y * 0.5 * swayK;
    pz += R.z * 0.05;
    this.pose.position.set(px, py, pz);

    let rx = this.hipPitch * (1 - t) + k * 1.4;
    let ry = this.hipYaw * (1 - t);
    let rz = this.hipRoll * (1 - t);
    rx = THREE.MathUtils.lerp(rx, this.sprintPitch, s);
    ry = THREE.MathUtils.lerp(ry, this.sprintYaw + swayPX * 3, s);
    rz = THREE.MathUtils.lerp(rz, this.sprintRoll + swayRz, s);
    rx = THREE.MathUtils.lerp(rx, this.slidePitch, sl);
    rz = THREE.MathUtils.lerp(rz, this.slideRoll, sl);
    rx += sw * 0.75 + rl * (0.55 + Math.sin(this._breath * 9) * 0.05); // reload wobbles like hands working
    ry += rl * 0.35;
    rz += sw * 0.35 + rl * 0.30;
    rz += Math.sin(this._walkPhase) * 0.012 * wb; // tiny roll with each step
    rx += R.p * 0.06 + this._look.y * 0.6 * swayK;
    ry += R.y * 0.03 + this._look.x * 0.8 * swayK;
    rz += R.r * 0.03 + this._look.x * 0.5 * swayK;
    this.pose.rotation.set(rx, ry, rz);
    this.arms?.update(dt);
    if (this.release && duration - this.throwing >= release) {
      const callback = this.release; this.release = null;
      callback(this.arms?.origin());
    }
  }

  dispose() {
    this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of this.materials) m.dispose();
  }
}

import * as THREE from 'three';
import { buildGun } from './gunModel.js';

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

    this.hipX = 0.29; this.hipY = -0.29; this.hipZ = -0.68;
    this.aimX = 0.00; this.aimY = -0.195; this.aimZ = -0.36;
    this.wallPull = 0;
    this.cant = 0;
    this.wallPullZ = 0.32;
    this.wallPullY = -0.05;
    this.aimFov = 38; // sniper scope fov
    this.aimSpeed = 26;
    this.recoilAmount = 0.25;

    this.sprintX = 0.24; this.sprintY = -0.32; this.sprintZ = -0.36;
    this.sprintPitch = -0.80;
    this.sprintYaw = 0.52;
    this.sprintRoll = 0.45;
    this.sprintSpeed = 20;
    this.swaySpeed = 11.5;
    this.swayX = 0.055;
    this.swayY = 0.02;
    this.swayRoll = 0;

    this.slidePitch = 0.85;
    this.slideRoll = 0;
    this.slideX = 0.28;
    this.slideY = 0.04;
    this.slideZ = 0;
    this.slideBlend = 16;

    this.aimT = 0;
    this.sprintT = 0;
    this.slideT = 0;
    this._swayPhase = 0;
    this._kick = 0;

    this.hipPitch = 0.05;
    this.hipYaw = 0.26;  // muzzle angled in toward the crosshair
    this.hipRoll = 0.08;
    this.viewScale = 0.82;
    this.refFov = 75;
    this.materials = [];

    this._build();
    this.pose.scale.setScalar(this.viewScale);
    this.pose.position.set(this.hipX, this.hipY, this.hipZ);
    this.pose.rotation.set(this.hipPitch, this.hipYaw, this.hipRoll);
    this._fovComp(this.refFov);
  }

  setMode(m) {
    this.mode = m === 1 ? 1 : 0;
    this.aimFov = this.mode === 0 ? 38 : 58;
    // rifle sights through the optic; rocket sights over the top slabs
    this.aimY = this.mode === 0 ? -0.195 : -0.18;
    this.rifleGroup.visible = this.mode === 0;
    this.rocketGroup.visible = this.mode === 1;
    this._kick = 0.6;
  }

  _build() {
    const gun = buildGun();
    this.pose.add(gun.group);
    this.rifleGroup = gun.rifleGroup;
    this.rocketGroup = gun.rocketGroup;
    this.glowMats = gun.glowMats;
    this.materials.push(...gun.materials);

    // gloved trigger hand + armoured forearm running off the bottom-right edge
    const glove = new THREE.MeshStandardMaterial({ color: 0x16181c, roughness: 0.78, metalness: 0 });
    const plate = new THREE.MeshStandardMaterial({ color: 0x202329, roughness: 0.45, metalness: 0.15 });
    this.materials.push(glove, plate);
    const arm = new THREE.Group();
    gun.group.add(arm);
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

  setPaintColor() {}

  setNeon(on) {
    for (const m of this.glowMats) m.emissiveIntensity = m.userData.baseEmissive * (on ? 1.2 : 1);
  }

  _fovComp(fov) {
    const k = Math.tan(THREE.MathUtils.degToRad(fov) / 2) /
              Math.tan(THREE.MathUtils.degToRad(this.refFov) / 2);
    this.root.scale.set(k, k, 1);
    return k;
  }

  kick(amount = 1) { this._kick = amount; }

  update(dt, aiming, baseFov = 75, sprinting = false, sliding = false) {
    const target = aiming ? 1 : 0;
    this.aimT += (target - this.aimT) * Math.min(1, dt * this.aimSpeed);
    const t = this.aimT;

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

    const curFov = THREE.MathUtils.lerp(baseFov, this.aimFov, t);
    const comp = this._fovComp(curFov);
    this.root.scale.set(comp, comp, 1);

    this._kick = Math.max(0, this._kick - dt * 6.5);
    const k = this._kick * this._kick * 0.014 * this.recoilAmount;

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
    this.pose.position.set(px, py, pz);

    let rx = this.hipPitch * (1 - t) + k * 1.4;
    let ry = this.hipYaw * (1 - t);
    let rz = this.hipRoll * (1 - t);
    rx = THREE.MathUtils.lerp(rx, this.sprintPitch, s);
    ry = THREE.MathUtils.lerp(ry, this.sprintYaw + swayPX * 3, s);
    rz = THREE.MathUtils.lerp(rz, this.sprintRoll + swayRz, s);
    rx = THREE.MathUtils.lerp(rx, this.slidePitch, sl);
    rz = THREE.MathUtils.lerp(rz, this.slideRoll, sl);
    this.pose.rotation.set(rx, ry, rz);
  }

  dispose() {
    this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of this.materials) m.dispose();
  }
}

import * as THREE from 'three';

export class Weapon {
  constructor() {
    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = true;

    this.mode = 0; // 0 = rifle, 1 = rocket

    this.hipX = 0.20; this.hipY = -0.14; this.hipZ = -0.38;
    this.aimX = 0.00; this.aimY = -0.11; this.aimZ = -0.28;
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

    this.viewScale = 0.82;
    this.refFov = 75;
    this.materials = [];

    this._build();
    this.root.scale.setScalar(this.viewScale);
    this.root.position.set(this.hipX, this.hipY, this.hipZ);
    this.root.rotation.set(0.015, -0.065, 0);
  }

  setMode(m) {
    this.mode = m === 1 ? 1 : 0;
    this.aimFov = this.mode === 0 ? 38 : 58;
    this.rifleGroup.visible = this.mode === 0;
    this.rocketGroup.visible = this.mode === 1;
    this._kick = 0.6;
  }

  _build() {
    const shell = new THREE.MeshStandardMaterial({ color: 0xe8ebef, roughness: 0.48, metalness: 0 });
    const carbon = new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.6, metalness: 0 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x343a44, roughness: 0.5, metalness: 0 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x0c0e12, roughness: 0.85, metalness: 0 });
    const fire = new THREE.MeshStandardMaterial({ color: 0xff6000, roughness: 0.42, emissive: 0xff6000, emissiveIntensity: 0.32 });
    const red = new THREE.MeshStandardMaterial({ color: 0xff4848, roughness: 0.42, emissive: 0xff4848, emissiveIntensity: 0.32 });
    this.fireMat = fire;
    this.redMat = red;
    this.materials.push(shell, carbon, metal, dark, fire, red);

    const base = new THREE.Group();
    this.root.add(base);

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = base) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      parent.add(m);
      return m;
    };

    const H = Math.PI / 2;

    // white receiver and armored stock
    add(new THREE.BoxGeometry(0.12, 0.105, 0.34), shell, 0, -0.005, 0.015);
    add(new THREE.BoxGeometry(0.095, 0.075, 0.16), shell, 0, 0.075, -0.03);
    add(new THREE.BoxGeometry(0.13, 0.032, 0.22), dark, 0, 0.125, -0.03);
    add(new THREE.BoxGeometry(0.10, 0.07, 0.18), shell, 0, -0.015, 0.22);
    add(new THREE.BoxGeometry(0.085, 0.09, 0.10), dark, 0, -0.02, 0.34);
    add(new THREE.BoxGeometry(0.09, 0.10, 0.025), red, 0, -0.02, 0.40);

    // side panels and illuminated channels
    add(new THREE.BoxGeometry(0.022, 0.07, 0.20), shell, -0.068, -0.005, -0.03);
    add(new THREE.BoxGeometry(0.022, 0.07, 0.20), shell, 0.068, -0.005, -0.03);
    add(new THREE.BoxGeometry(0.006, 0.016, 0.18), fire, -0.081, 0.012, -0.04);
    add(new THREE.BoxGeometry(0.006, 0.016, 0.18), fire, 0.081, 0.012, -0.04);
    add(new THREE.BoxGeometry(0.032, 0.012, 0.05), red, -0.062, -0.04, 0.11);
    add(new THREE.BoxGeometry(0.032, 0.012, 0.05), red, 0.062, -0.04, 0.11);

    // grip, trigger, and magazine housing
    const grip = add(new THREE.BoxGeometry(0.045, 0.13, 0.06), dark, 0, -0.115, 0.09);
    grip.rotation.x = -0.22;
    add(new THREE.TorusGeometry(0.033, 0.006, 8, 18, Math.PI), metal, 0, -0.061, 0.025, 0, 0, Math.PI);
    add(new THREE.BoxGeometry(0.009, 0.024, 0.009), fire, 0, -0.057, 0.025);
    add(new THREE.BoxGeometry(0.052, 0.12, 0.075), carbon, 0, -0.12, -0.045, 0.18);
    add(new THREE.BoxGeometry(0.055, 0.018, 0.078), fire, 0, -0.175, -0.05, 0.18);

    // fixed tri-barrel silhouette from the reference weapon
    add(new THREE.CylinderGeometry(0.016, 0.016, 0.56, 18), dark, 0, 0.055, -0.38, H);
    add(new THREE.CylinderGeometry(0.026, 0.026, 0.55, 18), dark, -0.04, -0.045, -0.36, H);
    add(new THREE.CylinderGeometry(0.026, 0.026, 0.55, 18), dark, 0.04, -0.045, -0.36, H);
    add(new THREE.CylinderGeometry(0.022, 0.022, 0.07, 18), metal, 0, 0.055, -0.64, H);
    for (const x of [-0.04, 0.04]) {
      add(new THREE.TorusGeometry(0.031, 0.006, 8, 20), fire, x, -0.045, -0.62);
      add(new THREE.CylinderGeometry(0.034, 0.034, 0.035, 18), metal, x, -0.045, -0.64, H);
    }
    add(new THREE.TorusGeometry(0.024, 0.005, 8, 20), red, 0, 0.055, -0.67);

    // rifle optic and top shroud
    this.rifleGroup = new THREE.Group();
    this.root.add(this.rifleGroup);
    add(new THREE.CylinderGeometry(0.023, 0.023, 0.23, 20), dark, 0, 0.145, -0.04, H, 0, 0, this.rifleGroup);
    add(new THREE.CylinderGeometry(0.028, 0.028, 0.045, 20), metal, 0, 0.145, -0.15, H, 0, 0, this.rifleGroup);
    add(new THREE.CylinderGeometry(0.026, 0.026, 0.035, 20), red, 0, 0.145, 0.075, H, 0, 0, this.rifleGroup);
    add(new THREE.BoxGeometry(0.022, 0.035, 0.025), dark, 0, 0.11, -0.08, 0, 0, 0, this.rifleGroup);
    add(new THREE.BoxGeometry(0.022, 0.035, 0.025), dark, 0, 0.11, 0.03, 0, 0, 0, this.rifleGroup);
    for (let i = 0; i < 4; i++) {
      add(new THREE.BoxGeometry(0.064, 0.009, 0.018), metal, 0, 0.112, -0.10 - i * 0.035, 0, 0, 0, this.rifleGroup);
    }

    // rocket mode adds the twin-tube collars and charge indicators
    this.rocketGroup = new THREE.Group();
    this.rocketGroup.visible = false;
    this.root.add(this.rocketGroup);
    add(new THREE.CylinderGeometry(0.037, 0.037, 0.10, 20), carbon, -0.04, -0.045, -0.56, H, 0, 0, this.rocketGroup);
    add(new THREE.CylinderGeometry(0.037, 0.037, 0.10, 20), carbon, 0.04, -0.045, -0.56, H, 0, 0, this.rocketGroup);
    add(new THREE.TorusGeometry(0.033, 0.007, 8, 20), red, -0.04, -0.045, -0.61, 0, 0, 0, this.rocketGroup);
    add(new THREE.TorusGeometry(0.033, 0.007, 8, 20), fire, 0.04, -0.045, -0.61, 0, 0, 0, this.rocketGroup);
    add(new THREE.BoxGeometry(0.085, 0.012, 0.035), fire, -0.04, 0.085, -0.18, 0, 0, 0, this.rocketGroup);
    add(new THREE.BoxGeometry(0.085, 0.012, 0.035), red, 0.04, 0.085, -0.18, 0, 0, 0, this.rocketGroup);
  }

  setPaintColor() {}

  setNeon(on) {
    for (const m of [this.fireMat, this.redMat]) {
      m.emissiveIntensity = on ? 0.9 : 0.32;
      m.toneMapped = !on;
      m.needsUpdate = true;
    }
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
    const comp = Math.tan(THREE.MathUtils.degToRad(curFov) / 2) /
                 Math.tan(THREE.MathUtils.degToRad(this.refFov) / 2);
    this.root.scale.setScalar(this.viewScale * comp);

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
    this.root.position.set(px, py, pz);

    let rx = 0.015 * (1 - t) + k * 1.4;
    let ry = -0.065 * (1 - t);
    let rz = 0;
    rx = THREE.MathUtils.lerp(rx, this.sprintPitch, s);
    ry = THREE.MathUtils.lerp(ry, this.sprintYaw + swayPX * 3, s);
    rz = THREE.MathUtils.lerp(rz, this.sprintRoll + swayRz, s);
    rx = THREE.MathUtils.lerp(rx, this.slidePitch, sl);
    rz = THREE.MathUtils.lerp(rz, this.slideRoll, sl);
    this.root.rotation.set(rx, ry, rz);
  }

  dispose() {
    this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of this.materials) m.dispose();
  }
}

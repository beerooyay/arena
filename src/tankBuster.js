import * as THREE from 'three';

/**
 * TankBuster — a first-person shoulder-fired paint launcher.
 *
 * A lock-on, top-attack anti-tank weapon: acquire a lock on an enemy tank, fire,
 * and a fat paint warhead rockets straight up, arcs over the target and plunges
 * down onto it, leaving a heavy smoke trail and a massive splat on impact.
 *
 * This class is just the VIEWMODEL + poses; the lock-on, flight and impact live
 * in main.js. Built to sit in the camera like the marker, shown when equipped.
 */
const _q = new THREE.Quaternion();
const _muzzleWorld = new THREE.Vector3();

export class TankBuster {
  constructor(paintHex = 0x2f7bff) {
    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = true;

    // poses (mirrors the marker's hip/aim feel, tuned for a bigger weapon)
    this.hipX = 0.24; this.hipY = -0.16; this.hipZ = -0.52;
    this.aimX = 0.0; this.aimY = -0.11; this.aimZ = -0.34;
    this.aimFov = 42; // scope magnification when zoomed
    this.aimSpeed = 26;
    this.aimT = 0;
    this._kick = 0;
    this._swayPhase = 0;

    // --- locomotion: same sprint carry / running sway / slide kick / wall pull
    // model as the paint marker so BOTH guns move identically as the player moves.
    // (values scaled up a touch for the bigger launcher.)
    this.sprintX = 0.30; this.sprintY = -0.36; this.sprintZ = -0.50; // running carry
    this.sprintPitch = -0.72;  // rx — muzzle tips up
    this.sprintYaw = 0.50;     // ry — swings inward across the screen
    this.sprintRoll = 0.44;    // rz — cants the launcher over
    this.sprintSpeed = 20;     // how fast the sprint pose blends in/out
    this.swaySpeed = 11.5;     // sway cadence (rad/s, ~footsteps) — matches marker
    this.swayX = 0.062;        // horizontal sway amplitude
    this.swayY = 0.02;         // vertical bob amplitude
    this.swayRoll = 0;         // roll wobble amplitude
    this.sprintT = 0;

    this.slidePitch = 0.9;     // rx — muzzle kicks up during a slide
    this.slideRoll = 0;        // rz — optional cant during a slide
    this.slideX = 0.34;        // position offset X during a slide
    this.slideY = 0.05;        // raises the launcher during a slide
    this.slideZ = 0;
    this.slideBlend = 16;
    this.slideT = 0;

    // wall pullback: 0 = normal, 1 = tucked back off a nearby wall
    this.wallPull = 0;
    this.wallPullZ = 0.32;
    this.wallPullY = -0.05;

    this.viewScale = 0.85;
    this.refFov = 75;

    this._build(paintHex);
    this.root.scale.setScalar(this.viewScale);
    this.root.position.set(this.hipX, this.hipY, this.hipZ);
    this.root.rotation.set(0.02, -0.06, 0);
    this.root.visible = false;
  }

  _build(paintHex) {
    // same light palette as the paint marker so it reads as a clean 3D object
    // against the white arena (NOT a black silhouette). metalness stays 0.
    const body = new THREE.MeshStandardMaterial({ color: 0xd2d7dd, roughness: 0.55, metalness: 0 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x9aa2ac, roughness: 0.65, metalness: 0 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x7b828a, roughness: 0.95, metalness: 0 });
    this.accentMat = new THREE.MeshStandardMaterial({
      color: paintHex, roughness: 0.4, metalness: 0,
      emissive: new THREE.Color(paintHex), emissiveIntensity: 0.3,
    });
    // the targeting optic lens glows so it reads as "electronics"
    this.lensMat = new THREE.MeshStandardMaterial({
      color: 0x39d0ff, roughness: 0.3, metalness: 0,
      emissive: new THREE.Color(0x39d0ff), emissiveIntensity: 0.9,
    });
    this.materials = [body, dark, rubber, this.accentMat, this.lensMat];

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
      m.castShadow = false; m.receiveShadow = false;
      this.root.add(m); return m;
    };

    // --- main launch tube (origin roughly on the tube axis) ---
    add(new THREE.CylinderGeometry(0.062, 0.062, 0.92, 24), body, 0, 0, -0.16, Math.PI / 2);
    // muzzle ring at the front, paint-accent
    add(new THREE.CylinderGeometry(0.078, 0.09, 0.12, 24), this.accentMat, 0, 0, -0.62, Math.PI / 2);
    // rear venturi cone (backblast end)
    add(new THREE.CylinderGeometry(0.066, 0.11, 0.18, 24), dark, 0, 0, 0.34, Math.PI / 2);
    // a couple of barrel bands
    add(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 24), dark, 0, 0, -0.36, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.07, 0.07, 0.04, 24), dark, 0, 0, 0.02, Math.PI / 2);

    // --- warhead: a fat paint round sitting in the muzzle (this is what fires) ---
    add(new THREE.SphereGeometry(0.07, 18, 14), this.accentMat, 0, 0, -0.66);

    // --- top targeting optic (the lock-on sight) ---
    add(new THREE.BoxGeometry(0.12, 0.1, 0.24), body, 0, 0.12, -0.02);
    // the front lens (the "camera" that feeds the scope screen)
    add(new THREE.CylinderGeometry(0.034, 0.034, 0.02, 16), this.lensMat, 0, 0.12, -0.15, Math.PI / 2);

    // --- digital scope screen: the flat REAR face of the optic, facing the player ---
    // the optic box spans z ∈ [-0.14, 0.10]; its back face (max z) points at us.
    this.screenMat = new THREE.MeshBasicMaterial({ color: 0x0b0f14, toneMapped: false });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.108, 0.086), this.screenMat);
    screen.position.set(0, 0.12, 0.101); // a hair proud of the box's back face
    screen.renderOrder = 3;              // draw over the optic body
    this.root.add(screen);
    this.screen = screen;

    // --- pistol grip + trigger guard ---
    const grip = add(new THREE.BoxGeometry(0.05, 0.15, 0.07), rubber, 0, -0.13, 0.06);
    grip.rotation.x = -0.2;
    add(new THREE.TorusGeometry(0.045, 0.008, 8, 16, Math.PI), dark, 0, -0.06, 0.0, 0, 0, Math.PI);
    // fore grip
    const fore = add(new THREE.BoxGeometry(0.045, 0.12, 0.05), rubber, 0, -0.11, -0.34);
    fore.rotation.x = 0.18;

    this._muzzleLocal = new THREE.Vector3(0, 0, -0.72); // tube tip, local
    this._optic = this.root.children.find((c) => c.material === this.lensMat);
  }

  setPaintColor(hex) {
    this.accentMat.color.setHex(hex);
    this.accentMat.emissive.setHex(hex);
  }

  kick() { this._kick = 1; }

  update(dt, aiming, baseFov = 75, sprinting = false, sliding = false) {
    // --- aim blend ---
    const target = aiming ? 1 : 0;
    this.aimT += (target - this.aimT) * Math.min(1, dt * this.aimSpeed);
    const t = this.aimT;

    // --- sprint blend + running sway (aiming always wins over sprint) ---
    const sTarget = (sprinting && !aiming) ? 1 : 0;
    this.sprintT += (sTarget - this.sprintT) * Math.min(1, dt * this.sprintSpeed);
    const s = this.sprintT;
    this._swayPhase += dt * this.swaySpeed;
    const swayPX = Math.sin(this._swayPhase) * this.swayX * s;      // side-to-side
    const swayPY = Math.sin(this._swayPhase * 2) * this.swayY * s;  // vertical bob (2x cadence)
    const swayRz = Math.sin(this._swayPhase) * this.swayRoll * s;   // roll wobble

    // --- slide blend (kicks the muzzle up; overrides sprint/hip while sliding) ---
    const slTarget = (sliding && !aiming) ? 1 : 0;
    this.slideT += (slTarget - this.slideT) * Math.min(1, dt * this.slideBlend);
    const sl = this.slideT;

    // keep on-screen size constant across FOV / ADS
    const curFov = THREE.MathUtils.lerp(baseFov, this.aimFov, t);
    const comp = Math.tan(THREE.MathUtils.degToRad(curFov) / 2) /
                 Math.tan(THREE.MathUtils.degToRad(this.refFov) / 2);
    this.root.scale.setScalar(this.viewScale * comp);

    this._kick = Math.max(0, this._kick - dt * 5);
    const k = this._kick * this._kick * 0.05; // heavier recoil than the marker

    const wp = this.wallPull;
    // base hip↔aim pose, then blend toward the sprint carry by s, then slide offset
    let px = THREE.MathUtils.lerp(this.hipX, this.aimX, t);
    let py = THREE.MathUtils.lerp(this.hipY, this.aimY, t) - k * 0.1 + wp * this.wallPullY;
    let pz = THREE.MathUtils.lerp(this.hipZ, this.aimZ, t) + k * 0.9 + wp * this.wallPullZ;
    px = THREE.MathUtils.lerp(px, this.sprintX + swayPX, s);
    py = THREE.MathUtils.lerp(py, this.sprintY + swayPY, s);
    pz = THREE.MathUtils.lerp(pz, this.sprintZ, s);
    px += this.slideX * sl;
    py += this.slideY * sl;
    pz += this.slideZ * sl;
    this.root.position.set(px, py, pz);

    let rx = 0.02 * (1 - t) + k * 0.5;
    let ry = -0.06 * (1 - t);
    let rz = 0;
    rx = THREE.MathUtils.lerp(rx, this.sprintPitch, s);
    ry = THREE.MathUtils.lerp(ry, this.sprintYaw + swayPX * 3, s);
    rz = THREE.MathUtils.lerp(rz, this.sprintRoll + swayRz, s);
    rx = THREE.MathUtils.lerp(rx, this.slidePitch, sl);
    rz = THREE.MathUtils.lerp(rz, this.slideRoll, sl);
    this.root.rotation.set(rx, ry, rz);

    // pulse the optic lens brighter when it has a lock
    if (this.lensMat) this.lensMat.emissiveIntensity = this._locked
      ? 0.7 + 0.5 * (0.5 + 0.5 * Math.sin(performance.now() / 90))
      : 0.9;
  }

  /** Reflect lock state so the optic can pulse. */
  setLocked(on) { this._locked = on; }

  /** World position of the tube tip, for spawning the warhead. */
  getMuzzle() {
    this.root.updateWorldMatrix(true, false);
    return _muzzleWorld.copy(this._muzzleLocal).applyMatrix4(this.root.matrixWorld).clone();
  }

  dispose() {
    this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of this.materials) m.dispose();
  }
}

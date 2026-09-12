import * as THREE from 'three';
import { HopperPhysics } from './hopperPhysics.js';

/**
 * Weapon — first-person paintball marker viewmodel.
 *
 * Built so the MODEL ORIGIN SITS ON THE BARREL AXIS. That matters for aiming:
 * canting (rolling) the marker then swings the hopper out of the sight line
 * while the barrel stays locked on the crosshair — the same thing real players
 * do so the hopper doesn't block their view when they aim.
 *
 * The hopper holds live paintballs with real ball physics (see hopperPhysics.js),
 * tinted to whatever paint colour the player has selected.
 */

// Loader sits square on the feedneck. Aiming cants the whole marker to clear
// the sight line, which is what real players do.
const HOPPER_POS = new THREE.Vector3(0, 0.100, 0.035);
const HOPPER_LEAN = 0;
const HOPPER_INNER_R = 0.046;
const HOPPER_INNER_H = 0.075;
const BALL_R = 0.0085; // real paintballs are ~17mm across

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _down = new THREE.Vector3();
const _wpos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _accLocal = new THREE.Vector3();

export class Weapon {
  constructor(paintHex = 0x2f7bff, ballCount = 78) {
    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = true;
    this.ballCount = ballCount;

    // --- tunables (wired to the dev panel) ---
    this.hipX = 0.19; this.hipY = -0.105; this.hipZ = -0.355;
    this.aimX = -0.025; this.aimY = -0.094; this.aimZ = -0.19;
    // wall pullback: 0 = normal, 1 = pressed against a wall (tuck the gun back
    // toward the camera so the barrel stops poking through geometry)
    this.wallPull = 0;
    this.wallPullZ = 0.3;   // how far back to tuck
    this.wallPullY = -0.05; // slight downward tuck
    this.cant = 0.74;        // radians of roll when aiming (tips the loader clear)
    this.aimFov = 75;
    this.aimSpeed = 30;      // how fast the aim pose blends
    this.recoilAmount = 0.2;

    // --- sprint pose (Call-of-Duty style angled carry + sway while running) ---
    this.sprintX = 0.215; this.sprintY = -0.33; this.sprintZ = -0.34; // where the gun rides
    this.sprintPitch = -0.82;  // rx — muzzle tips up
    this.sprintYaw = 0.54;     // ry — muzzle swings inward across the screen
    this.sprintRoll = 0.52;    // rz — cants the marker over
    this.sprintSpeed = 20;     // how fast the sprint pose blends in/out
    this.swaySpeed = 11.5;     // sway cadence (rad/s, ~footsteps)
    this.swayX = 0.062;        // horizontal sway amplitude
    this.swayY = 0.02;         // vertical bob amplitude
    this.swayRoll = 0;         // roll-wobble amplitude

    // --- slide pose (gun kicks up while sliding) ---
    this.slidePitch = 0.94;    // rx — rotates the muzzle up during a slide
    this.slideRoll = 0;        // rz — optional cant during a slide
    this.slideX = 0.315;       // position offset X during a slide
    this.slideY = 0.04;        // position offset Y (raises the gun) during a slide
    this.slideZ = 0;           // position offset Z during a slide
    this.slideBlend = 16;      // how fast the slide pose blends in/out

    this.aimT = 0;           // 0 = hip, 1 = aimed
    this.sprintT = 0;        // 0 = normal, 1 = full sprint pose
    this.slideT = 0;         // 0 = normal, 1 = full slide pose
    this._swayPhase = 0;
    this._kick = 0;

    this._prevWorld = new THREE.Vector3();
    this._prevVel = new THREE.Vector3();
    this._hasPrev = false;
    this._smoothAcc = new THREE.Vector3();

    this._build(paintHex);
    this.viewScale = 0.8; // base viewmodel scale
    this.refFov = 75;     // FOV viewScale was tuned at; scale tracks FOV vs this
    this.root.scale.setScalar(this.viewScale);
    // seat it in the hip pose immediately — otherwise it sits on the camera
    // origin (clipping into the lens) until the first update()
    this.root.position.set(this.hipX, this.hipY, this.hipZ);
    this.root.rotation.set(0.015, -0.075, 0);

    this.physics = new HopperPhysics({
      count: ballCount,
      innerRadius: HOPPER_INNER_R,
      innerHeight: HOPPER_INNER_H,
      ballRadius: BALL_R,
    });
    this.physics.init();
    this._writeBalls(); // show the loaded hopper immediately
  }

  _build(paintHex) {
    // Light, mid-tone metals so the marker reads as a 3D object under this
    // scene's bright fill lighting — dark materials just flatten into a black
    // silhouette against the white arena.
    // NOTE: metalness must stay 0 — there's no environment map in this scene, so
    // any metalness renders as near-black and flattens the model into a
    // silhouette. Form comes from diffuse shading + the contour outline pass.
    const body = new THREE.MeshStandardMaterial({ color: 0xd2d7dd, roughness: 0.55, metalness: 0 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x9aa2ac, roughness: 0.65, metalness: 0 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x7b828a, roughness: 0.95, metalness: 0 });
    this.accentMat = new THREE.MeshStandardMaterial({
      color: paintHex, roughness: 0.4, metalness: 0,
      emissive: new THREE.Color(paintHex), emissiveIntensity: 0.18,
    });
    this.materials = [body, dark, rubber, this.accentMat];

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      m.castShadow = false;
      m.receiveShadow = false;
      this.root.add(m);
      return m;
    };

    // barrel (origin sits on this axis) + porting + muzzle tip
    add(new THREE.CylinderGeometry(0.0105, 0.0105, 0.34, 20), body, 0, 0, -0.215, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.0135, 0.0135, 0.11, 20), dark, 0, 0, -0.335, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.0125, 0.0125, 0.02, 20), this.accentMat, 0, 0, -0.386, Math.PI / 2);

    // receiver / body (dark plate seated just below the body's top so their
    // faces don't coincide and z-fight)
    add(new THREE.BoxGeometry(0.046, 0.058, 0.20), body, 0, -0.030, 0.015);
    add(new THREE.BoxGeometry(0.044, 0.022, 0.115), dark, 0, -0.018, 0.005);
    // bolt/cocking cap at the rear
    add(new THREE.CylinderGeometry(0.017, 0.017, 0.03, 16), dark, 0, -0.012, 0.128, Math.PI / 2);

    // top rail + iron sights (seated flush on the receiver top, y = -0.001)
    add(new THREE.BoxGeometry(0.020, 0.008, 0.16), dark, 0, 0.003, 0.02);
    add(new THREE.BoxGeometry(0.004, 0.016, 0.006), dark, 0, 0.015, -0.055); // front post
    add(new THREE.BoxGeometry(0.016, 0.012, 0.006), dark, 0, 0.013, 0.088);  // rear notch

    // feed neck / mount collar — bridges the receiver top up into the hopper
    // base with no see-through gap (bottom tucked into the receiver)
    add(new THREE.CylinderGeometry(0.030, 0.034, 0.079, 16), dark, 0, 0.038, 0.035);

    // grip + trigger guard + trigger
    const grip = add(new THREE.BoxGeometry(0.034, 0.105, 0.048), rubber, 0, -0.108, 0.072);
    grip.rotation.x = -0.22;
    add(new THREE.TorusGeometry(0.030, 0.005, 8, 18, Math.PI), dark, 0, -0.058, 0.012, 0, 0, Math.PI);
    add(new THREE.BoxGeometry(0.007, 0.022, 0.006), this.accentMat, 0, -0.048, 0.012);

    // air tank, mounted at the rear ASA and angled down + back so its neck tucks
    // into the receiver (no gap); the regulator collar bridges the joint
    const tank = add(new THREE.CylinderGeometry(0.024, 0.024, 0.115, 18), body, 0, -0.082, 0.17, Math.PI / 2);
    tank.rotation.x = Math.PI / 2 + 0.30;
    add(new THREE.CylinderGeometry(0.016, 0.016, 0.05, 12), dark, 0, -0.06, 0.12, Math.PI / 2);

    // --- hopper -----------------------------------------------------------
    this.hopper = new THREE.Group();
    this.hopper.position.copy(HOPPER_POS);
    this.hopper.rotation.z = HOPPER_LEAN;
    this.root.add(this.hopper);

    // clear shell so the paintballs read through it
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0xe8ecf0, roughness: 0.12, metalness: 0.0,
      transparent: true, opacity: 0.26, depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.shellMat = shellMat; // thinned in Lights Out so the neon balls shine through
    this.materials.push(shellMat);
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(HOPPER_INNER_R + 0.004, HOPPER_INNER_R + 0.004, HOPPER_INNER_H + 0.008, 24, 1, true),
      shellMat);
    shell.renderOrder = 4;
    this.hopper.add(shell);
    const lid = new THREE.Mesh(
      new THREE.SphereGeometry(HOPPER_INNER_R + 0.004, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), shellMat);
    lid.position.y = HOPPER_INNER_H / 2;
    lid.renderOrder = 4;
    this.hopper.add(lid);
    // opaque base + rim so it still reads as a solid object
    const rim = new THREE.Mesh(new THREE.TorusGeometry(HOPPER_INNER_R + 0.005, 0.004, 8, 24), dark);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = -HOPPER_INNER_H / 2;
    this.hopper.add(rim);
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(HOPPER_INNER_R + 0.004, 0.020, 0.024, 20), dark);
    base.position.y = -HOPPER_INNER_H / 2 - 0.012;
    this.hopper.add(base);

    // the paintballs themselves — instanced so a full hopper is ~1 draw call
    this.ballMat = new THREE.MeshStandardMaterial({
      color: paintHex, roughness: 0.3, metalness: 0,
    });
    this.materials.push(this.ballMat);
    this.ballMesh = new THREE.InstancedMesh(
      new THREE.SphereGeometry(BALL_R, 10, 8), this.ballMat, this.ballCount);
    this.ballMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ballMesh.frustumCulled = false;
    this.ballMesh.renderOrder = 3;
    this.hopper.add(this.ballMesh);
    this._m4 = new THREE.Matrix4();
  }

  /** Tint the loaded paintballs (and the marker accents) to the paint colour. */
  setPaintColor(hex) {
    this.ballMat.color.setHex(hex);
    this.accentMat.color.setHex(hex);
    this.accentMat.emissive.setHex(hex);
    if (this._neon) this.ballMat.emissive.setHex(hex); // keep the neon glow on colour change
  }

  /** "Lights Out": make the loaded hopper paintballs glow their own colour. */
  setNeon(on) {
    this._neon = on;
    this.ballMat.emissive.copy(this.ballMat.color);
    this.ballMat.emissiveIntensity = on ? 2.6 : 0;
    // skip tone mapping so the emissive renders at full neon brightness instead
    // of being compressed by ACES (that's what made it look muffled)
    this.ballMat.toneMapped = !on;
    this.ballMat.needsUpdate = true;
    this.accentMat.emissiveIntensity = on ? 0.9 : 0.18;
    this.accentMat.toneMapped = !on;
    this.accentMat.needsUpdate = true;
    if (this.shellMat) this.shellMat.opacity = on ? 0.1 : 0.26; // thin dome so balls shine through
  }

  /** Called on each shot for a little recoil kick. */
  kick() { this._kick = 1; }

  /**
   * @param {number} dt
   * @param {boolean} aiming
   * @param {number} baseFov  the un-zoomed field of view, for scale compensation
   */
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

    // FOV magnifies everything the camera sees, viewmodel included — so a wider
    // FOV shrinks the gun on screen and a narrower one (or ADS zoom) balloons it.
    // Scale the marker by tan(currentFov/2)/tan(refFov/2) so its on-screen size
    // stays constant across ANY chosen field of view and while zooming. curFov is
    // the FOV the camera is actually at right now (base blended toward aimFov).
    const curFov = THREE.MathUtils.lerp(baseFov, this.aimFov, t);
    const comp = Math.tan(THREE.MathUtils.degToRad(curFov) / 2) /
                 Math.tan(THREE.MathUtils.degToRad(this.refFov) / 2);
    this.root.scale.setScalar(this.viewScale * comp);

    this._kick = Math.max(0, this._kick - dt * 7);
    const k = this._kick * this._kick * 0.012 * this.recoilAmount;

    const wp = this.wallPull;
    // base hip↔aim pose, then blend toward the sprint carry by s
    let px = THREE.MathUtils.lerp(this.hipX, this.aimX, t);
    let py = THREE.MathUtils.lerp(this.hipY, this.aimY, t) - k * 0.35 + wp * this.wallPullY;
    let pz = THREE.MathUtils.lerp(this.hipZ, this.aimZ, t) + k * 1.6 + wp * this.wallPullZ;
    px = THREE.MathUtils.lerp(px, this.sprintX + swayPX, s);
    py = THREE.MathUtils.lerp(py, this.sprintY + swayPY, s);
    pz = THREE.MathUtils.lerp(pz, this.sprintZ, s);
    // slide shifts the gun by its X/Y/Z offset (Y raises it)
    px += this.slideX * sl;
    py += this.slideY * sl;
    pz += this.slideZ * sl;
    this.root.position.set(px, py, pz);

    // hip pose is slightly toed-in; aiming rolls the marker so the hopper clears
    // the sight line; sprinting cants it to the angled running carry; sliding
    // kicks the muzzle up
    let rx = 0.015 * (1 - t) + k * 1.2;
    let ry = -0.075 * (1 - t);
    let rz = this.cant * t;
    rx = THREE.MathUtils.lerp(rx, this.sprintPitch, s);
    ry = THREE.MathUtils.lerp(ry, this.sprintYaw + swayPX * 3, s);
    rz = THREE.MathUtils.lerp(rz, this.sprintRoll + swayRz, s);
    rx = THREE.MathUtils.lerp(rx, this.slidePitch, sl);
    rz = THREE.MathUtils.lerp(rz, this.slideRoll, sl);
    this.root.rotation.set(rx, ry, rz);

    this._updateHopper(dt);
  }

  _updateHopper(dt) {
    const phys = this.physics;
    if (!phys || !phys.ready || dt <= 0) return;

    this.hopper.updateWorldMatrix(true, false);
    this.hopper.getWorldQuaternion(_q);
    _qi.copy(_q).invert();

    // world "down" expressed in hopper space — this is what tumbles the balls
    _down.set(0, -1, 0).applyQuaternion(_qi);

    // hopper acceleration (so the balls slosh when you move), smoothed
    this.hopper.getWorldPosition(_wpos);
    if (this._hasPrev) {
      _vel.subVectors(_wpos, this._prevWorld).divideScalar(dt);
      _acc.subVectors(_vel, this._prevVel).divideScalar(dt);
      if (!isFinite(_acc.x) || _acc.length() > 400) _acc.set(0, 0, 0);
      this._smoothAcc.lerp(_acc, Math.min(1, dt * 18)); // snappier so balls lurch with movement
      this._prevVel.copy(_vel);
    } else {
      this._prevVel.set(0, 0, 0);
      this._hasPrev = true;
    }
    this._prevWorld.copy(_wpos);
    _accLocal.copy(this._smoothAcc).applyQuaternion(_qi);

    phys.update(dt, _down, _accLocal);
    this._writeBalls();
  }

  /** Push simulated ball positions into the instanced mesh. */
  _writeBalls() {
    const pos = this.physics.positions;
    const n = Math.min(this.ballCount, pos.length);
    for (let i = 0; i < n; i++) {
      const p = pos[i];
      this._m4.makeTranslation(p.x, p.y, p.z);
      this.ballMesh.setMatrixAt(i, this._m4);
    }
    this.ballMesh.count = n;
    this.ballMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of this.materials) m.dispose();
  }
}

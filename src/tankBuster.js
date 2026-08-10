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
    // Clean white sci-fi launcher (styled after the reference art): white body,
    // gunmetal fittings, glowing blue accents + a big bolted breech drum with a
    // blue core. metalness stays 0 (no env map) — form comes from diffuse + the
    // contour outline pass.
    const body  = new THREE.MeshStandardMaterial({ color: 0xeceff2, roughness: 0.5,  metalness: 0 }); // white shell
    const panel = new THREE.MeshStandardMaterial({ color: 0xc7ccd2, roughness: 0.55, metalness: 0 }); // light-grey panels
    const dark  = new THREE.MeshStandardMaterial({ color: 0x565b63, roughness: 0.6,  metalness: 0 }); // gunmetal
    const black = new THREE.MeshStandardMaterial({ color: 0x41464d, roughness: 0.7,  metalness: 0 }); // handle / grips
    const steel = new THREE.MeshStandardMaterial({ color: 0xbcc1c8, roughness: 0.4,  metalness: 0 }); // muzzle face
    this.accentMat = new THREE.MeshStandardMaterial({
      color: paintHex, roughness: 0.35, metalness: 0,
      emissive: new THREE.Color(paintHex), emissiveIntensity: 0.6, // bright glowing blue strips/core
    });
    // targeting-optic lock indicator: glows cyan, pulses when locked (see update)
    this.lensMat = new THREE.MeshStandardMaterial({
      color: 0x39d0ff, roughness: 0.3, metalness: 0,
      emissive: new THREE.Color(0x39d0ff), emissiveIntensity: 0.9,
    });
    this.materials = [body, panel, dark, black, steel, this.accentMat, this.lensMat];

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
      m.castShadow = false; m.receiveShadow = false;
      this.root.add(m); return m;
    };
    const R = Math.PI / 2; // lay a cylinder (default +Y) along the tube axis (Z)

    // ===== FRONT BARREL (points forward, -Z) with a blue muzzle ring =====
    add(new THREE.CylinderGeometry(0.058, 0.062, 0.09, 20), dark, 0, 0, -0.24, R);      // base collar
    add(new THREE.CylinderGeometry(0.044, 0.044, 0.40, 20), body, 0, 0, -0.45, R);      // white barrel
    add(new THREE.TorusGeometry(0.046, 0.006, 8, 20), panel, 0, 0, -0.40);              // barrel band
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.05, 20), dark, 0, 0, -0.63, R);        // dark muzzle collar
    add(new THREE.CylinderGeometry(0.053, 0.053, 0.035, 20), this.accentMat, 0, 0, -0.665, R); // blue muzzle ring

    // ===== MAIN BODY =====
    add(new THREE.CylinderGeometry(0.082, 0.082, 0.46, 24), body, 0, 0, 0.0, R);        // rounded core
    add(new THREE.BoxGeometry(0.12, 0.05, 0.34), body, 0, 0.075, -0.03);                // flat top (scope deck)
    add(new THREE.BoxGeometry(0.115, 0.06, 0.30), panel, 0, -0.055, 0.0);               // belly housing
    add(new THREE.BoxGeometry(0.006, 0.10, 0.30), panel, 0.084, 0.0, -0.02);            // right side plate
    add(new THREE.BoxGeometry(0.006, 0.10, 0.30), panel, -0.084, 0.0, -0.02);           // left side plate
    // blue accent strips on the flanks + a top strip
    add(new THREE.BoxGeometry(0.01, 0.03, 0.15), this.accentMat, 0.088, 0.015, -0.07);
    add(new THREE.BoxGeometry(0.01, 0.03, 0.15), this.accentMat, -0.088, 0.015, -0.07);
    add(new THREE.BoxGeometry(0.05, 0.009, 0.12), this.accentMat, 0, 0.101, -0.12);
    // small vent lights near the scope deck
    for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(0.008, 0.026, 0.008), this.accentMat, -0.02 + i * 0.02, 0.055, -0.17);

    // ===== REAR BREECH DRUM (big, nearest the camera, +Z) with blue core =====
    add(new THREE.CylinderGeometry(0.10, 0.085, 0.04, 26), dark, 0, 0, 0.235, R);       // shoulder into the drum
    add(new THREE.CylinderGeometry(0.112, 0.112, 0.12, 28), dark, 0, 0, 0.30, R);       // the drum
    add(new THREE.CylinderGeometry(0.098, 0.098, 0.025, 28), steel, 0, 0, 0.362, R);    // silver rear face
    const core = add(new THREE.SphereGeometry(0.05, 20, 14), this.accentMat, 0, 0, 0.368); // blue core button
    core.scale.set(1, 1, 0.42);                                                          // shallow, set into the face (not a protruding egg)
    for (let i = 0; i < 8; i++) {                                                        // rim bolts
      const a = (i / 8) * Math.PI * 2;
      add(new THREE.CylinderGeometry(0.009, 0.009, 0.022, 8), black, Math.cos(a) * 0.09, Math.sin(a) * 0.09, 0.366, R);
    }

    // ===== DIGITAL SCOPE (top, faces the player) =====
    add(new THREE.BoxGeometry(0.085, 0.055, 0.10), black, 0, 0.115, -0.06);             // riser
    add(new THREE.BoxGeometry(0.16, 0.12, 0.03), black, 0, 0.15, 0.0);                  // screen bezel
    add(new THREE.BoxGeometry(0.013, 0.08, 0.02), this.accentMat, 0.084, 0.15, -0.004); // bezel side strips
    add(new THREE.BoxGeometry(0.013, 0.08, 0.02), this.accentMat, -0.084, 0.15, -0.004);
    add(new THREE.BoxGeometry(0.03, 0.012, 0.01), this.lensMat, 0, 0.09, -0.11);        // cyan lock indicator
    // the live screen (render-target feed is assigned in main.js), facing +Z
    this.screenMat = new THREE.MeshBasicMaterial({ color: 0x0b0f14, toneMapped: false });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.132, 0.094), this.screenMat);
    screen.position.set(0, 0.15, 0.016);
    screen.renderOrder = 3;
    this.root.add(screen);
    this.screen = screen;

    // ===== GRIPS =====
    const grip = add(new THREE.BoxGeometry(0.05, 0.15, 0.06), black, 0, -0.135, 0.10);  // pistol grip
    grip.rotation.x = -0.28;
    add(new THREE.BoxGeometry(0.02, 0.075, 0.008), this.accentMat, 0, -0.13, 0.073);    // grip accent
    add(new THREE.TorusGeometry(0.045, 0.008, 8, 16, Math.PI), dark, 0, -0.055, 0.05, 0, 0, Math.PI); // trigger guard
    const fore = add(new THREE.BoxGeometry(0.045, 0.14, 0.05), black, 0, -0.135, -0.18);// fore grip
    fore.rotation.x = 0.22;
    add(new THREE.BoxGeometry(0.018, 0.07, 0.008), this.accentMat, 0, -0.13, -0.206);   // fore-grip accent

    this._muzzleLocal = new THREE.Vector3(0, 0, -0.70); // barrel tip, local
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

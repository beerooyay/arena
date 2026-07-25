import * as THREE from 'three';

/**
 * PlayerController
 * First-person movement, gravity/jump, stand-on-surface, and AABB collision.
 * Handles look input for BOTH mouse (fed via addLook) and gamepad (via update),
 * using the same YXZ euler convention as PointerLockControls so they mix cleanly.
 */
const _vector = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _origin = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _dir = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
const HALF_PI = Math.PI / 2;

const SLIDE_TIME = 0.55;      // seconds a slide lasts
const SLIDE_CROUCH = -0.55;   // how far the camera dips during a slide
const SLIDE_COOLDOWN = 0.5;   // seconds before you can slide again

export class PlayerController {
  constructor(camera) {
    this.camera = camera;
    this.eyeHeight = 1.7;
    this.radius = 0.45;
    this.velocityY = 0;
    this.onGround = true;

    this.gravity = -26;
    this.jumpV = 12.5;       // tuned defaults (dev-panel sliders still adjust these live)
    this.baseSpeed = 13;
    this.sprintSpeed = 18;
    this.padLookSpeed = 2.6; // radians/sec at full stick deflection

    this.minPolar = 0;
    this.maxPolar = Math.PI;

    this.blockers = [];
    this.groundMeshes = [];
    this.ceilings = [];
    this.bots = [];
    this._down = new THREE.Raycaster();
    this._down.far = 100;

    // head-bob + crouch are applied as a removable render offset so they never
    // corrupt the physics position (and crouch can't break ground detection)
    this._bobX = 0;
    this._bobY = 0;
    this._bobPhase = 0;
    this._appliedX = 0;
    this._appliedY = 0;

    // slide state (slideTime / slideBoost are dev-tunable; the slide sound
    // loops so it covers whatever duration is set)
    this.slideTime = SLIDE_TIME;
    this.slideBoost = 1.8;        // multiplier on sprint speed at slide start
    this.crouch = 0;              // eased camera dip (<= 0)
    this.sliding = false;
    this.slideT = 0;
    this.slideSpeed = 0;
    this.slideCooldown = 0;
    this.slideDir = new THREE.Vector3();

    // crouch / prone / dive
    this.crouching = false;
    this.prone = false;
    this.diving = false;
    this.crouchDepth = -0.78;   // camera dip when crouched
    this.proneDepth = -1.24;    // camera dip when flat on the ground
    this.crouchSpeed = 5;       // move speed while crouched
    this.proneSpeed = 1.8;      // crawl speed while prone
    this.diveHold = 0.22;       // seconds of holding before a slide becomes a dive
    this.stanceHold = 0.1;      // seconds of holding to step DOWN the stance ladder
    this.diveBoost = 1.35;      // dive launch speed vs sprint speed
    this.diveUp = 4.2;          // upward kick at the start of a dive
    this.diveDir = new THREE.Vector3();
    this.diveSpeed = 0;
    this._pressActive = false;
    this._pressT = 0;
    this._holdFired = false;
    this._slidePress = false;
  }

  /** Horizontal world-space move direction from forward/strafe input. */
  _moveDir(forward, strafe, out) {
    const c = this.camera;
    _right.setFromMatrixColumn(c.matrix, 0); _right.y = 0;
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _fwd.crossVectors(c.up, _right); _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    out.set(0, 0, 0).addScaledVector(_fwd, forward).addScaledVector(_right, strafe);
    if (out.lengthSq() > 0) out.normalize();
    return out;
  }

  setWorld(blockers, groundMeshes, ceilings = [], bots = []) {
    this.blockers = blockers;
    this.groundMeshes = groundMeshes;
    this.ceilings = ceilings;
    this.bots = bots;
  }

  /** Apply a look delta in radians (yaw, pitch). Used by mouse + gamepad. */
  addLook(dYaw, dPitch) {
    const cam = this.camera;
    _euler.setFromQuaternion(cam.quaternion);
    _euler.y -= dYaw;
    _euler.x -= dPitch;
    _euler.x = Math.max(HALF_PI - this.maxPolar, Math.min(HALF_PI - this.minPolar, _euler.x));
    cam.quaternion.setFromEuler(_euler);
  }

  jump() {
    if (this.prone || this.diving) return false; // stand up first
    if (this.onGround) { this.velocityY = this.jumpV; this.onGround = false; return true; }
    return false;
  }

  _moveForward(d) {
    const c = this.camera;
    _vector.setFromMatrixColumn(c.matrix, 0);
    _vector.crossVectors(c.up, _vector);
    c.position.addScaledVector(_vector, d);
  }

  _moveRight(d) {
    const c = this.camera;
    _vector.setFromMatrixColumn(c.matrix, 0);
    c.position.addScaledVector(_vector, d);
  }

  /** Leave prone/crouch/slide and come back to a standing stance. */
  standUp() {
    this.prone = false;
    this.diving = false;
    this.crouching = false;
    this._pressActive = false;
    if (this.sliding) { this.sliding = false; this.slideCooldown = SLIDE_COOLDOWN; }
  }

  stance() { return this.prone ? 'prone' : (this.crouching ? 'crouch' : 'stand'); }
  _setStance(s) {
    this.prone = (s === 'prone');
    this.crouching = (s === 'crouch');
  }

  /** Tap steps UP the ladder (prone → crouch → stand), or stand → crouch. */
  _stanceTap() {
    if (this.diving) return;
    const s = this.stance();
    if (s === 'stand') this._setStance('crouch');
    else if (s === 'crouch') this._setStance('stand');
    else this._setStance('crouch');            // prone → crouch
  }

  /** Hold steps DOWN the ladder (stand → crouch → prone), prone → stand. */
  _stanceHold() {
    if (this.diving) return;
    const s = this.stance();
    if (s === 'stand') this._setStance('crouch');
    else if (s === 'crouch') this._setStance('prone');
    else this._setStance('stand');             // prone → stand (get up)
  }

  _startSlide(forward, strafe, moving) {
    this.sliding = true;
    this.slideT = this.slideTime;
    this.slideSpeed = this.sprintSpeed * this.slideBoost;
    if (moving) this._moveDir(forward || 0, strafe || 0, this.slideDir);
    else this._moveDir(1, 0, this.slideDir);
  }

  /** A held slide turns into a forward dive that ends prone on the ground. */
  _startDive() {
    this.sliding = false;
    this.diving = true;
    this.diveDir.copy(this.slideDir);
    this.diveSpeed = this.sprintSpeed * this.diveBoost;
    this.velocityY = this.diveUp;
    this.onGround = false;
  }

  /**
   * @param {number} dt
   * @param {{forward:number, strafe:number, sprint:boolean,
   *          crouchPress:boolean, crouchHeld:boolean}} input
   * @param {{x:number,y:number}} padLook  raw right-stick values (-1..1)
   */
  update(dt, input, padLook) {
    // gamepad look
    if (padLook && (padLook.x || padLook.y)) {
      this.addLook(padLook.x * this.padLookSpeed * dt, padLook.y * this.padLookSpeed * dt);
    }

    const pos = this.camera.position;

    // strip last frame's render offset (bob + crouch) so physics runs clean
    pos.x -= this._appliedX; pos.y -= this._appliedY;

    if (this.slideCooldown > 0) this.slideCooldown -= dt;

    const movingInput = !!(input.forward || input.strafe);

    // --- one button, four outcomes -------------------------------------
    //   prone/diving  + tap   -> stand back up
    //   crouched      + tap   -> stand back up
    //   sprinting     + tap   -> slide
    //   sprinting     + hold  -> dive (slide converts once held long enough)
    //   otherwise     + tap   -> crouch
    if (input.crouchPress && !this.diving) {
      this._pressActive = true;
      this._pressT = 0;
      this._holdFired = false;
      this._slidePress = false;
      // sliding fires instantly on press so it stays responsive; every other
      // stance change waits so we can tell a tap from a hold
      if (input.sprint && movingInput && this.onGround &&
          this.slideCooldown <= 0 && this.stance() === 'stand') {
        this._startSlide(input.forward, input.strafe, movingInput);
        this._slidePress = true;
      }
    }

    if (this._pressActive && input.crouchHeld) {
      this._pressT += dt;
      if (this._slidePress) {
        // keep holding through a slide and it commits to a dive
        if (this.sliding && this._pressT >= this.diveHold) {
          this._startDive();
          this._holdFired = true;
        }
      } else if (!this._holdFired && this._pressT >= this.stanceHold) {
        this._stanceHold();
        this._holdFired = true;
      }
    } else if (this._pressActive && !input.crouchHeld) {
      if (!this._holdFired && !this._slidePress) this._stanceTap();
      this._pressActive = false;
    }

    if (this.sliding) {
      this.slideT -= dt;
      const k = Math.max(0, this.slideT / this.slideTime); // 1 → 0 over the slide
      const spd = THREE.MathUtils.lerp(this.baseSpeed * 0.7, this.slideSpeed, k);
      pos.addScaledVector(this.slideDir, spd * dt);
      if (this.slideT <= 0 || !this.onGround) {
        this.sliding = false;
        this.slideCooldown = SLIDE_COOLDOWN;
      }
    } else if (this.diving) {
      // committed forward lunge; gravity brings us down, landing goes prone
      pos.addScaledVector(this.diveDir, this.diveSpeed * dt);
      this.diveSpeed = Math.max(this.baseSpeed * 0.5, this.diveSpeed - dt * 9);
    } else {
      let mag = input.sprint ? this.sprintSpeed : this.baseSpeed;
      if (this.prone) mag = this.proneSpeed;
      else if (this.crouching) mag = this.crouchSpeed;
      const speed = mag * dt;
      if (input.forward) this._moveForward(input.forward * speed);
      if (input.strafe) this._moveRight(input.strafe * speed);
    }

    // stance height: prone < diving < slide < crouch < standing
    let targetCrouch = 0;
    if (this.prone) targetCrouch = this.proneDepth;
    else if (this.diving) targetCrouch = this.proneDepth * 0.8;
    else if (this.sliding) targetCrouch = SLIDE_CROUCH;
    else if (this.crouching) targetCrouch = this.crouchDepth;
    this.crouch += (targetCrouch - this.crouch) * Math.min(1, dt * 12);

    // ground/collision always use the full standing height; the crouch dip is
    // applied to the camera visually at the end so it can't affect grounding
    const eye = this.eyeHeight;

    // gravity
    this.velocityY += this.gravity * dt;
    pos.y += this.velocityY * dt;

    // ceiling clamp so player can't jump through roofs
    for (const box of this.ceilings) {
      if (pos.y > box.min.y - 0.05) {
        pos.y = box.min.y - 0.05;
        this.velocityY = Math.min(this.velocityY, 0);
      }
    }

    // ground height beneath player (floor / ramps / box tops)
    const feet = pos.y - eye;
    _origin.set(pos.x, pos.y + 40, pos.z);
    this._down.set(_origin, DOWN);
    const gHits = this._down.intersectObjects(this.groundMeshes, false);
    let groundY = 0;
    for (const g of gHits) {
      if (g.point.y <= feet + 0.65 && g.point.y > groundY - 0.001) groundY = g.point.y;
    }

    if (feet <= groundY + 0.02) {
      pos.y = groundY + eye;
      this.velocityY = 0;
      if (this.diving) { this.diving = false; this.prone = true; } // dive landed
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    // horizontal push-out vs blocker boxes
    const r = this.radius;
    const pFeet = pos.y - eye;
    const pHead = pos.y;
    for (const box of this.blockers) {
      if (pHead <= box.min.y || pFeet >= box.max.y) continue;
      const minX = box.min.x - r, maxX = box.max.x + r;
      const minZ = box.min.z - r, maxZ = box.max.z + r;
      if (pos.x > minX && pos.x < maxX && pos.z > minZ && pos.z < maxZ) {
        const dL = pos.x - minX, dR = maxX - pos.x;
        const dB = pos.z - minZ, dF = maxZ - pos.z;
        const m = Math.min(dL, dR, dB, dF);
        if (m === dL) pos.x = minX;
        else if (m === dR) pos.x = maxX;
        else if (m === dB) pos.z = minZ;
        else pos.z = maxZ;
      }
    }

    // push-out vs bots (treat as cylinders/radius 0.5, height ~2.1)
    const botR = 0.85;
    for (const bot of this.bots) {
      if (!bot.alive) continue;
      if (pFeet >= 2.1 || pHead <= 0.3) continue;
      const dx = pos.x - bot.pos.x;
      const dz = pos.z - bot.pos.z;
      const dist2 = dx * dx + dz * dz;
      const minDist = r + botR;
      if (dist2 > 0 && dist2 < minDist * minDist) {
        const dist = Math.sqrt(dist2);
        const push = (minDist - dist) / dist;
        pos.x += dx * push;
        pos.z += dz * push;
      }
    }

    // head-bob / sway while running on the ground (eased out otherwise)
    if (this.onGround && movingInput && !this.sliding && !this.prone && !this.diving) {
      const mag = input.sprint ? this.sprintSpeed : this.baseSpeed;
      this._bobPhase += dt * mag * 0.9;
      const amp = input.sprint ? 0.10 : 0.065;
      this._bobY = Math.sin(this._bobPhase * 2) * amp;   // vertical (double freq)
      this._bobX = Math.sin(this._bobPhase) * amp * 0.7; // side-to-side rock
    } else {
      this._bobX *= 0.82; this._bobY *= 0.82;
      if (Math.abs(this._bobX) < 1e-4) this._bobX = 0;
      if (Math.abs(this._bobY) < 1e-4) this._bobY = 0;
    }

    // apply bob + crouch dip as one removable render offset
    this._appliedX = this._bobX;
    this._appliedY = this._bobY + this.crouch;
    pos.x += this._appliedX;
    pos.y += this._appliedY;
  }
}

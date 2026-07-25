/**
 * InputManager
 * Unifies keyboard + mouse + Xbox/gamepad into a single per-frame input state.
 *
 * Standard gamepad mapping (Xbox):
 *   axes[0,1] left stick  -> move (strafe, forward)
 *   axes[2,3] right stick -> look
 *   button 0  A           -> jump / start
 *   button 4  LB          -> previous paint color
 *   button 5  RB          -> next paint color
 *   button 7  RT          -> shoot (analog)
 *   button 9  Start       -> start game
 *   button 10 L3          -> sprint
 */
export class InputManager {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = {};

    // held / edge state
    this._mouseShoot = false;
    this._padShoot = false;
    this._mouseAim = false;
    this._padAim = false;
    this._jumpQueued = false;
    // crouch / slide / dive share one button: tap vs hold decides which
    this._crouchQueued = false;
    this._keyCrouchDown = false;
    this._padCrouchDown = false;
    this._colorDelta = 0;
    this._startQueued = false;

    // per-frame outputs
    this.move = { forward: 0, strafe: 0 };
    this.sprint = false;
    this.look = { x: 0, y: 0 };

    // gamepad
    this.gpIndex = null;
    this._prevButtons = [];

    window.addEventListener('keydown', (e) => this._onKey(e, true));
    window.addEventListener('keyup', (e) => this._onKey(e, false));
    domElement.addEventListener('mousedown', (e) => {
      if (e.button === 0) this._mouseShoot = true;
      if (e.button === 2) this._mouseAim = true;   // right mouse -> aim
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this._mouseShoot = false;
      if (e.button === 2) this._mouseAim = false;
    });
    // right-click aims, so don't pop the browser context menu over the game
    domElement.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('gamepadconnected', (e) => { this.gpIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.gpIndex === e.gamepad.index) this.gpIndex = null;
    });
  }

  get gamepadConnected() { return this.gpIndex !== null; }

  _onKey(e, down) {
    const wasDown = !!this.keys[e.code];
    this.keys[e.code] = down;
    if (down && e.code === 'Space') this._jumpQueued = true;
    if (e.code === 'ControlLeft' || e.code === 'KeyC') {
      // ignore auto-repeat so a held key doesn't spam the press edge
      if (down && !wasDown) this._crouchQueued = true;
      this._keyCrouchDown = down;
    }
  }

  /** Poll once per frame before reading state. */
  poll() {
    const k = this.keys;
    let strafe = (k['KeyD'] || k['ArrowRight'] ? 1 : 0) - (k['KeyA'] || k['ArrowLeft'] ? 1 : 0);
    let forward = (k['KeyW'] || k['ArrowUp'] ? 1 : 0) - (k['KeyS'] || k['ArrowDown'] ? 1 : 0);
    let sprint = !!(k['ShiftLeft'] || k['ShiftRight']);

    this.look.x = 0;
    this.look.y = 0;
    this._padShoot = false;

    const gp = this.gpIndex !== null ? navigator.getGamepads()[this.gpIndex] : null;
    if (gp) {
      const dz = (v) => (Math.abs(v) < 0.16 ? 0 : v);
      strafe += dz(gp.axes[0] || 0);
      forward += -dz(gp.axes[1] || 0);
      this.look.x = dz(gp.axes[2] || 0);
      this.look.y = dz(gp.axes[3] || 0);

      const b = gp.buttons.map((x) => x.pressed || x.value > 0.35);
      const pressed = (i) => b[i] && !this._prevButtons[i];

      if (pressed(0)) this._jumpQueued = true;              // A -> jump
      if (pressed(1)) this._crouchQueued = true;            // B -> crouch/slide/dive
      this._padCrouchDown = !!b[1];
      // Start (9) OR menu (8) -> begin / pause. NOT A, so jumping never pauses.
      if (pressed(9) || pressed(8)) this._startQueued = true;
      if (pressed(5)) this._colorDelta += 1;                // RB -> next color
      if (pressed(4)) this._colorDelta -= 1;                // LB -> prev color

      this._padShoot = !!b[7];                              // RT -> shoot
      this._padAim = !!b[6];                                // LT -> aim
      sprint = sprint || !!b[10];                           // L3 -> sprint

      this._prevButtons = b;
    }

    this.move.strafe = Math.max(-1, Math.min(1, strafe));
    this.move.forward = Math.max(-1, Math.min(1, forward));
    this.sprint = sprint;
  }

  get shootHeld() { return this._mouseShoot || this._padShoot; }
  get aimHeld() { return this._mouseAim || this._padAim; }

  consumeJump() { const j = this._jumpQueued; this._jumpQueued = false; return j; }
  get crouchHeld() { return this._keyCrouchDown || this._padCrouchDown; }
  consumeCrouch() { const s = this._crouchQueued; this._crouchQueued = false; return s; }
  consumeStart() { const s = this._startQueued; this._startQueued = false; return s; }
  consumeColorDelta() { const d = this._colorDelta; this._colorDelta = 0; return d; }
}

/**
 * Settings
 * Player-facing options with localStorage persistence. Owns the Settings menu
 * DOM (built into #settings-body) and applies values to the live game via a set
 * of target references passed to apply().
 *
 * Deep developer tuning (outline shader, paint internals, etc.) stays in the
 * lil-gui Dev Panel — this menu is only the handful of options a player expects.
 */

const STORAGE_KEY = 'whiteout.settings';

// Schema drives both persistence and the generated UI. `apply` receives the
// live game targets so each option knows how to push itself into the engine.
const SCHEMA = [
  {
    key: 'masterVolume', label: 'Master Volume',
    min: 0, max: 1, step: 0.05, default: 0.8, percent: true,
    apply: (v, t) => { t.audio.setMasterVolume(v); },
  },
  {
    key: 'mouseSensitivity', label: 'Mouse Sensitivity',
    min: 0.2, max: 3, step: 0.05, default: 1.0,
    apply: (v, t) => { t.controls.pointerSpeed = v; },
  },
  {
    key: 'padLookSpeed', label: 'Gamepad Look Speed',
    min: 0.8, max: 6, step: 0.1, default: 2.6,
    apply: (v, t) => { t.player.padLookSpeed = v; },
  },
  {
    key: 'fov', label: 'Field of View',
    min: 60, max: 110, step: 1, default: 75, unit: '°',
    apply: (v, t) => { t.camera.fov = v; t.camera.updateProjectionMatrix(); },
  },
  {
    key: 'aimZoom', label: 'Aim Zoom (FOV)',
    min: 20, max: 75, step: 1, default: 75, unit: '°',
    apply: (v, t) => { t.weapon.aimFov = v; },
  },
  {
    key: 'scoreToWin', label: 'Score to Win',
    min: 5, max: 50, step: 5, default: 25,
    apply: (v, t) => { t.match.target = v; },
  },
];

export class Settings {
  constructor() {
    this.values = {};
    for (const s of SCHEMA) this.values[s.key] = s.default;
    this._load();
    this._targets = null;
    this._rows = {};
  }

  get(key) { return this.values[key]; }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      for (const s of SCHEMA) {
        const v = saved[s.key];
        if (typeof v === 'number' && isFinite(v)) {
          this.values[s.key] = Math.min(s.max, Math.max(s.min, v));
        }
      }
    } catch (e) {
      // corrupt/blocked storage — fall back to defaults silently
    }
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch (e) {
      // storage may be unavailable (private mode / itch sandbox) — ignore
    }
  }

  /** Push all current values into the live game. Call after targets are ready. */
  apply(targets) {
    this._targets = targets;
    for (const s of SCHEMA) s.apply(this.values[s.key], targets);
  }

  _fmt(s, v) {
    if (s.percent) return Math.round(v * 100) + '%';
    const txt = Number.isInteger(s.step) ? v.toFixed(0) : v.toFixed(2);
    return txt + (s.unit || '');
  }

  /** Build the slider rows into the given container element. */
  buildUI(container) {
    container.innerHTML = '';
    for (const s of SCHEMA) {
      const row = document.createElement('label');
      row.className = 'set-row';

      const head = document.createElement('div');
      head.className = 'set-head';
      const name = document.createElement('span');
      name.className = 'set-name';
      name.textContent = s.label;
      const val = document.createElement('span');
      val.className = 'set-val';
      val.textContent = this._fmt(s, this.values[s.key]);
      head.append(name, val);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = s.min; input.max = s.max; input.step = s.step;
      input.value = this.values[s.key];
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        this.values[s.key] = v;
        val.textContent = this._fmt(s, v);
        if (this._targets) s.apply(v, this._targets);
        this._save();
      });

      row.append(head, input);
      container.append(row);
      this._rows[s.key] = { input, val, schema: s };
    }
  }

  /** Refresh the displayed slider positions (e.g. after an external change). */
  refreshUI() {
    for (const key in this._rows) {
      const r = this._rows[key];
      r.input.value = this.values[key];
      r.val.textContent = this._fmt(r.schema, this.values[key]);
    }
  }
}

/**
 * HopperPhysics — a small, self-contained rigid-sphere simulation for the
 * paintballs loaded in the marker's hopper. No physics library needed.
 *
 * The hopper is bolted to a moving camera, so rather than simulate in world
 * space we simulate in the hopper's LOCAL space against a static bin and rotate
 * the GRAVITY VECTOR each frame. Tilting your view swings gravity around inside
 * the bin, which tumbles the balls; the hopper's own acceleration is folded in
 * as an inertial force so they slosh when you start, stop and strafe.
 *
 * Collision is sphere/cylinder for the bin plus brute-force sphere/sphere. At
 * ~100 balls that's ~5k pair checks a substep, which is nothing.
 */

// Position-Based Dynamics: predict positions, then relax non-penetration +
// container constraints over several ITERATIONS so a densely packed hopper stays
// FIRM (discrete rigid balls) instead of oozing like liquid. Velocity is read
// back from the solved position change, which is naturally stable and settles.
const SUBSTEPS = 2;
const ITERATIONS = 8;       // constraint relaxation passes per substep (firmness)
const LINEAR_DAMP = 0.9;    // per-substep velocity damping — settles yet still rattles
const MAX_ACCEL = 40;       // clamp the inertial force so movement JOSTLES, not crushes

export class HopperPhysics {
  /** @param {{count:number, innerRadius:number, innerHeight:number, ballRadius:number}} opts */
  constructor(opts) {
    this.count = opts.count ?? 90;
    this.R = opts.innerRadius;
    this.H = opts.innerHeight;
    this.r = opts.ballRadius;
    this.ready = false;
    this.failed = false;

    this.positions = [];
    this.vel = [];
    this._seed();
  }

  /** Kept async-shaped so callers don't care which backend is in use. */
  async init() {
    this.ready = true;
    return true;
  }

  /**
   * Seed the balls already packed — concentric rings per layer, filling from
   * the bottom up — so the hopper looks loaded the instant you spawn instead of
   * needing a second to settle.
   */
  _seed() {
    const { R, H, r } = this;
    const d = r * 2;
    const usableR = Math.max(0, R - r * 1.02);
    const layers = Math.max(1, Math.floor((H - d * 0.1) / (d * 0.98)));
    let placed = 0;

    for (let L = 0; L < layers && placed < this.count; L++) {
      const y = -H / 2 + r + L * d * 0.98;
      const spin = L * 0.5; // offset each layer so they interlock
      // centre ball
      if (placed < this.count) {
        this.positions.push({ x: 0, y, z: 0 });
        this.vel.push({ x: 0, y: 0, z: 0 });
        placed++;
      }
      for (let ring = 1; placed < this.count; ring++) {
        const rad = ring * d * 0.98;
        if (rad > usableR) break;
        const slots = Math.max(1, Math.floor((Math.PI * 2 * rad) / d));
        for (let s = 0; s < slots && placed < this.count; s++) {
          const a = (s / slots) * Math.PI * 2 + spin;
          this.positions.push({ x: Math.cos(a) * rad, y, z: Math.sin(a) * rad });
          this.vel.push({ x: 0, y: 0, z: 0 });
          placed++;
        }
      }
    }
    // anything left over rides on top
    while (placed < this.count) {
      const a = placed * 2.399;
      const rad = usableR * 0.5;
      this.positions.push({ x: Math.cos(a) * rad, y: H / 2 - r, z: Math.sin(a) * rad });
      this.vel.push({ x: 0, y: 0, z: 0 });
      placed++;
    }
    this.count = this.positions.length;
  }

  /**
   * @param {number} dt
   * @param {{x,y,z}} downLocal   world-down expressed in hopper local space (unit)
   * @param {{x,y,z}} accelLocal  hopper acceleration in local space (m/s²), optional
   */
  update(dt, downLocal, accelLocal) {
    if (!this.ready || dt <= 0) return;
    const clamp = (v) => Math.max(-MAX_ACCEL, Math.min(MAX_ACCEL, v));
    // gravity swings around as you look; the hopper's own acceleration is folded
    // in as an inertial force so the balls lurch when you start/stop/strafe.
    const gx = clamp(downLocal.x * 9.81 - (accelLocal ? accelLocal.x : 0));
    const gy = clamp(downLocal.y * 9.81 - (accelLocal ? accelLocal.y : 0));
    const gz = clamp(downLocal.z * 9.81 - (accelLocal ? accelLocal.z : 0));

    const h = Math.min(dt, 1 / 45) / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) this._step(h, gx, gy, gz);
  }

  _step(h, gx, gy, gz) {
    const { positions: P, vel: V } = this;
    const n = P.length;

    // 1) integrate velocity, remember the pre-solve position, predict forward
    for (let i = 0; i < n; i++) {
      const v = V[i], p = P[i];
      v.x += gx * h; v.y += gy * h; v.z += gz * h;
      p.px = p.x; p.py = p.y; p.pz = p.z;
      p.x += v.x * h; p.y += v.y * h; p.z += v.z * h;
    }

    // 2) relax constraints several times — this is what keeps a packed hopper
    //    FIRM (rigid balls) instead of squishy/liquid
    for (let it = 0; it < ITERATIONS; it++) {
      this._solveContacts();
      this._solveContainer();
    }

    // 3) read velocity back from the solved motion, then damp so piles settle
    const inv = 1 / h;
    for (let i = 0; i < n; i++) {
      const v = V[i], p = P[i];
      v.x = (p.x - p.px) * inv * LINEAR_DAMP;
      v.y = (p.y - p.py) * inv * LINEAR_DAMP;
      v.z = (p.z - p.pz) * inv * LINEAR_DAMP;
    }
  }

  /** PBD: push every overlapping pair apart to exactly touching (positional). */
  _solveContacts() {
    const { r, positions: P } = this;
    const n = P.length;
    const dmin = r * 2, dmin2 = dmin * dmin;
    for (let i = 0; i < n; i++) {
      const pi = P[i];
      for (let j = i + 1; j < n; j++) {
        const pj = P[j];
        const dx = pj.x - pi.x, dy = pj.y - pi.y, dz = pj.z - pi.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= dmin2 || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        const corr = (dmin - d) * 0.5;
        const nx = dx / d, ny = dy / d, nz = dz / d;
        pi.x -= nx * corr; pi.y -= ny * corr; pi.z -= nz * corr;
        pj.x += nx * corr; pj.y += ny * corr; pj.z += nz * corr;
      }
    }
  }

  /** PBD: keep every ball inside the cylinder wall, floor and lid. */
  _solveContainer() {
    const { R, H, r, positions: P } = this;
    const wallR = R - r, floorY = -H / 2 + r, ceilY = H / 2 - r;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      const rad = Math.hypot(p.x, p.z);
      if (rad > wallR && rad > 1e-9) { const s = wallR / rad; p.x *= s; p.z *= s; }
      if (p.y < floorY) p.y = floorY;
      else if (p.y > ceilY) p.y = ceilY;
    }
  }
}

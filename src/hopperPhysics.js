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

const SUBSTEPS = 2;
const RESTITUTION = 0.18;   // how bouncy the balls are
const WALL_FRICTION = 0.82; // tangential velocity kept on a wall hit
const BALL_DAMP = 0.995;    // per-substep velocity damping so piles settle
const MAX_ACCEL = 90;       // clamp inertial force (m/s²)

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
    const gx = clamp(downLocal.x * 9.81 - (accelLocal ? accelLocal.x : 0));
    const gy = clamp(downLocal.y * 9.81 - (accelLocal ? accelLocal.y : 0));
    const gz = clamp(downLocal.z * 9.81 - (accelLocal ? accelLocal.z : 0));

    const h = Math.min(dt, 1 / 45) / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) this._step(h, gx, gy, gz);
  }

  _step(h, gx, gy, gz) {
    const { R, H, r, positions: P, vel: V } = this;
    const n = P.length;
    const wallR = R - r;
    const floorY = -H / 2 + r;
    const ceilY = H / 2 - r;

    // integrate
    for (let i = 0; i < n; i++) {
      const v = V[i], p = P[i];
      v.x = (v.x + gx * h) * BALL_DAMP;
      v.y = (v.y + gy * h) * BALL_DAMP;
      v.z = (v.z + gz * h) * BALL_DAMP;
      p.x += v.x * h; p.y += v.y * h; p.z += v.z * h;
    }

    // ball vs ball
    const d2min = (r * 2) * (r * 2);
    for (let i = 0; i < n; i++) {
      const pi = P[i], vi = V[i];
      for (let j = i + 1; j < n; j++) {
        const pj = P[j];
        let dx = pj.x - pi.x, dy = pj.y - pi.y, dz = pj.z - pi.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= d2min || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d, ny = dy / d, nz = dz / d;
        const overlap = r * 2 - d;
        // positional split
        const push = overlap * 0.5;
        pi.x -= nx * push; pi.y -= ny * push; pi.z -= nz * push;
        pj.x += nx * push; pj.y += ny * push; pj.z += nz * push;
        // equal-mass impulse along the normal
        const vj = V[j];
        const rel = (vj.x - vi.x) * nx + (vj.y - vi.y) * ny + (vj.z - vi.z) * nz;
        if (rel < 0) {
          const imp = -(1 + RESTITUTION) * rel * 0.5;
          vi.x -= nx * imp; vi.y -= ny * imp; vi.z -= nz * imp;
          vj.x += nx * imp; vj.y += ny * imp; vj.z += nz * imp;
        }
      }
    }

    // ball vs bin (cylinder wall + floor + lid)
    for (let i = 0; i < n; i++) {
      const p = P[i], v = V[i];
      const radial = Math.hypot(p.x, p.z);
      if (radial > wallR) {
        const nx = p.x / radial, nz = p.z / radial;
        p.x = nx * wallR; p.z = nz * wallR;
        const vn = v.x * nx + v.z * nz;
        if (vn > 0) {
          v.x -= (1 + RESTITUTION) * vn * nx;
          v.z -= (1 + RESTITUTION) * vn * nz;
          v.x *= WALL_FRICTION; v.z *= WALL_FRICTION; v.y *= WALL_FRICTION;
        }
      }
      if (p.y < floorY) {
        p.y = floorY;
        if (v.y < 0) { v.y = -v.y * RESTITUTION; v.x *= WALL_FRICTION; v.z *= WALL_FRICTION; }
      } else if (p.y > ceilY) {
        p.y = ceilY;
        if (v.y > 0) { v.y = -v.y * RESTITUTION; v.x *= WALL_FRICTION; v.z *= WALL_FRICTION; }
      }
    }
  }
}

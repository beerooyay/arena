import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/**
 * Shared "soft hard-surface" geometry helpers: rounded boxes, filleted 2D
 * profiles, lathe-turned shells. Everything the gun, armour and arena props
 * use so nothing reads as a raw box.
 */

const _cache = new Map();

/** Rounded box; radius defaults to a fraction of the smallest side. Cached. */
export function rbox(w, h, d, radius = null, segments = 3) {
  const r = Math.min(radius ?? Math.min(w, h, d) * 0.28, Math.min(w, h, d) * 0.49);
  const key = `${w.toFixed(4)}|${h.toFixed(4)}|${d.toFixed(4)}|${r.toFixed(4)}|${segments}`;
  let g = _cache.get(key);
  if (!g) { g = new RoundedBoxGeometry(w, h, d, segments, r); _cache.set(key, g); }
  return g;
}

/**
 * Polygon → Shape with every corner filleted by `radius` (clamped per corner so
 * short edges don't overlap). Points are [x, y] pairs.
 */
export function filletShape(points, radius, ShapeCtor = THREE.Shape) {
  const n = points.length;
  const s = new ShapeCtor();
  const P = points.map(([x, y]) => new THREE.Vector2(x, y));
  for (let i = 0; i < n; i++) {
    const prev = P[(i - 1 + n) % n], cur = P[i], next = P[(i + 1) % n];
    const a = prev.clone().sub(cur), b = next.clone().sub(cur);
    const r = Math.min(radius, a.length() * 0.45, b.length() * 0.45);
    const p1 = cur.clone().addScaledVector(a.normalize(), r);
    const p2 = cur.clone().addScaledVector(b.normalize(), r);
    if (i === 0) s.moveTo(p1.x, p1.y); else s.lineTo(p1.x, p1.y);
    s.quadraticCurveTo(cur.x, cur.y, p2.x, p2.y);
  }
  s.closePath();
  return s;
}

/**
 * Side profile (u = forward, v = up) extruded across X and centred, with
 * filleted corners and a soft bevel. Forward (+u) maps to -Z.
 */
export function profileGeo(points, width, { fillet = 0.02, bevel = 0.008, holes = [] } = {}) {
  const shape = filletShape(points, fillet);
  for (const h of holes) shape.holes.push(filletShape(h, fillet * 0.8, THREE.Path));
  const depth = Math.max(0.001, width - bevel * 2);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
    bevelSegments: 3, curveSegments: 8,
  });
  geo.translate(0, 0, -depth / 2);
  geo.rotateY(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

/** Lathe from [radius, y] pairs (around +Y). */
export function lathe(pairs, segments = 24, phiStart = 0, phiLength = Math.PI * 2) {
  return new THREE.LatheGeometry(pairs.map(([r, y]) => new THREE.Vector2(r, y)), segments, phiStart, phiLength);
}

/**
 * Tapered limb along +Y from 0..len: rounded ends, radius r0 → r1 with an
 * optional muscle bulge (bulge = extra radius at `at` fraction of the length).
 */
export function limbGeo(len, r0, r1, bulge = 0, at = 0.35, segments = 14) {
  const pts = [];
  const cap = 5;
  for (let i = 0; i <= cap; i++) {           // bottom cap
    const a = (i / cap) * Math.PI / 2;
    pts.push([Math.sin(a) * r0, r0 - Math.cos(a) * r0]);
  }
  const steps = 8;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const y = r0 + t * (len - r0 - r1);
    const bump = bulge * Math.exp(-((t - at) ** 2) / 0.05);
    pts.push([r0 + (r1 - r0) * t + bump, y]);
  }
  for (let i = 0; i <= cap; i++) {           // top cap
    const a = (i / cap) * Math.PI / 2;
    pts.push([Math.cos(a) * r1, len - r1 + Math.sin(a) * r1]);
  }
  pts[pts.length - 1][0] = 0.0001;
  pts[0][0] = 0.0001;
  return lathe(pts, segments);
}

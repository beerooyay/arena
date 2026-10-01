let arenaSize = 34;
export function setArenaSize(size) { arenaSize = size; }
export function heading(x, z, camera = false) { return Math.atan2(camera ? x : -x, camera ? z : -z); }

const lane = [-0.38, -0.13, 0.13, 0.38];
export const SPAWNS_PER_TEAM = lane.length;
export const SPAWN_EYE_Y = 1.7;

// Match openers: each team holds its own side. `slot` spreads the squad
// across the four lanes.
export function teamSpawnXZ(teamId, slot = 0) {
  const s = ((slot % SPAWNS_PER_TEAM) + SPAWNS_PER_TEAM) % SPAWNS_PER_TEAM;
  const x = lane[s] * (arenaSize - 2.5);
  const z = (teamId === 0 ? 1 : -1) * (arenaSize - 2.5);
  return { x, z };
}

// Respawns: eight anchor points ringing the octagon (between the wall faces),
// chosen randomly with a bias toward spots away from live enemies — the chaos
// of spawning anywhere, minus spawning on top of a rifle.
const RING = 8;
export function scatterSpawnXZ(avoid = null) {
  const candidates = [], phase = Math.random() * Math.PI * 2;
  for (let i = 0; i < RING * 3; i++) {
    const a = phase + i / (RING * 3) * Math.PI * 2;
    const sx = Math.sin(a), sz = Math.cos(a);
    const r = (arenaSize - 2.5) / Math.max(Math.abs(sx), Math.abs(sz), (Math.abs(sx) + Math.abs(sz)) / Math.SQRT2);
    const x = sx * r, z = sz * r;
    let distance = Infinity;
    if (avoid) for (const e of avoid) distance = Math.min(distance, Math.hypot(e.x - x, e.z - z));
    candidates.push({ x, z, distance });
  }
  const best = Math.max(...candidates.map((point) => point.distance));
  const safe = candidates.filter((point) => point.distance >= Math.min(7, best - 1));
  const { x, z } = safe[(Math.random() * safe.length) | 0];
  return { x, z };
}

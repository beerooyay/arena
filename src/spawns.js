let arenaSize = 34;
export function setArenaSize(size) { arenaSize = size; }

const lane = [-0.38, -0.13, 0.13, 0.38];
export const SPAWNS_PER_TEAM = lane.length;
export const SPAWN_EYE_Y = 1.7;

// Match openers: each team holds its own side. `slot` spreads the squad
// across the four lanes.
export function teamSpawnXZ(teamId, slot = 0) {
  const s = ((slot % SPAWNS_PER_TEAM) + SPAWNS_PER_TEAM) % SPAWNS_PER_TEAM;
  const x = lane[s] * arenaSize;
  const z = (teamId === 0 ? 1 : -1) * (arenaSize - 9.5);
  return { x, z };
}

// Respawns: eight anchor points ringing the octagon (between the wall faces),
// chosen randomly with a bias toward spots away from live enemies — the chaos
// of spawning anywhere, minus spawning on top of a rifle.
const RING = 8;
export function scatterSpawnXZ(avoid = null) {
  const r = arenaSize - 10;
  const safe = [];
  for (let i = 0; i < RING * 2; i++) {
    const a = (i / RING) * Math.PI * 2 + (i >= RING ? Math.PI / RING : 0) + (Math.random() - 0.5) * 0.35;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    let d = Infinity;
    if (avoid) for (const e of avoid) { const dd = Math.hypot(e.x - x, e.z - z); if (dd < d) d = dd; }
    if (d > 7) safe.push({ x, z });
  }
  return safe.length ? safe[(Math.random() * safe.length) | 0] : { x: (Math.random() - 0.5) * r, z: (Math.random() - 0.5) * r };
}

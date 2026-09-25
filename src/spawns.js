let arenaSize = 34;
export function setArenaSize(size) { arenaSize = size; }

const lane = [-0.38, -0.13, 0.13, 0.38];
export const SPAWNS_PER_TEAM = lane.length;
export const SPAWN_EYE_Y = 1.7;

export function teamSpawnXZ(teamId, slot = 0) {
  const s = ((slot % SPAWNS_PER_TEAM) + SPAWNS_PER_TEAM) % SPAWNS_PER_TEAM;
  const x = lane[s] * arenaSize;
  const z = (teamId === 0 ? 1 : -1) * (arenaSize - 9.5);
  return { x, z };
}

export function tankSpawn(teamId) {
  const x = arenaSize * 0.4, z = (teamId === 0 ? 1 : -1) * (arenaSize - 8);
  return { x, z, heading: teamId === 0 ? Math.PI : 0 };
}

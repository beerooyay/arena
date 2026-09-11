/**
 * Team spawn points — five per team, lined up just in front of each team's back
 * wall so a full squad drops in spread across their side instead of stacking on
 * one point. BLUE (team 0) spawns along the +Z wall, RED (team 1) along the -Z
 * wall. Shared by the local player, the bots, and online avatars so slots stay
 * consistent and nobody overlaps.
 *
 * Spawns scale with the CURRENT map's half-extent — call setArenaSize() right
 * after building the arena, before anything spawns. (At size 60 this reproduces
 * the original map-1 spawn points exactly.)
 */

let ARENA = 60; // current map half-extent (set by setArenaSize before any spawn)
export function setArenaSize(size) { ARENA = size; }

const XFRAC = [-2 / 3, -1 / 3, 0, 1 / 3, 2 / 3]; // five lanes across the arena width
export const SPAWNS_PER_TEAM = XFRAC.length;
export const SPAWN_EYE_Y = 1.7;

/**
 * Floor {x, z} for a team's spawn slot. Slots wrap if out of range so callers
 * never have to clamp.
 * @param {number} teamId 0 = BLUE (+Z), 1 = RED (-Z)
 * @param {number} slot   0..4
 */
export function teamSpawnXZ(teamId, slot = 0) {
  const s = ((slot % SPAWNS_PER_TEAM) + SPAWNS_PER_TEAM) % SPAWNS_PER_TEAM;
  return { x: XFRAC[s] * ARENA, z: (teamId === 0 ? 1 : -1) * (ARENA - 8) };
}

/**
 * Tank spawn for a team: parked in the back corner, clear of the five spawn
 * lanes, facing into the arena. BLUE (+Z) faces -Z (heading PI); RED faces +Z.
 */
export function tankSpawn(teamId) {
  const x = ARENA - 14, z = ARENA - 5;
  return teamId === 0
    ? { x, z, heading: Math.PI }
    : { x: -x, z: -z, heading: 0 };
}

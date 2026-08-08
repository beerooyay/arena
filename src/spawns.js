/**
 * Team spawn points — five per team, lined up just in front of each team's back
 * wall so a full squad drops in spread across their side instead of stacking on
 * one point. BLUE (team 0) spawns along the +Z wall, RED (team 1) along the -Z
 * wall. Shared by the local player, the bots, and online avatars so slots stay
 * consistent and nobody overlaps.
 */

const ARENA = 60;            // matches arena.js half-extent
const FRONT_Z = ARENA - 8;   // 52 — a few metres off the perimeter wall
const XS = [-40, -20, 0, 20, 40]; // five lanes across the arena width

export const SPAWNS_PER_TEAM = XS.length;
export const SPAWN_EYE_Y = 1.7;

/**
 * Floor {x, z} for a team's spawn slot. Slots wrap if out of range so callers
 * never have to clamp.
 * @param {number} teamId 0 = BLUE (+Z), 1 = RED (-Z)
 * @param {number} slot   0..4
 */
export function teamSpawnXZ(teamId, slot = 0) {
  const s = ((slot % SPAWNS_PER_TEAM) + SPAWNS_PER_TEAM) % SPAWNS_PER_TEAM;
  return { x: XS[s], z: (teamId === 0 ? 1 : -1) * FRONT_Z };
}

import * as THREE from 'three';
import { makeAvatar, disposeAvatar } from './playerGlow.js';
import { teamSpawnXZ } from './spawns.js';

/**
 * BotSystem — compact team deathmatch AI.
 *
 * Two teams (FIRE = player's team, WHITE = enemy). The player fills one FIRE
 * slot, so FIRE spawns perTeam-1 bots and WHITE spawns perTeam bots.
 *
 * Bots roam the arena, pick the nearest visible enemy, keep a fighting distance,
 * and fire through the shared projectile pipeline. Tagging the player triggers
 * `onPlayerTagged`.
 */

// Bot display names, kept per-team so they stay stable across respawns.
export const FIRE_NAMES = ['Flare', 'Ember', 'Bolt', 'Drift', 'Nova', 'Rook'];
export const WHITE_NAMES = ['Ghost', 'Ivory', 'Ash', 'Frost', 'Pearl', 'Snow'];

// Skill presets, indexed by the Bot Difficulty setting (0=chill, 1=pro, 2=sweat).
// err: aim jitter in radians. fire: multiplier on the player's fireInterval.
// react: ms of held line-of-sight before the first shot. engage: firing range.
const SKILL = [
  { err: 0.14,  fire: 2.2, react: 800, engage: 32 },
  { err: 0.07,  fire: 1.5, react: 400, engage: 45 },
  { err: 0.035, fire: 1.0, react: 150, engage: 55 },
];

// nearest positive ray-sphere hit distance, or -1 if none
function raySphere(origin, dir, center, radius) {
  const ox = origin.x - center.x, oy = origin.y - center.y, oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? (c <= 0 ? 0 : -1) : t;
}

export class BotSystem {
  constructor(scene, arena, opts = {}) {
    this.scene = scene;
    this.arena = arena;
    this.spawnProjectile = opts.spawnProjectile || (() => {});
    this.onPlayerTagged = opts.onPlayerTagged || (() => {});
    this.onFire = opts.onFire || null; // (muzzlePos, hex, dir, teamId) for audio + net replication
    this.onTag = opts.onTag || null;   // fired whenever a combatant is tagged
    this.onBotDown = null;             // (botIndex, byTeamId) — every bot death, any cause
    this.extraTargets = [];            // online: remote players the bots should fight
    this.paint = opts.paint || null;

    this.perTeam = 5;
    this.fireInterval = opts.fireInterval ?? 90; // ms — matches the player
    this.skill = SKILL[1];
    this.hitsToTag = 3; // hits needed to drop a bot in standard play
    this.onPlayerHit = opts.onPlayerHit || null; // (teamId, hex, shooter) => lethal?

    // First spawn slot bots take per team; human players occupy the slots below
    // it. Free play: the player holds FIRE slot 0, so FIRE bots start at slot 1.
    // Online: the host sets this to the number of humans on each team.
    this._slotBase = [1, 0];

    this.teams = [
      { id: 0, name: 'FIRE',    hex: 0xff6000 },
      { id: 1, name: 'WHITE', hex: 0xf4f6f8 },
    ];
    this.scores = [0, 0];
    this.bots = [];
    this.enabled = false;

    this._player = { pos: new THREE.Vector3(), team: 0, alive: true };
    this._playerInvulnUntil = 0;

    this._ray = new THREE.Raycaster();
    this._tmp = new THREE.Vector3();
    this._chest = new THREE.Vector3();
    this._tChest = new THREE.Vector3();
    this._los = new THREE.Vector3();
    this._move = new THREE.Vector3();
    this._to = new THREE.Vector3();
  }

  setDifficulty(i) {
    this.skill = SKILL[Math.max(0, Math.min(SKILL.length - 1, i | 0))];
  }

  setEnabled(on) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) this.respawnAll();
    else this._despawnAll();
  }

  setInvisible(invisible) {
    for (const b of this.bots) {
      if (!b.alive) { b.group.visible = false; continue; }
      b.group.visible = !invisible;
    }
  }

  addPaintHit(bot, threshold, shooter) {
    if (!bot.alive) return false;
    bot.paintHits++;
    if (bot.paintHits >= threshold) {
      const now = performance.now();
      this._tagBot(bot, bot.team.id === 0 ? 1 : 0, now, shooter || null);
      return true;
    }
    return false;
  }

  respawnAll(blueBots = this.perTeam - 1, redBots = this.perTeam) {
    this._despawnAll();
    this.scores = [0, 0];
    this._counts = [blueBots, redBots];
    for (let i = 0; i < blueBots; i++) this._spawnBot(this.teams[0], i);
    for (let i = 0; i < redBots; i++) this._spawnBot(this.teams[1], i);
  }

  /** Enable with explicit per-team bot counts (online lobby backfill). */
  setEnabledCounts(blueBots, redBots) {
    this.enabled = blueBots + redBots > 0;
    this.respawnAll(blueBots, redBots);
    if (!this.enabled) this._despawnAll();
  }

  /** Compact per-bot state for network sync: [x, z, yaw, alive]. */
  netSnapshot() {
    return this.bots.map((b) => [
      +b.pos.x.toFixed(1), +b.pos.z.toFixed(1),
      +b.group.rotation.y.toFixed(2), b.alive ? 1 : 0,
    ]);
  }

  /** Host-authoritative kill of a bot by index (client hits arrive as messages). */
  tagBotByIndex(idx, byTeamId) {
    const bot = this.bots[idx];
    if (!bot || !bot.alive) return false;
    this._tagBot(bot, byTeamId, performance.now(), null);
    return true;
  }

  /** Kill a bot with NO team credit — environmental (e.g. the angry moon). */
  moonKill(idx) {
    const bot = this.bots[idx];
    if (!bot || !bot.alive) return false;
    bot.alive = false;
    bot.respawnAt = performance.now() + 3000;
    bot.deaths++;
    this._startRagdoll(bot);
    if (this.paint) { for (const d of bot.bodyDecals) this.paint.removeDecal(d); bot.bodyDecals = []; }
    return true;
  }

  _despawnAll() {
    for (const b of this.bots) {
      if (this.paint) for (const d of b.bodyDecals) this.paint.removeDecal(d);
      this.scene.remove(b.group);
      disposeAvatar(b.group);
    }
    this.bots.length = 0;
  }

  /** Bots fill the spawn slots above the humans on each team (see _slotBase). */
  setSlotBase(blue, red) { this._slotBase = [blue, red]; }

  _spawnPoint(team, idx) {
    const { x, z } = teamSpawnXZ(team.id, this._slotBase[team.id] + idx);
    return new THREE.Vector3(x, 0, z);
  }

  _spawnBot(team, idx) {
    const namePool = team.id === 0 ? FIRE_NAMES : WHITE_NAMES;
    const name = namePool[idx % namePool.length];
    const { group, body, head, bodyMat, teamMat, label, marker, armL, armR, legL, legR } = makeAvatar(name, team.hex);

    const bot = {
      team, hex: team.hex, group, body, head, bodyMat, ringMat: teamMat,
      name, label, marker, armL, armR, legL, legR,
      kills: 0, deaths: 0, shots: 0,
      pos: this._spawnPoint(team, idx),
      spawn: null,
      alive: true, respawnAt: 0,
      hp: 100,
      lastShot: 0, burst: 0, reloadUntil: 0, lockAt: 0,
      wanderT: 0, strafeSign: Math.random() < 0.5 ? -1 : 1,
      rockPhase: Math.random() * Math.PI * 2,
      paintHits: 0,
      bodyDecals: [],
      ragdoll: null,
    };
    bot.spawn = bot.pos.clone();
    group.position.copy(bot.pos);
    this.scene.add(group);
    this.bots.push(bot);
  }

  _respawn(bot) {
    bot.alive = true;
    bot.hp = 100;
    bot.pos.copy(bot.spawn);
    bot.group.position.copy(bot.pos);
    bot.group.rotation.set(0, bot.group.rotation.y, 0);
    bot.group.scale.set(1.06, 1.1, 1.06); // matches makeAvatar's build scale
    bot.group.visible = true;
    bot.label.visible = true;
    bot.armL.rotation.x = 0; bot.armR.rotation.x = 0;
    bot.legL.rotation.x = 0; bot.legR.rotation.x = 0;
    bot.ragdoll = null;
    bot.bodyMat.color.copy(bot.bodyMat.userData.baseColor || bot.bodyMat.color);
    bot.ringMat.emissiveIntensity = bot.ringMat.userData.baseEmissive ?? 0.32;
    bot.burst = 0; bot.reloadUntil = 0; bot.lockAt = 0;
    bot.paintHits = 0;
    bot.bodyDecals = [];
  }

  // Topples the avatar over so it comes to rest LYING on the floor — a cheap
  // ragdoll-style drop. The corpse stays until the respawn timer brings it back.
  _startRagdoll(bot) {
    bot.ragdoll = { t: 0, dur: 0.5, dir: Math.random() < 0.5 ? -1 : 1 };
    bot.label.visible = false;
  }

  _updateRagdoll(bot, dt) {
    const r = bot.ragdoll;
    r.t = Math.min(r.dur, r.t + dt);
    const e = 1 - (1 - r.t / r.dur) * (1 - r.t / r.dur); // ease-out
    // rotate around the feet onto the side, plus a little forward slump — the
    // group origin is at the feet, so ~90deg lays the whole body on the floor
    bot.group.rotation.z = r.dir * e * (Math.PI / 2 - 0.12);
    bot.group.rotation.x = e * 0.25;
    bot.group.position.y = bot.pos.y; // stays ON the floor, never through it
    if (r.t >= r.dur) bot.ragdoll = null; // corpse lies there until respawn
  }

  _tagBot(bot, byTeamId, now, shooter) {
    bot.alive = false;
    bot.respawnAt = now + 3000;
    this.scores[byTeamId]++;
    bot.deaths++;
    if (shooter && typeof shooter.kills === 'number') shooter.kills++;
    if (this.onBotDown) this.onBotDown(this.bots.indexOf(bot), byTeamId);
    this._startRagdoll(bot);
    // remove paint splatters that hit this bot's body
    if (this.paint) {
      for (const d of bot.bodyDecals) this.paint.removeDecal(d);
      bot.bodyDecals = [];
    }
  }

  _nearestEnemy(bot) {
    let best = null, bd = Infinity;
    for (const b of this.bots) {
      if (!b.alive || b.team.id === bot.team.id || b === bot) continue;
      const d = b.pos.distanceToSquared(bot.pos);
      if (d < bd) { bd = d; best = { kind: 'bot', pos: b.pos }; }
    }
    if (this._player.alive && this._player.team !== bot.team.id) {
      const d = this._player.pos.distanceToSquared(bot.pos);
      if (d < bd) { bd = d; best = { kind: 'player', pos: this._player.pos }; }
    }
    // online: remote human players (fed by netplay each frame on the host)
    for (const t of this.extraTargets) {
      if (!t.alive || t.team === bot.team.id) continue;
      const d = t.pos.distanceToSquared(bot.pos);
      if (d < bd) { bd = d; best = { kind: 'remote', pos: t.pos }; }
    }
    return best;
  }

  _hasLOS(a, b) {
    const dir = this._los.subVectors(b, a);
    const d = dir.length();
    if (d < 1e-3) return true;
    dir.multiplyScalar(1 / d);
    this._ray.set(a, dir);
    this._ray.far = d - 0.5;
    return this._ray.intersectObjects(this.arena.paintTargets, false).length === 0;
  }

  _collide(bot) {
    const r = 0.4;
    for (const box of this.arena.blockers) {
      if (1.8 <= box.min.y || 0 >= box.max.y) continue;
      const minX = box.min.x - r, maxX = box.max.x + r;
      const minZ = box.min.z - r, maxZ = box.max.z + r;
      if (bot.pos.x > minX && bot.pos.x < maxX && bot.pos.z > minZ && bot.pos.z < maxZ) {
        const dL = bot.pos.x - minX, dR = maxX - bot.pos.x;
        const dB = bot.pos.z - minZ, dF = maxZ - bot.pos.z;
        const m = Math.min(dL, dR, dB, dF);
        if (m === dL) bot.pos.x = minX;
        else if (m === dR) bot.pos.x = maxX;
        else if (m === dB) bot.pos.z = minZ;
        else bot.pos.z = maxZ;
      }
    }
    // push out of the tanks (cylinder approximation)
    if (this.tankSolids) {
      for (const ts of this.tankSolids) {
        const dx = bot.pos.x - ts.x, dz = bot.pos.z - ts.z;
        const d2 = dx * dx + dz * dz, md = ts.r + r;
        if (d2 > 1e-4 && d2 < md * md) {
          const d = Math.sqrt(d2), push = (md - d) / d;
          bot.pos.x += dx * push; bot.pos.z += dz * push;
        }
      }
    }
  }

  /** @param {{playerPos:THREE.Vector3, playerTeam:number, playerAlive:boolean, now:number}} ctx */
  update(dt, ctx) {
    this._player.pos.copy(ctx.playerPos);
    this._player.team = ctx.playerTeam;
    this._player.alive = ctx.playerAlive;
    if (!this.enabled) return;

    const now = ctx.now;
    for (const bot of this.bots) {
      if (!bot.alive) {
        if (bot.ragdoll) this._updateRagdoll(bot, dt);
        if (now >= bot.respawnAt) this._respawn(bot);
        continue;
      }

      const tgt = this._nearestEnemy(bot);
      if (!tgt) continue;

      const to = this._to.set(tgt.pos.x - bot.pos.x, 0, tgt.pos.z - bot.pos.z);
      const dist = to.length() || 1;
      to.multiplyScalar(1 / dist);

      // steering: approach if far, back off if close, otherwise strafe
      const move = this._move.set(0, 0, 0);
      if (dist > 16) move.copy(to);
      else if (dist < 7) move.copy(to).multiplyScalar(-1);
      else move.set(-to.z, 0, to.x).multiplyScalar(bot.strafeSign);

      bot.wanderT -= dt;
      if (bot.wanderT <= 0) { bot.wanderT = 0.6 + Math.random(); bot.strafeSign = Math.random() < 0.5 ? -1 : 1; }
      move.x += (Math.random() * 2 - 1) * 0.15;
      move.z += (Math.random() * 2 - 1) * 0.15;

      if (move.lengthSq() > 0) {
        move.normalize();
        const spd = 6.0;
        bot.pos.x += move.x * spd * dt;
        bot.pos.z += move.z * spd * dt;
      }
      this._collide(bot);
      const bnd = this.arena.size - 0.8, diagBnd = bnd * Math.SQRT2;
      bot.pos.x = THREE.MathUtils.clamp(bot.pos.x, -bnd, bnd);
      bot.pos.z = THREE.MathUtils.clamp(bot.pos.z, -bnd, bnd);
      const bSum = bot.pos.x + bot.pos.z;
      if (bSum > diagBnd) { const d = (bSum - diagBnd) * 0.5; bot.pos.x -= d; bot.pos.z -= d; }
      else if (bSum < -diagBnd) { const d = (-bSum - diagBnd) * 0.5; bot.pos.x += d; bot.pos.z += d; }
      const bSub = bot.pos.x - bot.pos.z;
      if (bSub > diagBnd) { const d = (bSub - diagBnd) * 0.5; bot.pos.x -= d; bot.pos.z += d; }
      else if (bSub < -diagBnd) { const d = (-bSub - diagBnd) * 0.5; bot.pos.x += d; bot.pos.z += d; }
      bot.group.position.copy(bot.pos);
      bot.group.rotation.y = Math.atan2(to.x, to.z);

      // running rock: side-to-side lean + a little vertical bob while moving
      const moving = move.lengthSq() > 1e-4;
      bot.rockPhase += dt * (moving ? 9 : 0);
      bot.group.rotation.z = moving ? Math.sin(bot.rockPhase) * 0.11 : 0;
      bot.group.position.y = bot.pos.y + (moving ? Math.abs(Math.sin(bot.rockPhase)) * 0.09 : 0);

      // walk cycle: legs swing from the hip, arms counter-swing from the
      // opposite leg — eased toward zero when the bot stops moving.
      const ease = Math.min(1, dt * 10);
      const legTarget = moving ? Math.sin(bot.rockPhase) * 0.55 : 0;
      const armTarget = moving ? Math.sin(bot.rockPhase) * 0.06 : 0; // hands stay on the rifle
      bot.legL.rotation.x += (legTarget - bot.legL.rotation.x) * ease;
      bot.legR.rotation.x += (-legTarget - bot.legR.rotation.x) * ease;
      bot.armL.rotation.x += (-armTarget - bot.armL.rotation.x) * ease;
      bot.armR.rotation.x += (armTarget - bot.armR.rotation.x) * ease;

      // firing
      const chest = this._chest.copy(bot.pos); chest.y += 1.45;
      const tChest = this._tChest.copy(tgt.pos);
      if (tgt.kind === 'player') tChest.y -= 0.45;
      else tChest.y += 1.2;

      // reaction time: the bot must hold sight on a target for `skill.react`
      // ms before its first shot — breaking line-of-sight resets the lock
      const seen = dist < this.skill.engage && this._hasLOS(chest, tChest);
      if (!seen) bot.lockAt = 0;
      else if (!bot.lockAt) bot.lockAt = now;

      if (seen && now - bot.lockAt >= this.skill.react &&
          now >= bot.reloadUntil &&
          (now - bot.lastShot) >= this.fireInterval * this.skill.fire) {
        bot.lastShot = now;
        const aim = new THREE.Vector3().subVectors(tChest, chest).normalize();
        aim.x += (Math.random() * 2 - 1) * this.skill.err;
        aim.y += (Math.random() * 2 - 1) * this.skill.err * 0.75;
        aim.z += (Math.random() * 2 - 1) * this.skill.err;
        aim.normalize();
        const origin = chest.clone().addScaledVector(aim, 0.6);
        this.spawnProjectile(origin, aim, bot.hex, bot.team.id, 190, false, bot);
        bot.shots++;
        if (this.onFire) this.onFire(origin, bot.hex, aim, bot.team.id);
        bot.burst++;
        if (bot.burst >= 4 + ((Math.random() * 3) | 0)) {
          bot.burst = 0;
          bot.reloadUntil = now + 600 + Math.random() * 800;
        }
      }
    }
  }

  /**
   * Test a projectile segment against enemy combatants and apply a tag on hit.
   * @returns {boolean} true if an enemy was tagged (projectile consumed)
   */
  hitscan(origin, dir, maxDist, shooterTeamId, hex, shooter) {
    if (!this.enabled) return false;
    const now = performance.now();
    let best = null, bestT = maxDist;

    for (const b of this.bots) {
      if (!b.alive || b.team.id === shooterTeamId) continue;
      this._tmp.copy(b.pos); this._tmp.y += 1.3;
      const t = raySphere(origin, dir, this._tmp, 0.8);
      if (t >= 0 && t < bestT) { bestT = t; best = { kind: 'bot', bot: b, t }; }
    }
    if (this._player.alive && this._player.team !== shooterTeamId && now >= this._playerInvulnUntil) {
      this._tmp.copy(this._player.pos); this._tmp.y -= 0.55;
      const t = raySphere(origin, dir, this._tmp, 0.85);
      if (t >= 0 && t < bestT) { bestT = t; best = { kind: 'player', t }; }
    }

    if (!best) return false;
    this._tmp.copy(origin).addScaledVector(dir, best.t); // impact point

    if (best.kind === 'bot') {
      const bot = best.bot;
      const headshot = this._tmp.y >= bot.pos.y + 1.72;
      const dmg = headshot ? 100 : 50;
      bot.hp -= dmg;
      const killed = bot.hp <= 0;
      if (killed) this._tagBot(bot, shooterTeamId, now, shooter);
      if (this.onTag) {
        this.onTag({ shooter, victimName: bot.name, victimIsPlayer: false, pos: this._tmp, wounded: !killed, headshot });
      }
    } else {
      const headshot = this._tmp.y >= this._player.pos.y - 0.25;
      const dmg = headshot ? 100 : 50;
      const lethal = this.onPlayerHit ? this.onPlayerHit(shooterTeamId, hex, shooter, dmg, headshot) : true;
      if (this.onTag) {
        this.onTag({ shooter, victimName: 'YOU', victimIsPlayer: true, pos: this._tmp, wounded: !lethal, headshot });
      }
      if (lethal) {
        this._playerInvulnUntil = now + 1500;
        this.scores[shooterTeamId]++;
        if (shooter && typeof shooter.kills === 'number') shooter.kills++;
        this.onPlayerTagged(shooterTeamId, hex, shooter ? shooter.name : '');
      }
    }
    return true;
  }

  applyBlast(center, radius, maxDmg, shooterTeamId, shooter) {
    if (!this.enabled) return;
    const now = performance.now();
    for (const b of this.bots) {
      if (!b.alive || b.team.id === shooterTeamId) continue;
      const d = b.pos.distanceTo(center);
      if (d <= radius) {
        const falloff = 1 - d / radius;
        const dmg = Math.round(maxDmg * Math.max(0.3, falloff));
        b.hp -= dmg;
        const killed = b.hp <= 0;
        if (killed) this._tagBot(b, shooterTeamId, now, shooter);
        if (this.onTag) {
          this.onTag({ shooter, victimName: b.name, victimIsPlayer: false, pos: b.pos, wounded: !killed, blast: true });
        }
      }
    }
    if (this._player.alive && this._player.team !== shooterTeamId && now >= this._playerInvulnUntil) {
      const d = this._player.pos.distanceTo(center);
      if (d <= radius) {
        const falloff = 1 - d / radius;
        const dmg = Math.round(maxDmg * Math.max(0.3, falloff));
        const lethal = this.onPlayerHit ? this.onPlayerHit(shooterTeamId, 0xff6000, shooter, dmg, false) : true;
        if (this.onTag) {
          this.onTag({ shooter, victimName: 'YOU', victimIsPlayer: true, pos: this._player.pos, wounded: !lethal, blast: true });
        }
        if (lethal) {
          this._playerInvulnUntil = now + 1500;
          this.scores[shooterTeamId]++;
          if (shooter && typeof shooter.kills === 'number') shooter.kills++;
          this.onPlayerTagged(shooterTeamId, 0xff6000, shooter ? shooter.name : '');
        }
      }
    }
  }

  /**
   * Test a projectile segment against enemy combatants for invisible mode.
   * Increments paint hits instead of instant kill; returns true only when threshold reached.
   * @returns {boolean} true if threshold reached (projectile consumed)
   */
  hitscanPaint(origin, dir, maxDist, shooterTeamId, threshold, hex) {
    if (!this.enabled) return false;
    const now = performance.now();
    let best = null, bestT = maxDist;

    for (const b of this.bots) {
      if (!b.alive || b.team.id === shooterTeamId) continue;
      this._tmp.copy(b.pos); this._tmp.y += 1.3;
      const t = raySphere(origin, dir, this._tmp, 0.8);
      if (t >= 0 && t < bestT) { bestT = t; best = { kind: 'bot', bot: b, t }; }
    }
    if (this._player.alive && this._player.team !== shooterTeamId && now >= this._playerInvulnUntil) {
      this._tmp.copy(this._player.pos); this._tmp.y -= 0.55;
      const t = raySphere(origin, dir, this._tmp, 0.85);
      if (t >= 0 && t < bestT) { bestT = t; best = { kind: 'player', t }; }
    }

    if (!best) return false;
    if (best.kind === 'bot') {
      this._splatBot(best.bot, origin, dir, best.t, hex);
      const killed = this.addPaintHit(best.bot, threshold);
      return killed;
    } else {
      // Player hit - track via callback
      this._playerInvulnUntil = now + 1500;
      this.onPlayerPaintHit(threshold);
      return true;
    }
  }

  /**
   * Bodies are intentionally NOT painted. A decal projected onto a moving bot
   * bakes into world space at the hit point, so it floats where the bot *was*
   * (and its drips linger untracked) — the "leftover paint from dead players"
   * artifact. Combat feedback comes from the wet-splat sound + kill feed + the
   * victim's paint-border instead; only the static arena keeps paint.
   */
  _splatBot(/* bot, origin, dir, t, hex */) {}

  onPlayerPaintHit(threshold) {
    // This will be set by main.js
  }
}

import * as THREE from 'three';

/**
 * BotSystem — simple 5v5 paintball AI.
 *
 * Two teams (BLUE = player's team, RED = enemy). The player fills one BLUE slot,
 * so BLUE spawns perTeam-1 bots and RED spawns perTeam bots.
 *
 * Bots roam the open floor, pick the nearest visible enemy, keep a fighting
 * distance, and fire paintballs at the SAME rate of fire as the player
 * (fireInterval, in ms) using the shared projectile pipeline via `spawnProjectile`.
 * Getting tagged by an enemy paintball drops a bot for a few seconds, then it
 * respawns. Tagging the player triggers `onPlayerTagged`.
 */

// Bot display names, kept per-team so they stay stable across respawns.
export const BLUE_NAMES = ['Frost', 'Cobalt', 'Echo', 'Drift', 'Zephyr', 'Nova'];
export const RED_NAMES  = ['Blaze', 'Crimson', 'Havoc', 'Ember', 'Rogue', 'Viper'];

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// A camera-facing name label (canvas texture on a Sprite) with a team-colored
// outline, so you can read who's who from any angle.
function makeNameSprite(text, hex) {
  const fs = 44, padX = 16, padY = 8;
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = `700 ${fs}px Inter, system-ui, sans-serif`;
  const w = Math.ceil(meas.measureText(text).width) + padX * 2;
  const h = fs + padY * 2;

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.font = `700 ${fs}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  roundRect(ctx, 2, 2, w - 4, h - 4, 14); ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#' + hex.toString(16).padStart(6, '0');
  roundRect(ctx, 3, 3, w - 6, h - 6, 13); ctx.stroke();
  ctx.fillStyle = '#1c1f24';
  ctx.fillText(text, w / 2, h / 2 + 2);

  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.0045; // world units per canvas pixel
  sprite.scale.set(w * scale, h * scale, 1);
  sprite.position.y = 2.55;
  return sprite;
}

/**
 * A simplified paintball marker for a bot to carry — same silhouette as the
 * player's viewmodel (barrel, body, grip, loader, tank) but far cheaper.
 * Geometries are per-bot so _despawnAll() can dispose them safely.
 * Metalness stays 0: there's no env map, and metal would render near-black.
 */
function makeBotMarker(hopperMat) {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xc2c8ce, roughness: 0.6, metalness: 0,
  });
  const add = (geo, mat, x, y, z, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    m.castShadow = true;
    g.add(m);
  };
  // barrel runs along +Z, which is a bot's forward axis
  add(new THREE.CylinderGeometry(0.026, 0.026, 0.44, 10), bodyMat, 0, 0, 0.30, Math.PI / 2);
  add(new THREE.BoxGeometry(0.085, 0.115, 0.28), bodyMat, 0, -0.045, 0.02);
  add(new THREE.BoxGeometry(0.065, 0.17, 0.08), bodyMat, 0, -0.165, -0.05);
  add(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 10), bodyMat, 0, -0.085, -0.22, Math.PI / 2);
  // loader, filled with a mass in the team's paint colour
  add(new THREE.CylinderGeometry(0.082, 0.082, 0.13, 12), bodyMat, 0, 0.10, 0.01);
  add(new THREE.CylinderGeometry(0.068, 0.068, 0.10, 12), hopperMat, 0, 0.10, 0.01);
  g.userData.bodyMat = bodyMat;
  return g;
}

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

    this.teams = [
      { id: 0, name: 'BLUE', hex: 0x2f7bff },
      { id: 1, name: 'RED',  hex: 0xff3b3b },
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

  addPaintHit(bot, threshold) {
    if (!bot.alive) return false;
    bot.paintHits++;
    if (bot.paintHits >= threshold) {
      const now = performance.now();
      this._tagBot(bot, bot.team.id === 0 ? 1 : 0, now);
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

  _despawnAll() {
    for (const b of this.bots) {
      if (this.paint) for (const d of b.bodyDecals) this.paint.removeDecal(d);
      this.scene.remove(b.group);
      b.bodyMat.dispose();
      b.ringMat.dispose();
      if (b.label) { b.label.material.map.dispose(); b.label.material.dispose(); }
      if (b.marker && b.marker.userData.bodyMat) b.marker.userData.bodyMat.dispose();
      b.group.traverse((o) => o.geometry && o.geometry.dispose());
    }
    this.bots.length = 0;
  }

  _spawnPoint(team, idx) {
    const side = team.id === 0 ? 1 : -1;
    const z = side * (22 + (idx % 2) * 7);
    const x = -18 + idx * 9 + (Math.random() * 4 - 2);
    return new THREE.Vector3(x, 0, z);
  }

  _spawnBot(team, idx) {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
    const ringMat = new THREE.MeshStandardMaterial({
      color: team.hex, roughness: 0.5, metalness: 0,
      emissive: new THREE.Color(team.hex), emissiveIntensity: 0.25,
    });

    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 6, 12), bodyMat);
    body.position.y = 1.0; body.castShadow = true; body.receiveShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), bodyMat);
    head.position.y = 1.78; head.castShadow = true;

    // team-colored chest ring (visible from any angle) + head marker
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.08, 10, 24), ringMat);
    ring.position.y = 1.15; ring.rotation.x = Math.PI / 2; ring.castShadow = true;
    const crown = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), ringMat);
    crown.position.y = 2.06;

    const namePool = team.id === 0 ? BLUE_NAMES : RED_NAMES;
    const name = namePool[idx % namePool.length];
    const label = makeNameSprite(name, team.hex);

    // every bot visibly carries a marker, held out clear of the body capsule
    // (radius 0.35) so it reads from any angle instead of clipping inside
    const marker = makeBotMarker(ringMat);
    marker.position.set(0.47, 1.16, 0.34);
    marker.rotation.y = -0.10; // angled slightly inward, like a held gun

    group.add(body, head, ring, crown, label, marker);

    const bot = {
      team, hex: team.hex, group, body, head, bodyMat, ringMat,
      name, label, marker,
      kills: 0, deaths: 0, shots: 0,
      pos: this._spawnPoint(team, idx),
      spawn: null,
      alive: true, respawnAt: 0,
      lastShot: 0, burst: 0, reloadUntil: 0,
      wanderT: 0, strafeSign: Math.random() < 0.5 ? -1 : 1,
      rockPhase: Math.random() * Math.PI * 2,
      paintHits: 0,
      bodyDecals: [],
    };
    bot.spawn = bot.pos.clone();
    group.position.copy(bot.pos);
    this.scene.add(group);
    this.bots.push(bot);
  }

  _respawn(bot) {
    bot.alive = true;
    bot.pos.copy(bot.spawn);
    bot.group.position.copy(bot.pos);
    bot.group.scale.set(1, 1, 1);
    bot.group.visible = true;
    bot.bodyMat.color.setHex(0xffffff);
    bot.ringMat.emissiveIntensity = 0.25;
    bot.burst = 0; bot.reloadUntil = 0;
    bot.paintHits = 0;
    bot.bodyDecals = [];
  }

  _tagBot(bot, byTeamId, now, shooter) {
    bot.alive = false;
    bot.respawnAt = now + 3000;
    this.scores[byTeamId]++;
    bot.deaths++;
    if (shooter && typeof shooter.kills === 'number') shooter.kills++;
    if (this.onBotDown) this.onBotDown(this.bots.indexOf(bot), byTeamId);
    bot.group.visible = false;
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
  }

  /** @param {{playerPos:THREE.Vector3, playerTeam:number, playerAlive:boolean, now:number}} ctx */
  update(dt, ctx) {
    this._player.pos.copy(ctx.playerPos);
    this._player.team = ctx.playerTeam;
    this._player.alive = ctx.playerAlive;
    if (!this.enabled) return;

    const now = ctx.now;
    for (const bot of this.bots) {
      if (!bot.alive) { if (now >= bot.respawnAt) this._respawn(bot); continue; }

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
      bot.pos.x = THREE.MathUtils.clamp(bot.pos.x, -57, 57);
      bot.pos.z = THREE.MathUtils.clamp(bot.pos.z, -57, 57);
      bot.group.position.copy(bot.pos);
      bot.group.rotation.y = Math.atan2(to.x, to.z);

      // running rock: side-to-side lean + a little vertical bob while moving
      const moving = move.lengthSq() > 1e-4;
      bot.rockPhase += dt * (moving ? 9 : 0);
      bot.group.rotation.z = moving ? Math.sin(bot.rockPhase) * 0.11 : 0;
      bot.group.position.y = bot.pos.y + (moving ? Math.abs(Math.sin(bot.rockPhase)) * 0.09 : 0);

      // firing
      const chest = this._chest.copy(bot.pos); chest.y += 1.45;
      const tChest = this._tChest.copy(tgt.pos);
      if (tgt.kind !== 'player') tChest.y += 1.2;

      if (dist < 45 && now >= bot.reloadUntil &&
          (now - bot.lastShot) >= this.fireInterval && this._hasLOS(chest, tChest)) {
        bot.lastShot = now;
        const aim = new THREE.Vector3().subVectors(tChest, chest).normalize();
        aim.x += (Math.random() * 2 - 1) * 0.04;
        aim.y += (Math.random() * 2 - 1) * 0.03;
        aim.z += (Math.random() * 2 - 1) * 0.04;
        aim.normalize();
        const origin = chest.clone().addScaledVector(aim, 0.6);
        this.spawnProjectile(origin, aim, bot.hex, bot.team.id, 70, false, bot);
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
      this._tmp.copy(b.pos); this._tmp.y += 1.2;
      const t = raySphere(origin, dir, this._tmp, 0.7);
      if (t >= 0 && t < bestT) { bestT = t; best = { kind: 'bot', bot: b, t }; }
    }
    if (this._player.alive && this._player.team !== shooterTeamId && now >= this._playerInvulnUntil) {
      const t = raySphere(origin, dir, this._player.pos, 0.6);
      if (t >= 0 && t < bestT) { bestT = t; best = { kind: 'player', t }; }
    }

    if (!best) return false;
    this._tmp.copy(origin).addScaledVector(dir, best.t); // impact point
    if (best.kind === 'bot') {
      this._splatBot(best.bot, origin, dir, best.t, hex);
      this._tagBot(best.bot, shooterTeamId, now, shooter);
      if (this.onTag) {
        this.onTag({ shooter, victimName: best.bot.name, victimIsPlayer: false, pos: this._tmp });
      }
    } else {
      this._playerInvulnUntil = now + 1500;
      this.scores[shooterTeamId]++;
      if (shooter && typeof shooter.kills === 'number') shooter.kills++;
      if (this.onTag) {
        this.onTag({ shooter, victimName: 'YOU', victimIsPlayer: true, pos: this._tmp });
      }
      this.onPlayerTagged(shooterTeamId, hex, shooter);
    }
    return true;
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
      this._tmp.copy(b.pos); this._tmp.y += 1.2;
      const t = raySphere(origin, dir, this._tmp, 0.7);
      if (t >= 0 && t < bestT) { bestT = t; best = { kind: 'bot', bot: b, t }; }
    }
    if (this._player.alive && this._player.team !== shooterTeamId && now >= this._playerInvulnUntil) {
      const t = raySphere(origin, dir, this._player.pos, 0.6);
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

  /** Place a paint decal on the bot body at the approximate hit point. */
  _splatBot(bot, origin, dir, t, hex) {
    if (!this.paint) return;
    const center = this._tmp.copy(bot.pos); center.y += 1.2;
    const hit = this._chest.copy(origin).addScaledVector(dir, t);
    const normal = new THREE.Vector3().subVectors(hit, center).normalize();
    const decal = this.paint.splat(bot.body, hit, normal, hex, 0.22);
    if (decal) bot.bodyDecals.push(decal);
  }

  onPlayerPaintHit(threshold) {
    // This will be set by main.js
  }
}

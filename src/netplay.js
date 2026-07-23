import * as THREE from 'three';

/**
 * NetPlay — in-game multiplayer session on top of NetClient.
 *
 * v1 scope (drop-in skirmish):
 *  - remote players render as avatars (capsule + team ring + name label)
 *  - position/look sync at ~12Hz with smoothing on the receiving side
 *  - shots replicate as real projectiles in everyone's world
 *  - tags: shooter's client detects the hit, victim takes the paint-hit +
 *    respawn, team score updates for everyone, shooter gets the kill feed
 *  - host is the hub: joiner messages go to the host, which relays them on
 *  - bots sit out while a net session is live (PvP only, endless skirmish)
 *
 * Messages (over the data channels):
 *   welcome {you:{id,name,team}, roster:[{id,name,team}], scores:[b,r]}
 *   add     {p:{id,name,team}}          (host -> others when someone joins)
 *   remove  {id}
 *   s       {p:[x,y,z], ry}             (state, throttled)
 *   shot    {o:[x,y,z], d:[x,y,z], hex}
 *   tag     {victim, hex}               (shooter announces a confirmed hit)
 * Host relays joiner messages to the other peers with `from` stamped on.
 */

const TEAM_HEX = [0x2f7bff, 0xff3b3b]; // BLUE, RED — matches the game palette
const SEND_HZ = 12;
const EYE_HEIGHT = 1.7;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

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
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.82)';
  roundRect(ctx, 2, 2, w - 4, h - 4, 14); ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#' + hex.toString(16).padStart(6, '0');
  roundRect(ctx, 3, 3, w - 6, h - 6, 13); ctx.stroke();
  ctx.fillStyle = '#1c1f24';
  ctx.fillText(text, w / 2, h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  const scale = 0.0045;
  sprite.scale.set(w * scale, h * scale, 1);
  sprite.position.y = 2.55;
  return sprite;
}

function makeAvatar(name, teamHex) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
  const teamMat = new THREE.MeshStandardMaterial({
    color: teamHex, roughness: 0.5, metalness: 0,
    emissive: new THREE.Color(teamHex), emissiveIntensity: 0.25,
  });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 0.9, 6, 12), bodyMat);
  body.position.y = 1.0; body.castShadow = true;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), bodyMat);
  head.position.y = 1.78; head.castShadow = true;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.08, 10, 24), teamMat);
  ring.position.y = 1.25; ring.rotation.x = Math.PI / 2;
  const label = makeNameSprite(name, teamHex);
  group.add(body, head, ring, label);
  group.userData = { bodyMat, teamMat, label };
  return group;
}

// nearest positive ray-sphere hit distance, or -1
function raySphere(origin, dir, center, radius) {
  const ox = origin.x - center.x, oy = origin.y - center.y, oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? (c <= 0 ? 0 : -1) : t;
}

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _center = new THREE.Vector3();

export class NetPlay {
  /**
   * @param {import('./net.js').NetClient} net
   * @param {{scene, camera, spawnProjectile, onTagged, showKill,
   *          onRosterChange, onEnded}} deps
   */
  constructor(net, deps) {
    this.net = net;
    this.deps = deps;
    this.roster = new Map();   // id -> {id, name, team}
    this.remotes = new Map();  // id -> {group, cur:{...}, target:{...}}
    this.scores = [0, 0];
    this.me = null;            // {id, name, team}
    this._sendT = 0;
    this._nextIdx = 2;         // host is Player 1

    net.onPeer = (id) => this._onPeer(id);
    net.onPeerGone = (id) => this._onPeerGone(id);
    net.onData = (id, msg) => this._onData(id, msg);
    net.onClosed = (reason) => this._teardown(reason);
  }

  get active() { return this.net.active && this.me !== null; }

  beginHost() {
    this.me = { id: 'host', name: 'Player 1', team: 0 };
    this.roster.set('host', this.me);
    this.scores = [0, 0];
    this._nextIdx = 2;
    this.deps.onRosterChange();
  }

  beginClient() {
    // roster arrives in the host's `welcome`; me is set there
  }

  playerCount() { return this.roster.size; }

  // ---------------------------------------------------------------- host side
  _onPeer(id) {
    if (this.net.role !== 'host') return; // clients get `welcome` instead
    const p = { id, name: `Player ${this._nextIdx}`, team: (this._nextIdx - 1) % 2 };
    this._nextIdx++;
    this.roster.set(id, p);
    this._addRemote(p);
    this.net.sendTo(id, {
      t: 'welcome',
      you: p,
      roster: [...this.roster.values()],
      scores: this.scores,
    });
    this.net.send({ t: 'add', p }, id);
    this.deps.onRosterChange();
  }

  _onPeerGone(id) {
    if (this.net.role !== 'host') return;
    this.roster.delete(id);
    this._removeRemote(id);
    this.net.send({ t: 'remove', id });
    this.deps.onRosterChange();
  }

  // ------------------------------------------------------------------- shared
  _onData(fromId, msg) {
    // host relays joiner traffic to everyone else, stamped with the sender
    if (this.net.role === 'host' && msg.t !== 'welcome') {
      this.net.send({ ...msg, from: fromId }, fromId);
    }
    const senderId = this.net.role === 'host' ? fromId : (msg.from || 'host');

    switch (msg.t) {
      case 'welcome': {
        this.me = msg.you;
        this.scores = [...msg.scores];
        this.roster.clear();
        for (const p of msg.roster) {
          this.roster.set(p.id, p);
          if (p.id !== this.me.id) this._addRemote(p);
        }
        this.deps.onRosterChange();
        break;
      }
      case 'add': {
        this.roster.set(msg.p.id, msg.p);
        this._addRemote(msg.p);
        this.deps.onRosterChange();
        break;
      }
      case 'remove': {
        this.roster.delete(msg.id);
        this._removeRemote(msg.id);
        this.deps.onRosterChange();
        break;
      }
      case 's': {
        const r = this.remotes.get(senderId);
        if (r) {
          r.target.x = msg.p[0]; r.target.y = msg.p[1]; r.target.z = msg.p[2];
          r.target.ry = msg.ry;
        }
        break;
      }
      case 'shot': {
        const p = this.roster.get(senderId);
        this.deps.spawnProjectile(
          new THREE.Vector3(...msg.o), new THREE.Vector3(...msg.d),
          msg.hex, p ? p.team : 0, 70, false, null);
        break;
      }
      case 'tag': {
        const shooter = this.roster.get(senderId);
        if (shooter) this.scores[shooter.team]++;
        if (this.me && msg.victim === this.me.id) {
          this.deps.onTagged(shooter ? shooter.team : 0, msg.hex);
        }
        break;
      }
    }
  }

  _addRemote(p) {
    if (this.remotes.has(p.id)) return;
    const group = makeAvatar(p.name, TEAM_HEX[p.team]);
    group.position.set(0, 0, p.team === 0 ? 26 : -26);
    this.deps.scene.add(group);
    this.remotes.set(p.id, {
      group,
      target: { x: group.position.x, y: EYE_HEIGHT, z: group.position.z, ry: 0 },
    });
  }

  _removeRemote(id) {
    const r = this.remotes.get(id);
    if (!r) return;
    this.remotes.delete(id);
    this.deps.scene.remove(r.group);
    r.group.userData.bodyMat.dispose();
    r.group.userData.teamMat.dispose();
    const label = r.group.userData.label;
    label.material.map.dispose(); label.material.dispose();
    r.group.traverse((o) => o.geometry && o.geometry.dispose());
  }

  /** Called every frame from the main loop. */
  update(dt) {
    if (!this.active) return;

    // smooth remote avatars toward their latest network state
    const k = Math.min(1, dt * 10);
    for (const r of this.remotes.values()) {
      const g = r.group;
      g.position.x += (r.target.x - g.position.x) * k;
      g.position.z += (r.target.z - g.position.z) * k;
      g.position.y += ((r.target.y - EYE_HEIGHT) - g.position.y) * k; // eye -> feet
      let d = r.target.ry - g.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      g.rotation.y += d * k;
    }

    // broadcast my own state at SEND_HZ
    this._sendT += dt;
    if (this._sendT >= 1 / SEND_HZ) {
      this._sendT = 0;
      const cam = this.deps.camera;
      _euler.setFromQuaternion(cam.quaternion);
      this.net.send({
        t: 's',
        p: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
        ry: +_euler.y.toFixed(3),
      });
    }
  }

  /** Announce my shot so everyone else sees the paintball. */
  sendShot(origin, dir, hex) {
    if (!this.active) return;
    this.net.send({
      t: 'shot',
      o: [+origin.x.toFixed(2), +origin.y.toFixed(2), +origin.z.toFixed(2)],
      d: [+dir.x.toFixed(3), +dir.y.toFixed(3), +dir.z.toFixed(3)],
      hex,
    });
  }

  /**
   * Shooter-side hit test of my projectile segment against remote avatars.
   * @returns {{id:string, name:string}|null}
   */
  testHit(origin, dir, maxDist) {
    if (!this.active) return null;
    let best = null, bestT = maxDist;
    for (const [id, r] of this.remotes) {
      _center.copy(r.group.position); _center.y += 1.2;
      const t = raySphere(origin, dir, _center, 0.7);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = { id, name: (this.roster.get(id) || { name: '?' }).name };
      }
    }
    return best;
  }

  /** Broadcast a confirmed tag (also applies my own score locally). */
  sendTag(victimId, hex) {
    if (!this.active || !this.me) return;
    this.scores[this.me.team]++;
    this.net.send({ t: 'tag', victim: victimId, hex });
  }

  leave() { this.net.close(''); }

  _teardown(reason) {
    for (const id of [...this.remotes.keys()]) this._removeRemote(id);
    this.roster.clear();
    this.me = null;
    this.scores = [0, 0];
    this.deps.onEnded(reason);
  }
}

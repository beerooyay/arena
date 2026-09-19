import * as THREE from 'three';
import { NO_OUTLINE_LAYER } from './outline.js';

/**
 * Nuke — the "press N" easter egg.
 *
 * A bomb falls from the sky onto a target on the ground, then detonates with:
 *   - a blinding white screen flash + a huge transient light that lights the arena
 *   - a ground-zero fireball that rises and blooms into a towering mushroom cloud
 *     (a rising stem + a billowing, curling cap, built from soft sprites)
 *   - an expanding shockwave ring that, as it passes, flings the player back,
 *     kills + ragdolls nearby bots, and blows destructible props apart into
 *     tumbling debris (their collision is removed so you can walk through the wreck)
 *   - layered booms + a descending whistle on the way down
 *
 * Self-contained: build it once, give it the world refs, call trigger(target)
 * on the key press and update(dt, camera) every frame. renderShake() returns a
 * transient camera offset for the render only (never touches physics).
 *
 * Everything visual sits on NO_OUTLINE_LAYER so the contour pass ignores it, and
 * every mesh/sprite is disposed when it dies so nothing leaks across detonations.
 */

// ---- textures -------------------------------------------------------------
function softPuff() {
  const s = 128;
  const c = document.createElement('canvas'); c.width = c.height = s;
  const x = c.getContext('2d');
  // opaque-white rgb everywhere, shape carried in alpha only (avoids the
  // mipmap edge-bleed that speckles transparent canvas textures in Safari)
  const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.75, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  const mask = document.createElement('canvas'); mask.width = mask.height = s;
  const mx = mask.getContext('2d');
  mx.fillStyle = g; mx.fillRect(0, 0, s, s);
  // rough up the edge a little so puffs read as smoke, not perfect discs
  mx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2, r = s * (0.34 + Math.random() * 0.16);
    const px = s / 2 + Math.cos(a) * r, py = s / 2 + Math.sin(a) * r;
    const rr = s * (0.06 + Math.random() * 0.12);
    const gg = mx.createRadialGradient(px, py, 0, px, py, rr);
    gg.addColorStop(0, 'rgba(0,0,0,0.6)'); gg.addColorStop(1, 'rgba(0,0,0,0)');
    mx.fillStyle = gg; mx.beginPath(); mx.arc(px, py, rr, 0, Math.PI * 2); mx.fill();
  }
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, s, s);
  x.globalCompositeOperation = 'destination-in';
  x.drawImage(mask, 0, 0);
  const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t;
}
function glowTex() {
  const s = 128;
  const c = document.createElement('canvas'); c.width = c.height = s;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,240,200,0.85)');
  g.addColorStop(1, 'rgba(255,220,150,0)');
  x.fillStyle = g; x.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

const _v = new THREE.Vector3();
const smooth = (t) => t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
const clamp01 = (t) => t < 0 ? 0 : t > 1 ? 1 : t;

export class Nuke {
  constructor(scene, audio) {
    this.scene = scene;
    this.audio = audio;

    this.state = 'idle';        // idle | falling | blast
    this.t = 0;                 // seconds in the current phase

    // --- tunables (wired to dev sliders in main.js) ---
    this.dropHeight = 300;      // how high the bomb starts
    this.fallTime = 2.4;        // seconds to reach the ground
    this.shockTime = 0.9;       // seconds for the ring to reach blastRadius
    this.knockback = 40;        // player shove speed at ground zero
    this.shakeAmp = 1.4;        // camera-shake strength
    this.riseTime = 4.2;        // seconds for the cloud to reach full height
    this.holdTime = 6.0;        // seconds the cloud lingers at full size
    this.fadeTime = 5.0;        // seconds it takes to dissipate

    // MAP-RELATIVE sizing — computed from arena.size on each trigger so the
    // blast and cloud fill whatever map you're on (Backlot 60, Coliseum 78).
    this.blastScale = 1.8;      // shockwave reach   = arena.size * this (map-wide)
    this.capScale = 0.9;        // mushroom cap radius = arena.size * this
    this.heightScale = 1.55;    // mushroom apex       = arena.size * this
    // live values (recomputed in trigger(); these are just fallbacks)
    this.blastRadius = 108;
    this.cloudHeight = 93;
    this.capRadius = 54;
    // cap the upward launch so the shockwave can NEVER throw a player over the
    // 8m perimeter wall and off the map — apex stays well under the wall top.
    this.maxLaunchUp = 11;

    // --- pools ---
    this.puffs = [];            // mushroom stem/cap/fire sprites
    this.debris = [];           // flung chunks (props + bot bodies)
    this.rings = [];            // expanding ground/air shock sprites
    this.trail = [];            // vapour trail behind the falling bomb

    this._puffTex = softPuff();
    this._glowTex = glowTex();

    // transient detonation light
    this.light = new THREE.PointLight(0xfff0d0, 0, 600, 1.6);
    this.light.visible = false;
    scene.add(this.light);

    // ground-zero fireball (emissive sphere, additive) that becomes the base glow
    this.fire = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 18),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.fire.layers.set(NO_OUTLINE_LAYER);
    this.fire.visible = false;
    scene.add(this.fire);

    // full-screen white flash (created lazily so the module has no HTML deps)
    this.flashEl = document.createElement('div');
    this.flashEl.style.cssText =
      'position:fixed;inset:0;z-index:60;background:#fff;opacity:0;pointer-events:none;' +
      'transition:none;mix-blend-mode:normal;';
    document.body.appendChild(this.flashEl);
    this._flash = 0;            // current flash opacity

    // world refs (set by main.js)
    this.player = null;
    this.arena = null;
    this.bots = null;

    this.center = new THREE.Vector3();   // ground zero
    this._shakeVec = new THREE.Vector3();

    this._buildBomb();
  }

  setRefs({ player, arena, bots }) {
    if (player !== undefined) this.player = player;
    if (arena !== undefined) this.arena = arena;
    if (bots !== undefined) this.bots = bots;
  }

  get active() { return this.state !== 'idle'; }

  // --------------------------------------------------------------------------
  _buildBomb() {
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.55, metalness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x24262a, roughness: 0.6, metalness: 0.5 });
    const stripe = new THREE.MeshStandardMaterial({ color: 0xffcf33, roughness: 0.5, metalness: 0.2 });
    // fat "Fat Man" style bomb: rounded body, nose, tail cone + boxy fins
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 1.5, 8, 16), steel);
    g.add(body);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.62, 16, 12), steel);
    nose.position.y = -0.95; nose.scale.y = 0.9; g.add(nose);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.07, 8, 24), stripe);
    band.rotation.x = Math.PI / 2; band.position.y = -0.1; g.add(band);
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.28, 0.7, 16), dark);
    tail.position.y = 1.15; g.add(tail);
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.7, 0.7), dark);
      const a = i * Math.PI / 2;
      fin.position.set(Math.cos(a) * 0.42, 1.25, Math.sin(a) * 0.42);
      fin.rotation.y = -a; g.add(fin);
    }
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.layers.set(NO_OUTLINE_LAYER); } });
    g.visible = false;
    g.rotation.x = Math.PI; // nose points DOWN (body capsule long axis is Y)
    this.bomb = g;
    this.scene.add(g);
  }

  // --------------------------------------------------------------------------
  /** Start the sequence: bomb spawns high over `target` (a ground point). */
  trigger(target) {
    if (this.active) return false;
    this.center.copy(target); this.center.y = 0;
    // size the blast + cloud to the current map so it always reads as map-wide
    if (this.arena && this.arena.size) {
      const S = this.arena.size;
      this.blastRadius = S * this.blastScale;
      this.cloudHeight = S * this.heightScale;
      this.capRadius = S * this.capScale;
    }
    this.state = 'falling'; this.t = 0;
    this.bomb.position.set(this.center.x, this.dropHeight, this.center.z);
    this.bomb.visible = true;
    this._spin = (Math.random() - 0.5) * 0.6;
    this._trailAcc = 0;
    this._whistle();
    return true;
  }

  /** A descending WebAudio whistle synthesised on the shared audio context. */
  _whistle() {
    const ctx = this.audio && this.audio.ctx;
    if (!ctx || !this.audio.master || this.audio.masterVolume <= 0) return;
    const t0 = ctx.currentTime, dur = this.fallTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1400, t0);
    osc.frequency.exponentialRampToValueAtTime(240, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.25);
    g.gain.setValueAtTime(0.12, t0 + dur - 0.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(this.audio.master);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
    this._whistleOsc = osc;
  }

  // --------------------------------------------------------------------------
  _detonate() {
    this.state = 'blast'; this.t = 0;
    this.bomb.visible = false;

    // blinding flash
    this._flash = 1;
    this.flashEl.style.opacity = '1';

    // huge transient light, colours the whole arena warm-white for an instant
    this.light.position.set(this.center.x, 6, this.center.z);
    this.light.color.setHex(0xfff2d6);
    this.light.intensity = 4000;
    this.light.distance = 700;
    this.light.visible = true;

    // ground-zero fireball
    this.fire.position.set(this.center.x, 3.5, this.center.z);
    this.fire.scale.setScalar(2);
    this.fire.material.color.setHex(0xffe8b0);
    this.fire.material.opacity = 1;
    this.fire.visible = true;

    // sound: layered boom (deep + crack). Global so it's never voice-culled.
    this.audio && this.audio.play('tankExplode', { volume: 1.0, rate: 0.45 });
    this.audio && this.audio.play('tankRoundImpact', { volume: 0.9, rate: 0.55 });
    this.audio && this.audio.play('tankExplode', { volume: 0.7, rate: 0.8 });

    // shock bookkeeping
    this._shockR = 0;
    this._hitPlayer = false;

    // snapshot destructible props once, with distance from ground zero
    this._targets = [];
    if (this.arena) {
      for (const m of this.arena.paintTargets) {
        if (!m.userData || !m.userData.destructible || !m.visible) continue;
        m.getWorldPosition(_v);
        const d = Math.hypot(_v.x - this.center.x, _v.z - this.center.z);
        if (d <= this.blastRadius) this._targets.push({ mesh: m, dist: d, done: false });
      }
      this._targets.sort((a, b) => a.dist - b.dist);
    }
    // nearby bots, closest first
    this._botTargets = [];
    if (this.bots && this.bots.bots) {
      for (const b of this.bots.bots) {
        if (!b.alive) continue;
        const d = Math.hypot(b.pos.x - this.center.x, b.pos.z - this.center.z);
        if (d <= this.blastRadius) this._botTargets.push({ bot: b, dist: d, done: false });
      }
      this._botTargets.sort((a, b) => a.dist - b.dist);
    }

    this._spawnFireball();
    this._spawnMushroom();
    this._spawnGroundRing();
  }

  // ---- shock: expanding radius flings everything it passes -----------------
  _updateShock(dt, camera) {
    const prevR = this._shockR;
    this._shockR = this.blastRadius * smooth(clamp01(this.t / this.shockTime));
    const R = this._shockR;

    // player
    if (!this._hitPlayer && this.player && camera) {
      const px = camera.position.x, pz = camera.position.z;
      const d = Math.hypot(px - this.center.x, pz - this.center.z);
      if (d <= R || (this.t >= this.shockTime && d <= this.blastRadius)) {
        this._hitPlayer = true;
        const f = clamp01(1 - d / this.blastRadius);
        let nx = px - this.center.x, nz = pz - this.center.z;
        const len = Math.hypot(nx, nz) || 1;
        nx /= len; nz /= len;
        const power = this.knockback * (0.35 + 0.65 * f);
        // upward launch is capped low (apex < wall height) so the perimeter walls
        // always contain the player — a map-wide blast never throws you off the map
        const up = Math.min(this.maxLaunchUp, 4 + this.maxLaunchUp * f);
        this.player.applyImpulse(nx * power, nz * power, up);
      }
    }

    // props: blow apart as the ring reaches them
    for (const tp of this._targets) {
      if (tp.done || tp.dist > R) continue;
      tp.done = true;
      this._shatterProp(tp.mesh, tp.dist);
    }
    // bots: kill + ragdoll
    for (const bt of this._botTargets) {
      if (bt.done || bt.dist > R) continue;
      bt.done = true;
      this._ragdollBot(bt.bot, bt.dist);
    }
    void prevR;
  }

  _shatterProp(mesh, dist) {
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    const baseCol = (mesh.material && mesh.material.color) ? mesh.material.color.getHex() : 0xffffff;
    const f = clamp01(1 - dist / this.blastRadius);
    // over the debris budget: still drop the prop (+ its collision), skip chunks
    if (this.debris.length > 460) {
      this._puff(c.x, c.y + 0.4, c.z, { role: 'burst', color: 0x5a5a60, size: size.x + size.z, life: 1.2, o0: 0.6 });
      this._removeProp(mesh);
      return;
    }
    // number of chunks scales with the prop's size
    const vol = Math.max(0.3, size.x * size.y * size.z);
    const n = Math.min(10, 2 + Math.round(vol * 0.4));
    for (let i = 0; i < n; i++) {
      const cs = new THREE.Vector3(
        size.x * (0.28 + Math.random() * 0.34),
        size.y * (0.28 + Math.random() * 0.34),
        size.z * (0.28 + Math.random() * 0.34));
      const col = Math.random() < 0.22 ? PAINT[(Math.random() * PAINT.length) | 0] : baseCol;
      const m = new THREE.Mesh(new THREE.BoxGeometry(cs.x, cs.y, cs.z),
        new THREE.MeshStandardMaterial({ color: col, roughness: 0.8, metalness: 0, transparent: true, opacity: 1 }));
      m.castShadow = false; m.layers.set(0); // many chunks at once — skip shadows for FPS
      m.position.set(
        c.x + (Math.random() - 0.5) * size.x,
        c.y + (Math.random() - 0.5) * size.y,
        c.z + (Math.random() - 0.5) * size.z);
      // fling outward from ground zero + up
      let dx = m.position.x - this.center.x, dz = m.position.z - this.center.z;
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const out = (10 + Math.random() * 16) * (0.5 + f);
      this.scene.add(m);
      this.debris.push({
        mesh: m,
        vel: new THREE.Vector3(dx * out + (Math.random() - 0.5) * 4, 8 + Math.random() * 14 * (0.5 + f), dz * out + (Math.random() - 0.5) * 4),
        spin: new THREE.Vector3((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16),
        age: 0, life: 2.6 + Math.random() * 1.8,
      });
    }
    // a lick of fire + dust where it stood
    this._puff(c.x, c.y + 0.4, c.z, { role: 'burst', color: 0x5a5a60, size: size.x + size.z, life: 1.2, o0: 0.6 });
    // vanish the original + drop its collision so you can walk through the wreck
    this._removeProp(mesh);
  }

  _removeProp(mesh) {
    mesh.visible = false;
    const a = this.arena;
    if (!a) return;
    const rm = (arr, item) => { const i = arr.indexOf(item); if (i >= 0) { arr.splice(i, 1); return true; } return false; };
    rm(a.paintTargets, mesh);
    mesh.userData._wasGround = rm(a.groundMeshes, mesh);
    if (mesh.userData.blocker) { rm(a.blockers, mesh.userData.blocker); rm(a.tankBlockers, mesh.userData.blocker); }
    (this._downed || (this._downed = [])).push(mesh);
  }

  _ragdollBot(bot, dist) {
    const f = clamp01(1 - dist / this.blastRadius);
    const hex = bot.hex || 0xffffff;
    // take the bot out of play; it respawns on the normal timer
    bot.alive = false;
    if (bot.group) bot.group.visible = false;
    bot.respawnAt = performance.now() + 3200;
    // fling a few body-coloured chunks from where it stood
    const px = bot.pos.x, pz = bot.pos.z;
    let dx = px - this.center.x, dz = pz - this.center.z;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    for (let i = 0; i < 5; i++) {
      const s = 0.32 + Math.random() * 0.3;
      const m = new THREE.Mesh(new THREE.BoxGeometry(s, s * (1 + Math.random()), s),
        new THREE.MeshStandardMaterial({ color: hex, roughness: 0.5, metalness: 0, emissive: new THREE.Color(hex), emissiveIntensity: 0.25, transparent: true, opacity: 1 }));
      m.position.set(px + (Math.random() - 0.5) * 0.8, 0.6 + Math.random() * 1.4, pz + (Math.random() - 0.5) * 0.8);
      const out = (12 + Math.random() * 16) * (0.5 + f);
      this.scene.add(m);
      this.debris.push({
        mesh: m,
        vel: new THREE.Vector3(dx * out + (Math.random() - 0.5) * 6, 10 + Math.random() * 16, dz * out + (Math.random() - 0.5) * 6),
        spin: new THREE.Vector3((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20),
        age: 0, life: 2.4 + Math.random() * 1.4,
      });
    }
  }

  // ---- fireball, mushroom, ground ring -------------------------------------
  _spawnFireball() {
    // a cluster of bright fire puffs boiling up out of ground zero, scaled to blast
    const scl = Math.max(1, this.blastRadius / 40);
    const N = Math.round(16 * Math.min(2.4, scl));
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 6 * scl;
      this._puff(this.center.x + Math.cos(a) * r, 2 + Math.random() * 5 * scl, this.center.z + Math.sin(a) * r, {
        role: 'fire', color: i % 2 ? 0xff7a1e : 0xffc24d, size: (8 + Math.random() * 8) * scl,
        life: 1.8 + Math.random() * 1.2, o0: 0.95, rise: (6 + Math.random() * 5) * Math.min(2, scl),
      });
    }
  }

  _spawnMushroom() {
    const cx = this.center.x, cz = this.center.z;
    const total = this.riseTime + this.holdTime + this.fadeTime;
    const capBase = this.cloudHeight * 0.66;   // where the stem ends and the cap begins
    // scale puff size + count so a huge cap stays a solid mass, not a sparse spray
    const scl = Math.max(1, this.capRadius / 25);
    const cnt = Math.min(2.4, scl);
    // STEM — a rising column that fills out and lightens toward the cap
    const STEM = Math.round(28 * cnt);
    for (let i = 0; i < STEM; i++) {
      const u = i / (STEM - 1);
      const a = Math.random() * Math.PI * 2, r = (2.6 + u * 3.6) * scl * (0.5 + Math.random() * 0.6);
      this._puff(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r, {
        role: 'stem', color: this._smokeCol(0.12 + u * 0.5), size: (9 + u * 7 + Math.random() * 4) * scl,
        targetY: 5 + u * capBase, r0: r, delay: u * 0.45, grow: 2.4, life: total,
      });
    }
    // CAP — a broad billowing dome that overhangs the stem (widest at the rim,
    // outer puffs curling down and under for the classic mushroom silhouette)
    const CAP = Math.round(60 * cnt);
    for (let i = 0; i < CAP; i++) {
      const a = Math.random() * Math.PI * 2;
      const shell = Math.pow(Math.random(), 0.55);       // 0 centre .. 1 rim (biased outward)
      const rTarget = this.capRadius * (0.22 + shell * 0.92);
      const yTarget = this.cloudHeight - shell * this.capRadius * 0.62 + (Math.random() - 0.5) * 4 * scl;
      // rim puffs sit lower & in shadow -> a touch darker; the crown catches light
      this._puff(cx, 4, cz, {
        role: 'cap', color: this._smokeCol(0.85 - shell * 0.35 + Math.random() * 0.12),
        size: (16 + shell * 8 + Math.random() * 10) * scl,
        a, rTarget, yTarget, curl: 0.5 + shell, delay: 0.3 + shell * 0.5 + Math.random() * 0.4,
        grow: 3.0, life: total,
      });
    }
    // a rounded crown of a few big soft puffs right at the top centre
    const CROWN = Math.round(6 * cnt);
    for (let i = 0; i < CROWN; i++) {
      const a = Math.random() * Math.PI * 2, r = this.capRadius * 0.25 * Math.random();
      this._puff(cx, 4, cz, {
        role: 'cap', color: this._smokeCol(0.92), size: (20 + Math.random() * 10) * scl,
        a, rTarget: r, yTarget: this.cloudHeight + (3 + Math.random() * 4) * scl, curl: 0.3,
        delay: 0.5 + Math.random() * 0.4, grow: 3.2, life: total,
      });
    }
  }

  _spawnGroundRing() {
    // a flat expanding dust ring on the deck + a translucent air-shock dome
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 1.0, 48),
      new THREE.MeshBasicMaterial({ color: 0xfff1d8, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(this.center.x, 0.4, this.center.z);
    ring.layers.set(NO_OUTLINE_LAYER);
    this.scene.add(ring);
    this.rings.push({ mesh: ring, age: 0, life: this.shockTime + 0.3, kind: 'ground' });

    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending }));
    dome.position.set(this.center.x, 1, this.center.z);
    dome.layers.set(NO_OUTLINE_LAYER);
    this.scene.add(dome);
    this.rings.push({ mesh: dome, age: 0, life: this.shockTime + 0.15, kind: 'dome' });
  }

  _smokeCol(u) {
    // u 0..1 : darker/browner low, lighter grey high (catching the light)
    const lo = new THREE.Color(0x2b2622), hi = new THREE.Color(0x9a9aa2);
    return lo.lerp(hi, clamp01(u)).getHex();
  }

  // one mushroom/smoke sprite
  _puff(x, y, z, o) {
    const isFire = o.role === 'fire';
    const mat = new THREE.SpriteMaterial({
      map: isFire ? this._glowTex : this._puffTex, color: o.color,
      transparent: true, opacity: 0, depthWrite: false,
      blending: isFire ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    const s = new THREE.Sprite(mat);
    s.layers.set(NO_OUTLINE_LAYER);
    s.position.set(x, y, z);
    s.scale.setScalar(o.size * 0.35);
    this.scene.add(s);
    this.puffs.push({
      spr: s, role: o.role, age: 0, life: o.life || 1.4, o0: o.o0 != null ? o.o0 : 0.9,
      size0: o.size, x0: x, z0: z,
      targetY: o.targetY || 0, r0: o.r0 || 0, a: o.a || 0, rTarget: o.rTarget || 0,
      yTarget: o.yTarget || 0, curl: o.curl || 0, delay: o.delay || 0, grow: o.grow || 2,
      rise: o.rise || 0, spin: (Math.random() - 0.5) * 0.6,
    });
  }

  // --------------------------------------------------------------------------
  update(dt, camera) {
    if (this.freeze) return; // DEV: hold the current tableau for inspection
    if (dt > 0.05) dt = 0.05;

    // flash decay (runs even after the sequence's other parts finish)
    if (this._flash > 0) {
      // quick blinding hold, then ease off
      this._flash -= dt * (this.state === 'blast' && this.t < 0.12 ? 0 : 1.15);
      if (this._flash < 0) this._flash = 0;
      this.flashEl.style.opacity = String(this._flash * this._flash);
    }

    if (this.state === 'falling') {
      this.t += dt;
      const k = clamp01(this.t / this.fallTime);
      const y = this.dropHeight * (1 - k * k); // accelerate downward
      this.bomb.position.y = Math.max(1.4, y);
      this.bomb.rotation.y += this._spin * dt;
      // vapour trail
      this._trailAcc += dt;
      if (this._trailAcc > 0.03) {
        this._trailAcc = 0;
        this._spawnTrail(this.bomb.position);
      }
      if (k >= 1 || this.bomb.position.y <= 1.5) this._detonate();
    } else if (this.state === 'blast') {
      this.t += dt;
      this._updateShock(dt, camera);
      this._updateFire(dt);
      // transient light burst decays fast
      if (this.light.visible) {
        this.light.intensity *= Math.pow(0.02, dt); // ~fast exp decay
        if (this.t > 0.9) { this.light.intensity = 0; this.light.visible = false; }
      }
      // end the sequence once the cloud has fully dissipated
      if (this.t > this.riseTime + this.holdTime + this.fadeTime + 0.5 &&
          this.puffs.length === 0 && this.debris.length === 0) {
        this.state = 'idle';
      }
    }

    this._updatePuffs(dt);
    this._updateDebris(dt);
    this._updateRings(dt);
    this._updateTrail(dt);
  }

  _spawnTrail(p) {
    const mat = new THREE.SpriteMaterial({ map: this._puffTex, color: 0xf2f2f5, transparent: true, opacity: 0.5, depthWrite: false, fog: true });
    const s = new THREE.Sprite(mat);
    s.layers.set(NO_OUTLINE_LAYER);
    s.position.set(p.x + (Math.random() - 0.5) * 0.4, p.y + 0.8, p.z + (Math.random() - 0.5) * 0.4);
    s.scale.setScalar(2.2);
    this.scene.add(s);
    this.trail.push({ spr: s, age: 0, life: 1.1 });
  }
  _updateTrail(dt) {
    for (let i = this.trail.length - 1; i >= 0; i--) {
      const p = this.trail[i]; p.age += dt;
      const t = p.age / p.life;
      if (t >= 1) { this.scene.remove(p.spr); p.spr.material.dispose(); this.trail.splice(i, 1); continue; }
      p.spr.scale.setScalar(2.2 + t * 6);
      p.spr.material.opacity = 0.5 * (1 - t);
      p.spr.position.y += dt * 1.5;
    }
  }

  _updateFire(dt) {
    if (!this.fire.visible) return;
    const k = clamp01(this.t / 1.4);
    this.fire.scale.setScalar(2 + smooth(k) * 16);
    this.fire.position.y = 3.5 + smooth(k) * 8;
    this.fire.material.opacity = Math.max(0, 1 - k) * 0.9;
    this.fire.material.color.lerpColors(new THREE.Color(0xffe8b0), new THREE.Color(0xff5a1e), k);
    if (k >= 1) this.fire.visible = false;
  }

  _updatePuffs(dt) {
    const total = this.riseTime + this.holdTime + this.fadeTime;
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      if (p.age >= p.life) { this.scene.remove(p.spr); p.spr.material.dispose(); this.puffs.splice(i, 1); continue; }

      if (p.role === 'fire' || p.role === 'burst') {
        const t = p.age / p.life;
        p.spr.position.y += (p.rise || 2) * dt * (1 - t);
        p.spr.scale.setScalar(p.size0 * (0.5 + t * 1.4));
        p.spr.material.opacity = (t < 0.15 ? t / 0.15 : (1 - t) / 0.85) * p.o0;
        if (p.role === 'fire') {
          p.spr.material.color.lerpColors(new THREE.Color(p_fireHot), new THREE.Color(0x2a2622), clamp01(t * 1.3));
        }
        continue;
      }

      // stem + cap share a normalized rise/hold/fade clock
      const life = clamp01((p.age - p.delay) / this.riseTime);      // 0..1 rising
      const gt = clamp01(p.age / total);                            // 0..1 whole life
      const e = smooth(life);
      if (p.role === 'stem') {
        p.spr.position.y = e * p.targetY;
        // gentle swirl as it rises
        p.spr.position.x = p.x0 + Math.cos(p.age * 0.4 + p.a) * 0.6;
        p.spr.position.z = p.z0 + Math.sin(p.age * 0.4 + p.a) * 0.6;
        p.spr.scale.setScalar(p.size0 * (0.4 + e * 1.0 + gt * 0.4));
      } else { // cap — rise, spread into a dome, and slowly billow/curl under
        const y = 6 + e * (p.yTarget - 6);
        const r = e * p.rTarget;
        const roll = smooth(clamp01((p.age - p.delay - this.riseTime * 0.6) / (this.riseTime * 1.1)));
        const ang = p.a + roll * (0.25 + p.curl * 0.35); // gentle billow rotation
        p.spr.position.set(
          p.x0 + Math.cos(ang) * r,
          y - roll * p.curl * this.capRadius * 0.18,   // slight overhang curl-under
          p.z0 + Math.sin(ang) * r);
        p.spr.scale.setScalar(p.size0 * (0.4 + e * 1.1 + gt * 0.5));
      }
      p.spr.material.rotation += p.spin * dt;
      // opacity: fade in over the first 0.5s of the puff's active life, out over fadeTime
      const fadeOut = clamp01((p.age - (this.riseTime * 0.5 + this.holdTime)) / this.fadeTime);
      const fadeIn = clamp01((p.age - p.delay) / 0.6);
      p.spr.material.opacity = p.o0 * fadeIn * (1 - fadeOut);
    }
  }

  _updateDebris(dt) {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i]; d.age += dt;
      d.vel.y -= 26 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      if (d.mesh.position.y < 0.2) {
        d.mesh.position.y = 0.2; d.vel.y = -d.vel.y * 0.32;
        d.vel.x *= 0.6; d.vel.z *= 0.6; d.spin.multiplyScalar(0.6);
      }
      d.mesh.rotation.x += d.spin.x * dt; d.mesh.rotation.y += d.spin.y * dt; d.mesh.rotation.z += d.spin.z * dt;
      const left = d.life - d.age;
      if (left < 1.0) d.mesh.material.opacity = Math.max(0, left);
      if (d.age >= d.life) {
        this.scene.remove(d.mesh); d.mesh.geometry.dispose(); d.mesh.material.dispose();
        this.debris.splice(i, 1);
      }
    }
  }

  _updateRings(dt) {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]; r.age += dt;
      const t = clamp01(r.age / r.life);
      if (t >= 1) { this.scene.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh.material.dispose(); this.rings.splice(i, 1); continue; }
      if (r.kind === 'ground') {
        const rad = smooth(t) * this.blastRadius;
        r.mesh.scale.setScalar(Math.max(0.001, rad));
        r.mesh.material.opacity = 0.85 * (1 - t);
      } else { // dome
        r.mesh.scale.setScalar(1 + smooth(t) * this.blastRadius * 0.9);
        r.mesh.material.opacity = 0.32 * (1 - t) * (1 - t);
      }
    }
  }

  // transient camera shake for the RENDER only (removed by the caller each frame)
  renderShake(camera) {
    if (this.state !== 'blast') { this._shakeVec.set(0, 0, 0); return this._shakeVec; }
    // strongest at detonation, decays over ~1.2s; falls off with distance
    let decay = Math.max(0, 1 - this.t / 1.3);
    decay *= decay;
    const d = camera ? Math.hypot(camera.position.x - this.center.x, camera.position.z - this.center.z) : 0;
    const distFall = clamp01(1 - d / (this.blastRadius * 1.6));
    const amp = this.shakeAmp * decay * (0.3 + 0.7 * distFall);
    this._shakeVec.set((Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp);
    return this._shakeVec;
  }

  /** Restore anything the last blast destroyed and clear all live FX. */
  reset() {
    // stop any whistle
    try { this._whistleOsc && this._whistleOsc.stop(); } catch (_) {}
    // clear pools
    for (const p of this.puffs) { this.scene.remove(p.spr); p.spr.material.dispose(); }
    for (const d of this.debris) { this.scene.remove(d.mesh); d.mesh.geometry.dispose(); d.mesh.material.dispose(); }
    for (const r of this.rings) { this.scene.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh.material.dispose(); }
    for (const t of this.trail) { this.scene.remove(t.spr); t.spr.material.dispose(); }
    this.puffs.length = 0; this.debris.length = 0; this.rings.length = 0; this.trail.length = 0;
    // restore downed props + their collision
    if (this._downed && this.arena) {
      for (const m of this._downed) {
        m.visible = true;
        this.arena.paintTargets.push(m);
        if (m.userData._wasGround) this.arena.groundMeshes.push(m);
        if (m.userData.blocker) { this.arena.blockers.push(m.userData.blocker); this.arena.tankBlockers.push(m.userData.blocker); }
      }
    }
    this._downed = null;
    this.bomb.visible = false;
    this.fire.visible = false;
    this.light.visible = false; this.light.intensity = 0;
    this._flash = 0; this.flashEl.style.opacity = '0';
    this.state = 'idle'; this.t = 0;
  }
}

const PAINT = [0xff3b3b, 0x2f7bff, 0xffd21f, 0x27c93f, 0x9b3bff, 0xff7a1a];
const p_fireHot = 0xffd27a;

import * as THREE from 'three';
import { NO_OUTLINE_LAYER } from './outline.js';

/**
 * TankFX — the violent bits of a tank death: chunks of hull flung in every
 * direction (gravity + spin + a ground bounce, then a fade) and a rolling
 * black smoke/fireball burst. The coloured paint burst is fired separately by
 * main.js (it reuses the projectile system so the paint actually splats onto
 * the surrounding walls and objects).
 *
 * Self-contained: give it the scene, call explode(pos, hex) on death, and
 * update(dt) every frame.
 */
function softTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class TankFX {
  constructor(scene) {
    this.scene = scene;
    this.debris = [];   // {mesh, vel, spin, age, life}
    this.smoke = [];    // {sprite, vel, age, life, size0, o0}
    this.debrisCount = 18; // dev-tunable: chunks flung per explosion
    this.smokeCount = 18;  // dev-tunable: black smoke puffs per explosion
    this._tex = softTexture();
    this._flashTex = softTexture();
  }

  /** Blow the tank apart at `pos`, tinted toward its team colour `hex`. */
  explode(pos, hex) {
    const cx = pos.x, cz = pos.z, cy = 1.4;
    const gray = 0xcfd3d8, dark = 0x8b9098;

    // --- hull debris: a spray of chunks in all directions ---
    const N = this.debrisCount;
    for (let i = 0; i < N; i++) {
      const roll = Math.random();
      let geo, col;
      if (roll < 0.45) {
        geo = new THREE.BoxGeometry(0.35 + Math.random() * 0.6, 0.3 + Math.random() * 0.4, 0.35 + Math.random() * 0.6);
        col = gray;
      } else if (roll < 0.75) {
        geo = new THREE.BoxGeometry(0.3, 0.3, 0.5 + Math.random() * 0.7);
        col = dark;
      } else if (roll < 0.9) {
        geo = new THREE.CylinderGeometry(0.4, 0.4, 0.45, 12); // a road wheel
        col = dark;
      } else {
        geo = new THREE.CylinderGeometry(0.16, 0.18, 1.4, 12); // barrel shard
        col = hex; // a team-coloured piece
      }
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: col, roughness: 0.7, metalness: 0, transparent: true, opacity: 1,
      }));
      mesh.position.set(cx + (Math.random() - 0.5) * 1.6, cy + Math.random() * 1.4, cz + (Math.random() - 0.5) * 1.6);
      mesh.castShadow = true;
      this.scene.add(mesh);
      const ang = Math.random() * Math.PI * 2;
      const out = 5 + Math.random() * 8;
      const up = 6 + Math.random() * 8;
      this.debris.push({
        mesh,
        vel: new THREE.Vector3(Math.cos(ang) * out, up, Math.sin(ang) * out),
        spin: new THREE.Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14),
        age: 0,
        life: 2.4 + Math.random() * 1.4,
      });
    }

    // --- fireball flash (a couple of quick bright puffs) ---
    for (let i = 0; i < 4; i++) {
      this._spawnSmoke(cx, cy, cz, {
        tex: this._flashTex, color: 0xffb24d, size: 1.8 + Math.random() * 1.6,
        rise: 0.5, life: 0.35 + Math.random() * 0.2, o0: 0.85, spread: 1.2,
      });
    }
    // --- rolling black smoke ---
    for (let i = 0; i < this.smokeCount; i++) {
      this._spawnSmoke(cx, cy, cz, {
        tex: this._tex, color: 0x0e0f12, size: 1.2 + Math.random() * 1.7,
        rise: 1.6 + Math.random() * 2.2, life: 1.8 + Math.random() * 1.6, o0: 0.55 + Math.random() * 0.3, spread: 2.2,
      });
    }
  }

  _spawnSmoke(cx, cy, cz, o) {
    const mat = new THREE.SpriteMaterial({
      map: o.tex, color: o.color, transparent: true, opacity: o.o0, depthWrite: false,
    });
    const s = new THREE.Sprite(mat);
    s.layers.set(NO_OUTLINE_LAYER);
    s.position.set(cx + (Math.random() - 0.5) * o.spread, cy + Math.random() * 1.5, cz + (Math.random() - 0.5) * o.spread);
    s.scale.setScalar(o.size);
    this.scene.add(s);
    this.smoke.push({
      sprite: s,
      vel: new THREE.Vector3((Math.random() - 0.5) * 2.5, o.rise, (Math.random() - 0.5) * 2.5),
      age: 0, life: o.life, size0: o.size, o0: o.o0,
    });
  }

  update(dt) {
    if (dt <= 0) return;
    // debris: gravity, spin, a damped ground bounce, then fade + remove
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.age += dt;
      d.vel.y -= 24 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      if (d.mesh.position.y < 0.2) {
        d.mesh.position.y = 0.2;
        d.vel.y = -d.vel.y * 0.35;
        d.vel.x *= 0.6; d.vel.z *= 0.6;
        d.spin.multiplyScalar(0.6);
      }
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      const left = d.life - d.age;
      if (left < 0.8) d.mesh.material.opacity = Math.max(0, left / 0.8);
      if (d.age >= d.life) {
        this.scene.remove(d.mesh);
        d.mesh.geometry.dispose();
        d.mesh.material.dispose();
        this.debris.splice(i, 1);
      }
    }
    // smoke: rise, drag, grow, fade
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const p = this.smoke[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.scene.remove(p.sprite);
        p.sprite.material.dispose();
        this.smoke.splice(i, 1);
        continue;
      }
      p.sprite.position.addScaledVector(p.vel, dt);
      p.vel.y += 0.6 * dt;
      p.vel.multiplyScalar(1 - 0.5 * dt);
      const t = p.age / p.life;
      p.sprite.scale.setScalar(p.size0 * (1 + t * 3));
      p.sprite.material.opacity = (1 - t) * p.o0;
    }
  }
}

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { fixHandThighBleed } from './avatar/fixskin.js';
import { makeArmIK } from './avatar/armik.js';
import { makeAvatar as makeLegacyAvatar, disposeAvatar as disposeLegacyAvatar, makeNameSprite } from './playerGlow.js';

/**
 * Rigged player avatars: Tripo armour suits on a Mixamo-named skeleton, driven
 * by retargeted Mixamo clips (baked by tools/bake-avatars.mjs) and holding the
 * rifle in the right hand.
 *
 * Call preloadAvatars() once at boot. makeAvatar() stays synchronous: until the
 * rigs have loaded it falls back to the procedural avatar in playerGlow.js.
 */

const BASE = 'assets/players/';
// WHITE wears the white suit; FIRE the graphite suit with the orange visor.
const RIG_FOR_HEX = { 0xf4f6f8: 'p1', 0xff6000: 'p2' };
const SCALE = 1.95;         // suit is ~0.98 units tall -> ~1.9 m: eye level near the player's 1.7 m
const LABEL_Y = 2.35;

// Per-rig pose corrections (tuned in the anim lab against p1): p2's arms put
// its hands ~6 cm high, so shift them in chest space, drop the left elbow and
// lift the head a touch.
const RIG_TWEAKS = {
  p1: null,
  p2: { hand: new THREE.Vector3(0.020, -0.061, 0.027), leftElbowDown: 0.5, headPitch: 0.052 },
};

// Game-unit speeds at which the run clips' feet don't slide (Mixamo root
// motion: 242 cm / 0.5 s run, 363 cm / 0.5 s sprint, scaled to this rig).
const RUN_SPEED = 5.2;      // scale with SCALE: feet stay planted
const SPRINT_SPEED = 7.8;
const LOCO = ['idle', 'runF', 'runB', 'runL', 'runR', 'sprint'];
const UPPER_BODY = /(Spine|Neck|Head|Shoulder|Arm|Hand)/;

// rr.glb: +X barrel, +Y up; its pistol grip sits ~0.30 back from centre.
const RIFLE_GRIP = new THREE.Vector3(0.30, -0.10, 0);
const RIFLE_SCALE = 0.45;

// First-person support hand, in RIFLE space (rr.glb units: +x toward the muzzle,
// +y up; the gun is ~1 long): slide it back along the handguard and drop it
// under the barrel, plus a wrist roll so the palm cups it from below.
export const FP_LEFT_HAND = new THREE.Vector3(-0.2, -0.1, 0);
export let FP_LEFT_ROLL = 1.0;
export function setFirstPersonLeftHand(offset, roll) { if (offset) FP_LEFT_HAND.copy(offset); if (roll != null) FP_LEFT_ROLL = roll; }

const templates = {}; // rig -> { scene, clips, rifle: {pos, quat}, tweaks }
let rifleTemplate = null;
let _loading = null;

function clipFromJson(key, c) {
  const times = Float32Array.from(c.times);
  const tracks = c.tracks.map((t) => (t.type === 'quaternion'
    ? new THREE.QuaternionKeyframeTrack(t.name, times, t.values)
    : new THREE.VectorKeyframeTrack(t.name, times, t.values)));
  return new THREE.AnimationClip(key, c.duration, tracks);
}

// Fit the rifle to a rig's hands in the aiming pose: grip in the right palm,
// barrel along right palm -> left palm, receiver up. Returns hand-local pose.
function fitRifle(model, idleClip) {
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(idleClip).play();
  mixer.setTime(0.5);
  model.updateMatrixWorld(true);
  const W = (n) => model.getObjectByName('mixamorig' + n).getWorldPosition(new THREE.Vector3());
  const palm = W('RightHand').lerp(W('RightHandMiddle1'), 0.5);
  const fore = W('LeftHand').lerp(W('LeftHandMiddle1'), 0.5);
  const fwd = fore.sub(palm.clone()).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(fwd, up).normalize();
  up.crossVectors(side, fwd).normalize();
  const worldQ = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(fwd, up, new THREE.Vector3().crossVectors(fwd, up)));
  const hand = model.getObjectByName('mixamorigRightHand');
  const quat = hand.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(worldQ);
  const pos = hand.worldToLocal(palm.clone());
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  return { pos, quat };
}

async function loadRig(loader, rig) {
  const [gltf, anims] = await Promise.all([
    loader.loadAsync(BASE + rig + '.glb'),
    fetch(BASE + `anims-${rig}.json`).then((r) => r.json()),
  ]);
  const scene = gltf.scene;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.frustumCulled = false; // skinned: rest-pose bounds don't follow the animation
    if (o.isSkinnedMesh) fixHandThighBleed(o);
  });
  const clips = Object.fromEntries(Object.entries(anims.clips).map(([k, c]) => [k, clipFromJson(k, c)]));
  templates[rig] = { scene, clips, rifle: fitRifle(scene, clips.idle), tweaks: RIG_TWEAKS[rig] };
}

/** Load both suits, their clips and the rifle. Safe to call more than once. */
export function preloadAvatars() {
  if (_loading) return _loading;
  const loader = new GLTFLoader();
  _loading = Promise.all([
    loadRig(loader, 'p1'),
    loadRig(loader, 'p2'),
    // same rifle model the first-person viewmodel uses (gunModel.js)
    loader.loadAsync('assets/models/rr.glb').then((g) => {
      g.scene.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      rifleTemplate = g.scene;
    }),
  ]).catch((err) => {
    console.warn('[avatarRig] rigged avatars unavailable, using procedural ones', err);
  });
  return _loading;
}

export const avatarsReady = () => !!(templates.p1 && templates.p2 && rifleTemplate);

const smooth = (x, a, b) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Drives one avatar's clips from its ground velocity: directional run blend
 * (forward/back/strafe), sprint, idle, additive upper-body recoil, and death.
 */
class AvatarAnimator {
  constructor(model, t) {
    this.mixer = new THREE.AnimationMixer(model);
    this.act = {};
    this.w = {};
    for (const k of LOCO) {
      const a = this.mixer.clipAction(t.clips[k]);
      a.play();
      a.setEffectiveWeight(k === 'idle' ? 1 : 0);
      this.act[k] = a;
      this.w[k] = k === 'idle' ? 1 : 0;
    }
    // idles shouldn't march in lockstep across the whole team
    this.act.idle.time = Math.random() * t.clips.idle.duration;

    const recoil = t.clips.fire.clone();
    recoil.tracks = recoil.tracks.filter((tr) => UPPER_BODY.test(tr.name));
    THREE.AnimationUtils.makeClipAdditive(recoil);
    this.act.fire = this.mixer.clipAction(recoil, undefined, THREE.AdditiveAnimationBlendMode);
    this.act.fire.setLoop(THREE.LoopOnce, 1);

    for (const k of ['death', 'deathRun']) {
      const a = this.mixer.clipAction(t.clips[k]);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      this.act[k] = a;
    }
    // jump plays once and holds near the apex while airborne; the dive roll
    // windows in and out over its own clip so it reads as one smooth motion
    for (const k of ['jump', 'roll']) {
      const a = this.mixer.clipAction(t.clips[k]);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      this.act[k] = a;
    }
    this.deathAct = null;
    this.deathW = 0;
    this.speed = 0;
    this.airborne = false;
    this.airW = 0;
    this.hitT = 0;
    this.spine = model.getObjectByName('mixamorigSpine2') || model.getObjectByName('mixamorigSpine1') || model.getObjectByName('mixamorigSpine');
    this._hq = new THREE.Quaternion();
    this._hx = new THREE.Vector3(1, 0, 0);

    this.tweaks = t.tweaks;
    this.ik = t.tweaks ? makeArmIK(model) : null;
  }

  /** @param vx,vz world-space ground velocity (units/s); yaw = avatar rotation.y */
  update(dt, vx = 0, vz = 0, yaw = 0) {
    const k = Math.min(1, dt * 8); // blend rate between idle/run/strafe/sprint
    const target = { idle: 0, runF: 0, runB: 0, runL: 0, runR: 0, sprint: 0 };
    let timeScale = 1;
    if (!this.deathAct) {
      // velocity in the avatar's frame: +z forward, +x the avatar's left
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const lx = c * vx - s * vz, lz = s * vx + c * vz;
      const speed = Math.hypot(lx, lz);
      this.speed += (speed - this.speed) * k;
      const loco = smooth(speed, 0.4, 2.5);
      if (speed > 1e-3) {
        const f = Math.max(0, lz) / speed, b = Math.max(0, -lz) / speed;
        const l = Math.max(0, lx) / speed, r = Math.max(0, -lx) / speed;
        const wF = f * f, wB = b * b, wL = l * l, wR = r * r;
        const sprint = smooth(speed, RUN_SPEED + 2, SPRINT_SPEED + 3) * wF;
        target.runF = loco * wF * (1 - sprint);
        target.sprint = loco * wF * sprint;
        target.runB = loco * wB;
        target.runL = loco * wL;
        target.runR = loco * wR;
        const native = RUN_SPEED + (SPRINT_SPEED - RUN_SPEED) * sprint;
        timeScale = THREE.MathUtils.clamp(speed / native, 0.7, 1.8);
      }
      target.idle = 1 - loco;
    }
    // dive roll windows over its own clip: ramp in, out, done
    const rollA = this.act.roll;
    const rollK = rollA.isRunning() ? Math.min(1, rollA.time / rollA.getClip().duration) : 1;
    const rollW = rollK < 1 && !this.deathAct ? Math.sin(rollK * Math.PI) : 0;
    rollA.setEffectiveWeight(rollW);
    // airborne: jump clip takes over from the ground blend, holding the apex
    this.airW += ((this.airborne ? 1 : 0) - this.airW) * Math.min(1, dt * 10);
    const jumpA = this.act.jump;
    if (this.airW < 0.03 && !this.airborne) jumpA.stop();
    else {
      jumpA.setEffectiveWeight(this.deathAct ? 0 : this.airW);
      const jd = jumpA.getClip().duration;
      jumpA.setEffectiveTimeScale(this.airborne && jumpA.time > jd * 0.45 ? 0.07 : 1);
    }
    const baseW = (1 - this.deathW) * (1 - this.airW) * (1 - rollW);
    for (const key of LOCO) {
      this.w[key] += (target[key] - this.w[key]) * k;
      const a = this.act[key];
      a.setEffectiveWeight(this.w[key] * baseW);
      if (key !== 'idle') a.setEffectiveTimeScale(timeScale);
    }
    if (this.deathAct) {
      this.deathW = Math.min(1, this.deathW + dt / 0.15);
      this.deathAct.setEffectiveWeight(this.deathW);
    }
    this.mixer.update(dt);
    if (this.ik && !this.deathAct) {
      this.ik(this.tweaks.hand, { leftElbowDown: this.tweaks.leftElbowDown, headPitch: this.tweaks.headPitch });
    }
    // hit flinch: a quick backward whip of the chest, layered after IK so the
    // hands stay on the rifle and the reaction reads in the torso
    if (this.hitT > 0.001 && this.spine && !this.deathAct) {
      this.spine.quaternion.multiply(this._hq.setFromAxisAngle(this._hx, -0.3 * this.hitT));
      this.hitT = Math.max(0, this.hitT - dt * 4);
    }
  }

  /** Leave the ground: restart the jump clip (it hangs near the apex). */
  setAirborne(v) {
    v = !!v;
    if (v && !this.airborne) this.act.jump.reset().setEffectiveWeight(0).play();
    this.airborne = v;
  }

  /** Dive roll — one playthrough, windowed over the locomotion blend. */
  roll() {
    if (this.deathAct) return;
    this.act.roll.reset().play();
  }

  /** Non-lethal hit reaction — chest whips back briefly. */
  hit() {
    if (!this.deathAct) this.hitT = 1;
  }

  /** Kick the additive recoil (upper body only). */
  fire() {
    if (this.deathAct) return;
    const a = this.act.fire;
    // let most of a kick play out before restarting it: re-triggering every
    // shot of a fast burst just makes the upper body jitter
    if (a.isRunning() && a.time < a.getClip().duration * 0.6) return;
    a.reset().setEffectiveWeight(0.75).play();
  }

  /** Play a death clip; the running fall if they were moving fast. */
  die() {
    if (this.deathAct) return;
    this.deathAct = this.speed > 3 ? this.act.deathRun : this.act.death;
    this.deathAct.reset().setEffectiveWeight(0).play();
    this.deathW = 0;
    this.act.fire.stop();
  }

  /** Back on their feet (respawn): snap to idle. */
  revive() {
    if (this.deathAct) this.deathAct.stop();
    this.deathAct = null;
    this.deathW = 0;
    this.speed = 0;
    this.airborne = false; this.airW = 0; this.hitT = 0;
    this.act.jump.stop(); this.act.roll.stop();
    for (const key of LOCO) {
      this.w[key] = key === 'idle' ? 1 : 0;
      this.act[key].setEffectiveWeight(this.w[key]);
    }
  }

  get dead() { return !!this.deathAct; }

  dispose(model) {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(model);
  }
}

function makeRiggedAvatar(name, hex) {
  const t = templates[RIG_FOR_HEX[hex] || 'p1'];
  const group = new THREE.Group();
  const model = cloneSkinned(t.scene);
  model.scale.setScalar(SCALE);
  group.add(model);

  const hand = model.getObjectByName('mixamorigRightHand');
  const holder = new THREE.Group();
  holder.position.copy(t.rifle.pos);
  holder.quaternion.copy(t.rifle.quat);
  holder.scale.setScalar(RIFLE_SCALE);
  const rifle = rifleTemplate.clone();
  rifle.position.copy(RIFLE_GRIP);
  holder.add(rifle);
  hand.add(holder);

  const label = makeNameSprite(name, hex);
  label.position.y = LABEL_Y; // (makeNameSprite keeps it off the outline/reflection layer)
  group.add(label);

  const anim = new AvatarAnimator(model, t);
  // Legacy-shaped fields so callers that only need group/label/head keep working.
  const head = model.getObjectByName('mixamorigHead');
  group.userData = { group, model, anim, label, head, marker: holder, rigged: true };
  return group.userData;
}

/**
 * First-person arms: the team's suit frozen in the aiming pose, cut down to
 * just the arms and gloves.
 * Returns { model, rifleMatrix } where rifleMatrix maps rr.glb's raw model
 * space into the suit's space; the viewmodel uses it to put the hands exactly
 * on its own rifle. Null until preloadAvatars() has finished.
 */
export function makeFirstPersonArms(hex) {
  if (!avatarsReady()) return null;
  const t = templates[RIG_FOR_HEX[hex] || 'p1'];
  const model = cloneSkinned(t.scene);
  model.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  // Pose once and leave the mixer un-stopped: stopping an action restores the
  // bones' original (rest) values, and we want them to keep the aim pose.
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(t.clips.idle).play();
  mixer.setTime(0.5);
  // first person: hang the support elbow straight down so that forearm runs
  // off the bottom of the screen instead of flaring out to the side
  const ik = makeArmIK(model);
  const base = { leftElbowDown: 1, headPitch: 0 };
  ik(t.tweaks ? t.tweaks.hand : null, base);
  // express the rifle-space nudge in chest space (IK offsets are chest-local)
  model.updateMatrixWorld(true);
  const handQ = model.getObjectByName('mixamorigRightHand').getWorldQuaternion(new THREE.Quaternion());
  const rifleQ = handQ.multiply(t.rifle.quat);
  const chestQ = model.getObjectByName('mixamorigSpine2').getWorldQuaternion(new THREE.Quaternion());
  const leftHand = FP_LEFT_HAND.clone().multiplyScalar(RIFLE_SCALE).applyQuaternion(rifleQ).applyQuaternion(chestQ.invert());
  // second call re-solves from the animated pose (armik never stacks corrections)
  ik(t.tweaks ? t.tweaks.hand : null, { ...base, leftHand, leftWristRoll: FP_LEFT_ROLL });
  // Keep only forearms, gloves and the elbow half of the upper arms (by each
  // vertex's dominant bone). Shoulder pads and chest would sit in front of
  // the camera; the rest is behind it.
  model.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const bones = o.skeleton.bones;
    const bindPos = o.skeleton.boneInverses.map((m) => new THREE.Vector3().setFromMatrixPosition(m.clone().invert()));
    const idxOf = (n) => bones.findIndex((b) => b.name === 'mixamorig' + n);
    // upper arms: keep only the elbow half so the shoulder pads drop out
    const upper = {};
    for (const side of ['Left', 'Right']) {
      const a = idxOf(side + 'Arm'), f = idxOf(side + 'ForeArm');
      upper[a] = { from: bindPos[a], dir: bindPos[f].clone().sub(bindPos[a]) };
    }
    const keepBone = bones.map((b) => /(ForeArm|Hand)/.test(b.name));
    const g = o.geometry.clone();
    const pos = g.attributes.position, ji = g.attributes.skinIndex, jw = g.attributes.skinWeight;
    const W = ['getX', 'getY', 'getZ', 'getW'];
    const v = new THREE.Vector3();
    const keepVert = (i) => {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) { const w = jw[W[k]](i); if (w > bw) { bw = w; best = ji[W[k]](i); } }
      if (keepBone[best]) return true;
      const u = upper[best];
      if (!u) return false;
      const along = v.fromBufferAttribute(pos, i).sub(u.from).dot(u.dir) / u.dir.lengthSq();
      return along > 0.8; // just the elbow cap, so the forearm doesn't end in an open cut
    };
    const idx = g.index.array, kept = [];
    for (let t = 0; t < idx.length; t += 3) {
      if (keepVert(idx[t]) && keepVert(idx[t + 1]) && keepVert(idx[t + 2])) kept.push(idx[t], idx[t + 1], idx[t + 2]);
    }
    g.setIndex(kept);
    o.geometry = g;
  });
  model.updateMatrixWorld(true);

  // rr raw space -> suit space, exactly as the third-person holder places it
  const hand = model.getObjectByName('mixamorigRightHand');
  const rifleMatrix = new THREE.Matrix4()
    .compose(t.rifle.pos, t.rifle.quat, new THREE.Vector3(RIFLE_SCALE, RIFLE_SCALE, RIFLE_SCALE))
    .premultiply(hand.matrixWorld)
    .multiply(new THREE.Matrix4().makeTranslation(RIFLE_GRIP.x, RIFLE_GRIP.y, RIFLE_GRIP.z));
  return { model, rifleMatrix };
}

/**
 * Build a player avatar. Rigged (animated suit + rifle) once preloadAvatars()
 * has finished; the procedural box avatar before that or if loading failed.
 */
export function makeAvatar(name, hex) {
  if (avatarsReady()) return makeRiggedAvatar(name, hex);
  return makeLegacyAvatar(name, hex);
}

export function disposeAvatar(group) {
  const u = group.userData || {};
  if (!u.rigged) { disposeLegacyAvatar(group); return; }
  u.anim.dispose(u.model);
  if (u.label) { u.label.material.map.dispose(); u.label.material.dispose(); }
  // geometry, materials and textures are shared with the template: keep them
}

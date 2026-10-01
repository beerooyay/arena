// Bake the player avatars for the game:
//   assets/players/p1.glb, p2.glb   — suits with textures resized for runtime
//   assets/players/anims-p1.json    — Mixamo clips retargeted onto each rig,
//   assets/players/anims-p2.json      root motion stripped (the game moves players)
//
// Usage (from tools/):  npm install && npm run bake-avatars
//
// The suits are Tripo exports whose skeleton uses Mixamo bone names but an
// arms-down rest pose, so clips are retargeted per rig (see src/avatar/retarget.js).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { register } from 'node:module';

register('./three-resolve.mjs', import.meta.url);
const { makeRetargeter } = await import('../src/avatar/retarget.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets');
const OUT = path.join(ROOT, 'assets/players');
const TEX_SIZE = 1024;
const FPS = 30;

// game name -> Mixamo download
const CLIPS = {
  idle: 'Rifle Aiming Idle',
  runF: 'Run Forward',
  runB: 'Run Backward',
  runL: 'Run Left',
  runR: 'Run Right',
  sprint: 'Sprint Forward',
  fire: 'Firing Rifle (1)',
  death: 'Rifle Death',
  deathRun: 'Rifle Run To Dying',
  roll: 'Running Dive Roll',
  jump: 'Rifle Jump In Place',
  grenade: 'Toss Grenade',
};

// --- rebuild a glTF skeleton (bones + rest TRS) straight from the GLB JSON ---
function readGlbJson(file) {
  const b = fs.readFileSync(file);
  const len = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
}
function skeletonFromGlb(file) {
  const j = readGlbJson(file);
  const joints = new Set(j.skins[0].joints);
  const objs = j.nodes.map((n, i) => {
    // GLTFLoader sanitizes names ("mixamorig:Hips" -> "mixamorigHips"); match it
    const o = joints.has(i) ? new THREE.Bone() : new THREE.Object3D();
    o.name = THREE.PropertyBinding.sanitizeNodeName(n.name || '');
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  j.nodes.forEach((n, i) => (n.children || []).forEach((c) => objs[i].add(objs[c])));
  const root = new THREE.Group();
  for (const i of j.scenes[j.scene || 0].nodes) root.add(objs[i]);
  root.updateMatrixWorld(true);
  return root;
}

function loadFbx(name) {
  const buf = fs.readFileSync(path.join(SRC, name + '.fbx'));
  const obj = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  obj.animations[0].name = name;
  return obj;
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;

function bakeRig(rig, fbx) {
  const target = skeletonFromGlb(path.join(SRC, rig + '.glb'));
  const rt = makeRetargeter(target, fbx['Rifle Idle'] || Object.values(fbx)[0]);
  const out = { rig, fps: FPS, clips: {} };
  let idle = null;
  for (const [key, file] of Object.entries(CLIPS)) {
    const src = fbx[file];
    const clip = rt.retarget(src, src.animations[0], { fps: FPS, mirror: key === 'grenade' });
    if (key === 'idle') idle = clip;
    if (key === 'grenade') {
      const mixer = new THREE.AnimationMixer(target);
      mixer.clipAction(idle).play(); mixer.setTime(0.5); target.updateMatrixWorld(true);
      const shoulder = target.getObjectByName('mixamorigLeftShoulder');
      const chest = shoulder.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      mixer.stopAllAction();
      const action = mixer.clipAction(clip).setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true; action.play();
      const track = clip.tracks.find((track) => track.name === 'mixamorigLeftShoulder.quaternion');
      const values = new Float32Array(track.values.length);
      for (let i = 0; i < track.times.length; i++) {
        mixer.setTime(track.times[i]); target.updateMatrixWorld(true);
        chest.clone().multiply(shoulder.getWorldQuaternion(new THREE.Quaternion())).normalize().toArray(values, i * 4);
      }
      mixer.stopAllAction(); mixer.uncacheRoot(target); track.values = values;
    }
    // in place: pin hips X/Z to the first frame (keep the vertical bob / fall)
    const hp = clip.tracks.find((t) => t.name.endsWith('Hips.position'));
    const x0 = hp.values[0], z0 = hp.values[2];
    for (let i = 0; i < hp.values.length; i += 3) { hp.values[i] = x0; hp.values[i + 2] = z0; }
    out.clips[key] = {
      source: file,
      duration: r4(clip.duration),
      times: Array.from(clip.tracks[0].times, r4),
      tracks: clip.tracks.map((t) => ({ name: t.name, type: t.ValueTypeName, values: Array.from(t.values, r4) })),
    };
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
console.log('loading clips…');
const needed = new Set([...Object.values(CLIPS), 'Rifle Idle']);
const fbx = Object.fromEntries([...needed].map((n) => [n, loadFbx(n)]));

for (const rig of ['p1', 'p2']) {
  const data = bakeRig(rig, fbx);
  const file = path.join(OUT, `anims-${rig}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  console.log(`${path.relative(ROOT, file)}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB  (${Object.keys(data.clips).length} clips)`);

  if (process.argv.includes('--animations')) continue;
  const glbOut = path.join(OUT, `${rig}.glb`);
  execFileSync('npx', ['gltf-transform', 'resize', path.join(SRC, rig + '.glb'), glbOut,
    '--width', String(TEX_SIZE), '--height', String(TEX_SIZE)], { stdio: 'inherit', cwd: path.dirname(fileURLToPath(import.meta.url)) });
  console.log(`${path.relative(ROOT, glbOut)}  ${(fs.statSync(glbOut).size / 1024 / 1024).toFixed(1)} MB`);
}

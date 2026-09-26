import * as THREE from 'three';

// Mixamo clips assume Mixamo's T-pose rest; the Tripo rig uses the same bone
// names but an arms-down rest with different bone orientations. Retarget by:
//  1. posing a copy of the target skeleton into the source rest pose
//     (swing each bone so it points the same way as its source counterpart),
//  2. per frame, applying the source's world-space delta-from-rest to that
//     matched pose, then converting back to target-local rotations.

// bone -> child used to define its pointing direction
const AIM = {
  Hips: 'Spine', Spine: 'Spine1', Spine1: 'Spine2', Spine2: 'Neck', Neck: 'Head', Head: 'HeadTop_End',
  LeftShoulder: 'LeftArm', LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', LeftHand: 'LeftHandMiddle1',
  RightShoulder: 'RightArm', RightArm: 'RightForeArm', RightForeArm: 'RightHand', RightHand: 'RightHandMiddle1',
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', LeftFoot: 'LeftToeBase', LeftToeBase: 'LeftToe_End',
  RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', RightFoot: 'RightToeBase', RightToeBase: 'RightToe_End',
};
for (const s of ['Left', 'Right']) for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'])
  for (let i = 1; i <= 3; i++) AIM[`${s}Hand${f}${i}`] = `${s}Hand${f}${i + 1}`;

const P = 'mixamorig';
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

function bonesOf(root) {
  const m = new Map();
  root.traverse((o) => { if (o.isBone && o.name.startsWith(P)) m.set(o.name.slice(P.length), o); });
  return m;
}
const wpos = (o) => o.getWorldPosition(new THREE.Vector3());
const wquat = (o) => o.getWorldQuaternion(new THREE.Quaternion());

/**
 * Build a retargeter for a given target rig (a loaded glTF scene with mixamorig* bones)
 * and source rest skeleton (any loaded Mixamo FBX — all share the same rest).
 */
export function makeRetargeter(targetRoot, sourceRoot) {
  const tb = bonesOf(targetRoot), sb = bonesOf(sourceRoot);
  const names = [...tb.keys()].filter((n) => sb.has(n)); // hierarchy (traverse) order: parents first

  // save target rest locals so we can restore after posing
  const restLocal = new Map(names.map((n) => [n, tb.get(n).quaternion.clone()]));
  const hipsRestLocalPos = tb.get('Hips').position.clone();

  sourceRoot.updateMatrixWorld(true);
  const S0 = new Map(names.map((n) => [n, wquat(sb.get(n))]));

  // 1. pose target into source rest (swing top-down)
  targetRoot.updateMatrixWorld(true);
  for (const n of names) {
    const bone = tb.get(n);
    const c = AIM[n];
    if (c && tb.has(c) && sb.has(c)) {
      const tDir = _v1.copy(wpos(tb.get(c))).sub(wpos(bone)).normalize();
      const sDir = _v2.copy(wpos(sb.get(c))).sub(wpos(sb.get(n))).normalize();
      const swing = new THREE.Quaternion().setFromUnitVectors(tDir, sDir);
      const newWorld = swing.multiply(wquat(bone));
      const parentW = wquat(bone.parent);
      bone.quaternion.copy(parentW.invert().multiply(newWorld));
      bone.updateMatrixWorld(true);
    }
  }
  const T0 = new Map(names.map((n) => [n, wquat(tb.get(n))]));
  // correction C_b = S0^-1 * T0'  so that  Tw(t) = Sw(t) * C_b
  const C = new Map(names.map((n) => [n, S0.get(n).clone().invert().multiply(T0.get(n))]));

  // hips translation scale: target hip height / source hip height
  const tHips = tb.get('Hips'), sHips = sb.get('Hips');
  const k = wpos(tHips).y / wpos(sHips).y;
  const sHips0 = wpos(sHips);
  const tHips0 = wpos(tHips);

  // restore target rest
  for (const n of names) tb.get(n).quaternion.copy(restLocal.get(n));
  tHips.position.copy(hipsRestLocalPos);
  targetRoot.updateMatrixWorld(true);
  const hipsParentInv = new THREE.Matrix4().copy(tHips.parent.matrixWorld).invert();
  const hipsParentQ = wquat(tHips.parent);

  /** Bake a source clip (played on sourceRoot) into a clip for the target rig. */
  function retarget(srcRoot, srcClip, { fps = 30 } = {}) {
    const srcBones = bonesOf(srcRoot);
    const mixer = new THREE.AnimationMixer(srcRoot);
    const act = mixer.clipAction(srcClip); act.play();
    const frames = Math.max(2, Math.round(srcClip.duration * fps) + 1);
    const times = new Float32Array(frames);
    const qv = new Map(names.map((n) => [n, new Float32Array(frames * 4)]));
    const pv = new Float32Array(frames * 3);
    const Tw = new Map();
    for (let f = 0; f < frames; f++) {
      const t = Math.min(srcClip.duration, f / fps);
      times[f] = t;
      mixer.setTime(t);
      srcRoot.updateMatrixWorld(true);
      for (const n of names) {
        const w = wquat(srcBones.get(n)).multiply(C.get(n));
        Tw.set(n, w);
        const parentName = tb.get(n).parent.name.startsWith(P) ? tb.get(n).parent.name.slice(P.length) : null;
        const pw = parentName && Tw.has(parentName) ? Tw.get(parentName) : hipsParentQ;
        const local = _q.copy(pw).invert().multiply(w);
        local.toArray(qv.get(n), f * 4);
      }
      const hp = wpos(srcBones.get('Hips')).sub(sHips0).multiplyScalar(k).add(tHips0).applyMatrix4(hipsParentInv);
      hp.toArray(pv, f * 3);
    }
    mixer.stopAllAction(); mixer.uncacheRoot(srcRoot);
    const tracks = names.map((n) => new THREE.QuaternionKeyframeTrack(`${P}${n}.quaternion`, times, qv.get(n)));
    tracks.push(new THREE.VectorKeyframeTrack(`${P}Hips.position`, times, pv));
    return new THREE.AnimationClip(srcClip.name, srcClip.duration, tracks);
  }
  return { retarget, names, k };
}

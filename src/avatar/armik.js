import * as THREE from 'three';

// Per-rig hand correction: shift both hands by a fixed offset expressed in the
// chest (Spine2) frame, solved with analytic two-bone IK (upper arm + forearm),
// keeping each hand's world orientation so a hand-held rifle doesn't tilt.
// Used to compensate for rigs whose arm proportions put the rifle too high.

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3();
const _off = new THREE.Vector3(), _s = new THREE.Vector3(), _ax0 = new THREE.Vector3(), _ax1 = new THREE.Vector3();
const _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _aw = new THREE.Quaternion(), _bw = new THREE.Quaternion(), _cw = new THREE.Quaternion(), _pw = new THREE.Quaternion();
const clamp = (x) => Math.max(-1, Math.min(1, x));
const ang = (u, v) => Math.acos(clamp(u.dot(v) / (u.length() * v.length() || 1)));

export function makeArmIK(model) {
  const B = (n) => model.getObjectByName('mixamorig' + n);
  const chest = B('Spine2');
  const arms = ['Right', 'Left'].map((s) => ({ a: B(s + 'Arm'), b: B(s + 'ForeArm'), c: B(s + 'Hand') }));

  function solve({ a, b, c }, offWorld) {
    a.getWorldPosition(_a); b.getWorldPosition(_b); c.getWorldPosition(_c);
    _t.copy(_c).add(offWorld);
    c.getWorldQuaternion(_cw);
    const lab = _b.distanceTo(_a), lcb = _c.distanceTo(_b);
    const lat = Math.min(Math.max(_t.distanceTo(_a), Math.abs(lab - lcb) + 1e-4), lab + lcb - 1e-4);
    // 1. elbow: set interior angle so |hand - shoulder| == |target - shoulder|
    const ab = _b.clone().sub(_a), bc = _c.clone().sub(_b), ba = ab.clone().negate();
    const cur = ang(ba, bc);
    const want = Math.acos(clamp((lab * lab + lcb * lcb - lat * lat) / (2 * lab * lcb)));
    _ax0.crossVectors(ab, bc);
    if (_ax0.lengthSq() < 1e-12) _ax0.set(1, 0, 0); else _ax0.normalize();
    // rotating bc about (ab x bc) by +θ opens it away from ab => interior angle shrinks
    _q1.setFromAxisAngle(_ax0, cur - want);
    // b_world' = q1 * b_world  =>  b_local' = a_world^-1 * q1 * a_world * b_local
    a.getWorldQuaternion(_aw);
    _q0.copy(_aw).invert().multiply(_q1).multiply(_aw);
    b.quaternion.premultiply(_q0);
    b.updateMatrixWorld(true);
    // 2. shoulder swing: point shoulder->hand at shoulder->target
    c.getWorldPosition(_c);
    _q2.setFromUnitVectors(_c.clone().sub(_a).normalize(), _t.clone().sub(_a).normalize());
    a.getWorldQuaternion(_aw);
    a.parent.getWorldQuaternion(_pw);
    a.quaternion.copy(_pw.invert().multiply(_q2.multiply(_aw)));
    a.updateMatrixWorld(true);
    // 3. keep the hand's original world orientation (rifle stays level)
    b.getWorldQuaternion(_bw);
    c.quaternion.copy(_bw.invert().multiply(_cw));
    c.updateMatrixWorld(true);
  }

  // Rotate the whole arm about the shoulder->hand line: the hand stays put, the
  // elbow swings. amount 0..1 blends from the animated elbow to "straight down".
  function swivelDown({ a, b, c }, amount) {
    if (!amount) return;
    a.getWorldPosition(_a); b.getWorldPosition(_b); c.getWorldPosition(_c);
    c.getWorldQuaternion(_cw);
    const axis = _c.clone().sub(_a).normalize();
    const elbow = _b.clone().sub(_a); elbow.addScaledVector(axis, -elbow.dot(axis));
    const down = new THREE.Vector3(0, -1, 0); down.addScaledVector(axis, -down.dot(axis));
    if (elbow.lengthSq() < 1e-10 || down.lengthSq() < 1e-10) return;
    elbow.normalize(); down.normalize();
    const full = Math.atan2(_ax0.crossVectors(elbow, down).dot(axis), elbow.dot(down));
    _q2.setFromAxisAngle(axis, full * amount);
    a.getWorldQuaternion(_aw); a.parent.getWorldQuaternion(_pw);
    a.quaternion.copy(_pw.invert().multiply(_q2.multiply(_aw)));
    a.updateMatrixWorld(true);
    b.getWorldQuaternion(_bw);
    c.quaternion.copy(_bw.invert().multiply(_cw));
    c.updateMatrixWorld(true);
  }
  // Pitch the head up (radians) about its own left-right axis.
  function pitchHead(rad) {
    if (!rad) return;
    head.getWorldQuaternion(_cw);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(_cw);
    const axis = _ax1.crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    if (axis.lengthSq() < 1e-10) return;
    _q2.setFromAxisAngle(axis.normalize(), rad);
    head.parent.getWorldQuaternion(_pw);
    head.quaternion.copy(_pw.invert().multiply(_q2.multiply(_cw)));
    head.updateMatrixWorld(true);
  }

  // AnimationMixer only writes a bone when its sampled value changes, so on
  // held/paused frames our previous IK output would still be on the bones.
  // Remember what we wrote; if it's still there, restore the animated pose
  // first so the correction never accumulates.
  const head = B('Head');
  const bones = [...arms.flatMap(({ a, b, c }) => [a, b, c]), head];
  const base = bones.map((o) => o.quaternion.clone());
  const wrote = bones.map(() => new THREE.Quaternion(NaN, NaN, NaN, NaN));
  const EPS = 1e-9;
  const same = (p, q) => Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS && Math.abs(p.z - q.z) < EPS && Math.abs(p.w - q.w) < EPS;

  /** offsetChest: Vector3 in Spine2-local units (same scale as the model). Call after mixer.update. */
  // Roll the left hand about its forearm (palm up under a handguard, etc.).
  function rollLeftWrist(rad) {
    if (!rad) return;
    const { b, c } = arms[1];
    b.getWorldPosition(_b); c.getWorldPosition(_c);
    const axis = _c.clone().sub(_b).normalize();
    c.getWorldQuaternion(_cw);
    _q2.setFromAxisAngle(axis, rad);
    c.parent.getWorldQuaternion(_pw);
    c.quaternion.copy(_pw.invert().multiply(_q2.multiply(_cw)));
    c.updateMatrixWorld(true);
  }

  // opts: { leftElbowDown: 0..1, headPitch: radians (+ = look up),
  //         leftHand: extra chest-space offset for the left hand only,
  //         leftWristRoll: radians about the left forearm }
  return function apply(offsetChest, opts = {}) {
    bones.forEach((o, i) => { if (same(o.quaternion, wrote[i])) o.quaternion.copy(base[i]); else base[i].copy(o.quaternion); });
    model.updateMatrixWorld(true);
    if (offsetChest && offsetChest.lengthSq() > 0) {
      // offset is in model units along the chest axes: rotate it into world
      // space and scale it with the model (the game scales avatars up)
      chest.getWorldQuaternion(_pw);
      chest.getWorldScale(_s);
      _off.copy(offsetChest).multiplyScalar(_s.x).applyQuaternion(_pw);
      for (const arm of arms) solve(arm, _off);
    }
    if (opts.leftHand && opts.leftHand.lengthSq() > 0) {
      chest.getWorldQuaternion(_pw);
      chest.getWorldScale(_s);
      _off.copy(opts.leftHand).multiplyScalar(_s.x).applyQuaternion(_pw);
      solve(arms[1], _off);
    }
    swivelDown(arms[1], opts.leftElbowDown || 0);
    rollLeftWrist(opts.leftWristRoll || 0);
    pitchHead(opts.headPitch || 0);
    bones.forEach((o, i) => wrote[i].copy(o.quaternion));
  };
}

/** Convert a world-space offset (measured in some pose) into chest-local, for storage. */
export function worldToChestOffset(model, offWorld) {
  const q = model.getObjectByName('mixamorigSpine2').getWorldQuaternion(new THREE.Quaternion()).invert();
  return offWorld.clone().applyQuaternion(q);
}

// Tripo's mesh is fused where the rest-pose hands touch the thighs, so the
// auto-rig bleeds hand weights into the holster/thigh (and vice versa).
// Split them: drop the minority side's influences per vertex, then delete the
// triangles that still bridge hand <-> body.
export function fixHandThighBleed(skinnedMesh) {
  const g = skinnedMesh.geometry;
  // getX/…/setW work on plain and interleaved (packed) attributes alike;
  // getComponent/setComponent don't exist on InterleavedBufferAttribute in r160
  const GET = ['getX', 'getY', 'getZ', 'getW'], SET = ['setX', 'setY', 'setZ', 'setW'];
  const wrap = (a) => ({ count: a.count, getComponent: (i, k) => a[GET[k]](i), setComponent: (i, k, v) => a[SET[k]](i, v), a });
  const ji = wrap(g.attributes.skinIndex), jw = wrap(g.attributes.skinWeight);
  const names = skinnedMesh.skeleton.bones.map((b) => b.name.replace(/^mixamorig:?/, ''));
  const grp = (n) => {
    for (const s of ['Right', 'Left']) if (n.startsWith(s + 'Hand') || n === s + 'ForeArm') return 'H';
    if (/UpLeg|Leg$|Foot|Toe|^Hips$|^Spine$|^Spine1$/.test(n)) return 'B';
    return 'O';
  };
  const G = names.map(grp);
  let reweighted = 0;
  for (let i = 0; i < ji.count; i++) {
    let h = 0, b = 0;
    for (let k = 0; k < 4; k++) { const w = jw.getComponent(i, k), gg = G[ji.getComponent(i, k)]; if (gg === 'H') h += w; else if (gg === 'B') b += w; }
    if (h > 0 && b > 0) {
      const drop = h >= b ? 'B' : 'H';
      let sum = 0;
      for (let k = 0; k < 4; k++) { if (G[ji.getComponent(i, k)] === drop) jw.setComponent(i, k, 0); sum += jw.getComponent(i, k); }
      for (let k = 0; k < 4; k++) jw.setComponent(i, k, sum > 0 ? jw.getComponent(i, k) / sum : 0);
      reweighted++;
    }
  }
  if (jw.a.isInterleavedBufferAttribute) jw.a.data.needsUpdate = true; else jw.a.needsUpdate = true;
  const dom = (i) => { let best = 0, bw = -1; for (let k = 0; k < 4; k++) { const w = jw.getComponent(i, k); if (w > bw) { bw = w; best = ji.getComponent(i, k); } } return G[best]; };
  const idx = g.index.array, keep = [];
  let removed = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const gs = [dom(idx[t]), dom(idx[t + 1]), dom(idx[t + 2])];
    if (gs.includes('H') && gs.includes('B')) { removed++; continue; }
    keep.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  g.setIndex(keep);
  return { reweighted, removed };
}

// Tripo sometimes places the upper spine joint (Spine2) right under the neck.
// Mixamo clips bend the chest around Spine2, so a too-high pivot lifts the arms
// (and rifle) into the helmet. Re-place Spine2 at the source skeleton's
// proportion along Spine1->Neck without moving any other joint, and rebind it
// so the rest mesh is unchanged.
export function fixSpine2(targetRoot, sourceRoot) {
  const P = 'mixamorig';
  const T = (root, n) => root.getObjectByName(P + n);
  targetRoot.updateMatrixWorld(true); sourceRoot.updateMatrixWorld(true);
  const wp = (o) => o.getWorldPosition(new o.position.constructor());
  const s1 = wp(T(sourceRoot, 'Spine1')), s2 = wp(T(sourceRoot, 'Spine2')), sn = wp(T(sourceRoot, 'Neck'));
  const f = s2.clone().sub(s1).length() / sn.clone().sub(s1).length();
  const spine1 = T(targetRoot, 'Spine1'), spine2 = T(targetRoot, 'Spine2');
  const t1 = wp(spine1), tn = wp(T(targetRoot, 'Neck')), old = wp(spine2);
  const target = t1.clone().lerp(tn, f);
  const oldWorld = spine2.matrixWorld.clone();
  const kids = spine2.children.filter((c) => c.isBone).map((c) => [c, wp(c)]);
  spine2.position.copy(spine1.worldToLocal(target.clone()));
  spine2.updateMatrixWorld(true);
  for (const [c, w] of kids) { c.position.copy(spine2.worldToLocal(w.clone())); }
  spine2.updateMatrixWorld(true);
  let rebound = 0;
  targetRoot.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const i = o.skeleton.bones.indexOf(spine2);
    if (i < 0) return;
    // keep rest skinning identical: newWorld * newInv == oldWorld * oldInv
    o.skeleton.boneInverses[i].premultiply(oldWorld).premultiply(spine2.matrixWorld.clone().invert());
    rebound++;
  });
  return { fraction: +f.toFixed(3), movedBy: +old.distanceTo(target).toFixed(3), rebound };
}

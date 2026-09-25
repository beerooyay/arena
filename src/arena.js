import * as THREE from 'three';

export function buildArena(scene, mapId = 1) {
  const group = new THREE.Group();
  scene.add(group);

  const paintTargets = [];
  const blockers = [];
  const tankBlockers = [];
  const groundMeshes = [];
  const ceilings = [];
  const materials = [];

  function mat(hex, rough = 0.82) {
    const m = new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0 });
    m.userData.baseColor = new THREE.Color(hex);
    materials.push(m);
    return m;
  }

  function glow(hex, night = hex) {
    const m = new THREE.MeshStandardMaterial({
      color: hex, roughness: 0.45, metalness: 0,
      emissive: new THREE.Color(night), emissiveIntensity: night === hex ? 0.32 : 0,
    });
    m.userData.baseColor = new THREE.Color(hex);
    m.userData.accent = night;
    materials.push(m);
    return m;
  }

  const floorMat = mat(0xf8f9fa, 0.94);
  const wallMat = mat(0xf1f3f5, 0.86);
  const panelMat = mat(0xdde2e7, 0.78);
  const coverMat = mat(0xaeb5bf, 0.72);
  const ceilMat = mat(0xe8ebef, 0.8);
  const trimMat = mat(0x7f8791, 0.66);
  const fireMat = glow(0xff6000);
  const redMat = glow(0xd8dde3, 0xff4848);
  fireMat.side = redMat.side = THREE.DoubleSide;

  const size = 25;
  const radius = size / Math.cos(Math.PI / 8);
  const wallH = 10;
  const wallT = 0.7;
  const ceilY = 10.15;
  const edgeLen = 2 * size * Math.tan(Math.PI / 8);

  const floor = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 8), floorMat);
  floor.position.y = -0.5;
  floor.rotation.y = Math.PI / 8;
  floor.receiveShadow = true;
  floor.name = 'floor';
  group.add(floor);
  paintTargets.push(floor);
  groundMeshes.push(floor);

  const edge = new THREE.Mesh(new THREE.RingGeometry(size - 0.18, size + 0.18, 8), fireMat);
  edge.rotation.x = -Math.PI / 2;
  edge.rotation.z = Math.PI / 8;
  edge.position.y = 0.012;
  group.add(edge);

  const center = new THREE.Mesh(new THREE.RingGeometry(2.3, 2.55, 32), redMat);
  center.rotation.x = -Math.PI / 2;
  center.position.y = 0.013;
  group.add(center);

  const grid = new THREE.GridHelper(size * 2, 20, 0x646b74, 0xd9dde2);
  grid.material.opacity = 0.12;
  grid.material.transparent = true;
  grid.material.depthWrite = false;
  grid.position.y = 0.011;
  group.add(grid);

  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    const seg = new THREE.Group();
    seg.position.set(Math.sin(a) * (size + wallT / 2), wallH / 2, Math.cos(a) * (size + wallT / 2));
    seg.rotation.y = a;
    group.add(seg);

    const wall = new THREE.Mesh(new THREE.BoxGeometry(edgeLen + 0.12, wallH, wallT), wallMat);
    wall.castShadow = true;
    wall.receiveShadow = true;
    seg.add(wall);
    paintTargets.push(wall);

    const panel = new THREE.Mesh(new THREE.BoxGeometry(edgeLen - 1.0, wallH - 1.2, 0.05), panelMat);
    panel.position.z = -wallT / 2 - 0.028;
    panel.receiveShadow = true;
    seg.add(panel);
    paintTargets.push(panel);

    const low = new THREE.Mesh(new THREE.BoxGeometry(edgeLen - 0.8, 0.08, 0.07), i % 2 ? redMat : fireMat);
    low.position.set(0, -wallH / 2 + 0.28, -wallT / 2 - 0.06);
    seg.add(low);

    const high = new THREE.Mesh(new THREE.BoxGeometry(edgeLen - 0.8, 0.06, 0.07), trimMat);
    high.position.set(0, wallH / 2 - 0.38, -wallT / 2 - 0.06);
    seg.add(high);
  }

  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4 + Math.PI / 8;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, wallH, 10), panelMat);
    post.position.set(Math.sin(a) * radius, wallH / 2, Math.cos(a) * radius);
    post.castShadow = true;
    post.receiveShadow = true;
    group.add(post);
    paintTargets.push(post);
  }

  const ceiling = new THREE.Mesh(new THREE.CylinderGeometry(radius + wallT, radius + wallT, 0.3, 8), ceilMat);
  ceiling.position.y = ceilY;
  ceiling.rotation.y = Math.PI / 8;
  ceiling.receiveShadow = true;
  group.add(ceiling);
  paintTargets.push(ceiling);
  ceilings.push(new THREE.Box3(
    new THREE.Vector3(-radius, ceilY - 0.15, -radius),
    new THREE.Vector3(radius, ceilY + 0.15, radius)));

  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, radius * 0.9), trimMat);
    beam.position.set(Math.sin(a) * radius * 0.45, ceilY - 0.24, Math.cos(a) * radius * 0.45);
    beam.rotation.y = a;
    beam.castShadow = true;
    group.add(beam);
    paintTargets.push(beam);
  }

  const ringA = new THREE.Mesh(new THREE.RingGeometry(size * 0.48, size * 0.50, 8), fireMat);
  ringA.rotation.x = Math.PI / 2;
  ringA.rotation.z = Math.PI / 8;
  ringA.position.y = ceilY - 0.31;
  group.add(ringA);

  const ringB = new THREE.Mesh(new THREE.RingGeometry(size * 0.66, size * 0.68, 8), redMat);
  ringB.rotation.x = Math.PI / 2;
  ringB.rotation.z = Math.PI / 8;
  ringB.position.y = ceilY - 0.32;
  group.add(ringB);

  function addBox(w, h, d, x, y, z, material, rotY = 0) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotY;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    paintTargets.push(mesh);
    groundMeshes.push(mesh);
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    blockers.push(box);
    tankBlockers.push(box);
    mesh.userData.blocker = box;
    mesh.userData.destructible = false;
    return mesh;
  }

  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.9, ceilY - 0.25, 20), panelMat);
  pillar.position.y = (ceilY - 0.25) / 2;
  pillar.castShadow = true;
  pillar.receiveShadow = true;
  group.add(pillar);
  paintTargets.push(pillar);
  pillar.updateMatrixWorld(true);
  const pillarBox = new THREE.Box3().setFromObject(pillar);
  blockers.push(pillarBox);
  tankBlockers.push(pillarBox);
  pillar.userData.blocker = pillarBox;
  pillar.userData.destructible = false;

  for (let i = 0; i < 4; i++) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.09, ceilY - 1.4, 0.09), i % 2 ? redMat : fireMat);
    const a = i * Math.PI / 2;
    strip.position.set(Math.sin(a) * 1.72, (ceilY - 1.4) / 2 + 0.45, Math.cos(a) * 1.72);
    group.add(strip);
  }

  addBox(4.6, 1.35, 0.75, -8.5, 0.675, -6.5, coverMat, -Math.PI / 4);
  addBox(4.6, 1.35, 0.75, 8.5, 0.675, 6.5, coverMat, -Math.PI / 4);
  addBox(4.6, 1.35, 0.75, 8.5, 0.675, -6.5, coverMat, Math.PI / 4);
  addBox(4.6, 1.35, 0.75, -8.5, 0.675, 6.5, coverMat, Math.PI / 4);

  return { group, paintTargets, blockers, tankBlockers, groundMeshes, ceilings, materials, floor, size, mapId };
}

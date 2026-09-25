import * as THREE from 'three';

// Polished white floor tiles: bright faces, soft gray grout.
function tileTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f5f7';
  ctx.fillRect(0, 0, S, S);
  // faint per-tile variation so the floor doesn't read as one flat sheet
  const n = 2, t = S / n;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const g = 242 + ((x + y) % 2) * 5;
    ctx.fillStyle = `rgb(${g},${g + 1},${g + 3})`;
    ctx.fillRect(x * t, y * t, t, t);
  }
  ctx.strokeStyle = '#b9bec5';
  ctx.lineWidth = 3;
  for (let i = 0; i <= n; i++) {
    ctx.beginPath(); ctx.moveTo(i * t, 0); ctx.lineTo(i * t, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * t); ctx.lineTo(S, i * t); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

export function buildArena(scene, mapId = 1) {
  const group = new THREE.Group();
  scene.add(group);

  const paintTargets = [];
  const blockers = [];
  const tankBlockers = [];
  const groundMeshes = [];
  const ceilings = [];
  const materials = [];

  // Every arena material records its day/night emissive so Lights Out can flip
  // the whole set (see setArenaEmissive in main.js).
  function mat(hex, rough = 0.5, extra = {}) {
    const m = new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0, envMapIntensity: 0.6, ...extra });
    m.userData.baseColor = new THREE.Color(hex);
    m.userData.day = { hex: 0x000000, i: 0 };
    m.userData.night = { hex: 0x101820, i: 0.08 };
    materials.push(m);
    return m;
  }

  // LED light strip: white in the day, an orange/crimson neon at night.
  function led(night, dayI = 6, nightI = 5) {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0 });
    m.toneMapped = false;
    m.userData.baseColor = new THREE.Color(0xffffff);
    m.userData.day = { hex: 0xffffff, i: dayI };
    m.userData.night = { hex: night, i: nightI };
    m.userData.accent = night;
    m.emissive.setHex(0xffffff);
    m.emissiveIntensity = dayI;
    materials.push(m);
    return m;
  }

  const tex = tileTexture();
  const floorMat = mat(0xffffff, 0.16, { map: tex, envMapIntensity: 1.1 });
  const wallMat = mat(0xb4bac2, 0.6);            // shows through panel seams
  const panelMat = mat(0xeceef1, 0.42);
  const ceilMat = mat(0xeef0f3, 0.55, { flatShading: true, side: THREE.DoubleSide });
  ceilMat.userData.day = { hex: 0xffffff, i: 0.18 }; // keeps the underside of the dome bright
  ceilMat.emissive.setHex(0xffffff); ceilMat.emissiveIntensity = 0.18;
  const pillarMat = mat(0xf4f6f8, 0.34);
  const coverMat = mat(0xe4e7eb, 0.45);
  const trimMat = mat(0x9aa1aa, 0.5);
  const darkMat = mat(0x3a3f47, 0.6);
  const ledA = led(0xff6000);
  const ledB = led(0xff4848);

  const size = 25;
  const radius = size / Math.cos(Math.PI / 8);
  const wallH = 10;
  const wallT = 0.7;
  const ceilY = 10.15;
  const domeH = 3.4;
  const domeTopR = 3.2;
  const edgeLen = 2 * size * Math.tan(Math.PI / 8);

  // --- floor ---
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 8), floorMat);
  tex.repeat.set(radius * 2 / 9, radius * 2 / 9); // ~4.5m tiles (cap UVs span the diameter)
  floor.position.y = -0.5;
  floor.rotation.y = Math.PI / 8;
  floor.receiveShadow = true;
  floor.name = 'floor';
  group.add(floor);
  paintTargets.push(floor);
  groundMeshes.push(floor);

  // --- walls: seamed tall panels, LED cove up top, lit kick strip at the floor ---
  const PANELS = 3;
  const panelW = (edgeLen - 0.2) / PANELS;
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

    const inner = -wallT / 2;
    for (let p = 0; p < PANELS; p++) {
      const x = -edgeLen / 2 + 0.1 + panelW * (p + 0.5);
      // main panel, from the kick strip to the cove
      const panel = new THREE.Mesh(new THREE.BoxGeometry(panelW - 0.07, wallH - 1.45, 0.08), panelMat);
      panel.position.set(x, -0.28, inner - 0.04);
      panel.receiveShadow = true;
      seg.add(panel);
      paintTargets.push(panel);
      // upper fascia above the LED strip, slightly proud
      const fascia = new THREE.Mesh(new THREE.BoxGeometry(panelW - 0.07, 0.62, 0.2), panelMat);
      fascia.position.set(x, wallH / 2 - 0.34, inner - 0.1);
      seg.add(fascia);
      paintTargets.push(fascia);
    }
    // LED cove under the fascia + kick strip along the floor
    const cove = new THREE.Mesh(new THREE.BoxGeometry(edgeLen - 0.2, 0.09, 0.05), ledA);
    cove.position.set(0, wallH / 2 - 0.71, inner - 0.18);
    seg.add(cove);
    const coveShelf = new THREE.Mesh(new THREE.BoxGeometry(edgeLen - 0.2, 0.05, 0.24), trimMat);
    coveShelf.position.set(0, wallH / 2 - 0.66, inner - 0.12);
    seg.add(coveShelf);
    const kick = new THREE.Mesh(new THREE.BoxGeometry(edgeLen - 0.2, 0.06, 0.04), i % 2 ? ledB : ledA);
    kick.position.set(0, -wallH / 2 + 0.2, inner - 0.08);
    seg.add(kick);
    const base = new THREE.Mesh(new THREE.BoxGeometry(edgeLen - 0.2, 0.16, 0.14), darkMat);
    base.position.set(0, -wallH / 2 + 0.08, inner - 0.07);
    seg.add(base);
  }

  // corner posts
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4 + Math.PI / 8;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.9, wallH, 0.9), panelMat);
    post.position.set(Math.sin(a) * (radius - 0.2), wallH / 2, Math.cos(a) * (radius - 0.2));
    post.rotation.y = a;
    post.castShadow = true;
    post.receiveShadow = true;
    group.add(post);
    paintTargets.push(post);
  }

  // --- faceted dome ceiling: 8 sloped panels rising to a lit oculus ---
  const dome = new THREE.Mesh(
    new THREE.CylinderGeometry(domeTopR, radius + wallT, domeH, 8, 2, true), ceilMat);
  dome.position.y = ceilY + domeH / 2;
  dome.rotation.y = Math.PI / 8;
  dome.receiveShadow = true;
  group.add(dome);
  paintTargets.push(dome);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(domeTopR + 0.05, domeTopR + 0.05, 0.2, 8), ceilMat);
  cap.position.y = ceilY + domeH;
  cap.rotation.y = Math.PI / 8;
  group.add(cap);
  paintTargets.push(cap);
  ceilings.push(new THREE.Box3(
    new THREE.Vector3(-radius, ceilY - 0.15, -radius),
    new THREE.Vector3(radius, ceilY + 0.15, radius)));

  // ribs along each fold, each carrying a thin LED line, plus a mid ring
  const slope = Math.atan2(domeH, radius + wallT - domeTopR);
  const ribLen = Math.hypot(domeH, radius + wallT - domeTopR);
  const ribMid = (radius + wallT + domeTopR) / 2;
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4 + Math.PI / 8;
    const rib = new THREE.Group();
    rib.position.set(Math.sin(a) * ribMid, ceilY + domeH / 2 - 0.12, Math.cos(a) * ribMid);
    rib.rotation.set(0, a, 0);
    group.add(rib);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.18, ribLen), panelMat);
    beam.rotation.x = slope;
    rib.add(beam);
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.04, ribLen - 0.4), ledA);
    line.rotation.x = slope;
    line.position.y = -0.1;
    rib.add(line);
  }
  const midR = (radius + wallT) * 0.55 + domeTopR * 0.45;
  const midY = ceilY + domeH * 0.45 - 0.1;
  const midEdge = 2 * midR * Math.cos(Math.PI / 8) * Math.tan(Math.PI / 8);
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    const r = midR * Math.cos(Math.PI / 8) - 0.15;
    const ringSeg = new THREE.Mesh(new THREE.BoxGeometry(midEdge, 0.05, 0.08), ledA);
    ringSeg.position.set(Math.sin(a) * r, midY, Math.cos(a) * r);
    ringSeg.rotation.y = a;
    group.add(ringSeg);
  }
  const oculus = new THREE.Mesh(new THREE.CircleGeometry(domeTopR * 0.8, 8), ledA);
  oculus.rotation.x = Math.PI / 2;
  oculus.rotation.z = Math.PI / 8;
  oculus.position.y = ceilY + domeH - 0.12;
  group.add(oculus);

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

  // --- central pillar: seamed white column meeting the oculus ---
  const pillarH = ceilY + domeH;
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, pillarH, 40), pillarMat);
  pillar.position.y = pillarH / 2;
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

  for (const y of [2.6, 6.4]) { // horizontal panel seams
    const seam = new THREE.Mesh(new THREE.CylinderGeometry(1.812, 1.812, 0.035, 40, 1, true), trimMat);
    seam.position.y = y;
    group.add(seam);
  }
  for (let i = 0; i < 6; i++) { // vertical seams
    const a = i * Math.PI / 3;
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.03, pillarH - 0.4, 0.03), trimMat);
    seam.position.set(Math.sin(a) * 1.8, pillarH / 2, Math.cos(a) * 1.8);
    group.add(seam);
  }
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.95, 1.95, 0.18, 40), darkMat);
  plinth.position.y = 0.09;
  group.add(plinth);
  const plinthLed = new THREE.Mesh(new THREE.CylinderGeometry(1.84, 1.84, 0.05, 40, 1, true), ledA);
  plinthLed.position.y = 0.22;
  group.add(plinthLed);

  // --- low cover: white slabs on dark plinths with a lit top edge ---
  const covers = [
    [-8.5, -6.5, -Math.PI / 4], [8.5, 6.5, -Math.PI / 4],
    [8.5, -6.5, Math.PI / 4], [-8.5, 6.5, Math.PI / 4],
  ];
  covers.forEach(([x, z, r], i) => {
    const c = addBox(4.6, 1.35, 0.75, x, 0.675, z, coverMat, r);
    const plinthC = new THREE.Mesh(new THREE.BoxGeometry(4.64, 0.14, 0.79), darkMat);
    plinthC.position.set(0, -0.6, 0);
    c.add(plinthC);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.04, 0.05), i % 2 ? ledB : ledA);
    lip.position.set(0, 0.5, -0.4);
    c.add(lip);
    const lip2 = lip.clone();
    lip2.position.z = 0.4;
    c.add(lip2);
  });

  return { group, paintTargets, blockers, tankBlockers, groundMeshes, ceilings, materials, floor, size, mapId };
}

import * as THREE from 'three';

/**
 * Builds a clean white test arena.
 * Returns references used by the rest of the game:
 *  - group:        the arena root object
 *  - paintTargets: meshes that can receive paint decals + be shot
 *  - blockers:     THREE.Box3[] for horizontal player collision
 *  - groundMeshes: meshes used for downward "stand on" raycasts (floor, ramps, tops)
 *  - materials:    the shared standard materials (so contrast slider can tweak them)
 */
export function buildArena(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const paintTargets = [];
  const blockers = [];
  const groundMeshes = [];
  const ceilings = [];
  const materials = [];

  // --- Shared white / off-white materials with subtle tonal variation ---
  function whiteMat(hex, rough = 0.85) {
    const m = new THREE.MeshStandardMaterial({
      color: hex,
      roughness: rough,
      metalness: 0.0,
    });
    m.userData.baseColor = new THREE.Color(hex);
    materials.push(m);
    return m;
  }

  // Near-pure white everywhere. Readability comes from the outline pass and
  // soft shadows, not from gray material tones. Variations are tiny (< 1%).
  const floorMat  = whiteMat(0xffffff, 0.95);
  const wallMat   = whiteMat(0xffffff, 0.9);
  const crateMat  = whiteMat(0xffffff, 0.8);
  const pillarMat = whiteMat(0xfdfdfe, 0.85);
  const rampMat   = whiteMat(0xffffff, 0.88);
  const barrierMat= whiteMat(0xfcfcfd, 0.8);
  const coverMat  = whiteMat(0xfdfdfd, 0.82);

  const ARENA = 60;   // half-extent of playable area
  const WALL_H = 8;
  const WALL_T = 1;

  // --- Floor with faint grid seams for depth readability ---
  const floorGeo = new THREE.BoxGeometry(ARENA * 2, 1, ARENA * 2);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.position.y = -0.5;
  floor.receiveShadow = true;
  floor.name = 'floor';
  group.add(floor);
  paintTargets.push(floor);
  groundMeshes.push(floor);

  // very faint grid seams for a hint of ground scale (kept subtle so the
  // floor still reads as white)
  const grid = new THREE.GridHelper(ARENA * 2, ARENA, 0xe4e7ea, 0xeef0f2);
  grid.material.opacity = 0.15;
  grid.material.transparent = true;
  grid.material.depthWrite = false;
  grid.position.y = 0.011;
  group.add(grid);

  // helper: axis-aligned box mesh registered as blocker + paint target
  function addBox(w, h, d, x, y, z, mat, { blocker = true, stand = true } = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    paintTargets.push(mesh);
    if (stand) groundMeshes.push(mesh);
    if (blocker) {
      const box = new THREE.Box3().setFromObject(mesh);
      blockers.push(box);
    }
    return mesh;
  }

  // --- Perimeter walls ---
  addBox(ARENA * 2, WALL_H, WALL_T, 0, WALL_H / 2, -ARENA, wallMat, { stand: false });
  addBox(ARENA * 2, WALL_H, WALL_T, 0, WALL_H / 2,  ARENA, wallMat, { stand: false });
  addBox(WALL_T, WALL_H, ARENA * 2, -ARENA, WALL_H / 2, 0, wallMat, { stand: false });
  addBox(WALL_T, WALL_H, ARENA * 2,  ARENA, WALL_H / 2, 0, wallMat, { stand: false });

  // --- A few interior dividing walls (cover + sightline breaks) ---
  addBox(18, 5, 1, -18, 2.5, -8, wallMat);
  addBox(1, 5, 16, 10, 2.5, 14, wallMat);
  addBox(14, 4, 1, 22, 2, -20, wallMat);
  // extra interior walls for more sightline breaks + a central cross
  addBox(12, 4, 1, -30, 2, 16, wallMat);
  addBox(1, 4, 14, 34, 2, 30, wallMat);
  addBox(10, 3.5, 1, 4, 1.75, 6, wallMat);
  addBox(1, 3.5, 10, -6, 1.75, -2, wallMat);
  addBox(16, 4, 1, -40, 2, -34, wallMat);

  // --- Crates (clusters, stackable to climb) ---
  const crateSpots = [
    [-6, 6, 2], [-4, 5, 2], [-5, 5, 4],
    [14, -18, 1.6], [16, -16, 1.6], [15, -17, 3.2],
    [-24, 20, 2.2], [-21, 22, 2.2],
    [4, -6, 1.4], [30, 10, 2],
    [-36, -24, 1.8], [-34, -22, 1.8], [-35, -23, 3.5],
    [24, 24, 2.0], [26, 26, 2.0], [25, 25, 3.8],
    [-10, -40, 1.5], [-12, -40, 1.5], [-11, -40, 3.0],
    [40, -8, 1.8], [42, -10, 2.2], [41, -9, 3.8],
    [-48, 40, 2], [-46, 42, 2], [-47, 41, 3.6],
    [48, -34, 2], [46, -32, 2],
    [2, 44, 1.8], [5, 46, 1.8], [3.5, 45, 3.4],
    [-50, 8, 2.2], [50, 4, 2.2],
    [10, -48, 1.8], [12, -46, 1.8], [11, -47, 3.4],
    [-2, -12, 1.6], [16, 34, 2], [-32, -12, 1.8],
  ];
  for (const [x, z, s] of crateSpots) {
    addBox(s, s, s, x, s / 2, z, crateMat);
  }

  // --- Pillars ---
  const pillarSpots = [
    [-30, -30], [30, 30], [-30, 30], [30, -30], [0, 0],
    [-15, 22], [15, -22], [-45, -45], [45, 45], [22, 40], [-22, -40],
  ];
  for (const [x, z] of pillarSpots) {
    const r = 1.1;
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 7, 24), pillarMat);
    mesh.position.set(x, 3.5, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    paintTargets.push(mesh);
    const box = new THREE.Box3().setFromObject(mesh);
    blockers.push(box);
  }

  // --- Ramps (walkable, not horizontal blockers) ---
  function addRamp(x, z, rotY, len = 8, wide = 5, rise = 3) {
    const geo = new THREE.BoxGeometry(wide, 0.4, len);
    const mesh = new THREE.Mesh(geo, rampMat);
    const angle = Math.atan2(rise, len);
    mesh.position.set(x, rise / 2, z);
    mesh.rotation.y = rotY;
    mesh.rotateX(-angle);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    paintTargets.push(mesh);
    groundMeshes.push(mesh);
    // a platform at the top of each ramp
    const plat = addBox(wide, 0.6, 4,
      x - Math.sin(rotY) * (len / 2 + 2),
      rise,
      z - Math.cos(rotY) * (len / 2 + 2),
      rampMat);
    return mesh;
  }
  addRamp(-38, -10, 0);
  addRamp(38, 8, Math.PI, 9, 6, 3.5);
  addRamp(6, 44, Math.PI, 9, 6, 3.5);
  addRamp(-50, -28, 0, 8, 5, 3);

  // --- Low barriers / half-cover ---
  const barrierSpots = [
    [-2, -28, 8, 1.2], [20, 4, 1.2, 8], [-34, 4, 6, 1.2], [8, 28, 10, 1.2],
    [-15, 36, 1.2, 8], [28, -28, 8, 1.2], [-44, -8, 6, 1.2], [12, 40, 10, 1.2],
    [-20, -10, 1.2, 6], [35, 18, 8, 1.2], [-6, 30, 5, 1.2], [18, -36, 1.2, 8],
    [40, 40, 8, 1.2], [-40, -40, 1.2, 8], [0, 48, 10, 1.2], [46, -18, 1.2, 8],
    [-48, 18, 8, 1.2], [24, -44, 6, 1.2], [-24, 44, 1.2, 6], [8, 16, 6, 1.2],
  ];
  for (const [x, z, w, d] of barrierSpots) {
    addBox(w, 1.3, d, x, 0.65, z, barrierMat);
  }

  // --- More cover pieces (small L-shapes and boxes) ---
  const coverSpots = [
    [6, -24, 2, 2.4], [-28, 10, 2.4, 2], [18, 18, 1.8, 1.8], [-38, 30, 2.2, 2.2],
    [32, -4, 1.6, 1.6], [-14, -34, 2, 2], [44, 22, 2.4, 1.6], [0, -18, 2.2, 2.2],
    [-8, 12, 2, 2], [12, 8, 1.8, 1.8], [-20, 28, 2.2, 2.2], [30, -12, 2, 2],
    [-42, -14, 1.8, 1.8], [40, 30, 2.2, 2.2], [-30, 40, 2, 2], [20, 48, 1.8, 1.8],
  ];
  for (const [x, z, w, d] of coverSpots) {
    addBox(w, 2.2, d, x, 1.1, z, coverMat);
  }

  return { group, paintTargets, blockers, groundMeshes, ceilings, materials, floor };
}

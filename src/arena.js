import * as THREE from 'three';

/**
 * Builds a clean white arena. `mapId` selects the layout (1 = original test
 * arena, 2 = larger point-symmetric arena). Returns references used by the rest
 * of the game:
 *  - group / paintTargets / blockers / tankBlockers / groundMeshes / ceilings
 *  - materials: shared standard materials (contrast slider tweaks them)
 *  - floor, size (half-extent), mapId
 *
 * Map 2 is built with 180-degree ROTATIONAL symmetry (every piece is mirrored
 * to (-x,-z)), so BLUE's half and RED's half are identical — perfectly fair.
 */
export function buildArena(scene, mapId = 1) {
  const group = new THREE.Group();
  scene.add(group);

  const paintTargets = [];
  const blockers = [];       // full set — players collide with all of these
  const tankBlockers = [];   // solid objects only (no ramp fillers) so tanks can mount ramps
  const groundMeshes = [];
  const ceilings = [];
  const materials = [];

  function whiteMat(hex, rough = 0.85) {
    const m = new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: 0.0 });
    m.userData.baseColor = new THREE.Color(hex);
    materials.push(m);
    return m;
  }
  const floorMat  = whiteMat(0xffffff, 0.95);
  const wallMat   = whiteMat(0xffffff, 0.9);
  const crateMat  = whiteMat(0xffffff, 0.8);
  const pillarMat = whiteMat(0xfdfdfe, 0.85);
  const rampMat   = whiteMat(0xffffff, 0.88);
  const barrierMat= whiteMat(0xfcfcfd, 0.8);
  const coverMat  = whiteMat(0xfdfdfd, 0.82);

  const SIZE = mapId === 2 ? 78 : 60;   // half-extent of the playable area
  const WALL_H = 8;
  const WALL_T = 1;

  // --- Floor + faint grid seams ---
  const floor = new THREE.Mesh(new THREE.BoxGeometry(SIZE * 2, 1, SIZE * 2), floorMat);
  floor.position.y = -0.5;
  floor.receiveShadow = true;
  floor.name = 'floor';
  group.add(floor);
  paintTargets.push(floor);
  groundMeshes.push(floor);

  const grid = new THREE.GridHelper(SIZE * 2, SIZE, 0xe4e7ea, 0xeef0f2);
  grid.material.opacity = 0.15;
  grid.material.transparent = true;
  grid.material.depthWrite = false;
  grid.position.y = 0.011;
  group.add(grid);

  // --- shared builders ---
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
      tankBlockers.push(box);
    }
    return mesh;
  }
  function addPillar(x, z, r = 1.1, h = 7, baseY = 0) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24), pillarMat);
    mesh.position.set(x, baseY + h / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    paintTargets.push(mesh);
    const box = new THREE.Box3().setFromObject(mesh);
    blockers.push(box);
    tankBlockers.push(box);
    return mesh;
  }
  // collision-only box (no mesh) — fills the wedge under a ramp
  function addBlockerBox(w, h, d, x, y, z) {
    blockers.push(new THREE.Box3(
      new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2),
      new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2)));
  }
  function addRamp(x, z, rotY, len = 8, wide = 5, rise = 3) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(wide, 0.4, len), rampMat);
    const angle = Math.atan2(rise, len);
    mesh.position.set(x, rise / 2, z);
    mesh.rotation.y = rotY;
    mesh.rotateX(-angle);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    paintTargets.push(mesh);
    groundMeshes.push(mesh);
    // step-fill the wedge under it so players can't walk through (NOT a tank blocker)
    mesh.updateMatrixWorld(true);
    const rc = new THREE.Raycaster();
    const N = 8, half = len / 2, seg = len / N;
    for (let i = 0; i < N; i++) {
      const lz = -half + (i + 0.5) * seg;
      const wx = x + Math.sin(rotY) * lz;
      const wz = z + Math.cos(rotY) * lz;
      rc.set(new THREE.Vector3(wx, 50, wz), new THREE.Vector3(0, -1, 0));
      const hit = rc.intersectObject(mesh, false)[0];
      const h = (hit ? hit.point.y : 0) - 0.35;
      if (h > 0.15) addBlockerBox(wide * 0.98, h, seg + 0.05, wx, h / 2, wz);
    }
    return mesh;
  }

  // --- Perimeter walls (from SIZE) ---
  addBox(SIZE * 2, WALL_H, WALL_T, 0, WALL_H / 2, -SIZE, wallMat, { stand: false });
  addBox(SIZE * 2, WALL_H, WALL_T, 0, WALL_H / 2,  SIZE, wallMat, { stand: false });
  addBox(WALL_T, WALL_H, SIZE * 2, -SIZE, WALL_H / 2, 0, wallMat, { stand: false });
  addBox(WALL_T, WALL_H, SIZE * 2,  SIZE, WALL_H / 2, 0, wallMat, { stand: false });

  if (mapId === 2) buildMap2(); else buildMap1();

  return { group, paintTargets, blockers, tankBlockers, groundMeshes, ceilings, materials, floor, size: SIZE, mapId };

  // =========================================================================
  // MAP 1 — the original test arena (unchanged)
  // =========================================================================
  function buildMap1() {
    // The original Backlot layout, preserved exactly, with every asymmetric
    // piece also placed at its 180-degree mirror (-x,-z) so both teams get
    // identical cover. (The pillar ring was already symmetric — placed as-is.)
    const mBox = (w, h, d, x, y, z, mat) => { addBox(w, h, d, x, y, z, mat); addBox(w, h, d, -x, y, -z, mat); };
    const mRamp = (x, z, rotY, len, wide, rise) => { addRamp(x, z, rotY, len, wide, rise); addRamp(-x, -z, rotY + Math.PI, len, wide, rise); };

    const RAMPS = [
      [-38, -10, 0, 8, 5, 3],
      [38, 8, Math.PI, 9, 6, 3.5],
      [6, 44, Math.PI, 9, 6, 3.5],
      [-50, -28, 0, 8, 5, 3],
    ];
    // keep-out rects around every ramp AND its mirror (the ramp set is symmetric,
    // so a spot clear of all of them is clear for both a piece and its mirror)
    const _rects = [];
    for (const [x, z, rotY, len, wide] of RAMPS) {
      for (const [mx, mz, mr] of [[x, z, rotY], [-x, -z, rotY + Math.PI]]) {
        const hx = Math.abs(Math.cos(mr)) * wide / 2 + Math.abs(Math.sin(mr)) * len / 2;
        const hz = Math.abs(Math.sin(mr)) * wide / 2 + Math.abs(Math.cos(mr)) * len / 2;
        const pad = 3.5;
        _rects.push({ x0: mx - hx - pad, x1: mx + hx + pad, z0: mz - hz - pad, z1: mz + hz + pad });
      }
    }
    const nearRamp = (x, z) => _rects.some((r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);

    // interior dividing walls (original + mirror)
    mBox(18, 5, 1, -18, 2.5, -8, wallMat);
    mBox(1, 5, 16, 10, 2.5, 14, wallMat);
    mBox(14, 4, 1, 22, 2, -20, wallMat);
    mBox(12, 4, 1, -30, 2, 16, wallMat);
    mBox(1, 4, 14, 34, 2, 30, wallMat);
    mBox(10, 3.5, 1, 4, 1.75, 6, wallMat);
    mBox(1, 3.5, 10, -6, 1.75, -2, wallMat);
    mBox(16, 4, 1, -40, 2, -34, wallMat);

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
      if (nearRamp(x, z)) continue;
      mBox(s, s, s, x, s / 2, z, crateMat);
    }

    // the pillar ring is already 180-degree symmetric — place as-is (no mirror)
    const pillarSpots = [
      [-30, -30], [30, 30], [-30, 30], [30, -30], [0, 0],
      [-15, 22], [15, -22], [-45, -45], [45, 45], [22, 40], [-22, -40],
    ];
    for (const [x, z] of pillarSpots) {
      if (nearRamp(x, z)) continue;
      addPillar(x, z);
    }

    for (const [x, z, rotY, len, wide, rise] of RAMPS) mRamp(x, z, rotY, len, wide, rise);

    const barrierSpots = [
      [-2, -28, 8, 1.2], [20, 4, 1.2, 8], [-34, 4, 6, 1.2], [8, 28, 10, 1.2],
      [-15, 36, 1.2, 8], [28, -28, 8, 1.2], [-44, -8, 6, 1.2], [12, 40, 10, 1.2],
      [-20, -13, 1.2, 6], [35, 18, 8, 1.2], [-6, 30, 5, 1.2], [18, -36, 1.2, 8],
      [40, 40, 8, 1.2], [-40, -40, 1.2, 8], [0, 48, 10, 1.2], [46, -18, 1.2, 8],
      [-48, 18, 8, 1.2], [24, -44, 6, 1.2], [-24, 44, 1.2, 6], [4, 16, 6, 1.2],
    ];
    for (const [x, z, w, d] of barrierSpots) {
      if (nearRamp(x, z)) continue;
      mBox(w, 1.3, d, x, 0.65, z, barrierMat);
    }

    const coverSpots = [
      [6, -24, 2, 2.4], [-28, 10, 2.4, 2], [18, 18, 1.8, 1.8], [-38, 30, 2.2, 2.2],
      [32, -4, 1.6, 1.6], [-14, -34, 2, 2], [44, 22, 2.4, 1.6], [0, -18, 2.2, 2.2],
      [-8, 12, 2, 2], [12, 8, 1.8, 1.8], [-20, 28, 2.2, 2.2], [30, -12, 2, 2],
      [-42, -14, 1.8, 1.8], [40, 30, 2.2, 2.2], [-30, 40, 2, 2], [20, 48, 1.8, 1.8],
    ];
    for (const [x, z, w, d] of coverSpots) {
      if (nearRamp(x, z)) continue;
      mBox(w, 2.2, d, x, 1.1, z, coverMat);
    }
  }

  // =========================================================================
  // MAP 2 — larger, 180-degree rotationally symmetric (fair for both teams)
  // =========================================================================
  function buildMap2() {
    // helpers that place a piece AND its 180-degree rotation (-x,-z)
    const pBox = (w, h, d, x, y, z, mat) => { addBox(w, h, d, x, y, z, mat); addBox(w, h, d, -x, y, -z, mat); };
    const pPillar = (x, z, r, h) => { addPillar(x, z, r, h); addPillar(-x, -z, r, h); };
    const pRamp = (x, z, rotY, len, wide, rise) => { addRamp(x, z, rotY, len, wide, rise); addRamp(-x, -z, rotY + Math.PI, len, wide, rise); };
    // roofless U-shaped bunker (back + two sides) with a crate inside to peek over,
    // opening toward the centre; placed together with its 180-degree mirror.
    const pBunker = (cx, cz, W = 9, D = 7, H = 4) => {
      pBox(W, H, 1, cx, H / 2, cz + D / 2, wallMat);       // back wall (far side)
      pBox(1, H, D, cx - W / 2, H / 2, cz, wallMat);        // left wall
      pBox(1, H, D, cx + W / 2, H / 2, cz, wallMat);        // right wall
      pBox(3, 1.3, 3, cx, 0.65, cz - 0.5, coverMat);        // inner crate to peek over
    };

    // --- CENTRE: a raised control platform reached by 4 ramps ---
    addBox(24, 3, 24, 0, 1.5, 0, wallMat);                 // platform (top at y=3)
    pRamp(0, 17.5, Math.PI, 11, 8, 3);                     // +Z & -Z ramps up to it
    pRamp(17.5, 0, -Math.PI / 2, 11, 8, 3);                // +X & -X ramps up to it
    pBox(2.6, 2.2, 2.6, 7, 4.1, 7, coverMat);              // cover on the platform corners
    pBox(2.6, 2.2, 2.6, 7, 4.1, -7, coverMat);

    // --- BUNKERS: fill the open ground with real cover you can duck into ---
    pBunker(0, 34);        // centre-lane bunkers facing off across the middle
    pBunker(48, 20);       // right-flank bunkers
    pBunker(24, 52);       // approach-to-base bunkers
    pBunker(62, 50);       // far-corner bunkers

    // --- SIGHTLINE-BREAKING WALLS between the centre and each base ---
    pBox(1, 5, 16, 32, 2.5, 12, wallMat);
    pBox(14, 5, 1, 14, 2.5, 42, wallMat);
    pBox(1, 4.5, 12, 62, 2.25, 26, wallMat);
    pBox(12, 4.5, 1, 44, 2.25, 8, wallMat);

    // --- PILLARS (mid-field cover + landmarks) ---
    pPillar(40, 8, 1.2, 7);
    pPillar(20, 26, 1.2, 7);
    pPillar(56, 34, 1.2, 7);
    pPillar(38, 64, 1.2, 7);
    pPillar(12, 62, 1.2, 7);
    pPillar(68, 12, 1.2, 7);

    // --- CRATE CLUSTERS (climbable), placed as mirrored pairs ---
    const cluster = (cx, cz) => {
      pBox(2.2, 2.2, 2.2, cx, 1.1, cz, crateMat);
      pBox(2.2, 2.2, 2.2, cx + 2.3, 1.1, cz + 1.5, crateMat);
      pBox(2.4, 2.4, 2.4, cx + 1.1, 3.4, cz + 0.7, crateMat); // stacked on top
    };
    cluster(52, 10);
    cluster(30, 42);
    cluster(66, 62);
    cluster(8, 22);

    // --- LOW BARRIERS (half-cover across the open lanes) ---
    pBox(12, 1.4, 1.3, 22, 0.7, 20, barrierMat);
    pBox(1.3, 1.4, 12, 44, 0.7, 40, barrierMat);
    pBox(10, 1.4, 1.3, 10, 0.7, 52, barrierMat);
    pBox(1.3, 1.4, 10, 66, 0.7, 16, barrierMat);
    pBox(12, 1.4, 1.3, 50, 0.7, 64, barrierMat);
    pBox(10, 1.4, 1.3, 34, 0.7, 30, barrierMat);
    pBox(1.3, 1.4, 10, 18, 0.7, 48, barrierMat);

    // --- BASE COVER (protects the spawn line near each back wall, z ~ +-70) ---
    pBox(9, 3, 1.6, 26, 1.5, 62, coverMat);
    pBox(9, 3, 1.6, -26, 1.5, 62, coverMat);
    pBox(1.6, 3, 9, 58, 1.5, 58, coverMat);
    pBox(1.6, 3, 9, -58, 1.5, 58, coverMat);
    pBox(7, 3, 1.6, 4, 1.5, 66, coverMat);
  }
}

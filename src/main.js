import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import GUI from 'lil-gui';

import { buildArena } from './arena.js';
import { PaintSystem } from './paint.js';
import { createOutline, NO_OUTLINE_LAYER } from './outline.js';
import { PlayerController } from './player.js';
import { InputManager } from './input.js';
import { BotSystem, BLUE_NAMES, RED_NAMES } from './bots.js';
import { Settings } from './settings.js';
import { SplatDesigner } from './splatDesigner.js';
import { Weapon } from './weapon.js';
import { AudioManager } from './audio.js';
import { NetClient, signalUrl } from './net.js';
import { NetPlay } from './netplay.js';
import { GLOW, setGlow } from './playerGlow.js';
import { teamSpawnXZ, SPAWNS_PER_TEAM, SPAWN_EYE_Y, setArenaSize, tankSpawn } from './spawns.js';
import { Tank } from './tank.js';
import { Jet } from './jet.js';
import { TankFX } from './tankFX.js';
import { TankBuster } from './tankBuster.js';
import { createNightSky } from './nightSky.js';
import { createDaySky } from './sky.js';
import { unlockAchievement } from './steamClient.js';

// ---------------------------------------------------------------------------
// Paint colors (future: teams)
// ---------------------------------------------------------------------------
const COLORS = [
  { name: 'RED',    hex: 0xff3b3b },
  { name: 'BLUE',   hex: 0x2f7bff },
  { name: 'YELLOW', hex: 0xffd21f },
  { name: 'GREEN',  hex: 0x27c93f },
  { name: 'PURPLE', hex: 0x9b3bff },
  { name: 'ORANGE', hex: 0xff7a1a },
];
let colorIndex = 0;

// Dev-only: the lil-gui tuning panel exists only during local development
// (localhost) or with ?dev in the URL. The itch build is served from itch's
// domain, so players never get it — but all the panel code below stays intact.
const DEV = (['localhost', '127.0.0.1'].includes(location.hostname)
  || new URLSearchParams(location.search).has('dev'))
  && !new URLSearchParams(location.search).has('prod'); // ?prod forces the itch (DEV=false) path for testing
let colorCtrl = null; // dev-panel color dropdown (null when the panel is off)

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const app = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);
scene.fog = new THREE.Fog(0xffffff, 80, 170);

const camera = new THREE.PerspectiveCamera(
  75, window.innerWidth / window.innerHeight, 0.1, 300);
camera.position.set(0, 1.7, 26);

// ---------------------------------------------------------------------------
// Lights
// ---------------------------------------------------------------------------
const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.6);
scene.add(hemi);

const ambient = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambient);

// kept fairly low so shadowed faces stay near-white; the outline defines shape
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(30, 48, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 160;
sun.shadow.camera.left = -75;
sun.shadow.camera.right = 75;
sun.shadow.camera.top = 75;
sun.shadow.camera.bottom = -75;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(sun.target);

// ---------------------------------------------------------------------------
// Arena + systems
// ---------------------------------------------------------------------------
// Map selection (1 = original, 2 = larger symmetric). Persisted; the menu picker
// swaps it live (see setMap). ?map= still works as a quick override.
const MAPS = [
  { id: 1, name: 'Backlot' },
  { id: 2, name: 'Coliseum' },
];
const _urlMap = parseInt(new URLSearchParams(location.search).get('map'), 10);
let _savedMap = 1;
try { _savedMap = parseInt(localStorage.getItem('wo.map'), 10) || 1; } catch {}
let arena = buildArena(scene, Math.max(1, Math.min(MAPS.length, _urlMap || _savedMap)));
setArenaSize(arena.size); // spawns/tanks scale to this map's half-extent
const paint = new PaintSystem(scene);

// One drivable tank per team, parked at each team's base. Press T (near your
// team's tank) to drive it. ~40 armor; destroyed -> driver ejected, respawns.
const tanks = [new Tank(scene, arena, 0), new Tank(scene, arena, 1)];
const TANK_RESPAWN_MS = 45000;
const tankFX = new TankFX(scene);
let tankAlarmLoop = null; // looping alarm handle while the driven tank is critical
const fxTune = { paintCount: 60, playerPaintCount: 22 }; // dev-tunable paint-shell counts (tank / player)

// A wide, loud palette for the death paint burst — the 6 selectable paints plus
// a bunch of extra vivid hues so the explosion throws every colour around.
const EXPLOSION_COLORS = [
  0xff3b3b, 0x2f7bff, 0xffd21f, 0x27c93f, 0x9b3bff, 0xff7a1a,
  0xff2fa8, 0x00d9d0, 0x7fff2a, 0xff5edc, 0x2affc3, 0xffe14d,
  0x8a5cff, 0xff9d3b, 0x3bffd6, 0xe83bff, 0x3bd1ff, 0xa0ff3b,
  0xff4d6d, 0x18e0ff, 0xc6ff2a, 0xff6a00, 0x00ffa2, 0xd400ff,
];

// Violent tank death: blast the hull apart, throw a black smoke/fireball, and
// burst many paint colours outward so they splatter the surrounding walls and
// objects. The paint uses visual-only (netGhost) shells so it harms no one.
function explodeTank(tank) {
  const pos = tank.pos;
  // global (not spatial) so the signature boom is never culled by the voice cap
  audio.play('tankExplode', { volume: 0.95 });
  tankFX.explode(pos, tank.hex);
  const origin = new THREE.Vector3(pos.x, 1.4, pos.z);
  const dir = new THREE.Vector3();
  for (let i = 0; i < fxTune.paintCount; i++) {
    const col = EXPLOSION_COLORS[(Math.random() * EXPLOSION_COLORS.length) | 0];
    const a = Math.random() * Math.PI * 2;
    const el = 0.05 + Math.random() * 0.95;          // mostly outward, some up
    dir.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)).normalize();
    const speed = 14 + Math.random() * 18;
    spawnProjectile(origin.clone().addScaledVector(dir, 1.0), dir.clone(), col,
      tank.teamId, speed, false, { netGhost: true }, { splatScale: 1.4 });
  }
}

// A player/bot popping into paint on death — same idea as the tank blast but
// smaller: a compact colour burst that splatters what's nearby. Deliberately
// does NOT use the tank explosion sound; a soft wet splat instead.
const _explodeAt = new THREE.Vector3();
function explodePlayer(pos) {
  const x = pos.x, y = 1.2, z = pos.z; // burst from mid-body height
  audio.playAt('splat', _explodeAt.set(x, y, z), { volume: 0.55, rate: 0.85 });
  const origin = new THREE.Vector3(x, y, z);
  const dir = new THREE.Vector3();
  for (let i = 0; i < fxTune.playerPaintCount; i++) {
    const col = EXPLOSION_COLORS[(Math.random() * EXPLOSION_COLORS.length) | 0];
    const a = Math.random() * Math.PI * 2;
    const el = 0.1 + Math.random() * 0.9;
    dir.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)).normalize();
    const speed = 8 + Math.random() * 10;
    spawnProjectile(origin.clone().addScaledVector(dir, 0.4), dir.clone(), col,
      0, speed, false, { netGhost: true }, { splatScale: 0.5 }); // smaller splats
  }
}

// A moving tank crushes enemy combatants caught under its hull — same paint
// death as a shot. Bots are killed where they actually live (host / free play);
// the local on-foot player checks itself against enemy tanks in every mode.
function tankRunOver() {
  const halfX = 1.6, halfZ = 2.4; // hull footprint, a touch past the tracks
  for (const tank of tanks) {
    if (!tank.alive || Math.abs(tank.speed) < 1.5) continue; // must be rolling
    const c = Math.cos(tank.heading), s = Math.sin(tank.heading);
    if (!netplay.active || netplay.isHost) {
      for (let i = 0; i < bots.bots.length; i++) {
        const b = bots.bots[i];
        if (!b.alive || b.team.id === tank.teamId) continue; // never crush teammates
        const dx = b.pos.x - tank.pos.x, dz = b.pos.z - tank.pos.z;
        const lx = dx * c - dz * s, lz = dx * s + dz * c; // world → tank-local
        if (Math.abs(lx) < halfX && Math.abs(lz) < halfZ) {
          if (tank === currentTank) { playerStats.kills++; showKill(b.name); unlockAchievement('ROADKILL'); pushKill(getPlayerName(), myTeamId(), b.name, b.team.id); } // your roadkill counts
          bots.tagBotByIndex(i, tank.teamId);
        }
      }
    }
    // only an ENEMY tank you're not driving can crush the on-foot player
    // (never while flying the jet — you're in the air, not under the tracks)
    if (active && !playerDead && !tankMode && !jetMode && tank !== currentTank && tank.teamId !== myTeamId()) {
      const dx = camera.position.x - tank.pos.x, dz = camera.position.z - tank.pos.z;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) < halfX && Math.abs(lz) < halfZ) {
        pushKill((tank.teamId === 0 ? 'BLUE' : 'RED') + ' TANK', tank.teamId, getPlayerName(), myTeamId());
        onPlayerTagged(tank.teamId, tank.hex, 'TANK');
      }
    }
  }
}
function spawnTanks() {
  // parked in each team's back corner, clear of the player spawn lanes (scales with the map)
  const b = tankSpawn(0), r = tankSpawn(1);
  tanks[0].spawn(b.x, b.z, b.heading); // BLUE near +Z wall, facing into the arena
  tanks[1].spawn(r.x, r.z, r.heading); // RED near -Z wall, facing into the arena
}
spawnTanks();
// tunables live on tanks[0] (dev panel); mirrored onto tanks[1] each frame
const TANK_TUNE_KEYS = ['driveSpeed', 'reverseSpeed', 'turnSpeed', 'turretTraverse',
  'barrelTraverse', 'barrelMin', 'barrelMax', 'projSpeed', 'projGravity', 'projRadius',
  'splatScale', 'fireInterval', 'turretVolume', 'recoilAmount', 'zoomFov', 'maxHp',
  'boostMult', 'boostDuration', 'boostCooldown', 'dmgSmokeMul',
  'gravity', 'maxLaunch', 'launchBoost',
  'cam3rdDist', 'cam3rdHeight', 'camZoomDist', 'camZoomHeight', 'camZoomSide'];
let currentTank = null; // the tank the local player is driving (null = on foot)
let tankMode = false;
let tankZoomT = 0;
// --- Jet (free-play air support): player-flown fighter, 3rd-person ---
const jet = new Jet(scene, 0); // player's BLUE team (PLAYER_TEAM is defined later)
jet.arenaBlockers = arena.blockers; // for chase-cam wall pull-in
let jetMode = false;
let JET_BOUND = arena.size + 32; // half-extent of the "in bounds" box (past the walls); beyond → warning
const JET_CEILING = 120;   // max altitude before the same warning
const JET_RETURN_SECS = 8; // seconds to get back before the jet self-destructs
let jetWarnT = 0;          // counts UP while out of bounds; explodes at JET_RETURN_SECS
const jetHudEl = document.getElementById('jet-hud');
const jetSpeedEl = document.getElementById('jet-speed');
const jetAltEl = document.getElementById('jet-alt');
const jetThrEl = document.getElementById('jet-throttle-fill');
const jetWarnEl = document.getElementById('jet-warn');
const jetWarnCountEl = document.getElementById('jet-warn-count');
function updateJetHud() {
  if (!jetHudEl) return;
  jetSpeedEl.textContent = Math.round(jet.speed);
  jetAltEl.textContent = Math.round(jet.pos.y);
  // throttle bar: minSpeed→maxSpeed mapped 0..100%
  const frac = THREE.MathUtils.clamp((jet.speed - jet.minSpeed) / (jet.maxSpeed - jet.minSpeed), 0, 1);
  jetThrEl.style.width = Math.round(frac * 100) + '%';
  const out = jetWarnT > 0;
  jetWarnEl.classList.toggle('hidden', !out);
  if (out) jetWarnCountEl.textContent = Math.max(0, Math.ceil(JET_RETURN_SECS - jetWarnT));
}
const _jetLook = new THREE.Vector3();
const _tankAim = new THREE.Vector3();
const _tankSelfPos = new THREE.Vector3();
const _aiAim = new THREE.Vector3();
const _tankHit = new THREE.Vector3();
const _segEnd = new THREE.Vector3();
const tankSightEl = document.getElementById('tank-sight');
const hitmarkerEl = document.getElementById('hitmarker');
// Flash the crosshair hitmarker on EVERY enemy hit — on foot or in the tank.
// `big` = a larger pop, used when the shot tags a player/bot (vs a tank).
function showTankHitmarker(big = false) {
  hitmarkerEl.classList.remove('hit', 'big');
  void hitmarkerEl.offsetWidth; // force reflow so the animation restarts each hit
  hitmarkerEl.classList.toggle('big', big);
  hitmarkerEl.classList.add('hit');
}
const tsZoomEl = document.getElementById('ts-zoom');
const tsExitKeyEl = document.getElementById('ts-exit-key');
const tsRngEl = document.getElementById('ts-rng');
const tsCompassEl = document.getElementById('ts-compass');
const tsHeadingEl = document.getElementById('ts-heading');
const tsSpeedEl = document.getElementById('ts-speed');
const tsGunStatusEl = document.getElementById('ts-gun-status');
const tsArmorEl = document.getElementById('ts-armor');
const tsArmorFillEl = document.getElementById('ts-armor-fill');
const tsArmorWrapEl = () => tsArmorFillEl.parentElement.parentElement;
const tsBoostEl = document.getElementById('ts-boost');
const tsBoostFillEl = document.getElementById('ts-boost-fill');
const TS_CARDINALS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
let tsTicks = null;
function buildTankCompass() {
  tsTicks = [];
  for (let i = 0; i < 13; i++) {
    const d = document.createElement('div'); d.className = 'tk';
    const bar = document.createElement('i'); const lbl = document.createElement('span');
    d.append(bar, lbl); tsCompassEl.appendChild(d);
    tsTicks.push({ el: d, lbl });
  }
}
function updateTankHud() {
  const tank = currentTank;
  if (!tank) return;
  if (!tsTicks) buildTankCompass();
  const headingDeg = (Math.atan2(_tankAim.x, _tankAim.z) * 180 / Math.PI + 360) % 360;
  tsHeadingEl.textContent = String(Math.round(headingDeg)).padStart(3, '0');
  const cx = 260, pxPerDeg = 5.6, base = Math.round(headingDeg / 15) * 15;
  for (let i = 0; i < 13; i++) {
    const th = base + (i - 6) * 15;
    const diff = ((th - headingDeg + 540) % 360) - 180;
    const x = cx + diff * pxPerDeg;
    const t = tsTicks[i];
    if (x < -20 || x > 540) { t.el.style.display = 'none'; continue; }
    const h = ((th % 360) + 360) % 360, card = TS_CARDINALS[h];
    t.el.style.display = 'block';
    t.el.style.left = x + 'px';
    t.el.className = card ? 'tk card' : 'tk';
    t.lbl.textContent = card || String(h);
  }
  tsSpeedEl.textContent = String(Math.round(Math.abs(tank.speed) * 3.6));
  raycaster.set(camera.position, _tankAim); raycaster.far = 500;
  const hit = raycaster.intersectObjects(arena.paintTargets, false)[0];
  tsRngEl.textContent = hit ? String(Math.round(hit.distance)) : '---';
  const ready = tank.canFire(performance.now());
  tsGunStatusEl.textContent = ready ? 'READY' : 'RELOADING';
  tsGunStatusEl.classList.toggle('reloading', !ready);
  const pct = Math.max(0, Math.round((tank.hp / tank.maxHp) * 100));
  tsArmorEl.textContent = pct;
  tsArmorFillEl.style.width = pct + '%';
  tsArmorWrapEl().classList.toggle('low', pct <= 30);
  tsBoostFillEl.style.width = Math.round(tank.boostFrac * 100) + '%';
  tsBoostEl.classList.toggle('charging', !tank.boostReady);
  tsExitKeyEl.textContent = input.gamepadConnected ? 'Y' : 'E';
}
let devPanelOpen = false; // dev panel visible → Esc frees the cursor to tune, no menu
const outline = createOutline(renderer, scene, camera);

// ---- "Lights Out" night mode -------------------------------------------------
const nightSky = createNightSky(scene);
const daySky = createDaySky(scene, sun.position); // blue sky + sun + clouds (day only)
let nightMode = false;
function setArenaEmissive(hex, intensity) {
  for (const m of arena.materials) { m.emissive.setHex(hex); m.emissiveIntensity = intensity; m.needsUpdate = true; }
}
// Flip the whole scene between the bright white day and a glowing night: dark
// sky + moon/stars, dim cool light, a WHITE contour so everything is rimmed in a
// faint glow, faintly self-lit surfaces, and neon paint.
function setNightMode(on) {
  nightMode = on;
  if (on) {
    scene.background.set(0x05060e);
    scene.fog.color.set(0x05060e); scene.fog.near = 55; scene.fog.far = 230;
    hemi.intensity = 0.30; hemi.color.set(0x4a5a8a); hemi.groundColor.set(0x0a0c16);
    ambient.intensity = 0.34; ambient.color.set(0x8ea2d6);
    sun.intensity = 0.55; sun.color.set(0xaebfff);
    outline.uniforms.outlineColor.value.set(0xffffff);
    outline.uniforms.strength.value = 1.0;
    setArenaEmissive(0x0e1524, 1.0);
    daySky.group.visible = false;
    nightSky.group.visible = true;
    paint.setNeon(true);
    weapon.setNeon(true);
    document.body.classList.add('lights-out');
  } else {
    scene.background.set(0xffffff);
    scene.fog.color.set(0xffffff); scene.fog.near = 80; scene.fog.far = 170;
    hemi.intensity = 0.6; hemi.color.set(0xffffff); hemi.groundColor.set(0xffffff);
    ambient.intensity = 0.7; ambient.color.set(0xffffff);
    sun.intensity = 1.6; sun.color.set(0xffffff);
    outline.uniforms.outlineColor.value.set(guiState.outlineGray);
    outline.uniforms.strength.value = guiState.outlineStrength;
    setArenaEmissive(0x000000, 0);
    daySky.group.visible = true;
    nightSky.group.visible = false;
    nightSky.resetEgg(); // calm the moon when leaving Lights Out
    paint.setNeon(false);
    weapon.setNeon(false);
    document.body.classList.remove('lights-out');
  }
}

// Sound: gun on player fire, splat on paintball impact, jump on liftoff.
// Decoded up front; the context is resumed from the first user gesture.
const audio = new AudioManager();
audio.load({
  single: './assets/SingleShotPaintballSound.wav', // one tap = one shot
  gun:    './assets/PaintballGunSound.wav',         // sustained loop while held
  splat:  './assets/PaintballSplatterSound.wav',
  jump:   './assets/PlayerJumpSound.wav',
  slide:  './assets/PlayerSlideSound.wav',          // seamless loop, any duration
  bodyHit: './assets/WetPaintballSplatHittingPlayer.wav', // wet splat on a player
  killConfirm: './assets/KillConfirm.wav',          // satisfying chime on your kills
  countdownBeep: './assets/CountdownBeep.wav',      // tick per second in a countdown
  countdownGo: './assets/CountdownGo.wav',          // final "GO" / respawn tone
  tankFire: './assets/TankFiring.wav',              // tank cannon shot
  tankEngine: './assets/TankEngine.wav',            // diesel loop (throttles with speed)
  tankTracks: './assets/TankTracks.wav',            // track clatter loop
  tankTurret: './assets/TankTurret.wav',            // turret traverse servo loop
  tankReload: './assets/TankReload.wav',            // shell reload after each shot
  tankAlarm: './assets/TankAlarm.wav',              // seamless alarm loop when armor is critical
  tankExplode: './assets/TankExploding.wav',        // violent blast when the tank is destroyed
  tankRoundImpact: './assets/TankRoundImpact.wav',  // a tank shell slamming into another tank
});
// tuned defaults: faint gray contour that reads well on pure white
outline.uniforms.strength.value = 0.75;
outline.uniforms.thickness.value = 1.4;

// ---------------------------------------------------------------------------
// Controls / input (mouse+keyboard via pointer lock, plus Xbox gamepad)
// ---------------------------------------------------------------------------
const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.getObject());

const input = new InputManager(renderer.domElement);
const player = new PlayerController(camera);

// First-person marker, parented to the camera. Its hopper runs a ball sim.
const weapon = new Weapon(COLORS[1].hex);
camera.add(weapon.root);
const tankBuster = new TankBuster(COLORS[1].hex);
camera.add(tankBuster.root);
let currentWeapon = 0; // 0 = paint marker, 1 = tank buster

// ---- Digital scope: a live world feed rendered onto the buster's optic ----
// Viewmodels live on their own layer so the scope camera can render the world
// WITHOUT the launcher poking into its own screen (no feedback loop).
const VIEWMODEL_LAYER = 2;
const _setLayerDeep = (obj, layer) => obj.traverse((o) => o.layers.set(layer));
_setLayerDeep(weapon.root, VIEWMODEL_LAYER);
_setLayerDeep(tankBuster.root, VIEWMODEL_LAYER);
camera.layers.enable(VIEWMODEL_LAYER); // the main camera still shows the viewmodels

// the scope RT matches the screen aspect so the full-screen ADS view isn't
// stretched; it renders at ~0.6× resolution to stay cheap
const _scopeDim = () => [Math.max(320, Math.round(window.innerWidth * 0.6)),
                         Math.max(200, Math.round(window.innerHeight * 0.6))];
const [_sw, _sh] = _scopeDim();
const scopeRT = new THREE.WebGLRenderTarget(_sw, _sh, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
const scopeCam = new THREE.PerspectiveCamera(42, _sw / _sh, 0.1, 300);
scopeCam.layers.set(0);                     // world only,
scopeCam.layers.enable(NO_OUTLINE_LAYER);   // + smoke/decals — but NOT the viewmodels
tankBuster.screenMat.map = scopeRT.texture; // the live feed drives the gun's mini screen
tankBuster.screenMat.color.setHex(0xffffff);
tankBuster.screenMat.needsUpdate = true;

// full-screen quad that shows the scope feed over the whole view while zoomed —
// so aiming down the buster IS looking through its live screen (clean: no
// viewmodel, no contour outline)
const scopeOverlay = new THREE.Scene();
const scopeOverlayCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const scopeQuadMat = new THREE.MeshBasicMaterial({
  map: scopeRT.texture, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false,
});
scopeOverlay.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), scopeQuadMat));

const _scopeP = new THREE.Vector3(), _scopeQ = new THREE.Quaternion();
function renderScope() {
  camera.getWorldPosition(_scopeP);
  camera.getWorldQuaternion(_scopeQ);
  scopeCam.position.copy(_scopeP);
  scopeCam.quaternion.copy(_scopeQ);
  scopeCam.fov = camera.fov;       // match the main (zoomed) FOV so ADS lines up
  scopeCam.aspect = camera.aspect;
  scopeCam.updateProjectionMatrix();
  scopeCam.updateMatrixWorld();
  renderer.setRenderTarget(scopeRT);
  renderer.render(scene, scopeCam); // autoClear paints scene.background + world
  renderer.setRenderTarget(null);
}
// draw the full-screen scope feed over the main render, faded by the zoom amount
function drawScopeOverlay() {
  const show = currentWeapon === 1 && tankBuster.root.visible;
  const z = show ? tankBuster.aimT : 0;
  if (busterScopeEl) busterScopeEl.style.opacity = String(z); // DOM scope HUD fade (every frame)
  if (!(show && z > 0.01)) return;
  scopeQuadMat.opacity = z;
  renderer.autoClear = false;
  renderer.render(scopeOverlay, scopeOverlayCam);
  renderer.autoClear = true;
}

// Free play: the player holds BLUE slot 0; bots fill the other four lanes.
const _ps = teamSpawnXZ(0, 0);
const PLAYER_SPAWN = new THREE.Vector3(_ps.x, 1.7, _ps.z);
const _spawnV = new THREE.Vector3();
// Always a slot on YOUR team's side — never the enemy half, in any game mode.
function playerSpawnPoint() {
  const p = teamSpawnXZ(myTeamId(), (Math.random() * SPAWNS_PER_TEAM) | 0);
  return _spawnV.set(p.x, SPAWN_EYE_Y, p.z);
}
let playerPaintHits = 0;

// Player name (chosen in the main menu, persisted, used in-game + online).
const PLAYER_NAME_KEY = 'whiteout.playerName';
function loadPlayerName() {
  try { return (localStorage.getItem(PLAYER_NAME_KEY) || '').slice(0, 14); } catch { return ''; }
}
let playerName = loadPlayerName();
function getPlayerName() { return playerName.trim() || 'Recruit'; }

// The human's scoreline, shaped like a bot's so kill crediting is uniform.
const playerStats = { name: getPlayerName(), kills: 0, deaths: 0, shots: 0, isPlayer: true };

// Match state: first team to `target` tags wins. `over` freezes play and shows
// the game-over screen until Play Again resets it. `target` is driven by the
// Score to Win setting.
const match = { target: 25, over: false, winner: -1 };

const overlay = document.getElementById('overlay');
const crosshair = document.getElementById('crosshair');
const hud = document.getElementById('hud');
const scoreboard = document.getElementById('scoreboard');
const scoreBlueEl = document.getElementById('score-blue');
const scoreRedEl = document.getElementById('score-red');
const sbTimerEl = document.getElementById('sb-timer'); // center scoreboard clock
let matchStartMs = 0; // wall-clock at match start, for the free-play elapsed timer
const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.max(0, Math.floor(sec % 60))).padStart(2, '0')}`;

// ---- Global multi-row kill feed (top-right): "shooter [splat][gun] victim" ----
const killfeedRowsEl = document.getElementById('killfeed-rows');
const KF_MAX = 5, KF_TTL_MS = 5200;
const _kfEsc = (s) => { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; };
function pushKill(shooterName, shooterTeam, victimName, victimTeam) {
  if (!killfeedRowsEl) return;
  const row = document.createElement('div');
  row.className = 'kf-row';
  const sc = shooterTeam === 0 ? 'kf-name-blue' : 'kf-name-red';
  const vc = victimTeam === 0 ? 'kf-name-blue' : 'kf-name-red';
  const splat = shooterTeam === 0 ? 'kf-fill-blue' : 'kf-fill-red';
  row.innerHTML =
    `<span class="${sc}">${_kfEsc(shooterName)}</span>` +
    `<svg class="kf-splat ${splat}"><use href="#kf-splat-ico"/></svg>` +
    `<svg class="kf-gun"><use href="#kf-gun-ico"/></svg>` +
    `<span class="${vc}">${_kfEsc(victimName)}</span>`;
  killfeedRowsEl.prepend(row); // newest on top
  while (killfeedRowsEl.children.length > KF_MAX) killfeedRowsEl.lastChild.remove();
  setTimeout(() => { row.classList.add('kf-out'); setTimeout(() => row.remove(), 320); }, KF_TTL_MS);
}
function clearKillFeed() { if (killfeedRowsEl) killfeedRowsEl.innerHTML = ''; }
const paintHitEl = document.getElementById('paint-hit');
const paintDripsEl = paintHitEl.querySelector('.ph-drips');
let paintHitTimer = null;

const respawnEl = document.getElementById('respawn');
const respawnCountEl = respawnEl.querySelector('.respawn-count');

const killfeedEl = document.getElementById('killfeed');
const killfeedNameEl = document.getElementById('kf-name');
let killfeedTimer = null;
const killedbyEl = document.getElementById('killedby');
const killedbyNameEl = document.getElementById('kb-name');
let killedbyTimer = null;

/** Flash "KILLED <name>" under the crosshair + a satisfying chime. */
function showKill(name) {
  killfeedNameEl.textContent = name;
  killfeedEl.classList.remove('hidden');
  // restart the pop animation even on back-to-back kills
  killfeedEl.style.animation = 'none';
  void killfeedEl.offsetWidth;
  killfeedEl.style.animation = '';
  audio.play('killConfirm', { volume: 0.9 });
  clearTimeout(killfeedTimer);
  killfeedTimer = setTimeout(() => killfeedEl.classList.add('hidden'), 1600);
}

/** Flash "KILLED BY <name>" when you're tagged. */
function showKilledBy(name) {
  if (!name) { killedbyEl.classList.add('hidden'); return; }
  killedbyNameEl.textContent = name;
  killedbyEl.classList.remove('hidden');
  killedbyEl.style.animation = 'none';
  void killedbyEl.offsetWidth;
  killedbyEl.style.animation = '';
  clearTimeout(killedbyTimer);
  killedbyTimer = setTimeout(() => killedbyEl.classList.add('hidden'), 2800);
}

// Player death/respawn state: tagged players wait out a 3s countdown, then
// respawn with brief spawn protection (bots already respawn on a 3s timer).
const RESPAWN_MS = 3000;
let playerDead = false;
let playerRespawnMs = 0; // remaining ms, counted down only while in-game

// Match-start countdown: a "get ready" freeze at the start of every match.
// > 0 while counting; readiness is countdownMs <= 0. It dips slightly negative
// to hold "GO" on screen, then hides. Ticks only during active play.
const COUNTDOWN_MS = 5000;
const COUNTDOWN_GO_MS = -650; // how long "GO" lingers after zero
let countdownMs = 0;
let _countdownShown = -1;
let _respawnShown = -1; // last whole second shown on the respawn timer (for beeps)
const countdownEl = document.getElementById('countdown');

function startCountdown() {
  countdownMs = COUNTDOWN_MS;
  _countdownShown = -1;
  countdownEl.classList.remove('hidden', 'go');
  updateCountdown(0);
}

// Advances the timer and drives the on-screen number. Returns nothing; callers
// read `countdownMs <= 0` for readiness.
function updateCountdown(dt) {
  if (countdownMs <= COUNTDOWN_GO_MS) return; // already finished + hidden
  countdownMs -= dt * 1000;
  if (countdownMs > 0) {
    const n = Math.ceil(countdownMs / 1000);
    if (n !== _countdownShown) {
      _countdownShown = n;
      countdownEl.textContent = String(n);
      countdownEl.classList.remove('go', 'hidden');
      countdownEl.style.animation = 'none'; void countdownEl.offsetWidth; countdownEl.style.animation = '';
      audio.play('countdownBeep', { volume: 0.6 });
    }
  } else if (countdownMs > COUNTDOWN_GO_MS) {
    if (_countdownShown !== 0) {
      _countdownShown = 0;
      countdownEl.textContent = 'GO';
      countdownEl.classList.add('go');
      countdownEl.style.animation = 'none'; void countdownEl.offsetWidth; countdownEl.style.animation = '';
      audio.play('countdownGo', { volume: 0.7 });
    }
  } else {
    countdownEl.classList.add('hidden');
  }
}

// Flash a colored vignette + a few running drips in the shooter's paint color.
function paintHit(hex) {
  const col = '#' + ((hex >>> 0) & 0xffffff).toString(16).padStart(6, '0');
  paintHitEl.style.setProperty('--hit-color', col);
  paintDripsEl.innerHTML = '';
  const n = 5 + (Math.random() * 4 | 0);
  for (let i = 0; i < n; i++) {
    const d = document.createElement('div');
    d.className = 'ph-drip';
    d.style.setProperty('--w', (12 + Math.random() * 26) + 'px');
    d.style.left = (Math.random() * 100) + '%';
    paintDripsEl.appendChild(d);
    const len = 40 + Math.random() * 150;
    requestAnimationFrame(() => { d.style.height = len + 'px'; }); // grow downward
  }
  paintHitEl.classList.add('show');
  clearTimeout(paintHitTimer);
  paintHitTimer = setTimeout(() => paintHitEl.classList.remove('show'), 850);
}

// ---------------------------------------------------------------------------
// Bots (5v5). Player fills one BLUE slot; bots use the same fire rate.
// ---------------------------------------------------------------------------
function onPlayerTagged(shooterTeamId, hex = 0xff3b3b, shooterName = '') {
  paintHit(hex); // border turns the color that tagged us
  if (playerDead) return; // already down, waiting to respawn
  playerStats.deaths++;
  playerDead = true;
  playerRespawnMs = RESPAWN_MS; // counts down only while in-game (never in a menu)
  _respawnShown = -1;          // so the first tick beeps
  playerPaintHits = 0;
  stopFiring();
  setWeaponsVisible(false); // hide the first-person gun/body while you're down
  showKilledBy(shooterName);
  respawnEl.classList.remove('hidden');
  if (jetMode) {
    // shot down while flying: the jet breaks apart, then you respawn on foot
    jetMode = false;
    document.body.classList.remove('flying-jet');
    if (jetHudEl) { jetHudEl.classList.add('hidden'); jetWarnEl.classList.add('hidden'); }
    camera.fov = settings.get('fov'); camera.updateProjectionMatrix();
    jet.explode();
    audio.play('tankExplode', { volume: 0.9 });
    busterPaintBurst(jet.pos.clone(), COLORS[colorIndex].hex);
  } else {
    explodePlayer(camera.position); // pop into paint where you fell
  }
}

function respawnPlayer() {
  playerDead = false;
  // never respawn still flying — always come back on foot as a player
  if (jetMode) { jetMode = false; document.body.classList.remove('flying-jet'); }
  jet.hide();
  jetWarnT = 0;
  if (jetHudEl) { jetHudEl.classList.add('hidden'); jetWarnEl.classList.add('hidden'); }
  camera.fov = settings.get('fov'); camera.updateProjectionMatrix(); // in case we died flying/zoomed
  respawnEl.classList.add('hidden');
  setWeaponsVisible(true); // restore the gun (an in-tank death hides it)
  camera.position.copy(playerSpawnPoint()); // always your own side
  player.velocityY = 0;
  player.resetStance();   // stand up — don't carry a crouch/slide into respawn
  playerPaintHits = 0;
  audio.play('countdownGo', { volume: 0.6 }); // back in — "go" tone
  bots._playerInvulnUntil = performance.now() + 1500; // brief spawn protection
}

const bots = new BotSystem(scene, arena, {
  spawnProjectile,
  onPlayerTagged,
  onFire: (pos, hex, dir, teamId) => {
    audio.playAt('single', pos, {
      volume: 0.5, rate: 0.9 + Math.random() * 0.14, refDistance: 5, maxDistance: 80,
    });
    // host: replicate bot shots so clients see the paintballs
    if (dir && netplay.isHost && netplay.active) netplay.sendShot(pos, dir, hex, teamId);
  },
  onTag: ({ shooter, victimName, victimIsPlayer, pos }) => {
    // wet splat on a body: full volume when it's us, positional otherwise
    if (victimIsPlayer) {
      audio.play('bodyHit', { volume: 1.0, rate: 0.96 + Math.random() * 0.08 });
    } else {
      audio.playAt('bodyHit', pos, {
        volume: 0.9, rate: 0.96 + Math.random() * 0.08, refDistance: 6, maxDistance: 70,
      });
    }
    if (shooter === playerStats && !victimIsPlayer) showKill(victimName);
    // kill feed row: you only ever tag enemies, so the victim's team is the
    // shooter's opposite
    const sIsPlayer = shooter === playerStats;
    const sName = sIsPlayer ? getPlayerName() : (shooter && shooter.name) || 'Bot';
    const sTeam = sIsPlayer ? myTeamId() : (shooter && shooter.team ? shooter.team.id : 0);
    const vName = victimIsPlayer ? getPlayerName() : victimName;
    pushKill(sName, sTeam, vName, 1 - sTeam);
  },
  paint,
  fireInterval: 90,
});

bots.onPlayerPaintHit = (threshold) => {
  playerPaintHits++;
  if (playerPaintHits >= threshold) {
    bots.scores[1]++;
    onPlayerTagged();
  }
};

// set world after bots exists so dynamic bot collision works
player.setWorld(arena.blockers, arena.groundMeshes, arena.ceilings, bots.bots);

// `active` = game is being played (mouse locked OR gamepad session started)
let active = false;
let padSession = false;
// `sessionLive` = a single-player match is underway (menu = pause, not reset)
let sessionLive = false;

// ---------------------------------------------------------------------------
// Screen management: start / settings / game-over overlays + in-game HUD.
// ---------------------------------------------------------------------------
const settingsOverlay = document.getElementById('settings-overlay');
const gameoverOverlay = document.getElementById('gameover-overlay');
const howtoOverlay = document.getElementById('howto-overlay');
const publicOverlay = document.getElementById('public-overlay');
const privateOverlay = document.getElementById('private-overlay');
const gameoverResult = document.getElementById('gameover-result');
const gameoverScore = document.getElementById('gameover-score');
let settingsReturnScreen = 'start';

function hideAllMenus() {
  overlay.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
  gameoverOverlay.classList.add('hidden');
  howtoOverlay.classList.add('hidden');
  publicOverlay.classList.add('hidden');
  privateOverlay.classList.add('hidden');
  document.getElementById('lobby-overlay').classList.add('hidden');
}
function showHowTo() {
  hideAllMenus();
  howtoOverlay.classList.remove('hidden');
}
function showPublic() {
  hideAllMenus();
  publicOverlay.classList.remove('hidden');
}
function showPrivate() {
  hideAllMenus();
  roomCodeBox.classList.add('hidden');   // hosting now moves to the lobby screen
  privateEnterBtn.classList.add('hidden');
  joinInput.value = '';
  joinStatus.textContent = '';
  privateOverlay.classList.remove('hidden');
}
function showStart() {
  active = false;
  padSession = false;
  hideAllMenus();
  overlay.classList.remove('hidden');
  crosshair.classList.add('hidden');
  hud.classList.add('hidden');
  respawnEl.classList.add('hidden');
  countdownEl.classList.add('hidden');
  killfeedEl.classList.add('hidden');
  killedbyEl.classList.add('hidden');
  scoreboard.classList.add('hidden'); // re-shown on entering play
  netHudEl.classList.add('hidden');
  netStatusEl.classList.add('hidden');
  // name is editable only at a fresh menu — not when pausing mid-match
  nameInput.disabled = sessionLive;
}
function showSettings(returnTo) {
  settingsReturnScreen = returnTo;
  settings.refreshUI();
  hideAllMenus();
  settingsOverlay.classList.remove('hidden');
}
function showGameOver() {
  active = false;
  hideAllMenus();
  gameoverOverlay.classList.remove('hidden');
  crosshair.classList.add('hidden');
  hud.classList.add('hidden');
  respawnEl.classList.add('hidden');
  countdownEl.classList.add('hidden');
  killfeedEl.classList.add('hidden');
  killedbyEl.classList.add('hidden');
}
function enterGame() {
  active = true;
  audio.resume(); // first gesture unlocks WebAudio
  hideAllMenus();
  crosshair.classList.remove('hidden');
  hud.classList.remove('hidden');
  scoreboard.classList.toggle('hidden', !(bots.enabled || netplay.active));
}

const TEAM_HEX = [0x2f7bff, 0xff3b3b]; // BLUE, RED

// Render report rows [{name, teamId, kills, deaths, shots, you?}] into the table.
function renderReportRows(rows) {
  rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.shots - a.shots);
  const body = document.getElementById('cr-body');
  body.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (r.you) tr.className = 'cr-you';
    const col = '#' + (r.hex ?? TEAM_HEX[r.teamId] ?? 0x888888).toString(16).padStart(6, '0');
    const nameTd = document.createElement('td');
    const dot = document.createElement('span');
    dot.className = 'cr-dot';
    dot.style.background = col;
    nameTd.append(dot, document.createTextNode(r.name));
    tr.appendChild(nameTd);
    for (const v of [r.kills, r.deaths, r.shots]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

/** Single-player after-action report: the player folded in with the bots. */
function buildCombatReport() {
  renderReportRows([
    { name: playerStats.name, teamId: PLAYER_TEAM, you: true,
      kills: playerStats.kills, deaths: playerStats.deaths, shots: playerStats.shots },
    ...bots.bots.map(b => ({
      name: b.name, hex: b.hex, teamId: b.team.id,
      kills: b.kills, deaths: b.deaths, shots: b.shots,
    })),
  ]);
}

// End the match and surface the result. Frees the cursor so menu buttons work.
function endMatch(winnerTeamId) {
  match.over = true;
  sessionLive = false; // next Play starts a fresh match
  match.winner = winnerTeamId;
  if (winnerTeamId === myTeamId()) unlockAchievement('VICTORY'); // your team won
  gameoverResult.textContent = winnerTeamId === 0 ? 'BLUE WINS' : 'RED WINS';
  gameoverResult.className = winnerTeamId === 0 ? 'win-blue' : 'win-red';
  gameoverScore.textContent = `${bots.scores[0]} – ${bots.scores[1]}`;
  buildCombatReport();
  document.getElementById('play-again-btn').textContent = 'Play Again';
  document.getElementById('gameover-settings-btn').classList.remove('hidden');
  if (controls.isLocked) controls.unlock();
  showGameOver();
}

// Online match ended: show the combat report, then everyone returns to the same
// lobby (net session stays alive) where the host can start another match.
let onlineResultShowing = false;
function showOnlineResult(winner, scores, rows) {
  onlineResultShowing = true;
  gameoverResult.textContent = winner === 0 ? 'BLUE WINS' : winner === 1 ? 'RED WINS' : 'DRAW';
  gameoverResult.className = winner === 0 ? 'win-blue' : winner === 1 ? 'win-red' : '';
  gameoverScore.textContent = `${scores[0]} – ${scores[1]}`;
  renderReportRows((rows || []).map((r) => ({
    ...r, you: netplay.me && r.name === (netplay.roster.get(netplay.me.id) || {}).name,
  })));
  document.getElementById('play-again-btn').textContent = 'Back to Lobby';
  document.getElementById('gameover-settings-btn').classList.add('hidden'); // lobby has Leave
  if (controls.isLocked) controls.unlock();
  showGameOver();
}

// Reset scores/positions for a fresh match (does not itself enter the game).
function resetMatch() {
  match.over = false;
  match.winner = -1;
  sessionLive = true;    // a single-player match is now underway
  matchStartMs = performance.now(); // reset the elapsed clock
  clearKillFeed();
  playerDead = false;
  // never carry a flight into a fresh match
  if (jetMode) { jetMode = false; document.body.classList.remove('flying-jet'); jetHudEl.classList.add('hidden'); jetWarnEl.classList.add('hidden'); }
  jet.hide(); jetWarnT = 0;
  setWeaponsVisible(true); // a prior death hides the gun — always restore it on a new match
  respawnEl.classList.add('hidden');
  killfeedEl.classList.add('hidden');
  killedbyEl.classList.add('hidden');
  playerStats.kills = 0; playerStats.deaths = 0; playerStats.shots = 0;
  bots.setSlotBase(1, 0);              // player holds BLUE slot 0; bots fill 1..4
  if (bots.enabled) bots.respawnAll(); // resets scores + stats, respawns teams
  camera.position.copy(playerSpawnPoint()); // always your own side
  player.velocityY = 0;
  player.resetStance();
  playerPaintHits = 0;
  startCountdown();                    // "get ready" freeze before the match
}

// --- Title / cover screen: Start splatters, then reveals the main menu ---
const titleEl = document.getElementById('title');
const titleSplatEl = document.getElementById('title-splat');
const startBtn = document.getElementById('start-btn');
let started = false;

function titleSplatBurst() {
  const r = startBtn.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const n = 7;
  for (let i = 0; i < n; i++) {
    const b = document.createElement('div');
    b.className = 'title-blob';
    const hex = COLORS[(Math.random() * COLORS.length) | 0].hex;
    const size = 60 + Math.random() * 150;
    // first, biggest blob lands dead-center on the button; rest scatter around it
    const ang = Math.random() * Math.PI * 2;
    const dist = i === 0 ? 0 : 30 + Math.random() * 90;
    b.style.background = '#' + hex.toString(16).padStart(6, '0');
    b.style.width = b.style.height = (i === 0 ? size * 1.4 : size) + 'px';
    b.style.left = (cx + Math.cos(ang) * dist) + 'px';
    b.style.top = (cy + Math.sin(ang) * dist) + 'px';
    b.style.setProperty('--rot', (Math.random() * 40 - 20) + 'deg');
    b.style.animationDelay = (i === 0 ? 0 : Math.random() * 0.12) + 's';
    titleSplatEl.appendChild(b);
  }
}

function startGame() {
  if (started) return;
  started = true;
  audio.resume();                 // Start is a user gesture — unlock audio here
  startBtn.classList.add('hit');
  titleSplatBurst();
  setTimeout(() => {
    titleEl.classList.add('title-out');
    showStart();                  // reveal the main menu
    setTimeout(() => { titleEl.style.display = 'none'; }, 500);
  }, 620);
}
startBtn.addEventListener('click', startGame);

// Name field (main menu only). Sanitize, persist, and reflect into stats.
const nameInput = document.getElementById('player-name');
nameInput.value = playerName;
nameInput.addEventListener('input', () => {
  nameInput.value = nameInput.value.replace(/[^\w .'-]/g, '').slice(0, 14);
  playerName = nameInput.value;
  playerStats.name = getPlayerName();
  try { localStorage.setItem(PLAYER_NAME_KEY, playerName); } catch (_) { /* ignore */ }
});

document.getElementById('play-btn').addEventListener('click', () => {
  // fresh single-player match on first Play; resume if paused mid-match
  if (!netplay.active && !sessionLive) {
    bots.setEnabled(guiState.bots5v5);
    resetMatch();
  }
  controls.lock();
});
// "Lights Out" mode toggle — flips night mode live (so you preview it behind the
// menu) and it carries into whatever match you start, free play or online.
const lightsOutToggle = document.getElementById('lights-out-toggle');
// flip night mode AND keep the toggle button in sync (used by the click handler
// and by the online match start, so clients follow the host's Lights Out setting)
function setNightUI(on) {
  setNightMode(on);
  lightsOutToggle.classList.toggle('on', nightMode);
  lightsOutToggle.setAttribute('aria-pressed', String(nightMode));
}
// Lights Out is a whole-MATCH mode, so it can't differ between players. You may
// change it only in free play, or as the HOST in the online lobby before the
// match goes live — never as a client, and never mid-match.
function nightToggleAllowed() {
  if (!netplay.active) return true;                    // free play: your call
  if (!netplay.isHost) return false;                   // online: only the host decides
  return !(netplay.started && !netplay.matchOver);     // host: not during a live match
}
function refreshNightToggle() {
  const allowed = nightToggleAllowed();
  lightsOutToggle.classList.toggle('disabled', !allowed);
  lightsOutToggle.setAttribute('aria-disabled', String(!allowed));
}
lightsOutToggle.addEventListener('click', () => {
  if (!nightToggleAllowed()) return; // ignore — the host owns the match mode
  setNightUI(!nightMode);
});

// --- Map selection: rebuild the arena in place and re-point every system ---
function setMap(mapId) {
  mapId = Math.max(1, Math.min(MAPS.length, mapId | 0));
  if (mapId === arena.mapId) return;
  if (netplay.active) { refreshMapPicker(); return; } // free play only for now (MP map sync is a follow-up)
  try { localStorage.setItem('wo.map', String(mapId)); } catch {}
  paint.clear();                                    // drop paint from the old map
  scene.remove(arena.group);                        // dispose the old arena
  arena.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  for (const m of arena.materials) m.dispose();
  arena = buildArena(scene, mapId);                 // build + re-wire everything holding an arena ref
  setArenaSize(arena.size);
  JET_BOUND = arena.size + 32;
  jet.arenaBlockers = arena.blockers;
  player.setWorld(arena.blockers, arena.groundMeshes, arena.ceilings, bots.bots);
  bots.arena = arena;
  for (const t of tanks) t.arena = arena;
  spawnTanks();
  refreshMapPicker();
}
const mapPickerEl = document.getElementById('map-picker');
function refreshMapPicker() {
  if (!mapPickerEl) return;
  const locked = netplay.active; // the map is chosen in free play; MP map sync is a follow-up
  for (const b of mapPickerEl.querySelectorAll('.map-btn')) {
    b.classList.toggle('on', +b.dataset.map === arena.mapId);
    b.classList.toggle('disabled', locked);
  }
}
if (mapPickerEl) {
  for (const m of MAPS) {
    const b = document.createElement('button');
    b.className = 'map-btn'; b.dataset.map = m.id; b.textContent = m.name;
    if (m.id === arena.mapId) b.classList.add('on'); // initial highlight (netplay not up yet)
    b.addEventListener('click', () => setMap(m.id));
    mapPickerEl.appendChild(b);
  }
}

document.getElementById('open-settings-btn').addEventListener('click', () => showSettings('start'));
document.getElementById('open-howto-btn').addEventListener('click', () => showHowTo());
document.getElementById('howto-back-btn').addEventListener('click', () => showStart());

// ---------------------------------------------------------------------------
// Multiplayer: NetClient (rooms + WebRTC channels) + NetPlay (in-game sync).
// v1 is a drop-in PvP skirmish — bots sit out while a net session is live.
// ---------------------------------------------------------------------------
const netHudEl = document.getElementById('net-hud');
const netCodeEl = document.getElementById('net-code');
const netCountEl = document.getElementById('net-count');
const roomCodeBox = document.getElementById('room-code-box');
const roomCodeValue = document.getElementById('room-code-value');
const privateEnterBtn = document.getElementById('private-enter-btn');
const publicEnterBtn = document.getElementById('public-enter-btn');
const publicStatus = document.getElementById('public-status');
const joinInput = document.getElementById('join-code-input');
const joinStatus = document.getElementById('join-status');

const OFFLINE_MSG = "Online play isn't live in this build yet.";
const mpConfigured = () => !!signalUrl();

function updateNetHud() {
  netCodeEl.textContent = net.code || '—';
  const n = netplay.playerCount();
  netCountEl.textContent = n === 1 ? 'waiting for players…' : `${n} players`;
}

const netStatusEl = document.getElementById('net-status');
function setNetStatusHud() {
  const cfg = netplay.matchConfig;
  netStatusEl.classList.remove('hidden');
  if (cfg.mode === 'score') netStatusEl.textContent = `First to ${cfg.value}`;
  else setNetClock(cfg.value * 60);
}
function setNetClock(secondsLeft) {
  sbTimerEl.textContent = fmtClock(secondsLeft); // the match clock lives in the scoreboard now
}

// Host's win-condition picker (only the host edits it; synced on Start).
const wcState = { mode: 'score', value: 25 };
const WC_LIMITS = { score: { min: 5, max: 100, step: 5, unit: 'tags to win' },
                    time: { min: 1, max: 20, step: 1, unit: 'minute match' } };
function renderWinConfig() {
  const lim = WC_LIMITS[wcState.mode];
  document.getElementById('wc-score').classList.toggle('active', wcState.mode === 'score');
  document.getElementById('wc-time').classList.toggle('active', wcState.mode === 'time');
  document.getElementById('wc-value').textContent = wcState.value;
  document.getElementById('wc-unit').textContent =
    wcState.mode === 'time' ? `minute${wcState.value === 1 ? '' : 's'}` : 'tags to win';
  netplay.matchConfig = { mode: wcState.mode, value: wcState.value };
}
function setWcMode(mode) {
  wcState.mode = mode;
  wcState.value = mode === 'score' ? 25 : 5; // sensible defaults per mode
  renderWinConfig();
}
document.getElementById('wc-score').addEventListener('click', () => setWcMode('score'));
document.getElementById('wc-time').addEventListener('click', () => setWcMode('time'));
document.getElementById('wc-minus').addEventListener('click', () => {
  const lim = WC_LIMITS[wcState.mode];
  wcState.value = Math.max(lim.min, wcState.value - lim.step);
  renderWinConfig();
});
document.getElementById('wc-plus').addEventListener('click', () => {
  const lim = WC_LIMITS[wcState.mode];
  wcState.value = Math.min(lim.max, wcState.value + lim.step);
  renderWinConfig();
});

// Lobby DOM
const lobbyOverlay = document.getElementById('lobby-overlay');
const lobbyCodeValue = document.getElementById('lobby-code-value');
const lobbyCount = document.getElementById('lobby-count');
const lobbyRoster = document.getElementById('lobby-roster');
const lobbyHint = document.getElementById('lobby-hint');
const lobbyStartBtn = document.getElementById('lobby-start-btn');

const net = new NetClient();
const netplay = new NetPlay(net, {
  scene,
  camera,
  spawnProjectile,
  onTagged: (shooterTeamId, hex, name) => onPlayerTagged(shooterTeamId, hex, name),
  showKill,
  onRosterChange: () => { updateNetHud(); renderLobby(); refreshNightToggle(); refreshMapPicker(); },
  onStart: () => startNetMatchLocal(),  // clients: (re)start — fresh scoreline
  onClock: (secondsLeft) => setNetClock(secondsLeft),
  onMatchEnd: (winner, scores, rows) => showOnlineResult(winner, scores, rows),
  getLocalStats: () => ({ kills: playerStats.kills, deaths: playerStats.deaths, shots: playerStats.shots }),
  getPlayerName: () => getPlayerName(),
  getBotSnapshot: () => bots.netSnapshot(),
  tagBot: (idx, team) => bots.tagBotByIndex(idx, team),
  onGhostBotDied: (pos) => explodePlayer(pos), // client: enemy ghost bots pop into paint too
  onMoonSplat: (p, hex) => nightSky.hitMoonLocal(p, hex), // a peer painted the moon
  onMoonWake: () => { nightSky.wake(); audio.play('countdownGo', { volume: 0.6, rate: 0.6 }); }, // the moon woke for everyone
  onEnded: (reason) => {
    netHudEl.classList.add('hidden');
    bots.setEnabled(false);   // menus stay frozen; Play starts a fresh match
    scoreboard.classList.add('hidden');
    sessionLive = false;
    const note = reason || 'Left the online match.';
    joinStatus.textContent = note;
    publicStatus.textContent = note;
    if (!lobbyOverlay.classList.contains('hidden')) showStart();
    if (controls.isLocked) controls.unlock(); // unlock handler shows the menu
    refreshNightToggle(); // back to free play — the toggle is yours again
    refreshMapPicker();
  },
});

// host: when a real bot dies, score it for everyone
bots.onBotDown = (idx, byTeam) => {
  const b = bots.bots[idx];
  if (b) explodePlayer(b.pos); // enemy pops into paint
  if (netplay.isHost && netplay.active) netplay.hostBotDied(idx, byTeam);
};

// ---- Lobby rendering + flow ------------------------------------------------
const TEAM_DOT = ['#2f7bff', '#ff3b3b'];

function renderLobby() {
  if (lobbyOverlay.classList.contains('hidden')) return;
  lobbyCodeValue.textContent = net.code || '—';
  const players = [...netplay.roster.values()];
  lobbyCount.textContent = `(${players.length}/10)`;
  lobbyRoster.innerHTML = '';
  for (const p of players) {
    const row = document.createElement('div');
    row.className = 'lobby-player';
    const dot = document.createElement('span');
    dot.className = 'lp-dot';
    dot.style.background = TEAM_DOT[p.team];
    const name = document.createElement('span');
    name.textContent = p.name;
    row.append(dot, name);
    if (netplay.me && p.id === netplay.me.id) {
      const you = document.createElement('span');
      you.className = 'lp-you'; you.textContent = 'YOU';
      row.appendChild(you);
    }
    lobbyRoster.appendChild(row);
  }
  const winConfig = document.getElementById('lobby-winconfig');
  const resumeBtn = document.getElementById('lobby-resume-btn');
  const inProgress = netplay.started && !netplay.matchOver; // paused mid-match

  resumeBtn.classList.toggle('hidden', !inProgress);
  // host setup (win-condition + Start) only shows between matches
  const showSetup = netplay.isHost && !inProgress;
  winConfig.classList.toggle('hidden', !showSetup);
  lobbyStartBtn.classList.toggle('hidden', !showSetup);
  lobbyStartBtn.textContent = netplay.matchOver ? 'Next Match' : 'Start Game';

  if (inProgress) {
    lobbyHint.textContent = 'Match in progress — resume, or leave.';
  } else if (netplay.isHost) {
    renderWinConfig();
    const fill = 10 - players.length;
    lobbyHint.textContent = fill > 0
      ? `${netplay.matchOver ? 'Next match' : 'Start'} fills ${fill} empty slot${fill === 1 ? '' : 's'} with bots.`
      : 'Teams are full. Start when ready.';
  } else {
    lobbyHint.textContent = netplay.matchOver
      ? 'Match over — waiting for the host to start the next one…'
      : 'Waiting for the host to start the match…';
  }
}

function showLobby() {
  active = false;
  hideAllMenus();
  // the lobby is a menu state — clear the in-game HUD
  crosshair.classList.add('hidden');
  hud.classList.add('hidden');
  scoreboard.classList.add('hidden');
  netHudEl.classList.add('hidden');
  netStatusEl.classList.add('hidden');
  respawnEl.classList.add('hidden');
  countdownEl.classList.add('hidden');
  killfeedEl.classList.add('hidden');
  killedbyEl.classList.add('hidden');
  onlineResultShowing = false;
  if (controls.isLocked) controls.unlock();
  lobbyOverlay.classList.remove('hidden');
  renderLobby();
  refreshNightToggle(); // in the lobby, only the host may pick the mode
  refreshMapPicker();
}

// Host clicks Start: backfill empty slots to 5v5 with bots, then drop in.
function hostStartMatch() {
  const players = [...netplay.roster.values()];
  const blueHumans = players.filter((p) => p.team === 0).length;
  const redHumans = players.filter((p) => p.team === 1).length;
  const blueBots = Math.max(0, 5 - blueHumans);
  const redBots = Math.max(0, 5 - redHumans);

  const botRoster = [];
  for (let i = 0; i < blueBots; i++) botRoster.push({ name: BLUE_NAMES[i % BLUE_NAMES.length], team: 0 });
  for (let i = 0; i < redBots; i++) botRoster.push({ name: RED_NAMES[i % RED_NAMES.length], team: 1 });

  bots.setSlotBase(blueHumans, redHumans);  // bots fill slots above the humans
  bots.setEnabledCounts(blueBots, redBots); // host owns the real bot AI
  netplay.matchConfig.night = nightMode;    // sync Lights Out to everyone in the match
  netplay.hostStart(botRoster);             // tells clients to spawn ghosts + drop in
  startNetMatchLocal();
}

// Fresh start of a net match: wipe my scoreline, spawn on my team's side.
function startNetMatchLocal() {
  setNightUI(!!netplay.matchConfig.night); // match the host's Lights Out setting (host: no-op)
  refreshNightToggle();                    // lock the toggle now that the match is live
  refreshMapPicker();
  playerStats.kills = 0; playerStats.deaths = 0; playerStats.shots = 0;
  playerDead = false;
  setWeaponsVisible(true); // restore the gun in case a prior death hid it
  clearKillFeed();
  respawnEl.classList.add('hidden');
  killfeedEl.classList.add('hidden');
  killedbyEl.classList.add('hidden');
  const s = netplay.mySpawn();
  camera.position.set(s.x, 1.7, s.z);
  player.velocityY = 0;
  player.resetStance();
  setNetStatusHud();
  startCountdown();                    // "get ready" freeze before the match
  enterNetArena();
}

// Enter/return to the arena (used by match start AND resume — no stat reset).
function enterNetArena() {
  scoreboard.classList.remove('hidden');
  netHudEl.classList.remove('hidden');
  updateNetHud();
  controls.lock();                   // click gesture → pointer lock → enterGame
}

async function hostFlow(isPublic, statusEl) {
  if (!mpConfigured()) { statusEl.textContent = OFFLINE_MSG; return false; }
  if (net.active) { showLobby(); return true; } // already hosting → back to lobby
  try {
    statusEl.textContent = 'Creating room…';
    const code = await net.hostRoom({ isPublic, name: "ceeboozwah's match" });
    netplay.beginHost();
    statusEl.textContent = '';
    lobbyCodeValue.textContent = code;
    showLobby();
    return true;
  } catch (e) {
    statusEl.textContent = e.message === 'no-signal-url'
      ? OFFLINE_MSG : 'Could not reach the matchmaking server.';
    return false;
  }
}

async function joinFlow(code, statusEl) {
  if (!mpConfigured()) { statusEl.textContent = OFFLINE_MSG; return; }
  if (net.active) { statusEl.textContent = 'Already in a room.'; return; }
  try {
    statusEl.textContent = `Joining ${code}…`;
    await net.joinRoom(code, getPlayerName());
    netplay.beginClient();
    statusEl.textContent = '';
    // land in the lobby; if a match is already running, the host's `welcome`
    // fires onStart and pulls us straight into the arena
    showLobby();
  } catch (e) {
    net.close(''); // teardown first — onEnded writes a generic note we overwrite
    statusEl.textContent =
      e.message === 'no-signal-url' ? OFFLINE_MSG :
      e.message === 'signal-unreachable' ? 'Could not reach the matchmaking server.' :
      e.message === 'peer-timeout' ? 'Found the room, but the connection timed out.' :
      e.message; // join-fail reasons arrive human-readable ("Room not found.")
  }
}

lobbyStartBtn.addEventListener('click', () => hostStartMatch());
document.getElementById('lobby-resume-btn').addEventListener('click', () => enterNetArena());
document.getElementById('lobby-leave-btn').addEventListener('click', () => {
  net.close('');
  showStart();
});

async function refreshPublicList() {
  const rowsEl = document.getElementById('server-rows');
  const emptyEl = document.getElementById('server-empty');
  if (!mpConfigured()) { publicStatus.textContent = OFFLINE_MSG; return; }
  try {
    publicStatus.textContent = 'Searching…';
    const rooms = await net.listRooms();
    publicStatus.textContent = '';
    rowsEl.innerHTML = '';
    emptyEl.classList.toggle('hidden', rooms.length > 0);
    for (const r of rooms) {
      const row = document.createElement('div');
      row.className = 'server-row';
      const name = document.createElement('span');
      name.className = 'sv-name';
      name.textContent = r.name;
      const players = document.createElement('span');
      players.className = 'sv-players';
      players.textContent = `${r.players}/${r.maxPlayers}`;
      const joinCell = document.createElement('span');
      joinCell.className = 'sv-join';
      const btn = document.createElement('button');
      btn.textContent = 'Join';
      btn.addEventListener('click', () => joinFlow(r.code, publicStatus));
      joinCell.appendChild(btn);
      row.append(name, players, joinCell);
      rowsEl.appendChild(row);
    }
  } catch (e) {
    publicStatus.textContent = 'Could not reach the matchmaking server.';
  }
}

document.getElementById('open-public-btn').addEventListener('click', () => {
  showPublic();
  document.getElementById('public-note').textContent = mpConfigured()
    ? 'Public games anyone can drop into.' : OFFLINE_MSG;
  refreshPublicList();
});
document.getElementById('open-private-btn').addEventListener('click', () => {
  showPrivate();
  document.getElementById('private-note').textContent = mpConfigured()
    ? 'Share a room code to play with friends.' : OFFLINE_MSG;
});
document.getElementById('public-back-btn').addEventListener('click', () => showStart());
document.getElementById('private-back-btn').addEventListener('click', () => showStart());
document.getElementById('public-refresh-btn').addEventListener('click', () => refreshPublicList());

document.getElementById('public-host-btn').addEventListener('click', () => hostFlow(true, publicStatus));
document.getElementById('private-host-btn').addEventListener('click', () => hostFlow(false, joinStatus));

joinInput.addEventListener('input', () => {
  joinInput.value = joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
});
document.getElementById('private-join-btn').addEventListener('click', () => {
  const code = joinInput.value.trim();
  if (code.length !== 5) { joinStatus.textContent = 'Enter a 5-character room code.'; return; }
  joinFlow(code, joinStatus);
});
document.getElementById('gameover-settings-btn').addEventListener('click', () => showSettings('gameover'));
document.getElementById('settings-back-btn').addEventListener('click', () => {
  if (settingsReturnScreen === 'gameover') showGameOver();
  else showStart();
});
document.getElementById('play-again-btn').addEventListener('click', () => {
  if (onlineResultShowing) {         // online match ended → back to the same lobby
    showLobby();                     // net session stays alive; host can restart
    return;
  }
  resetMatch();
  controls.lock(); // this click is a user gesture, so pointer lock is allowed
});

controls.addEventListener('lock', enterGame);
controls.addEventListener('unlock', () => {
  if (devPanelOpen) return; // tuning in the dev panel — keep the game, just free the cursor
  if (padSession || match.over) return;
  // pausing an online match returns to the lobby, not the single-player menu
  if (netplay.active) showLobby();
  else showStart();
});

// ---------------------------------------------------------------------------
// Direct number-key color selection (movement keys handled by InputManager)
// ---------------------------------------------------------------------------
const DIGIT_TO_COLOR = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4, Digit6: 5 };
document.addEventListener('keydown', (e) => {
  if (e.code in DIGIT_TO_COLOR) setColor(DIGIT_TO_COLOR[e.code]);
});

// ---------------------------------------------------------------------------
// Shooting / projectiles
// ---------------------------------------------------------------------------
const projectiles = [];
const projGeo = new THREE.SphereGeometry(0.13, 12, 12);
const raycaster = new THREE.Raycaster();
const _forward = new THREE.Vector3();
const _aimPt = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
// World point directly under the screen-centre crosshair — raycast against the
// arena and any live enemy tank, with a far fallback. Player rounds are aimed at
// this point (and flown flat) so they land exactly where the crosshair sits,
// with no muzzle/parallax offset on foot or in the tank.
function crosshairAimPoint() {
  camera.getWorldDirection(_aimDir);
  const eye = camera.getWorldPosition(_aimPt); // _aimPt now holds the eye pos
  raycaster.set(eye, _aimDir);
  raycaster.far = 500;
  let best = null, bestD = Infinity;
  const wall = raycaster.intersectObjects(arena.paintTargets, false)[0];
  if (wall) { best = wall.point; bestD = wall.distance; }
  for (const tk of tanks) {
    if (!tk.alive || tk === currentTank) continue;
    const th = raycaster.intersectObject(tk.root, true)[0];
    if (th && th.distance < bestD) { best = th.point; bestD = th.distance; }
  }
  if (best) return _aimPt.copy(best);
  return _aimPt.addScaledVector(_aimDir, 300); // _aimPt still = eye
}
const _wpnRay = new THREE.Raycaster();
const _wpnDir = new THREE.Vector3();
const _wpnHit = new THREE.Vector3();
const PLAYER_TEAM = 0; // player fights on the BLUE team
const FIRE_INTERVAL = 90; // ms — shared by player and bots
let lastShot = 0;

// Generic projectile spawner shared by the player and bots. `isPlayer` marks the
// human's shots so their impacts can stamp the custom-designed splatter.
function spawnProjectile(origin, dir, hex, team, speed = 70, isPlayer = false, shooter = null, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.4 });
  if (nightMode) { mat.emissive.setHex(hex); mat.emissiveIntensity = 2.4; mat.toneMapped = false; } // full-bright neon
  const mesh = new THREE.Mesh(projGeo, mat);
  mesh.position.copy(origin);
  const radius = opts.radius || 0.13;      // projGeo is r=0.13
  if (radius !== 0.13) mesh.scale.setScalar(radius / 0.13);
  scene.add(mesh);
  const proj = {
    mesh,
    vel: dir.clone().multiplyScalar(speed),
    prev: origin.clone(),
    born: performance.now(),
    hex,
    team,
    isPlayer,
    shooter,
    radius,
    splatScale: opts.splatScale || 1, // bigger splat for tank shells
    gravity: (opts.gravity != null) ? opts.gravity : null, // per-shell drop (else default)
  };
  projectiles.push(proj);
  return proj; // callers (e.g. the tank buster) can tag on extra behaviour
}

// Returns true if a projectile was actually spawned this call (respects the
// fire-rate limit). Sound is handled by updateShooting() so single taps and
// held fire can use different clips.
function shoot() {
  const now = performance.now();
  if (now - lastShot < FIRE_INTERVAL) return false; // fire-rate limit
  lastShot = now;

  camera.getWorldDirection(_forward);
  const hex = COLORS[colorIndex].hex;
  const origin = camera.getWorldPosition(new THREE.Vector3())
    .add(_forward.clone().multiplyScalar(0.6));
  // aim straight at the crosshair point and fly flat, so the round lands dead-on
  const dir = crosshairAimPoint().sub(origin).normalize().clone();
  const p = spawnProjectile(origin, dir, hex, PLAYER_TEAM, 70, true, playerStats, { gravity: 0 });
  // easter egg: a round aimed at the moon (night) homes to it
  if (p && nightMode && nightSky.aimHitsMoon(origin, _forward)) p.moonBound = true;
  playerStats.shots++;
  weapon.kick();
  netplay.sendShot(origin, dir, hex); // no-op unless an online match is live
  return true;
}

// ---------------------------------------------------------------------------
// Firing sound logic:
//  - the gun always fires at FIRE_INTERVAL while held (no stutter on hold)
//  - each shot plays the crisp one-shot clip until a sustained hold hands off
//    to the looping gun sound, so the two never leave a gap between them
//  - the loop stops the instant the trigger is released
// ---------------------------------------------------------------------------
let shootWasHeld = false;
let firePressStart = 0;
let autoEngaged = false;
let gunLoop = null;
const AUTO_DELAY = 200; // ms the trigger must be held before the loop takes over

function updateShooting() {
  const held = input.shootHeld;
  const now = performance.now();

  if (held && !shootWasHeld) { // new trigger press
    firePressStart = now;
    autoEngaged = false;
  }

  if (held) {
    // a sustained hold hands off to the looping gun sound
    if (!autoEngaged && now - firePressStart >= AUTO_DELAY) {
      autoEngaged = true;
      gunLoop = audio.playLoop('gun', { volume: 0.8 });
    }
    // fire at the normal rate throughout; before the loop engages every shot
    // gets its own one-shot clip, so the sound stays continuous into the loop
    if (shoot() && !autoEngaged) {
      audio.play('single', { volume: 0.95, rate: 0.97 + Math.random() * 0.06 });
    }
  } else if (shootWasHeld) {
    stopFiring(); // trigger released
  }

  shootWasHeld = held;
}

// Silence the gun loop and reset press state (release, pause, or match end).
function stopFiring() {
  if (gunLoop) { audio.stopLoop(gunLoop); gunLoop = null; }
  autoEngaged = false;
  shootWasHeld = false;
}

// Aim-down-sights zoom: blend the FOV toward the weapon's aim FOV and slow the
// mouse a touch while zoomed, so aiming actually feels like aiming.
let _lastFov = -1;
function activeWeapon() { return currentWeapon === 1 ? tankBuster : weapon; }
function applyAimZoom() {
  const w = activeWeapon();
  const base = settings ? settings.get('fov') : 75;
  const fov = THREE.MathUtils.lerp(base, w.aimFov, w.aimT);
  if (Math.abs(fov - _lastFov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
    _lastFov = fov;
  }
  const sens = settings ? settings.get('mouseSensitivity') : 1;
  controls.pointerSpeed = sens * THREE.MathUtils.lerp(1, 0.55, w.aimT);
}

// ==========================================================================
// TANK BUSTER — lock-on, top-attack anti-tank launcher (on-foot, free play + MP)
// ==========================================================================
const BUSTER = {
  range: 155, coneCos: Math.cos(0.11), // TIGHT cone (~6°): tank must be on the reticle
  lockTime: 1.5, fireInterval: 2600,   // s to lock, ms between busts
  ascendSpeed: 55, cruiseSpeed: 72, plungeSpeed: 95,
  apex: 55, damage: 20,                 // metres up, armour per hit
  turnRadius: 12,                       // m — radius of the rounded flight-path corners (bigger = more sweeping)
};
const buster = { target: null, lockT: 0, locked: false, lastShot: 0 };
const _bv = new THREE.Vector3(), _bEye = new THREE.Vector3();
const _bDes = new THREE.Vector3(), _bCur = new THREE.Vector3();
const _bLosDir = new THREE.Vector3(), _bLosHit = new THREE.Vector3();
const _bLosRay = new THREE.Raycaster();

// true when nothing solid is between the eye and the tank (tank actually visible)
function busterLOS(eye, tk) {
  _bLosDir.set(tk.pos.x, tk.pos.y + 1.2, tk.pos.z).sub(eye);
  const dist = _bLosDir.length();
  _bLosDir.multiplyScalar(1 / dist);
  _bLosRay.set(eye, _bLosDir); _bLosRay.far = dist;
  for (const box of arena.blockers) {
    if (_bLosRay.ray.intersectBox(box, _bLosHit) && _bLosHit.distanceTo(eye) < dist - 2.4) return false;
  }
  return true;
}

// true when no static wall blocks a tank muzzle's shot at a ground target point.
// Bot tanks use this so they never fire at an enemy they can't actually see.
function tankAiLOS(origin, tx, tz) {
  _bLosDir.set(tx - origin.x, 1.4 - origin.y, tz - origin.z);
  const dist = _bLosDir.length();
  if (dist < 1e-3) return true;
  _bLosDir.multiplyScalar(1 / dist);
  _bLosRay.set(origin, _bLosDir); _bLosRay.far = dist;
  for (const box of arena.blockers) {
    if (_bLosRay.ray.intersectBox(box, _bLosHit) && _bLosHit.distanceTo(origin) < dist - 1.0) return false;
  }
  return true;
}

// smoke-trail pool (dark puffs, no contour outline)
const _busterSmokeTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const busterSmoke = [];
for (let i = 0; i < 220; i++) {
  const mat = new THREE.SpriteMaterial({ map: _busterSmokeTex, color: 0x2a2d33, transparent: true, opacity: 0, depthWrite: false });
  const s = new THREE.Sprite(mat); s.visible = false; s.layers.set(NO_OUTLINE_LAYER); scene.add(s);
  busterSmoke.push({ sprite: s, age: 0, life: 1, size0: 0.6, vel: new THREE.Vector3() });
}
// drop one smoke puff at a point (jittered), reused by the trail + impact burst
function spawnBusterPuff(x, y, z) {
  const p = busterSmoke.find((s) => !s.sprite.visible); if (!p) return;
  p.sprite.position.set(x + (Math.random() - .5) * 0.25, y + (Math.random() - .5) * 0.2, z + (Math.random() - .5) * 0.25);
  p.vel.set((Math.random() - .5) * 0.7, 0.4 + Math.random() * 0.6, (Math.random() - .5) * 0.7);
  p.age = 0; p.life = 1.4 + Math.random() * 0.9; p.size0 = 0.75 + Math.random() * 0.6;
  p.sprite.scale.setScalar(p.size0); p.sprite.material.opacity = 0.85; p.sprite.visible = true;
}
// a puff burst at one spot (impact smoke)
function emitBusterSmoke(pos) { spawnBusterPuff(pos.x, pos.y, pos.z); spawnBusterPuff(pos.x, pos.y, pos.z); }
// lay a CONTINUOUS ribbon of puffs along the path the warhead actually travelled
// this frame — so fast horizontal runs and the two 90° corners stay filled with
// no gaps, regardless of frame rate or speed.
const _smkStep = 0.5; // metres between puffs
const _smkSeg = new THREE.Vector3();
function emitBusterTrail(p, pos) {
  if (!p._smokePrev) { p._smokePrev = pos.clone(); p._smokeCarry = 0; spawnBusterPuff(pos.x, pos.y, pos.z); return; }
  _smkSeg.subVectors(pos, p._smokePrev);
  let dist = _smkSeg.length();
  if (dist < 1e-4) return;
  _smkSeg.multiplyScalar(1 / dist);
  let carry = p._smokeCarry || 0;
  // walk from the last puff forward along the segment at fixed spacing
  let d = _smkStep - carry;
  while (d <= dist) {
    spawnBusterPuff(p._smokePrev.x + _smkSeg.x * d, p._smokePrev.y + _smkSeg.y * d, p._smokePrev.z + _smkSeg.z * d);
    d += _smkStep;
  }
  p._smokeCarry = dist - (d - _smkStep); // leftover distance carried to next frame
  p._smokePrev.copy(pos);
}
function updateBusterSmoke(dt) {
  for (const p of busterSmoke) {
    if (!p.sprite.visible) continue;
    p.age += dt; if (p.age >= p.life) { p.sprite.visible = false; continue; }
    p.sprite.position.addScaledVector(p.vel, dt);
    p.vel.multiplyScalar(1 - 0.4 * dt); p.vel.y += 0.35 * dt;
    const t = p.age / p.life;
    p.sprite.scale.setScalar(p.size0 * (1 + t * 2.6));
    p.sprite.material.opacity = (1 - t) * 0.85;
  }
}

// the best enemy tank the player is aiming at, within range + cone
function busterAcquire() {
  camera.getWorldDirection(_forward);
  camera.getWorldPosition(_bEye);
  let best = null, bestDot = BUSTER.coneCos;
  for (const tk of tanks) {
    if (!tk.alive || tk.teamId === myTeamId()) continue; // enemy tanks only
    _bv.set(tk.pos.x, tk.pos.y + 1.4, tk.pos.z).sub(_bEye);
    const d = _bv.length();
    if (d > BUSTER.range) continue;
    _bv.multiplyScalar(1 / d);
    const dot = _bv.dot(_forward);
    if (dot > bestDot) { bestDot = dot; best = tk; }
  }
  if (best && !busterLOS(_bEye, best)) return null; // must have clear line of sight
  return best;
}

// per-frame: acquire/hold lock and fire when locked (no-op unless buster equipped)
function updateBuster(dt, ready) {
  if (currentWeapon !== 1) { buster.target = null; buster.lockT = 0; buster.locked = false; updateBusterHud(); return; }
  // lock-on ONLY works while zoomed down the scope (ADS) with the tank on the reticle
  const cand = (ready && !playerDead && input.aimHeld) ? busterAcquire() : null;
  if (cand && cand === buster.target) buster.lockT = Math.min(1, buster.lockT + dt / BUSTER.lockTime);
  else if (cand) { buster.target = cand; buster.lockT = 0.001; }
  else { buster.lockT = Math.max(0, buster.lockT - dt / (BUSTER.lockTime * 0.5)); if (buster.lockT <= 0) buster.target = null; }

  const wasLocked = buster.locked;
  buster.locked = !!buster.target && buster.lockT >= 1;
  if (buster.locked && !wasLocked) audio.play('countdownGo', { volume: 0.4 }); // lock-acquired tone
  tankBuster.setLocked(buster.locked);
  updateBusterHud();

  if (ready && input.shootHeld && buster.locked && performance.now() - buster.lastShot >= BUSTER.fireInterval) {
    buster.lastShot = performance.now();
    fireBuster(buster.target);
  }
  updateBusterSmoke(dt);
}

function fireBuster(tk) {
  const hex = COLORS[colorIndex].hex;
  const origin = tankBuster.getMuzzle();
  const p = spawnProjectile(origin, new THREE.Vector3(0, 1, 0), hex, PLAYER_TEAM, BUSTER.ascendSpeed, true, playerStats, { radius: 0.5, gravity: 0 });
  p.tankBuster = true; p.phase = 'ascend'; p.target = tk;
  p.apexY = origin.y + BUSTER.apex; p.lastX = tk.pos.x; p.lastZ = tk.pos.z;
  p._smokePrev = origin.clone(); p._smokeCarry = 0; // seed the continuous smoke ribbon
  tankBuster.kick();
  playerStats.shots++;
  audio.play('tankFire', { volume: 0.85, rate: 1.2 }); // launch
}

// drives a buster warhead through ascend -> transit -> plunge; returns true when
// it has impacted (and been removed)
function updateBusterProjectile(p, i, dt) {
  const pos = p.mesh.position;
  const tk = p.target;
  const live = tk && tk.alive;
  const tx = live ? tk.pos.x : p.lastX;
  const tz = live ? tk.pos.z : p.lastZ;
  if (live) { p.lastX = tk.pos.x; p.lastZ = tk.pos.z; }

  if (!p.vel) p.vel = new THREE.Vector3(0, 1, 0); // heading (unit); launches straight up

  // --- desired heading + speed for the current phase ---
  const des = _bDes;
  let speed;
  if (p.phase === 'ascend') {
    des.set(0, 1, 0); speed = BUSTER.ascendSpeed;
    // start arcing over BEFORE the apex so the top rounds into a smooth dome
    if (pos.y >= p.apexY - BUSTER.turnRadius) p.phase = 'transit';
  } else if (p.phase === 'transit') {
    const dx = tx - pos.x, dz = tz - pos.z, hd = Math.hypot(dx, dz);
    // fly toward the point over the target, easing height back toward the apex
    des.set(dx, (p.apexY - pos.y) * 0.5, dz);
    if (des.lengthSq() < 1e-6) des.set(0, -1, 0);
    des.normalize();
    speed = BUSTER.cruiseSpeed;
    // begin the dive a turn-radius out so the descent corner is a smooth arc
    if (hd <= BUSTER.turnRadius + 1.5) p.phase = 'plunge';
  } else { // plunge — curve over and home down onto the target
    const dx = tx - pos.x, dz = tz - pos.z;
    des.set(dx, -Math.max(2, BUSTER.turnRadius), dz).normalize(); // mostly down, still homing
    speed = BUSTER.plungeSpeed;
    const onTank = live && Math.hypot(pos.x - tk.pos.x, pos.z - tk.pos.z) < tk.hitRadius && pos.y <= tk.pos.y + 2.6;
    if (onTank || pos.y <= 0.25) { busterImpact(p, live ? tk : null, i); return true; }
  }

  // steer the current heading toward the desired one, capped so the turn traces
  // a fixed radius (arc length / radius). That fillets every corner into a curve
  // instead of a hard 90° break — and the smoke ribbon follows the same path.
  const cur = _bCur.copy(p.vel).normalize();
  const maxTurn = (speed * dt) / BUSTER.turnRadius; // radians allowed this frame
  const ang = Math.acos(THREE.MathUtils.clamp(cur.dot(des), -1, 1));
  const dir = (ang <= maxTurn || ang < 1e-4) ? des : cur.lerp(des, maxTurn / ang).normalize();
  p.vel.copy(dir);
  pos.addScaledVector(p.vel, speed * dt);

  emitBusterTrail(p, pos); // continuous ribbon along the whole flight path
  return false;
}

function busterImpact(p, tk, i) {
  const pos = p.mesh.position.clone();
  if (tk && Math.hypot(pos.x - tk.pos.x, pos.z - tk.pos.z) < tk.hitRadius + 1.2) {
    // a MASSIVE conformal splat on the hull
    raycaster.set(_bv.set(pos.x, tk.pos.y + 4, pos.z), _forward.set(0, -1, 0));
    raycaster.far = 14;
    const th = raycaster.intersectObject(tk.root, true)[0];
    if (th && th.face) {
      const n = th.face.normal.clone().transformDirection(th.object.matrixWorld).normalize();
      const decal = paint.buildDecal(th.object, th.point, n, p.hex, 4.8);
      if (decal) tk.addSplat(decal, th.object); // stick to the exact part (turret/barrel/hull)
    }
    if (!netplay.active || netplay.isHost) {
      for (let d = 0; d < BUSTER.damage && tk.alive; d++) {
        if (tk.takeHit(1)) { // destroyed
          tk.respawnAt = performance.now() + TANK_RESPAWN_MS;
          if (currentTank === tk) exitTank(true);
          playerStats.kills++; showKill('TANK');
          pushKill(getPlayerName(), myTeamId(), (tk.teamId === 0 ? 'BLUE' : 'RED') + ' TANK', tk.teamId);
          break;
        }
      }
    } else {
      for (let d = 0; d < BUSTER.damage; d++) netplay.sendTankHit(tk.teamId);
    }
    showTankHitmarker(true);
  }
  busterPaintBurst(pos, p.hex);
  audio.play('tankRoundImpact', { volume: 1.3 });
  removeProjectile(i);
}

// a huge multi-colour paint blast that coats the ground, walls and the tank
function busterPaintBurst(pos, hex) {
  const origin = new THREE.Vector3(pos.x, Math.max(0.6, pos.y), pos.z);
  const dir = new THREE.Vector3();
  for (let n = 0; n < 46; n++) {
    const col = (Math.random() < 0.55) ? hex : EXPLOSION_COLORS[(Math.random() * EXPLOSION_COLORS.length) | 0];
    const a = Math.random() * Math.PI * 2, el = 0.03 + Math.random() * 0.75;
    dir.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)).normalize();
    const speed = 12 + Math.random() * 22;
    spawnProjectile(origin.clone().addScaledVector(dir, 0.6), dir.clone(), col, PLAYER_TEAM, speed, false, { netGhost: true }, { splatScale: 2.7 });
  }
  for (let n = 0; n < 6; n++) emitBusterSmoke(origin); // impact smoke puff
}

// show/hide the whole viewmodel set based on the active weapon
function setWeaponsVisible(show) {
  weapon.root.visible = show && currentWeapon === 0;
  tankBuster.root.visible = show && currentWeapon === 1;
}
function switchWeapon(slot) {
  slot = slot ? 1 : 0;
  if (slot === currentWeapon) return;
  currentWeapon = slot;
  buster.target = null; buster.lockT = 0; buster.locked = false;
  setWeaponsVisible(active && !playerDead && !tankMode && !jetMode);
  audio.play('single', { volume: 0.3, rate: 1.5 }); // switch click
}

// lock-on brackets that track the target tank on screen
const busterHudEl = document.getElementById('buster-hud');
const busterLockPctEl = document.getElementById('buster-lock-pct');
const busterScopeEl = document.getElementById('buster-scope');
const busterScopeStatusEl = document.getElementById('buster-scope-status');
const bsTgtEl = document.getElementById('bs-tgt');
const bsRngEl = document.getElementById('bs-rng');
const bsBrgEl = document.getElementById('bs-brg');
const bsSysEl = document.getElementById('bs-sys');
const bsLockFillEl = document.getElementById('bs-lockfill');
const _bsDir = new THREE.Vector3();
function updateBusterHud() {
  if (!busterHudEl) return;
  const zoomed = tankBuster.aimT > 0.5;

  // scope overlay HUD state (its opacity is driven from the render loop so it
  // resets cleanly when you die / switch away); here we set the reticle status
  busterScopeEl.classList.toggle('locked', buster.locked);
  busterScopeStatusEl.textContent = buster.locked ? 'TARGET LOCKED'
    : (buster.target ? `ACQUIRING ${Math.round(buster.lockT * 100)}%` : 'SEEKING');

  // technical solution readouts (range / bearing / target designation)
  const tgt = buster.target;
  if (bsLockFillEl) bsLockFillEl.style.width = `${Math.round(buster.lockT * 100)}%`;
  if (bsSysEl) bsSysEl.textContent = buster.locked ? 'LOCK' : 'ARMED';
  if (tgt) {
    camera.getWorldPosition(_bEye);
    const rng = Math.hypot(tgt.pos.x - _bEye.x, tgt.pos.z - _bEye.z);
    if (bsRngEl) bsRngEl.textContent = String(Math.round(rng)).padStart(3, '0');
    camera.getWorldDirection(_bsDir);
    let brg = Math.atan2(_bsDir.x, -_bsDir.z) * 180 / Math.PI; // 0 = north (-Z)
    if (brg < 0) brg += 360;
    if (bsBrgEl) bsBrgEl.textContent = String(Math.round(brg)).padStart(3, '0');
    if (bsTgtEl) bsTgtEl.textContent = (tgt.teamId === 0 ? 'BLU' : 'RED') + '-ARMOR';
  } else {
    if (bsRngEl) bsRngEl.textContent = '----';
    if (bsBrgEl) bsBrgEl.textContent = '---';
    if (bsTgtEl) bsTgtEl.textContent = 'NO CONTACT';
  }

  // world-space tracking brackets only at the hip (the scope reticle owns it while zoomed)
  if (currentWeapon !== 1 || !buster.target || playerDead || !active || zoomed) { busterHudEl.classList.add('hidden'); return; }
  const tk = buster.target;
  _bv.set(tk.pos.x, tk.pos.y + 1.7, tk.pos.z).project(camera);
  if (_bv.z > 1) { busterHudEl.classList.add('hidden'); return; } // behind us
  busterHudEl.style.left = ((_bv.x * 0.5 + 0.5) * window.innerWidth) + 'px';
  busterHudEl.style.top = ((-_bv.y * 0.5 + 0.5) * window.innerHeight) + 'px';
  busterHudEl.classList.remove('hidden');
  busterHudEl.classList.toggle('locked', buster.locked);
  busterLockPctEl.textContent = buster.locked ? 'LOCKED' : `${Math.round(buster.lockT * 100)}%`;
}

// --- Tank driving (free play). T toggles in/out; mouse aims the turret, WASD
// drives, click fires big paintballs, right-click is the gunner zoom view. ---
let tankEngineLoop = null, tankTrackLoop = null, tankTurretLoop = null;
function stopTankSound() {
  if (tankEngineLoop) { audio.stopLoop(tankEngineLoop); tankEngineLoop = null; }
  if (tankTrackLoop) { audio.stopLoop(tankTrackLoop); tankTrackLoop = null; }
  if (tankTurretLoop) { audio.stopLoop(tankTurretLoop); tankTurretLoop = null; }
}
function myTeamId() { return (netplay.active && netplay.me) ? netplay.me.team : PLAYER_TEAM; }
function enterTank() {
  const t = tanks[myTeamId()];
  if (!t || !t.alive) return; // your team's tank is destroyed / respawning
  if (netplay.active) {
    const myId = netplay.me && netplay.me.id;
    if (netplay.tankDriver[t.teamId] && netplay.tankDriver[t.teamId] !== myId) return; // someone else is in it
    if (netplay.isHost) netplay.tankDriver[t.teamId] = 'host';
    else netplay.sendTankEnter(t.teamId);
  }
  currentTank = t;
  tankMode = true;
  tankZoomT = 0;
  setWeaponsVisible(false);
  if (gunLoop || shootWasHeld) stopFiring();
  stopSlideSound();      // entering mid-slide must not leave the slide loop playing
  player.resetStance();  // and clear any lingering slide/crouch state on foot
  // face the view along the hull so you start behind the tank looking forward
  camera.rotation.order = 'YXZ';
  camera.rotation.set(0, currentTank.heading + Math.PI, 0);
  audio.resume(); // engine/track loops lazy-start in updateTank (survives pause/resume)
}
// `dead` = the tank was destroyed under you. Then the player dies WITH it: the
// camera stays put where the tank blew up, the player isn't stepped out on foot
// (and stays hidden/untargetable), and the normal respawn countdown runs.
function exitTank(dead = false) {
  const tank = currentTank;
  if (netplay.active && tank) {
    if (netplay.isHost) netplay.tankDriver[tank.teamId] = null;
    else netplay.sendTankExit(tank.teamId);
  }
  tankMode = false;
  currentTank = null;
  stopTankSound();
  tankSightEl.classList.add('hidden'); // hide the gunner HUD
  tankSightEl.style.opacity = 0;
  document.body.classList.remove('driving-tank', 'tank-zoomed');
  netplay.selfPosOverride = null; // back to broadcasting the camera position
  camera.fov = settings.get('fov');
  camera.updateProjectionMatrix();

  if (dead) {
    setWeaponsVisible(false); // no floating gun while we watch the wreck
    if (!playerDead) {           // go into the standard respawn countdown
      playerStats.deaths++;
      playerDead = true;
      playerRespawnMs = RESPAWN_MS;
      _respawnShown = -1;
      playerPaintHits = 0;
      stopFiring();
      respawnEl.classList.remove('hidden');
    }
    return; // leave the camera exactly where it is (watching the explosion)
  }

  setWeaponsVisible(true);
  if (tank) { // step out to the side of the tank
    const rx = Math.cos(tank.heading), rz = -Math.sin(tank.heading);
    camera.position.set(tank.pos.x + rx * 4, 1.7, tank.pos.z + rz * 4);
  }
  player.velocityY = 0;
  player.resetStance();
}

// ---------------------------------------------------------------------------
// Jet (free-play air support). G launches you into the fighter above your spot;
// G again ejects. 3rd-person chase view; mouse steers (nose follows your look),
// W/S trims throttle, left-click strafes the arena with paint MG fire, Space
// drops a cluster paint bomb. Straying past the battlefield boundary starts an
// 8-second return timer — run it out and the jet breaks apart.
// ---------------------------------------------------------------------------
function enterJet() {
  if (netplay.active) return;                 // free-play only for now
  if (jetMode || tankMode || !active || playerDead) return;
  jetMode = true;
  jetWarnT = 0;
  setWeaponsVisible(false);
  if (gunLoop || shootWasHeld) stopFiring();
  stopSlideSound();
  player.resetStance();
  camera.getWorldDirection(_jetLook);
  if (_jetLook.lengthSq() < 1e-4) _jetLook.set(0, 0, 1);
  jet.setColor(COLORS[colorIndex].hex);
  jet.spawn(camera.position.x - _jetLook.x * 6, Math.max(26, camera.position.y + 22),
    camera.position.z - _jetLook.z * 6, _jetLook);
  document.body.classList.add('flying-jet');
  jetHudEl.classList.remove('hidden');
  audio.resume();
  audio.play('tankFire', { volume: 0.5, rate: 1.7 }); // launch whoosh
}
function exitJet(dead = false) {
  jetMode = false;
  document.body.classList.remove('flying-jet');
  jetHudEl.classList.add('hidden');
  jetWarnEl.classList.add('hidden');
  camera.fov = settings.get('fov');
  camera.updateProjectionMatrix();
  if (dead) {
    jet.explode();
    audio.play('tankExplode', { volume: 0.9 });
    busterPaintBurst(jet.pos.clone(), COLORS[colorIndex].hex); // paint splatter where it broke up
    if (!playerDead) {
      playerStats.deaths++;
      playerDead = true;
      playerRespawnMs = RESPAWN_MS;
      _respawnShown = -1;
      playerPaintHits = 0;
      stopFiring();
      respawnEl.classList.remove('hidden');
    }
    return; // camera stays put, watching the debris fall
  }
  jet.hide();
  setWeaponsVisible(true);
  // step down to the ground under the jet (clamped inside the arena)
  const A = 57;
  camera.position.set(THREE.MathUtils.clamp(jet.pos.x, -A, A), 1.7, THREE.MathUtils.clamp(jet.pos.z, -A, A));
  player.velocityY = 0;
  player.resetStance();
}

// Jet enter/exit is handled by a keydown listener HERE in main.js (not routed
// through input.js) so it works even if a stale-cached input.js is loaded — the
// same reason movement broke. G launches/ejects while on foot or flying.
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyG' || e.repeat) return;
  if (!active || playerDead) return;
  if (jetMode) exitJet(false);
  else if (!tankMode) enterJet();
});

function updateJet(dt, ready) {
  camera.getWorldDirection(_jetLook);
  jet.update(dt, _jetLook, ready ? input.move.forward : 0);
  jet.updateCamera(camera, dt);

  const now = performance.now();
  // machine guns — rapid paint rounds forward from the wing roots
  if (ready && input.shootHeld && jet.canFireMg(now)) {
    jet.markMg(now);
    const { origin, dir } = jet.getMuzzle();
    const d = dir.clone();
    d.x += (Math.random() - 0.5) * 0.02; d.y += (Math.random() - 0.5) * 0.02; d.z += (Math.random() - 0.5) * 0.02;
    d.normalize();
    spawnProjectile(origin, d, COLORS[colorIndex].hex, PLAYER_TEAM, jet.mgSpeed, true, playerStats,
      { radius: 0.15, splatScale: 1.1, gravity: -4 });
    playerStats.shots++;
    audio.play('single', { volume: 0.22, rate: 1.5 });
  }
  // cluster paint bomb on Space
  const drop = input.consumeJump();
  if (ready && drop && jet.canDropBomb(now)) { jet.markBomb(now); dropClusterBomb(); }

  // boundary: warn + self-destruct if you leave the battlefield
  const out = Math.abs(jet.pos.x) > JET_BOUND || Math.abs(jet.pos.z) > JET_BOUND || jet.pos.y > JET_CEILING;
  if (out) { jetWarnT += dt; if (jetWarnT >= JET_RETURN_SECS) { exitJet(true); return; } }
  else jetWarnT = 0;

  updateJetHud();
  updateSun();
}

function dropClusterBomb() {
  const origin = jet.getBombPoint();
  // lob it forward with the jet's momentum; gravity pulls it down onto the arena
  const vel = jet.dir.clone().multiplyScalar(jet.speed * 0.45);
  vel.y -= 3;
  const spd = vel.length() || 1;
  const p = spawnProjectile(origin, vel.multiplyScalar(1 / spd), COLORS[colorIndex].hex, PLAYER_TEAM, spd,
    true, playerStats, { radius: 0.32, gravity: -22, splatScale: 1.6 });
  p.clusterBomb = true;
  p.armMs = performance.now() + 300; // brief arm delay before it can burst
  audio.play('single', { volume: 0.4, rate: 0.7 });
}
function updateClusterBomb(p, i, dt) {
  p.vel.y += -22 * dt;
  p.mesh.position.addScaledVector(p.vel, dt);
  const now = performance.now();
  if (now >= p.armMs && (p.mesh.position.y <= 1.3 || now - p.born > 4500)) {
    clusterBurst(p.mesh.position, p.hex);
    removeProjectile(i);
  }
}
function clusterBurst(pos, hex) {
  audio.playAt('tankRoundImpact', pos, { volume: 1.0, refDistance: 16, maxDistance: 160 });
  const origin = new THREE.Vector3(pos.x, Math.max(1.6, pos.y), pos.z);
  const dir = new THREE.Vector3();
  for (let n = 0; n < 28; n++) {
    const col = (Math.random() < 0.5) ? hex : EXPLOSION_COLORS[(Math.random() * EXPLOSION_COLORS.length) | 0];
    const a = Math.random() * Math.PI * 2, el = 0.05 + Math.random() * 0.6;
    dir.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)).normalize();
    const speed = 10 + Math.random() * 16;
    spawnProjectile(origin.clone().addScaledVector(dir, 0.5), dir.clone(), col, PLAYER_TEAM, speed,
      true, playerStats, { splatScale: 1.6 });
  }
  for (let n = 0; n < 4; n++) emitBusterSmoke(origin);
}

// ---------------------------------------------------------------------------
// Lights Out moon easter egg: rounds aimed at the moon home up and splat it;
// enough splats wake the angry moon, which spews paintballs onto the arena.
// ---------------------------------------------------------------------------
const _moonC = new THREE.Vector3(), _moonDir = new THREE.Vector3(), _moonMouth = new THREE.Vector3();
const _mbSeg = new THREE.Vector3(), _mbDir = new THREE.Vector3(), _mbEnd = new THREE.Vector3();
let _moonFireAcc = 0;
let _moonWasActive = false; // edge-detect the egg finishing (to re-arm in MP)

// A barrage round: real ballistics, but it kills EVERYONE it catches (the moon
// is on no team). The on-foot player dies "by ANGRY MOON"; bots die neutrally.
function updateMoonBarrageProjectile(p, i, dt) {
  p.prev.copy(p.mesh.position);
  p.vel.y += (p.gravity != null ? p.gravity : -12) * dt;
  p.mesh.position.addScaledVector(p.vel, dt);
  const seg = _mbSeg.subVectors(p.mesh.position, p.prev);
  const dist = seg.length();
  if (dist > 1e-5) {
    const dir = _mbDir.copy(seg).multiplyScalar(1 / dist);
    // resolve a wall first so it can't pass through geometry
    raycaster.set(p.prev, dir);
    raycaster.far = dist + 0.13;
    const wallHit = raycaster.intersectObjects(arena.paintTargets, false)[0];
    const reach = wallHit ? Math.min(dist + 0.13, wallHit.distance) : dist + 0.13;
    const segEnd = wallHit ? _mbEnd.copy(p.prev).addScaledVector(dir, reach) : p.mesh.position;

    // caught the on-foot player? (respects spawn protection; safe in a vehicle)
    if (active && !playerDead && !tankMode && !jetMode && performance.now() >= bots._playerInvulnUntil
        && segHitsSphere(p.prev, segEnd, camera.position, 0.7)) {
      onPlayerTagged(1, p.hex, 'ANGRY MOON');
      removeProjectile(i); return;
    }
    // caught a bot? (host / free play own the bots)
    if (!netplay.active || netplay.isHost) {
      for (let bi = 0; bi < bots.bots.length; bi++) {
        const b = bots.bots[bi];
        if (!b.alive) continue;
        _tankHit.set(b.pos.x, b.pos.y + 1.1, b.pos.z);
        if (segHitsSphere(p.prev, segEnd, _tankHit, 0.7)) {
          bots.moonKill(bi);
          audio.playAt('bodyHit', _tankHit, { volume: 0.55, rate: 0.85, refDistance: 6, maxDistance: 70 });
          removeProjectile(i); return;
        }
      }
    }
    // otherwise splat on the wall it reached
    if (wallHit) {
      const n = wallHit.face
        ? wallHit.face.normal.clone().transformDirection(wallHit.object.matrixWorld).normalize()
        : new THREE.Vector3(0, 1, 0);
      paint.splat(wallHit.object, wallHit.point, n, p.hex, p.splatScale || 1, false);
      const k = Math.max(0, 1 - camera.position.distanceTo(wallHit.point) / 45);
      audio.play('splat', { volume: 0.7 * k * k, rate: 0.94 + Math.random() * 0.12 });
      removeProjectile(i); return;
    }
  }
  if (performance.now() - p.born > 4000) removeProjectile(i);
}
function updateMoonProjectile(p, i, dt) {
  nightSky.getMoonWorld(_moonC);
  _moonDir.subVectors(_moonC, p.mesh.position);
  const dist = _moonDir.length();
  _moonDir.multiplyScalar(1 / Math.max(dist, 1e-4));
  if (dist <= nightSky.moonRadius + 0.4) {                 // reached the surface
    const surface = _moonC.clone().addScaledVector(_moonDir, -nightSky.moonRadius);
    const local = nightSky.hitMoon(surface, p.hex); // splat locally, get the moon-local point
    audio.play('splat', { volume: 0.5, rate: 0.85 + Math.random() * 0.1 });
    if (netplay.active) {
      netplay.sendMoonHit(local, p.hex);   // MP: peers splat too; the host tallies + wakes it
    } else if (nightSky.registerHit()) {
      audio.play('countdownGo', { volume: 0.6, rate: 0.6 }); // SP: local trigger cue
    }
    removeProjectile(i);
    return;
  }
  p.mesh.position.addScaledVector(_moonDir, 170 * dt);      // home straight up to the moon, fast
  if (performance.now() - p.born > 3000) removeProjectile(i); // safety net
}

// While the moon's mouth is open, rain paintballs down onto the arena (visual
// paint only — netGhost, so nobody is unfairly killed from the sky).
function updateMoonBarrage(dt) {
  if (!nightMode || !nightSky.firing) { _moonFireAcc = 0; return; }
  _moonFireAcc += dt;
  const interval = 0.06; // ~2 rounds every 0.06s (~33/s) raining down
  while (_moonFireAcc >= interval) {
    _moonFireAcc -= interval;
    nightSky.mouthWorld(_moonMouth);
    for (let n = 0; n < 2; n++) {
      const col = EXPLOSION_COLORS[(Math.random() * EXPLOSION_COLORS.length) | 0];
      // aim at a random spot on the ARENA floor (world-fixed, ±55) so it actually
      // lands on the map — the moon itself sits well outside the arena bounds
      const span = (arena.size - 8) * 2; // rain across the whole arena floor
      const tx = (Math.random() - 0.5) * span, tz = (Math.random() - 0.5) * span;
      _moonDir.set(tx - _moonMouth.x, 0.5 - _moonMouth.y, tz - _moonMouth.z).normalize();
      const mb = spawnProjectile(_moonMouth.clone(), _moonDir.clone(), col, PLAYER_TEAM, 95 + Math.random() * 45,
        false, null, { splatScale: 1.5, gravity: -6 }); // light gravity so it reaches
      mb.moonBarrage = true; // lethal to anyone caught under it (see updateMoonBarrageProjectile)
    }
  }
}

// Push the on-foot player out of any tank hull (oriented box, follows heading).
function pushOutOfTank() {
  const pr = player.radius;
  const halfX = 1.4 + pr, halfZ = 2.35 + pr;
  for (const tank of tanks) {
    if (!tank.alive || tank === currentTank) continue;
    const c = Math.cos(tank.heading), s = Math.sin(tank.heading);
    const dx = camera.position.x - tank.pos.x, dz = camera.position.z - tank.pos.z;
    let lx = dx * c - dz * s, lz = dx * s + dz * c; // world -> tank-local
    if (Math.abs(lx) < halfX && Math.abs(lz) < halfZ) {
      if (halfX - Math.abs(lx) < halfZ - Math.abs(lz)) lx = Math.sign(lx) * halfX;
      else lz = Math.sign(lz) * halfZ;
      camera.position.x = tank.pos.x + lx * c + lz * s; // local -> world
      camera.position.z = tank.pos.z - lx * s + lz * c;
    }
  }
}
// Tank simulation. Free play: local AI + respawn. Online: the HOST owns the
// tanks (AI for undriven, client pose for client-driven, armor + destruction +
// respawn) and broadcasts snapshots; clients just follow the snapshots.
function simulateTanks(dt) {
  const now = performance.now();
  if (!netplay.active) {
    for (const t of tanks) if (t.alive && t !== currentTank) updateTankAI(t, dt);
    for (const t of tanks) if (!t.alive && t.respawnAt && now >= t.respawnAt) t.respawn();
    return;
  }
  if (netplay.isHost) {
    for (let team = 0; team < 2; team++) {
      while (netplay.tankHits[team] > 0) {          // client-reported hits
        netplay.tankHits[team]--;
        const tk = tanks[team];
        if (tk.alive && tk.takeHit(1)) { tk.respawnAt = now + TANK_RESPAWN_MS; if (currentTank === tk) exitTank(true); }
      }
    }
    for (const tk of tanks) {
      if (!tk.alive || tk === currentTank) continue; // host drives its own in updateTank
      const drv = netplay.tankDriver[tk.teamId];
      if (drv && drv !== 'host') {
        const pose = netplay.clientTankPose[tk.teamId];
        if (pose) tk.applyNetState(pose.x, pose.z, pose.ry, pose.ty, pose.bp, tk.hp, true);
      } else {
        updateTankAI(tk, dt);                        // no driver -> bot crew
      }
    }
    for (const t of tanks) if (!t.alive && t.respawnAt && now >= t.respawnAt) t.respawn();
    netplay._tankSendT += dt;
    if (netplay._tankSendT >= 1 / 12) {
      netplay._tankSendT = 0;
      netplay.broadcastTankSync(tanks.map((tk) => [tk.teamId,
        +tk.pos.x.toFixed(2), +tk.pos.z.toFixed(2), +tk.heading.toFixed(3),
        +tk.turretYaw.toFixed(3), +tk.barrelPitch.toFixed(3),
        Math.round(tk.hp), tk.alive ? 1 : 0, netplay.tankDriver[tk.teamId] || '',
        +tk.pos.y.toFixed(2)]));
    }
  } else {
    for (const tk of tanks) {                        // client: follow the host
      const st = netplay.tankNet[tk.teamId];
      if (!st) continue;
      if (tk === currentTank) { tk.hp = st.hp; if (!st.alive) exitTank(true); }
      else tk.applyNetState(st.x, st.z, st.ry, st.ty, st.bp, st.hp, st.alive, st.y);
    }
  }
}

// Bot-driven tank: aims its turret at the nearest enemy, drives to a standoff,
// and fires when lined up. Runs for any tank not driven by the local player.
function updateTankAI(tank, dt) {
  let tx = 0, tz = 0, best = Infinity, found = false;
  const consider = (x, z, team) => {
    if (team === tank.teamId) return;
    const dx = x - tank.pos.x, dz = z - tank.pos.z, d = dx * dx + dz * dz;
    if (d < best) { best = d; tx = x; tz = z; found = true; }
  };
  if (active && !playerDead && !tankMode && !jetMode) consider(camera.position.x, camera.position.z, myTeamId());
  if (currentTank && currentTank !== tank) consider(currentTank.pos.x, currentTank.pos.z, currentTank.teamId);
  for (const b of bots.bots) if (b.alive) consider(b.group.position.x, b.group.position.z, b.team.id);

  let forward = 0, turn = 0, aim = null;
  if (found) {
    const dx = tx - tank.pos.x, dz = tz - tank.pos.z, dist = Math.sqrt(best);
    aim = _aiAim.set(dx, -1.2, dz).normalize();
    let hd = ((Math.atan2(dx, dz) - tank.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    turn = THREE.MathUtils.clamp(-hd * 1.2, -1, 1);   // update() applies heading -= turn*...
    forward = dist > 32 ? 1 : (dist < 16 ? -0.4 : 0);  // keep a standoff distance
  }
  tank.update(dt, forward, turn, aim);

  if (found && tank.canFire(performance.now())) {
    const m = tank.getMuzzle();
    const tdx = tx - m.origin.x, tdz = tz - m.origin.z, tl = Math.hypot(tdx, tdz) || 1;
    if ((m.dir.x * tdx + m.dir.z * tdz) / tl > 0.985 && Math.sqrt(best) < 130 &&
        tankAiLOS(m.origin, tx, tz)) { // never fire through a wall at a hidden target
      const { origin, dir } = tank.fire(performance.now());
      spawnProjectile(origin, dir, tank.hex, tank.teamId, tank.projSpeed, false,
        { name: 'Tank' }, { radius: tank.projRadius, splatScale: tank.splatScale, gravity: tank.projGravity });
      if (netplay.active) netplay.sendShot(origin, dir, tank.hex, tank.teamId,
        { radius: tank.projRadius, speed: tank.projSpeed, splatScale: tank.splatScale });
      audio.playAt('tankFire', origin, { volume: 0.7 });
    }
  }
}
function updateTank(dt, ready) {
  const tank = currentTank;
  if (!tank) return;
  // gamepad aim: mouse look goes through PointerLockControls, but the right
  // stick doesn't — rotate the camera here so the turret can aim on a pad
  if (input.gamepadConnected && (input.look.x || input.look.y)) {
    const sp = settings.get('padLookSpeed');
    camera.rotation.order = 'YXZ';
    camera.rotation.y -= input.look.x * sp * dt;
    camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - input.look.y * sp * dt, -1.4, 1.4);
    camera.rotation.z = 0;
  }
  camera.getWorldDirection(_tankAim);
  tank.update(dt, ready ? input.move.forward : 0, ready ? input.move.strafe : 0, _tankAim,
    ready && input.sprint); // Shift / L3 = speed boost

  // --- engine + tracks + turret audio ride the tank's motion ---
  if (!tankEngineLoop) tankEngineLoop = audio.playLoop('tankEngine', { volume: 0.4, rate: 0.8 });
  if (!tankTrackLoop) tankTrackLoop = audio.playLoop('tankTracks', { volume: 0.0, rate: 1.0 });
  const spd = Math.min(1, Math.abs(tank.speed) / tank.driveSpeed); // 0..1 throttle
  if (tankEngineLoop) {
    tankEngineLoop.src.playbackRate.value = 0.8 + spd * 0.8;  // revs up with speed
    tankEngineLoop.gain.gain.value = 0.4 + spd * 0.3;
  }
  if (tankTrackLoop) {
    tankTrackLoop.gain.gain.value = spd * 0.6;                // only clatters while moving
    tankTrackLoop.src.playbackRate.value = 0.85 + spd * 0.5;
  }
  // turret servo loop: on while the turret/barrel is actually traversing
  if (tank.turretMoving) {
    if (!tankTurretLoop) tankTurretLoop = audio.playLoop('tankTurret', { volume: tank.turretVolume, rate: 1.0 });
    else tankTurretLoop.gain.gain.value = tank.turretVolume; // live volume slider
  } else if (tankTurretLoop) {
    audio.stopLoop(tankTurretLoop); tankTurretLoop = null;
  }

  // online: broadcast the tank's position as mine so peers see me at the tank
  if (netplay.active) { _tankSelfPos.set(tank.pos.x, 3.4, tank.pos.z); netplay.selfPosOverride = _tankSelfPos; }
  else netplay.selfPosOverride = null;

  // online: a client driver streams its tank pose to the host, reads its armor
  // back, and drops out if the host reassigned the tank
  if (netplay.active && !netplay.isHost) {
    netplay.sendTankDrive(tank.teamId, tank.pos.x, tank.pos.z, tank.heading, tank.turretYaw, tank.barrelPitch);
    const st = netplay.tankNet[tank.teamId];
    if (st) tank.hp = st.hp;
    const drv = netplay.tankDriver[tank.teamId];
    if (drv && netplay.me && drv !== netplay.me.id) { exitTank(); return; } // host gave it to someone else
  }

  // right-click / LT eases into the gunner zoom view + a narrower FOV
  const zTarget = (ready && input.aimHeld) ? 1 : 0;
  tankZoomT += (zTarget - tankZoomT) * Math.min(1, dt * 8);
  camera.fov = THREE.MathUtils.lerp(settings.get('fov'), tank.zoomFov, tankZoomT);
  camera.updateProjectionMatrix();
  tank.updateCamera(camera, _tankAim, tankZoomT, dt);

  // status panels (armor/boost/speed) show the whole time you're driving;
  // the gunsight (compass/reticle/range) fades in only with the zoom
  tankSightEl.classList.remove('hidden');
  tankSightEl.style.opacity = 1;
  tsZoomEl.style.opacity = tankZoomT;
  document.body.classList.add('driving-tank');
  document.body.classList.toggle('tank-zoomed', tankZoomT > 0.5);
  updateTankHud();

  // fire large paintballs from the barrel
  if (ready && input.shootHeld && tank.canFire(performance.now())) {
    const { origin } = tank.fire(performance.now()); // recoil + muzzle smoke + marks fired
    const hex = COLORS[colorIndex].hex;
    // shell converges on the crosshair point and flies flat — perfectly sighted,
    // regardless of where the barrel is mid-traverse
    const dir = crosshairAimPoint().sub(origin).normalize().clone();
    spawnProjectile(origin, dir, hex, tank.teamId, tank.projSpeed, true, playerStats,
      { radius: tank.projRadius, splatScale: tank.splatScale, gravity: 0 });
    if (netplay.active) netplay.sendShot(origin, dir, hex, tank.teamId,
      { radius: tank.projRadius, speed: tank.projSpeed, splatScale: tank.splatScale });
    playerStats.shots++;
    audio.play('tankFire', { volume: 1.0 });            // cannon boom
    setTimeout(() => { if (tankMode) audio.play('tankReload', { volume: 0.7 }); }, 350); // reload clunk
  }
}
// Tank enter/exit is proximity-based (run up to your team's tank, press E / Y).
// Prompt element + a distance test drive it from the main loop.
const tankPromptEl = document.getElementById('tank-prompt');
const tankPromptKeyEl = document.getElementById('tank-prompt-key');
function updateTankPrompt() {
  const interact = input.consumeInteract();
  if (!active || playerDead) { tankPromptEl.classList.add('hidden'); return; }
  if (tankMode) {
    tankPromptEl.classList.add('hidden');
    if (interact) exitTank();
    return;
  }
  const myTank = tanks[myTeamId()];
  const dx = camera.position.x - myTank.pos.x, dz = camera.position.z - myTank.pos.z;
  const near = myTank.alive && (dx * dx + dz * dz) < 42; // ~6.5m
  if (near) {
    tankPromptKeyEl.textContent = input.gamepadConnected ? 'Y' : 'E';
    tankPromptEl.classList.remove('hidden');
    if (interact) enterTank();
  } else {
    tankPromptEl.classList.add('hidden');
  }
}

// Slide sound: a seamless loop held for exactly as long as the slide lasts, so
// it covers whatever Slide Duration is set in the dev panel.
let slideLoop = null;
function updateSlideSound() {
  const scraping = player.sliding || player.diving;
  if (scraping && !slideLoop) {
    slideLoop = audio.playLoop('slide', { volume: 0.6 });
  } else if (!scraping && slideLoop) {
    audio.stopLoop(slideLoop);
    slideLoop = null;
  }
}
function stopSlideSound() {
  if (slideLoop) { audio.stopLoop(slideLoop); slideLoop = null; }
}

// shooting is driven from the loop via input.shootHeld (mouse + gamepad RT)

// Does the segment a->b pass within radius r of a sphere centered at c?
function segHitsSphere(a, b, c, r) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = ab2 > 0 ? ((c.x - a.x) * abx + (c.y - a.y) * aby + (c.z - a.z) * abz) / ab2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = c.x - (a.x + abx * t), dy = c.y - (a.y + aby * t), dz = c.z - (a.z + abz * t);
  return dx * dx + dy * dy + dz * dz <= r * r;
}

function updateProjectiles(dt) {
  const PROJ_GRAV = -12;
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    // tank-buster warhead flies its own guided top-attack arc, not ballistics
    if (p.tankBuster) { updateBusterProjectile(p, i, dt); continue; }
    if (p.clusterBomb) { updateClusterBomb(p, i, dt); continue; }
    if (p.moonBound) { updateMoonProjectile(p, i, dt); continue; }
    if (p.moonBarrage) { updateMoonBarrageProjectile(p, i, dt); continue; }
    p.prev.copy(p.mesh.position);
    p.vel.y += (p.gravity != null ? p.gravity : PROJ_GRAV) * dt;
    p.mesh.position.addScaledVector(p.vel, dt);

    const seg = new THREE.Vector3().subVectors(p.mesh.position, p.prev);
    const dist = seg.length();
    if (dist > 1e-5) {
      const dir = seg.clone().normalize();

      // Resolve a blocking wall FIRST. Anything solid between p.prev and the
      // segment end stops the shot, so NOTHING (player, bot or tank) can be
      // tagged through a wall. `reach` caps every hit test at the wall, and
      // `segEnd` is the clamped end of the travelled segment for the tank test.
      // (At tank-shell speed a single frame spans metres, which is exactly how
      // enemies behind thin walls used to get hit "through" them.)
      raycaster.set(p.prev, dir);
      raycaster.far = dist + 0.13;
      const wallHit = raycaster.intersectObjects(arena.paintTargets, false)[0];
      const reach = wallHit ? Math.min(dist + 0.13, wallHit.distance) : dist + 0.13;
      const segEnd = wallHit ? _segEnd.copy(p.prev).addScaledVector(dir, reach) : p.mesh.position;

      // Relayed shots from other players are visual only — the authoritative
      // shooter already resolved their hits. Skip combatant detection; still
      // let them splat on walls below.
      const isNetGhost = p.shooter && p.shooter.netGhost;

      // online: MY shots test against remote players + the host's ghost bots
      if (p.isPlayer && netplay.active) {
        const victim = netplay.testHit(p.prev, dir, reach);
        if (victim) {
          audio.play('bodyHit', { volume: 0.9, rate: 0.96 + Math.random() * 0.08 });
          showKill(victim.name);
          showTankHitmarker(true); // player/bot tag → larger marker
          playerStats.kills++;
          if (victim.kind === 'bot') netplay.sendBotHit(victim.index);
          else netplay.sendTag(victim.id, p.hex);
          removeProjectile(i);
          continue;
        }
      }

      // host: my bots' paintballs can tag remote human players
      if (!isNetGhost && !p.isPlayer && netplay.isHost && netplay.active) {
        const rv = netplay.hostTestRemoteHit(p.prev, dir, reach, p.team);
        if (rv) {
          netplay.broadcastTag(rv.id, p.hex, p.team, p.shooter && p.shooter.name);
          removeProjectile(i);
          continue;
        }
      }

      if (isNetGhost) {
        // fall through to wall-splat only
      } else if (guiState.invisibleMode) {
        // In invisible mode, track paint hits instead of instant kills
        const hitResult = bots.hitscanPaint(p.prev, dir, reach, p.team, guiState.paintKillThreshold, p.hex);
        if (hitResult) {
          removeProjectile(i);
          continue;
        }
      } else {
        // Normal mode: instant tag on hit
        if (bots.hitscan(p.prev, dir, reach, p.team, p.hex, p.shooter)) {
          if (p.isPlayer) showTankHitmarker(true); // player/bot tag → larger marker
          removeProjectile(i);
          continue;
        }
      }

      // tank armor: paintballs damage the ENEMY team's tank
      let hitTank = false;
      for (const tk of tanks) {
        if (!tk.alive || tk.teamId === p.team) continue;
        tk.hitCenter(_tankHit);
        if (segHitsSphere(p.prev, segEnd, _tankHit, tk.hitRadius)) {
          // real projected decal on the hull, baked into tank-local so it moves with it
          raycaster.set(p.prev, dir);
          raycaster.far = dist + (p.radius || 0.13) + 0.6;
          const th = raycaster.intersectObject(tk.root, true)[0];
          if (th && th.face) {
            const n = th.face.normal.clone().transformDirection(th.object.matrixWorld).normalize();
            const decal = paint.buildDecal(th.object, th.point, n, p.hex, (p.radius > 0.2 ? 2.4 : 1.2));
            if (decal) tk.addSplat(decal, th.object); // stick to the exact part (turret/barrel/hull)
          }
          if (p.isPlayer) showTankHitmarker();
          if (!isNetGhost) { // relayed ghost shells only splat; they never damage
            if (!netplay.active || netplay.isHost) {
              if (tk.takeHit(1)) {                   // destroyed
                tk.respawnAt = performance.now() + TANK_RESPAWN_MS;
                if (currentTank === tk) exitTank(true); // you die with your tank
                if (p.isPlayer) { playerStats.kills++; showKill('TANK'); unlockAchievement('TANK_COMMANDER'); pushKill(getPlayerName(), myTeamId(), (tk.teamId === 0 ? 'BLUE' : 'RED') + ' TANK', tk.teamId); }
              }
            } else {
              netplay.sendTankHit(tk.teamId);        // host applies the armor damage
            }
          }
          // a tank SHELL slamming a tank gets the heavy impact clip; small
          // paintballs just wet-splat on the armor
          if (p.radius > 0.2) audio.playAt('tankRoundImpact', _tankHit, { volume: 1.3, refDistance: 16, maxDistance: 150 });
          else audio.playAt('bodyHit', _tankHit, { volume: 0.5, rate: 0.8 });
          removeProjectile(i);
          hitTank = true;
          break;
        }
      }
      if (hitTank) continue;

      // splat on the blocking wall we found up top (nothing got hit before it)
      if (wallHit) {
        const h = wallHit;
        const n = h.face
          ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
          : new THREE.Vector3(0, 1, 0);
        paint.splat(h.object, h.point, n, p.hex, p.splatScale || 1, p.isPlayer);
        // impact sound, quieter with distance (squared falloff; skipped when far)
        const k = Math.max(0, 1 - camera.position.distanceTo(h.point) / 45);
        audio.play('splat', { volume: 0.85 * k * k, rate: 0.94 + Math.random() * 0.12 });
        removeProjectile(i);
        continue;
      }
    }

    if (performance.now() - p.born > 4000) removeProjectile(i);
  }
}

function removeProjectile(i) {
  const p = projectiles[i];
  scene.remove(p.mesh);
  p.mesh.material.dispose();
  projectiles.splice(i, 1);
}

// ---------------------------------------------------------------------------
// Player physics now lives in PlayerController (player.js).
// Keep the sun following the player so shadows stay crisp across the arena.
// ---------------------------------------------------------------------------
function updateSun() {
  const p = camera.position;
  sun.target.position.set(p.x, 0, p.z);
  sun.position.set(p.x + 30, 48, p.z + 20);
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
const swatchEl = document.getElementById('color-swatch');
const nameEl = document.getElementById('color-name');

function setColor(i) {
  colorIndex = i;
  const c = COLORS[i];
  swatchEl.style.background = '#' + c.hex.toString(16).padStart(6, '0');
  nameEl.textContent = c.name;
  weapon.setPaintColor(c.hex); // hopper balls match the selected paint
  tankBuster.setPaintColor(c.hex);
  guiState.paintColor = c.name;
  if (colorCtrl) colorCtrl.updateDisplay();
}

// ---------------------------------------------------------------------------
// Environment controls
// ---------------------------------------------------------------------------
const guiState = {
  // outline
  outlineStrength: outline.uniforms.strength.value,
  outlineThickness: outline.uniforms.thickness.value,
  outlineGray: '#3a3f47',
  depthEdges: outline.uniforms.depthBias.value,
  normalEdges: outline.uniforms.normalBias.value,
  // paint
  paintColor: COLORS[0].name,
  splatSize: paint.settings.size,
  splatSizeVariation: paint.settings.sizeVariation,
  splatOpacity: paint.settings.opacity,
  fadeEnabled: paint.settings.fadeEnabled,
  lifetime: paint.settings.lifetime,
  dripsEnabled: paint.settings.dripsEnabled,
  dripAmount: paint.settings.dripAmount,
  dripLength: paint.settings.dripLength,
  dripSpeed: paint.settings.dripSpeed,
  clearPaint: () => paint.clear(),
  // environment
  environmentContrast: 1.0,
  shadowIntensity: 0.45,
  // movement
  moveSpeed: player.baseSpeed,
  jumpV: player.jumpV,
  fov: camera.fov,
  // player glow
  glowEnabled: GLOW.enabled,
  glowScale: GLOW.scale,
  glowIntensity: GLOW.intensity,
  glowPower: GLOW.power,
  // bots
  bots5v5: true,
  // invisible mode
  invisibleMode: false,
  paintKillThreshold: 5,
};

function applyEnvironment() {
  if (nightMode) return; // Lights Out owns the lighting while it's active
  renderer.toneMappingExposure = guiState.environmentContrast;
  // High ambient/hemi baseline keeps unlit faces bright white so the map does
  // not read as gray. Shadow intensity trades fill for a stronger directional
  // light, which makes cast/attached shadows more pronounced.
  const fill = 1 - guiState.shadowIntensity;
  ambient.intensity = 0.55 + fill * 0.4;   // 0.55 (strong shadows) .. 0.95 (flat)
  hemi.intensity = 0.4 + fill * 0.35;
  sun.intensity = 1.1 + guiState.shadowIntensity * 1.3;
}

function applyInvisibleMode() {
  const invisible = guiState.invisibleMode;
  // Toggle arena visibility
  arena.group.visible = !invisible;
  // Toggle bot visibility
  bots.setInvisible(invisible);
}
applyEnvironment();

// ---------------------------------------------------------------------------
// Dev Panel (developer-only; absent from the itch build — see DEV flag)
// ---------------------------------------------------------------------------
if (DEV) {
const gui = new GUI({ title: 'Dev Panel' });

const fOutline = gui.addFolder('Outline / Readability');
fOutline.add(guiState, 'outlineStrength', 0, 1.5, 0.01).name('Strength')
  .onChange(v => outline.uniforms.strength.value = v);
fOutline.add(guiState, 'outlineThickness', 0.4, 4, 0.05).name('Thickness')
  .onChange(v => outline.uniforms.thickness.value = v);
fOutline.addColor(guiState, 'outlineGray').name('Outline Color')
  .onChange(v => outline.uniforms.outlineColor.value.set(v));
fOutline.add(guiState, 'depthEdges', 0, 2, 0.01).name('Depth Edges')
  .onChange(v => outline.uniforms.depthBias.value = v);
fOutline.add(guiState, 'normalEdges', 0, 2, 0.01).name('Normal Edges')
  .onChange(v => outline.uniforms.normalBias.value = v);
fOutline.open();

const fGlow = gui.addFolder('Player Glow');
fGlow.add(guiState, 'glowEnabled').name('Enabled')
  .onChange(v => setGlow({ enabled: v }));
fGlow.add(guiState, 'glowScale', 1.0, 1.4, 0.005).name('Size')
  .onChange(v => setGlow({ scale: v }));
fGlow.add(guiState, 'glowIntensity', 0, 1.5, 0.01).name('Intensity')
  .onChange(v => setGlow({ intensity: v }));
fGlow.add(guiState, 'glowPower', 0.5, 6, 0.05).name('Softness')
  .onChange(v => setGlow({ power: v }));
fGlow.open();

const fPaint = gui.addFolder('Paint');
colorCtrl = fPaint.add(guiState, 'paintColor', COLORS.map(c => c.name)).name('Color')
  .onChange(v => setColor(COLORS.findIndex(c => c.name === v)));
fPaint.add(guiState, 'splatSize', 0.4, 4, 0.05).name('Splat Size')
  .onChange(v => paint.settings.size = v);
fPaint.add(guiState, 'splatSizeVariation', 0, 1, 0.01).name('Size Variation')
  .onChange(v => paint.settings.sizeVariation = v);
fPaint.add(guiState, 'splatOpacity', 0.1, 1, 0.01).name('Opacity')
  .onChange(v => paint.settings.opacity = v);
fPaint.add(guiState, 'fadeEnabled').name('Fade Over Time')
  .onChange(v => paint.settings.fadeEnabled = v);
fPaint.add(guiState, 'lifetime', 3, 60, 1).name('Fade Lifetime (s)')
  .onChange(v => paint.settings.lifetime = v);
fPaint.add(guiState, 'dripsEnabled').name('Paint Drips')
  .onChange(v => paint.settings.dripsEnabled = v);
fPaint.add(guiState, 'dripAmount', 0, 1, 0.01).name('Drip Amount')
  .onChange(v => paint.settings.dripAmount = v);
fPaint.add(guiState, 'dripLength', 0.5, 4, 0.05).name('Drip Length')
  .onChange(v => paint.settings.dripLength = v);
fPaint.add(guiState, 'dripSpeed', 0.2, 5, 0.05).name('Drip Speed')
  .onChange(v => paint.settings.dripSpeed = v);
fPaint.add(guiState, 'clearPaint').name('Clear All Paint');
fPaint.open();

const fEnv = gui.addFolder('Environment');
fEnv.add(guiState, 'environmentContrast', 0.5, 1.6, 0.01).name('Contrast')
  .onChange(applyEnvironment);
fEnv.add(guiState, 'shadowIntensity', 0, 1, 0.01).name('Shadow Intensity')
  .onChange(applyEnvironment);
fEnv.open();

const fPlayer = gui.addFolder('Player / Controls');
fPlayer.add(guiState, 'moveSpeed', 3, 20, 0.5).name('Move Speed')
  .onChange(v => player.baseSpeed = v);
fPlayer.add(guiState, 'jumpV', 3, 25, 0.5).name('Jump Power')
  .onChange(v => player.jumpV = v);
fPlayer.add(player, 'sprintSpeed', 6, 28, 0.5).name('Sprint Speed');
// the slide sound loops, so it covers whatever duration is set here
fPlayer.add(player, 'slideTime', 0.2, 3, 0.05).name('Slide Duration (s)');
fPlayer.add(player, 'slideBoost', 1, 3, 0.05).name('Slide Speed');
fPlayer.add(player, 'crouchDepth', -1.2, 0, 0.02).name('Crouch Depth');
fPlayer.add(player, 'crouchSpeed', 1, 12, 0.5).name('Crouch Speed');
fPlayer.add(player, 'proneDepth', -1.6, -0.4, 0.02).name('Prone Depth');
fPlayer.add(player, 'proneSpeed', 0, 6, 0.2).name('Prone Speed');
fPlayer.add(player, 'diveHold', 0.08, 0.6, 0.01).name('Dive Hold (s)');
fPlayer.add(player, 'stanceHold', 0.1, 0.6, 0.01).name('Stance Hold (s)');
fPlayer.add(player, 'diveBoost', 0.8, 3, 0.05).name('Dive Speed');
fPlayer.add(player, 'diveUp', 0, 9, 0.2).name('Dive Launch');
fPlayer.add(player, 'padLookSpeed', 0.8, 6, 0.1).name('Gamepad Look Speed');
fPlayer.add(guiState, 'fov', 60, 110, 1).name('Field of View')
  .onChange(v => { camera.fov = v; camera.updateProjectionMatrix(); });

const fWeapon = gui.addFolder('Weapon / Aim');
fWeapon.add(weapon, 'hipX', -0.6, 0.6, 0.005).name('Hip X');
fWeapon.add(weapon, 'hipY', -0.6, 0.3, 0.005).name('Hip Y');
fWeapon.add(weapon, 'hipZ', -1.0, -0.1, 0.005).name('Hip Z');
fWeapon.add(weapon, 'aimX', -0.3, 0.3, 0.005).name('Aim X');
fWeapon.add(weapon, 'aimY', -0.3, 0.2, 0.002).name('Aim Y');
fWeapon.add(weapon, 'aimZ', -0.8, -0.1, 0.005).name('Aim Z');
fWeapon.add(weapon, 'cant', -1.4, 1.4, 0.02).name('Cant (hopper tilt)');
fWeapon.add(weapon, 'aimFov', 20, 75, 1).name('Zoom FOV');
fWeapon.add(weapon, 'aimSpeed', 3, 30, 0.5).name('Aim Speed');
fWeapon.add(weapon, 'recoilAmount', 0, 4, 0.1).name('Recoil');
fWeapon.open();

const fSprint = gui.addFolder('Weapon / Sprint');
fSprint.add(weapon, 'sprintX', -0.6, 0.6, 0.005).name('Pos X');
fSprint.add(weapon, 'sprintY', -0.6, 0.3, 0.005).name('Pos Y');
fSprint.add(weapon, 'sprintZ', -1.0, -0.1, 0.005).name('Pos Z');
fSprint.add(weapon, 'sprintPitch', -1.2, 1.2, 0.02).name('Tilt X (pitch)');
fSprint.add(weapon, 'sprintYaw', -1.2, 1.2, 0.02).name('Tilt Y (yaw)');
fSprint.add(weapon, 'sprintRoll', -1.4, 1.4, 0.02).name('Tilt Z (roll/45°)');
fSprint.add(weapon, 'sprintSpeed', 3, 30, 0.5).name('Blend Speed');
fSprint.add(weapon, 'swaySpeed', 2, 20, 0.5).name('Sway Speed');
fSprint.add(weapon, 'swayX', 0, 0.1, 0.002).name('Sway Side');
fSprint.add(weapon, 'swayY', 0, 0.1, 0.002).name('Sway Bob');
fSprint.add(weapon, 'swayRoll', 0, 0.3, 0.005).name('Sway Roll');
fSprint.open();

const fSlide = gui.addFolder('Weapon / Slide');
fSlide.add(weapon, 'slidePitch', -1.4, 1.4, 0.02).name('Tilt Up (pitch)');
fSlide.add(weapon, 'slideRoll', -1.4, 1.4, 0.02).name('Tilt (roll)');
fSlide.add(weapon, 'slideX', -0.6, 0.6, 0.005).name('Pos X');
fSlide.add(weapon, 'slideY', -0.6, 0.6, 0.005).name('Pos Y (raise)');
fSlide.add(weapon, 'slideZ', -1.0, 0.6, 0.005).name('Pos Z');
fSlide.add(weapon, 'slideBlend', 3, 30, 0.5).name('Blend Speed');
fSlide.open();

const fBuster = gui.addFolder('Tank Buster');
fBuster.add(tankBuster, 'hipX', -0.6, 0.6, 0.005).name('Hip X');
fBuster.add(tankBuster, 'hipY', -0.6, 0.3, 0.005).name('Hip Y');
fBuster.add(tankBuster, 'hipZ', -1.0, -0.1, 0.005).name('Hip Z');
fBuster.add(tankBuster, 'aimX', -0.4, 0.4, 0.005).name('Aim X');
fBuster.add(tankBuster, 'aimY', -0.4, 0.2, 0.005).name('Aim Y');
fBuster.add(tankBuster, 'aimZ', -0.8, -0.1, 0.005).name('Aim Z');
fBuster.add(tankBuster, 'aimFov', 20, 75, 1).name('Zoom FOV');
fBuster.add(tankBuster, 'viewScale', 0.5, 1.4, 0.01).name('Scale');
fBuster.open();

const fBots = gui.addFolder('Bots (5v5)');
fBots.add(guiState, 'bots5v5').name('Enable 5v5')
  .onChange(v => { bots.setEnabled(v); scoreboard.classList.toggle('hidden', !v); });
fBots.add({ respawn: () => bots.respawnAll() }, 'respawn').name('Respawn Teams');
fBots.open();

const fInvisible = gui.addFolder('Invisible Mode');
fInvisible.add(guiState, 'invisibleMode').name('Enable Invisible Mode')
  .onChange(applyInvisibleMode);
fInvisible.add(guiState, 'paintKillThreshold', 1, 20, 1).name('Paint Hits to Kill');
fInvisible.open();

const fTank = gui.addFolder('Tank');
const tk0 = tanks[0]; // tuner master; values mirror onto both tanks each frame
fTank.add({ toggle: () => { if (active && !playerDead) { tankMode ? exitTank() : enterTank(); } } }, 'toggle').name('Enter / Exit (dev)');
fTank.add(tk0, 'maxHp', 5, 80, 1).name('Armor (HP)');
fTank.add(tk0, 'driveSpeed', 4, 40, 1).name('Drive Speed');
fTank.add(tk0, 'reverseSpeed', 2, 20, 1).name('Reverse Speed');
fTank.add(tk0, 'turnSpeed', 0.4, 3.5, 0.05).name('Turn Speed');
fTank.add(tk0, 'turretTraverse', 0.4, 5, 0.1).name('Turret Speed');
fTank.add(tk0, 'barrelTraverse', 0.4, 4, 0.1).name('Barrel Speed');
fTank.add(tk0, 'barrelMin', -0.5, 0, 0.01).name('Barrel Down Limit');
fTank.add(tk0, 'barrelMax', 0, 0.9, 0.01).name('Barrel Up Limit');
fTank.add(tk0, 'projSpeed', 20, 160, 1).name('Shell Speed');
fTank.add(tk0, 'projGravity', -20, 0, 0.5).name('Shell Gravity (drop)');
fTank.add(tk0, 'projRadius', 0.15, 1.2, 0.01).name('Shell Size');
fTank.add(tk0, 'splatScale', 1, 12, 0.5).name('Splat Size');
fTank.add(tk0, 'fireInterval', 150, 2500, 50).name('Fire Interval (ms)');
fTank.add(tk0, 'recoilAmount', 0, 1, 0.02).name('Recoil Jolt');
fTank.add(tk0, 'turretVolume', 0, 1, 0.05).name('Turret/Barrel Sound');
fTank.add(tk0, 'boostMult', 1, 3, 0.05).name('Boost Speed x');
fTank.add(tk0, 'boostDuration', 0.5, 6, 0.1).name('Boost Duration (s)');
fTank.add(tk0, 'boostCooldown', 1, 15, 0.5).name('Boost Cooldown (s)');
const fTankCam = fTank.addFolder('Camera');
fTankCam.add(tk0, 'zoomFov', 25, 100, 1).name('Zoom FOV');
fTankCam.add(tk0, 'cam3rdDist', 4, 20, 0.5).name('3rd Person Dist');
fTankCam.add(tk0, 'cam3rdHeight', 1, 12, 0.5).name('3rd Person Height');
fTankCam.add(tk0, 'camZoomDist', 0, 10, 0.2).name('Zoom Dist');
fTankCam.add(tk0, 'camZoomHeight', 0.5, 8, 0.2).name('Zoom Height');
fTankCam.add(tk0, 'camZoomSide', -3, 3, 0.1).name('Zoom Side Offset');
const fTankFX = fTank.addFolder('FX (Smoke / Explosion)');
fTankFX.add(tk0, 'dmgSmokeMul', 0.2, 4, 0.1).name('Damage Smoke x');
fTankFX.add(tankFX, 'debrisCount', 4, 48, 1).name('Explosion Debris');
fTankFX.add(tankFX, 'smokeCount', 4, 48, 1).name('Explosion Smoke');
fTankFX.add(fxTune, 'paintCount', 8, 140, 1).name('Explosion Paint');
fTankFX.add(fxTune, 'playerPaintCount', 4, 60, 1).name('Player Death Paint');
const fRamp = fTank.addFolder('Ramp Jump');
fRamp.add(tk0, 'launchBoost', 0.5, 5, 0.1).name('Launch Boost');
fRamp.add(tk0, 'maxLaunch', 6, 40, 1).name('Max Launch (m/s)');
fRamp.add(tk0, 'gravity', -40, -12, 1).name('Gravity');
fRamp.open();
fTank.open();

// --- Jet (fighter) ---
const fJet = gui.addFolder('Jet');
fJet.add({ toggle: () => { if (active && !playerDead) { if (jetMode) exitJet(false); else if (!tankMode) enterJet(); } } }, 'toggle').name('Launch / Eject (dev)');
const fJetCam = fJet.addFolder('3rd-Person Camera');
fJetCam.add(jet, 'camX', -12, 12, 0.2).name('Camera X (side)');
fJetCam.add(jet, 'camY', -2, 14, 0.2).name('Camera Y (up)');
fJetCam.add(jet, 'camZ', 4, 32, 0.5).name('Camera Z (behind)');
fJetCam.add(jet, 'camEase', 1, 20, 0.5).name('Follow Ease');
fJetCam.open();
const fJetFly = fJet.addFolder('Flight');
fJetFly.add(jet, 'minSpeed', 8, 40, 1).name('Min Speed');
fJetFly.add(jet, 'cruiseSpeed', 15, 60, 1).name('Cruise Speed');
fJetFly.add(jet, 'maxSpeed', 30, 120, 1).name('Max Speed');
fJetFly.add(jet, 'turnRate', 0.6, 5, 0.1).name('Turn Rate');
fJetFly.add(jet, 'bankGain', 0.5, 6, 0.1).name('Bank Into Turn');
fJetFly.add(jet, 'maxBank', 0.2, 1.6, 0.05).name('Max Bank');
const fJetGun = fJet.addFolder('Weapons');
fJetGun.add(jet, 'mgSpeed', 60, 220, 5).name('MG Round Speed');
fJetGun.add(jet, 'fireInterval', 30, 300, 5).name('MG Interval (ms)');
fJetGun.add(jet, 'bombInterval', 300, 3000, 50).name('Bomb Interval (ms)');
fJet.open();

// keep dev panel from stealing pointer-lock clicks
gui.domElement.addEventListener('mousedown', e => e.stopPropagation());

// starts hidden; summon with the backtick key (dev only)
gui.hide();
let devPanelVisible = false;
document.addEventListener('keydown', (e) => {
  if (e.code === 'Backquote') {
    devPanelVisible = !devPanelVisible;
    devPanelOpen = devPanelVisible; // Esc won't bounce to the menu while tuning
    if (devPanelVisible) { gui.show(); if (controls.isLocked) controls.unlock(); }
    else gui.hide();
  }
});

// Dev-only screen/audio recorder. Dynamically imported so it is NEVER fetched
// in the shipped build (the file is also excluded from the release zip). Adds a
// Recorder folder to the dev panel + F9 (video) / F10 (audio) hotkeys.
import('./devRecorder.js').then(({ DevRecorder }) => {
  const rec = new DevRecorder(renderer.domElement, audio);
  const mkBtn = (text) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'display:block;width:100%;margin:6px 0;padding:10px;border-radius:8px;' +
      'border:none;cursor:pointer;font:700 13px system-ui,sans-serif;background:#1c1f24;color:#fff';
    return b;
  };
  const vBtn = mkBtn('Record Video + Audio');
  const aBtn = mkBtn('Record Audio Only');
  const toggleVideo = async () => {
    if (rec.recordingVideo) { rec.stopVideo(); vBtn.textContent = 'Record Video + Audio'; vBtn.style.background = '#1c1f24'; }
    else if (await rec.startVideo()) { vBtn.textContent = 'Stop + Download Video'; vBtn.style.background = '#c0392b'; }
  };
  const toggleAudio = () => {
    if (rec.recordingAudio) { rec.stopAudio(); aBtn.textContent = 'Record Audio Only'; aBtn.style.background = '#1c1f24'; }
    else if (rec.startAudio()) { aBtn.textContent = 'Stop + Download Audio'; aBtn.style.background = '#c0392b'; }
  };
  vBtn.onclick = toggleVideo;
  aBtn.onclick = toggleAudio;

  // dev-only recorder section, appended into the Settings menu
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:14px;padding-top:12px;border-top:1px solid rgba(0,0,0,.12)';
  const label = document.createElement('div');
  label.textContent = 'DEV — RECORDER';
  label.style.cssText = 'font:700 11px/1 system-ui,sans-serif;letter-spacing:.16em;color:#8a9099;margin-bottom:8px';
  wrap.append(label, vBtn, aBtn);
  document.getElementById('settings-body').appendChild(wrap);

  document.addEventListener('keydown', (e) => {
    if (e.code === 'F9') { e.preventDefault(); toggleVideo(); }
    else if (e.code === 'F10') { e.preventDefault(); toggleAudio(); }
  });
}).catch((err) => console.warn('dev recorder unavailable:', err));
} // end DEV

setColor(1); // start on BLUE (the player's team color)
// bots stay OFF until a match actually starts — no phantom battle raging
// behind the title screen and menus

// ---------------------------------------------------------------------------
// Player-facing Settings (persisted). The dev tuning panel above is gated on
// DEV, so players use only this Settings menu.
// ---------------------------------------------------------------------------
const settings = new Settings();
settings.buildUI(document.getElementById('settings-body'));
settings.apply({ controls, player, camera, match, audio, weapon });

// Custom splatter designer — kept for a future update; its menu button is
// hidden, but any saved design still loads into the paint system.
const splatDesigner = new SplatDesigner(paint, COLORS);
document.getElementById('open-splat-btn').addEventListener('click', () => splatDesigner.show());

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  outline.setSize(w, h);
  const [sw, sh] = _scopeDim();
  scopeRT.setSize(sw, sh); // keep the scope feed matched to the screen aspect
});

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
// Steam achievements — evaluated cheaply each frame so every kill path (incl.
// bot kills resolved inside bots.js) is covered. Each unlock is one-shot + a
// no-op in the browser/itch build. Create these API names on the Steamworks
// partner site (Stats & Achievements) for them to actually fire.
const _ach = { firstBlood: false, sharpShooter: false, lightsOut: false };
function checkSteamAchievements() {
  if (!_ach.firstBlood && playerStats.kills >= 1) { _ach.firstBlood = true; unlockAchievement('FIRST_BLOOD'); }
  if (!_ach.sharpShooter && playerStats.kills >= 10) { _ach.sharpShooter = true; unlockAchievement('SHARP_SHOOTER'); }
  if (!_ach.lightsOut && nightMode && active && !playerDead) { _ach.lightsOut = true; unlockAchievement('LIGHTS_OUT'); }
}

// Log a per-frame subsystem error ONCE (per unique message) so a stale/odd
// module can't spam the console — used by the safety wrappers below.
const _frameWarned = new Set();
function _frameWarn(where, e) {
  const key = where + ':' + (e && e.message);
  if (_frameWarned.has(key)) return;
  _frameWarned.add(key);
  console.warn('[frame] non-fatal error in', where, '—', e);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  input.poll();

  // Ambient / vehicle-FX / gamepad systems. Wrapped so a failure in ANY of them
  // (e.g. a mismatched module after a bad cache load) can never skip the
  // movement block below and freeze the player — the exact class of "can't move"
  // bug. Movement stays independent of all of this.
  try {
    daySky.update(dt, camera);   // sun/clouds follow the camera (day only)
    nightSky.update(dt, camera); // moon/stars follow the camera + twinkle (night only)
    checkSteamAchievements();     // Steam unlocks (no-op in the browser build)

    // Tank enter/exit prompt + proximity interact (E / gamepad Y)
    updateTankPrompt();

    // keep both team tanks on one set of tuned values
    for (const k of TANK_TUNE_KEYS) tanks[1][k] = tanks[0][k];

    // tank death FX: catch the moment a tank is destroyed (host, free play, or a
    // client learning it over the network) and blow it up violently
    for (const tk of tanks) {
      if (tk._wasAlive === undefined) tk._wasAlive = tk.alive;
      if (tk._wasAlive && !tk.alive) explodeTank(tk);
      tk._wasAlive = tk.alive;
    }
    tankFX.update(dt);
    jet.updateDebris(dt); // tumbling wreckage after a jet breaks up (no-op when idle)

    // seamless critical-armor alarm on the tank you're driving
    const critTank = currentTank;
    const critical = !!(critTank && critTank.alive && critTank.hp / critTank.maxHp <= 0.15);
    if (critical && !tankAlarmLoop) tankAlarmLoop = audio.playLoop('tankAlarm', { volume: 0.5 });
    else if (!critical && tankAlarmLoop) { audio.stopLoop(tankAlarmLoop); tankAlarmLoop = null; }

    // Gamepad Start button: begins a session without pointer lock, and pauses
    // (back to the menu/lobby) when already playing.
    if (input.consumeStart()) {
      if (active) {
        // pause — mirrors what Esc does for mouse+keyboard
        padSession = false;
        if (netplay.active) showLobby();
        else if (!match.over) showStart();
      } else {
        if (!netplay.active && !sessionLive) {
          bots.setEnabled(guiState.bots5v5);
          resetMatch();
        } else if (match.over) {
          resetMatch();
        }
        padSession = true;
        enterGame();
      }
    }
  } catch (e) { _frameWarn('per-frame systems', e); }

  if (active && !playerDead) {
    updateCountdown(dt);
    const ready = countdownMs <= 0; // frozen during the "get ready" countdown
    // (jet enter/exit is handled by the KeyG listener defined above, not here)
    if (jetMode) {
      updateJet(dt, ready);
    } else if (tankMode) {
      updateTank(dt, ready);
      updateSun();
    } else {
    // online: also collide with remote humans + ghost bots so nobody overlaps
    player.extraSolids = netplay.active ? netplay.collisionActors() : [];
    const crouchPress = ready && input.consumeCrouch();
    // Pulling the trigger on the marker CANCELS sprint (like other shooters): the
    // gun comes up to fire instead of swaying, and you drop to normal move speed.
    const firing = ready && input.shootHeld && currentWeapon === 0;
    player.update(
      dt,
      ready
        ? {
            forward: input.move.forward, strafe: input.move.strafe, sprint: input.sprint && !firing,
            crouchPress, crouchHeld: input.crouchHeld,
          }
        : { forward: 0, strafe: 0, sprint: false, crouchPress: false, crouchHeld: false },
      input.look); // looking around is always allowed
    pushOutOfTank(); // can't walk through the tank hull
    if (ready) {
      if (input.consumeJump() && player.jump()) audio.play('jump', { volume: 0.7 });
    } else {
      input.consumeJump();
    }
    const cd = input.consumeColorDelta();
    if (cd) setColor((colorIndex + cd + COLORS.length) % COLORS.length);
    const wsw = input.consumeWeapon();
    if (wsw !== null) switchWeapon(wsw === -1 ? (currentWeapon ^ 1) : wsw);
    if (ready && currentWeapon === 0) updateShooting(); // marker; buster fires in updateBuster
    else if (gunLoop || shootWasHeld) stopFiring();
    updateSlideSound();
    // tuck the gun back when facing a nearby wall so the barrel doesn't clip
    // through it — test blocker boxes only (skips the floor/ramps you look at)
    camera.getWorldDirection(_wpnDir);
    _wpnRay.set(camera.position, _wpnDir);
    let wDist = Infinity;
    for (const box of arena.blockers) {
      if (_wpnRay.ray.intersectBox(box, _wpnHit)) {
        const d = _wpnHit.distanceTo(camera.position);
        if (d < wDist) wDist = d;
      }
    }
    const wTarget = wDist >= 1.3 ? 0 : (wDist <= 0.7 ? 1 : (1.3 - wDist) / 0.6);
    weapon.wallPull += (wTarget - weapon.wallPull) * Math.min(1, dt * 14);
    tankBuster.wallPull += (wTarget - tankBuster.wallPull) * Math.min(1, dt * 14);
    // sprint pose: holding sprint, moving, grounded, not aiming or sliding.
    // slide pose: while the player is sliding (it takes over from sprint).
    const moving = Math.hypot(input.move.forward, input.move.strafe) > 0.1;
    const sprinting = ready && input.sprint && moving && !input.aimHeld && !firing &&
      player.onGround && !player.sliding && !player.diving;
    if (currentWeapon === 0) weapon.update(dt, ready && input.aimHeld, settings.get('fov'), sprinting, player.sliding);
    else tankBuster.update(dt, ready && input.aimHeld, settings.get('fov'), sprinting, player.sliding);
    updateBuster(dt, ready); // lock-on + buster fire (no-op unless the buster is equipped)
    applyAimZoom();
    updateSun();
    }
  } else if (active && playerDead) {
    // frozen while the respawn timer counts down (mouse look still works).
    // The timer advances by dt so it only ticks during actual play — pausing
    // to a menu preserves it, so you always serve a full countdown.
    input.consumeJump();
    input.consumeCrouch();
    input.consumeColorDelta();
    if (gunLoop || shootWasHeld) stopFiring();
    stopSlideSound();
    weapon.update(dt, false, settings.get('fov')); // ease the marker out of ADS
    applyAimZoom();                                 // and un-zoom the view
    playerRespawnMs -= dt * 1000;
    const rn = Math.max(1, Math.ceil(playerRespawnMs / 1000));
    respawnCountEl.textContent = rn;
    if (rn !== _respawnShown) { _respawnShown = rn; audio.play('countdownBeep', { volume: 0.55 }); }
    if (playerRespawnMs <= 0) respawnPlayer();
  } else {
    input.consumeJump();
    input.consumeCrouch();
    input.consumeColorDelta();
    if (gunLoop || shootWasHeld) stopFiring(); // paused / match over
    stopSlideSound();
  }
  // silence the tank loops whenever we're not actively driving (pause/death/on-foot)
  if (!(active && !playerDead && tankMode)) stopTankSound();

  audio.updateListener(camera); // keep 3D audio anchored to the view

  netplay.update(dt); // sync remote players (no-op when offline)

  // the world only simulates during play — menus, match-end, and the
  // match-start countdown all freeze it (bots hold at their spawns)
  const frozen = match.over || netplay.matchOver || countdownMs > 0;
  const simRunning = active || netplay.active;
  if (!frozen && simRunning) {
    // host: bots also hunt the remote human players (local player's team below)
    bots.extraTargets = netplay.isHost ? netplay.getBotTargets() : [];
    bots.tankSolids = tanks.filter((t) => t.alive).map((t) => ({ x: t.pos.x, z: t.pos.z, r: 2.4 }));
    bots.update(dt, {
      playerPos: (tankMode && currentTank) ? currentTank.pos : camera.position,
      playerTeam: netplay.active && netplay.me ? netplay.me.team : PLAYER_TEAM,
      playerAlive: active && !playerDead && !tankMode && !jetMode, // untargetable in a vehicle
      now: performance.now(),
    });
    simulateTanks(dt);
    tankRunOver();
  }

  if (simRunning) updateProjectiles(dt);
  if (simRunning) updateMoonBarrage(dt); // angry moon rains paint while its mouth is open
  // MP: once the egg finishes (moon back to idle), let the host re-arm the tally
  if (nightSky.active) _moonWasActive = true;
  else if (_moonWasActive) { _moonWasActive = false; if (netplay.active) netplay.rearmMoon(); }
  paint.update(dt);

  if (netplay.active) {
    // online skirmish: live team tag totals (endless — no match end in v1)
    scoreBlueEl.textContent = netplay.scores[0];
    scoreRedEl.textContent = netplay.scores[1];
  } else if (bots.enabled) {
    scoreBlueEl.textContent = bots.scores[0];
    scoreRedEl.textContent = bots.scores[1];
    // free-play match clock: 0:00 during the countdown, counts up in play, then
    // freezes at match end
    if (countdownMs > 0) { matchStartMs = performance.now(); sbTimerEl.textContent = '0:00'; }
    else if (!match.over) sbTimerEl.textContent = fmtClock((performance.now() - matchStartMs) / 1000);
    if (!match.over) {
      if (bots.scores[0] >= match.target) endMatch(0);
      else if (bots.scores[1] >= match.target) endMatch(1);
    }
  }

  if (currentWeapon === 1 && tankBuster.root.visible) renderScope(); // live scope feed
  outline.render();
  drawScopeOverlay(); // full-screen scope view while zoomed
}
animate();

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import GUI from 'lil-gui';

import { buildArena } from './arena.js';
import { createOutline, NO_OUTLINE_LAYER } from './outline.js';
import { PlayerController } from './player.js';
import { InputManager } from './input.js';
import { BotSystem, FIRE_NAMES, WHITE_NAMES } from './bots.js';
import { Settings } from './settings.js';
import { Weapon } from './weapon.js';
import { AudioManager } from './audio.js';
import { NetClient, signalUrl } from './net.js';
import { NetPlay } from './netplay.js';
import { GLOW, setGlow } from './playerGlow.js';
import { preloadAvatars } from './avatarRig.js';
import { createFloorReflection } from './floorReflection.js';
import { initLiquidGlass } from './liquidGlass.js';
import { teamSpawnXZ, scatterSpawnXZ, SPAWN_EYE_Y, setArenaSize } from './spawns.js';
import { createNightSky } from './nightSky.js';
import { createDaySky } from './sky.js';
import { unlockAchievement } from './steamClient.js';
import { FlashLights } from './fx.js';
import { buildCombatSfx } from './sfx.js';

// Team palette: FIRE (orange) and WHITE. The only accent colours in the game.
const TEAM_HEX = [0xff6000, 0xf4f6f8]; // FIRE, WHITE

// Dev-only: the lil-gui tuning panel exists only during local development
// (localhost) or with ?dev in the URL. The itch build is served from itch's
// domain, so players never get it — but all the panel code below stays intact.
const DEV = (['localhost', '127.0.0.1'].includes(location.hostname)
  || new URLSearchParams(location.search).has('dev'))
  && !new URLSearchParams(location.search).has('prod'); // ?prod forces the itch (DEV=false) path for testing

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
scene.background = new THREE.Color(0xe8ebef);
scene.fog = new THREE.Fog(0xe8ebef, 55, 150);

const camera = new THREE.PerspectiveCamera(
  75, window.innerWidth / window.innerHeight, 0.1, 300);
camera.position.set(0, 1.7, 26);

// ---------------------------------------------------------------------------
// Lights
// ---------------------------------------------------------------------------
// Studio-style image-based light: soft fill + glossy reflections on the white
// tiles and armour. Lights Out drops it for the dark neon look.
const pmrem = new THREE.PMREMGenerator(renderer);
const envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
scene.environment = envTex;

const hemi = new THREE.HemisphereLight(0xfff3e6, 0x9a958e, 0.62);
scene.add(hemi);

const ambient = new THREE.AmbientLight(0xffffff, 0.64);
scene.add(ambient);

// kept fairly low so shadowed faces stay near-white; the outline defines shape
const sun = new THREE.DirectionalLight(0xfff0dc, 1.5);
sun.position.set(30, 48, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 90;
sun.shadow.camera.left = -42;
sun.shadow.camera.right = 42;
sun.shadow.camera.top = 42;
sun.shadow.camera.bottom = -42;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(sun.target);

// pooled muzzle / impact / blast lights (fixed count → no shader recompiles)
const flashes = new FlashLights(scene, 4);

// ---------------------------------------------------------------------------
// Arena + systems
// ---------------------------------------------------------------------------
// Map selection. Persisted; ?map= still works as a quick override.
const MAPS = [
  { id: 1, name: 'Octagon Cage' },
];
const _urlMap = parseInt(new URLSearchParams(location.search).get('map'), 10);
let _savedMap = 1;
try { _savedMap = parseInt(localStorage.getItem('ffa.map'), 10) || 1; } catch {}
let arena = buildArena(scene, Math.max(1, Math.min(MAPS.length, _urlMap || _savedMap)));

// Reflections of the actual arena: render the lit room once into a PMREM env
// map from a standing spot between the pillar and the wall (fromScene captures
// at the origin, so shift the arena for the capture). The glossy floor and the
// armour then reflect the real LED coves/pillar instead of a generic studio.
let arenaEnv = null;
function captureArenaReflections() {
  if (arenaEnv) arenaEnv.dispose();
  const prevEnv = scene.environment;
  scene.environment = envTex; // light the capture with the studio env
  arena.group.position.set(0, -2.2, -14);
  arena.group.updateMatrixWorld(true);
  arenaEnv = pmrem.fromScene(scene, 0.02, 0.1, 120).texture; // scene = arena + lights (+ sky) at this point
  arena.group.position.set(0, 0, 0);
  arena.group.updateMatrixWorld(true);
  scene.environment = prevEnv === envTex ? arenaEnv : prevEnv;
}
captureArenaReflections();

// Polished floor: planar reflection of the room over the tiles (see floorReflection.js).
let floorRefl = null;
function setupFloorReflection() {
  if (floorRefl) { scene.remove(floorRefl.mesh); floorRefl.dispose(); }
  floorRefl = createFloorReflection(renderer, camera, {
    radius: arena.size / Math.cos(Math.PI / 8), layer: NO_OUTLINE_LAYER, strength: 1.0, base: 0.38,
  });
  scene.add(floorRefl.mesh);
}
setupFloorReflection();
setArenaSize(arena.size); // spawns scale to this map's half-extent

const hitmarkerEl = document.getElementById('hitmarker');
// Flash the crosshair hitmarker on every enemy hit; `big` pops larger on a kill.
function showHitmarker(big = false) {
  hitmarkerEl.classList.remove('hit', 'big');
  void hitmarkerEl.offsetWidth; // force reflow so the animation restarts each hit
  hitmarkerEl.classList.toggle('big', big);
  hitmarkerEl.classList.add('hit');
}
let devPanelOpen = false; // dev panel visible → Esc frees the cursor to tune, no menu
const outline = createOutline(renderer, scene, camera);

// ---- "Lights Out" night mode -------------------------------------------------
const nightSky = createNightSky(scene);
const daySky = createDaySky(scene, sun.position); // neutral sky + sun + clouds (day only)
const fireLight = new THREE.PointLight(0xff6000, 0, 38, 1.8);
fireLight.position.set(-12, 8, -12);
scene.add(fireLight);
const redLight = new THREE.PointLight(0xff4848, 0, 38, 1.8);
redLight.position.set(12, 8, 12);
scene.add(redLight);
let nightMode = false;
const BLOOM_DAY = 0.5; // LEDs glow without hazing the room
function setArenaEmissive(on) {
  for (const m of arena.materials) {
    const e = on ? m.userData.night : m.userData.day;
    if (!e) continue;
    m.emissive.setHex(e.hex);
    m.emissiveIntensity = e.i;
    m.needsUpdate = true;
  }
  for (const m of arena.washMats || []) {
    const w = on ? m.userData.night : m.userData.day;
    m.color.setHex(w.hex);
    m.opacity = w.o;
  }
}
// Flip the whole scene between the warm day and a glowing night: dark sky +
// moon/stars, dim cool light, a white contour rim, and neon-lit surfaces.
function setNightMode(on) {
  nightMode = on;
  if (on) {
    scene.background.set(0x05060e);
    scene.environment = null;
    outline.bloom.strength = 0.75;
    flashes.scale = 1.8;
    scene.fog.color.set(0x05060e); scene.fog.near = 55; scene.fog.far = 230;
    renderer.toneMappingExposure = 0.9;
    hemi.intensity = 0.07; hemi.color.set(0xe8ebef); hemi.groundColor.set(0x101318);
    ambient.intensity = 0.04; ambient.color.set(0xd8dde4);
    sun.intensity = 0.18; sun.color.set(0xd8dde4);
    fireLight.intensity = 2.4; redLight.intensity = 2.1;
    outline.uniforms.outlineColor.value.set(0xffffff);
    outline.uniforms.strength.value = 1.0;
    setArenaEmissive(true);
    daySky.group.visible = false;
    nightSky.group.visible = true;
    weapon.setNeon(true);
    setGlow({ intensity: 1.2 });
    document.body.classList.add('lights-out');
  } else {
    scene.background.set(0xe8ebef);
    scene.environment = arenaEnv || envTex;
    outline.bloom.strength = BLOOM_DAY;
    flashes.scale = 1;
    scene.fog.color.set(0xe8ebef); scene.fog.near = 55; scene.fog.far = 150;
    hemi.color.set(0xfff3e6); hemi.groundColor.set(0x9a958e); // warm key, neutral bounce
    ambient.color.set(0xfff6ee); sun.color.set(0xfff0dc);
    applyEnvironment();
    fireLight.intensity = 0; redLight.intensity = 0;
    outline.uniforms.outlineColor.value.set(guiState.outlineGray);
    outline.uniforms.strength.value = guiState.outlineStrength;
    setArenaEmissive(false);
    daySky.group.visible = true;
    nightSky.group.visible = false;
    weapon.setNeon(false);
    setGlow({ intensity: guiState.glowIntensity });
    document.body.classList.remove('lights-out');
  }
}

// Sound: movement/UI clips are small files; all combat sounds (rifle, rockets,
// explosions, hits, reloads) are synthesized at boot — see sfx.js.
const audio = new AudioManager();
audio.load({
  jump:          './assets/sfx/jump.wav',
  slide:         './assets/sfx/slide.wav',          // seamless loop, any duration
  killConfirm:   './assets/sfx/kill-confirm.wav',   // chime on your kills
  countdownBeep: './assets/sfx/countdown-beep.wav', // tick per second in a countdown
  countdownGo:   './assets/sfx/countdown-go.wav',   // final "GO" / respawn tone
});
audio.addBuffers(buildCombatSfx);
// tuned defaults: faint gray contour that reads well on pure white
outline.uniforms.strength.value = 0.32;
outline.uniforms.thickness.value = 1.2;

// ---------------------------------------------------------------------------
// Controls / input (mouse+keyboard via pointer lock, plus Xbox gamepad)
// ---------------------------------------------------------------------------
const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.getObject());

const input = new InputManager(renderer.domElement);
const player = new PlayerController(camera);

// First-person rifle (battle rifle on top, twin rocket tubes below), parented to the camera.
const weapon = new Weapon();
camera.add(weapon.root);
let currentWeapon = 0; // 0 = battle rifle, 1 = twin rockets

// Viewmodels live on their own layer (drawn by the main camera, and kept out of
// the floor reflection).
const VIEWMODEL_LAYER = 2;
const _setLayerDeep = (obj, layer) => obj.traverse((o) => o.layers.set(layer));
_setLayerDeep(weapon.root, VIEWMODEL_LAYER);
camera.layers.enable(VIEWMODEL_LAYER); // the main camera still shows the viewmodels
// Sprites render as solid quads in the outline's normal prepass, so a muzzle
// flash (even at zero opacity) would be outlined as a floating rectangle.
// NO_OUTLINE_LAYER: drawn by the main camera, skipped by the edge pass.
weapon.flash.layers.set(NO_OUTLINE_LAYER);

// rifle ADS: fade the full-screen scope reticle in with the zoom
const rifleScopeEl = document.getElementById('rifle-scope');
function drawScopeOverlay() {
  const show = currentWeapon === 0 && weapon.root.visible;
  if (rifleScopeEl) rifleScopeEl.style.opacity = String(show ? weapon.aimT : 0);
}

// Free play: the player holds FIRE slot 0; bots fill the other lanes.
const _ps = teamSpawnXZ(0, 0);
const PLAYER_SPAWN = new THREE.Vector3(_ps.x, 1.7, _ps.z);
const _spawnV = new THREE.Vector3();
// Match start: your own side. Respawns: anywhere on the ring, biased away
// from live enemies (bots, and remote players while online).
function spawnAvoid() {
  const out = [];
  if (bots.bots) for (const b of bots.bots) if (b.alive) out.push(b.pos);
  if (netplay.active) for (const a of netplay.collisionActors()) if (a.alive) out.push(a);
  return out;
}
function playerSpawnPoint(scatter = false) {
  const p = scatter ? scatterSpawnXZ(spawnAvoid()) : teamSpawnXZ(myTeamId(), 0);
  return _spawnV.set(p.x, SPAWN_EYE_Y, p.z);
}
// Player health: stay clean for HP_DELAY ms and it refills at HP_RATE per second.
const HP_MAX = 100, HP_HIT = 34, HP_DELAY = 4500, HP_RATE = 45;
let playerHp = HP_MAX;
let lastHurtAt = -Infinity;

// Player name (chosen in the main menu, persisted, used in-game + online).
const PLAYER_NAME_KEY = 'ffa.playerName';
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
const gameConfig = { size: 4, rule: 'free' };

const overlay = document.getElementById('overlay');
const crosshair = document.getElementById('crosshair');
const hud = document.getElementById('hud');
const scoreboard = document.getElementById('scoreboard');
const scoreBlueEl = document.getElementById('score-blue');
const scoreRedEl = document.getElementById('score-red');
const sbTimerEl = document.getElementById('sb-timer'); // center scoreboard clock
let matchStartMs = 0; // wall-clock at match start, for the free-play elapsed timer
const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.max(0, Math.floor(sec % 60))).padStart(2, '0')}`;

// ---- Global multi-row kill feed (top-right): "shooter [mark][gun] victim" ----
const killfeedRowsEl = document.getElementById('killfeed-rows');
const KF_MAX = 5, KF_TTL_MS = 5200;
const _kfEsc = (s) => { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; };
function pushKill(shooterName, shooterTeam, victimName, victimTeam) {
  if (!killfeedRowsEl) return;
  const row = document.createElement('div');
  row.className = 'kf-row';
  const sc = shooterTeam === 0 ? 'kf-name-blue' : 'kf-name-red';
  const vc = victimTeam === 0 ? 'kf-name-blue' : 'kf-name-red';
  const mark = shooterTeam === 0 ? 'kf-fill-blue' : 'kf-fill-red';
  row.innerHTML =
    `<span class="${sc}">${_kfEsc(shooterName)}</span>` +
    `<svg class="kf-mark ${mark}"><use href="#kf-flame-ico"/></svg>` +
    `<svg class="kf-gun"><use href="#kf-gun-ico"/></svg>` +
    `<span class="${vc}">${_kfEsc(victimName)}</span>`;
  killfeedRowsEl.prepend(row); // newest on top
  while (killfeedRowsEl.children.length > KF_MAX) killfeedRowsEl.lastChild.remove();
  setTimeout(() => { row.classList.add('kf-out'); setTimeout(() => row.remove(), 320); }, KF_TTL_MS);
}
function clearKillFeed() { if (killfeedRowsEl) killfeedRowsEl.innerHTML = ''; }
const hitVignetteEl = document.getElementById('hit-vignette');
const hitDirEl = document.getElementById('hit-dir');
let hitVignetteTimer = null, hitDirTimer = null;

const hpFillEl = document.getElementById('hp-fill');
const hpNumEl = document.getElementById('hp-num');
function updateHpBar() {
  const pct = Math.max(0, playerHp) / HP_MAX;
  if (hpFillEl) {
    hpFillEl.style.width = (pct * 100) + '%';
    hpFillEl.classList.toggle('low', pct <= 0.34);
  }
  if (hpNumEl) hpNumEl.textContent = Math.ceil(Math.max(0, playerHp));
}

const respawnEl = document.getElementById('respawn');
const respawnCountEl = respawnEl.querySelector('.respawn-count');

const killfeedEl = document.getElementById('killfeed');
const killfeedNameEl = document.getElementById('kf-name');
let killfeedTimer = null;
const killedbyEl = document.getElementById('killedby');
const killedbyNameEl = document.getElementById('kb-name');
let killedbyTimer = null;

/** Flash "KILLED <name>" under the crosshair + a satisfying chime. */
function showKill(name, headshot = false) {
  killfeedNameEl.textContent = headshot ? `${name} · HEADSHOT` : name;
  killfeedEl.classList.remove('hidden');
  killfeedEl.classList.toggle('headshot', !!headshot);
  // restart the pop animation even on back-to-back kills
  killfeedEl.style.animation = 'none';
  void killfeedEl.offsetWidth;
  killfeedEl.style.animation = '';
  audio.play('killConfirm', { volume: 0.9, rate: headshot ? 1.25 : 1.0 });
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

// ---- Damage feedback -------------------------------------------------------
// Edge vignette in the attacker's team colour, a directional arc around the
// reticle pointing at whoever hit you, and a short render-only view punch.
const viewPunch = { p: 0, y: 0, r: 0, vp: 0, vy: 0, vr: 0 }; // damped spring (radians)
function kickView(pitch, yaw = 0, roll = 0) {
  viewPunch.vp += pitch; viewPunch.vy += yaw; viewPunch.vr += roll;
}
function updateViewPunch(dt) {
  const k = 160, c = 16, h = Math.min(dt, 0.05);
  for (const [x, v] of [['p', 'vp'], ['y', 'vy'], ['r', 'vr']]) {
    viewPunch[v] += (-k * viewPunch[x] - c * viewPunch[v]) * h;
    viewPunch[x] += viewPunch[v] * h;
  }
}
const _hitTo = new THREE.Vector3(), _hitFwd = new THREE.Vector3();
function damageFeedback(hex, fromPos, heavy = false) {
  const col = '#' + ((hex >>> 0) & 0xffffff).toString(16).padStart(6, '0');
  hitVignetteEl.style.setProperty('--hit-color', col);
  hitVignetteEl.classList.remove('show'); void hitVignetteEl.offsetWidth;
  hitVignetteEl.classList.add('show');
  clearTimeout(hitVignetteTimer);
  hitVignetteTimer = setTimeout(() => hitVignetteEl.classList.remove('show'), heavy ? 900 : 650);
  if (fromPos && hitDirEl) {
    // screen-space bearing of the attacker relative to where we're looking
    camera.getWorldDirection(_hitFwd); _hitFwd.y = 0; _hitFwd.normalize();
    _hitTo.set(fromPos.x - camera.position.x, 0, fromPos.z - camera.position.z).normalize();
    const ang = Math.atan2(_hitFwd.x * _hitTo.z - _hitFwd.z * _hitTo.x, _hitFwd.dot(_hitTo));
    hitDirEl.style.setProperty('--hit-angle', `${ang}rad`);
    hitDirEl.style.setProperty('--hit-color', col);
    hitDirEl.classList.remove('show'); void hitDirEl.offsetWidth;
    hitDirEl.classList.add('show');
    clearTimeout(hitDirTimer);
    hitDirTimer = setTimeout(() => hitDirEl.classList.remove('show'), 1100);
    kickView(heavy ? 0.9 : 0.45, Math.sign(ang) * 0.25 * (heavy ? 2 : 1), (Math.random() - 0.5) * 0.6);
  } else {
    kickView(heavy ? 0.9 : 0.45, 0, (Math.random() - 0.5) * 0.6);
  }
}

// ---------------------------------------------------------------------------
// Bots. Player fills one FIRE slot; bots use the shared hit pipeline.
// ---------------------------------------------------------------------------
// One enemy hit: flash the screen, drain HP, report whether it was lethal.
function hurtPlayer(hex, dmg = 50, isHeadshot = false, fromPos = null) {
  playerHp -= dmg;
  lastHurtAt = performance.now();
  updateHpBar();
  damageFeedback(hex, fromPos, isHeadshot || dmg >= 60);
  // a physical jolt away from the hit — small enough not to steal your aim
  if (fromPos) {
    const dx = camera.position.x - fromPos.x, dz = camera.position.z - fromPos.z;
    const d = Math.hypot(dx, dz) || 1, jolt = Math.min(2.4, dmg * 0.032);
    player.knockback.x += (dx / d) * jolt;
    player.knockback.z += (dz / d) * jolt;
  }
  audio.play(isHeadshot ? 'hitHead' : 'hitTaken', { volume: 0.9, rate: 0.95 + Math.random() * 0.1 });
  return playerHp <= 0;
}

function onPlayerTagged(shooterTeamId, hex = 0xf4f6f8, shooterName = '') {
  damageFeedback(hex, null, true);
  if (playerDead) return; // already down, waiting to respawn
  playerStats.deaths++;
  playerDead = true;
  playerRespawnMs = RESPAWN_MS; // counts down only while in-game (never in a menu)
  _respawnShown = -1;          // so the first tick beeps
  playerHp = 0; updateHpBar(); // bar sits empty through the respawn countdown
  stopFiring();
  cancelReload();
  setWeaponsVisible(false); // hide the first-person gun while you're down
  showKilledBy(shooterName);
  respawnEl.classList.remove('hidden');
  bodyDown(camera.position);
}

// A combatant going down: a dull thud and a little dust where they fell.
function bodyDown(pos) {
  audio.playAt('bodyFall', pos, { volume: 0.6, rate: 0.9 + Math.random() * 0.15 });
  spawnPuff(pos.x, 0.5, pos.z, { size: 0.5, opacity: 0.22 });
  spawnPuff(pos.x, 0.4, pos.z, { size: 0.4, opacity: 0.18 });
}

function respawnPlayer() {
  playerDead = false;
  camera.fov = settings.get('fov'); camera.updateProjectionMatrix(); // in case we died zoomed
  respawnEl.classList.add('hidden');
  setWeaponsVisible(true);
  refillAmmo();
  camera.position.copy(playerSpawnPoint(true)); // respawns scatter around the ring
  player.velocityY = 0; player.moveVel.set(0, 0, 0);
  player.resetStance();   // stand up — don't carry a crouch/slide into respawn
  playerHp = HP_MAX; updateHpBar();
  audio.play('countdownGo', { volume: 0.6 }); // back in — "go" tone
  bots._playerInvulnUntil = performance.now() + 1500; // brief spawn protection
}

const bots = new BotSystem(scene, arena, {
  spawnProjectile,
  onPlayerTagged,
  onPlayerHit: (teamId, hex, shooter, dmg, isHeadshot) => hurtPlayer(hex, dmg, isHeadshot, shooter && shooter.pos),
  onFire: (pos, hex, dir, teamId) => {
    audio.playAt('rifleShot', pos, {
      volume: 0.55, rate: 0.92 + Math.random() * 0.12, refDistance: 5, maxDistance: 80,
    });
    // host: replicate bot shots so clients see the tracers
    if (dir && netplay.isHost && netplay.active) netplay.sendShot(pos, dir, hex, teamId);
  },
  onTag: ({ shooter, victimName, victimIsPlayer, pos, wounded, headshot }) => {
    // armour hit on someone else (your own hits have their own sound in hurtPlayer)
    if (!victimIsPlayer) {
      const mine = shooter === playerStats;
      audio.playAt(headshot ? 'hitHead' : 'hitArmor', pos, {
        volume: mine ? 0.9 : 0.6, rate: 0.95 + Math.random() * 0.1, refDistance: 6, maxDistance: 70,
      });
      if (mine) showHitmarker(!wounded);
    }
    if (!wounded && !victimIsPlayer) bodyDown(pos);
    if (wounded) return;
    if (shooter === playerStats && !victimIsPlayer) showKill(victimName, headshot);
    // kill feed row: you only ever tag enemies, so the victim's team is the
    // shooter's opposite
    const sIsPlayer = shooter === playerStats;
    const sName = sIsPlayer ? getPlayerName() : (shooter && shooter.name) || 'Bot';
    const sTeam = sIsPlayer ? myTeamId() : (shooter && shooter.team ? shooter.team.id : 0);
    const vName = victimIsPlayer ? getPlayerName() : victimName;
    pushKill(sName, sTeam, vName, 1 - sTeam);
  },
  fireInterval: 240, // matches the player's battle rifle cadence
});
// Rigged suits + clips load in the background; bots spawned before they land
// (fast Play click) get upgraded in place.
initLiquidGlass(); // edge-lensed glass on every .glass panel (Chromium)
preloadAvatars().then(() => {
  bots.refreshAvatars();
  weapon.attachArms(TEAM_HEX[PLAYER_TEAM]); // first-person gloves from the team suit
});

// set world after bots exists so dynamic bot collision works
player.setWorld(arena.blockers, arena.groundMeshes, arena.ceilings, bots.bots, arena.size);

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
    dot.style.background = r.teamId === 0 || col === '#ff6000' ? 'var(--grad)' : col; // FIRE accent is the gradient
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
  gameoverResult.textContent = winnerTeamId === 0 ? 'FIRE WINS' : 'WHITE WINS';
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
  gameoverResult.textContent = winner === 0 ? 'FIRE WINS' : winner === 1 ? 'WHITE WINS' : 'DRAW';
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
  setWeaponsVisible(true); // a prior death hides the gun — always restore it on a new match
  respawnEl.classList.add('hidden');
  killfeedEl.classList.add('hidden');
  killedbyEl.classList.add('hidden');
  playerStats.kills = 0; playerStats.deaths = 0; playerStats.shots = 0;
  bots.setSlotBase(1, 0);              // player holds FIRE slot 0; bots fill the rest
  if (bots.enabled) bots.respawnAll(gameConfig.size - 1, gameConfig.size); // player fills one FIRE slot
  camera.position.copy(playerSpawnPoint()); // always your own side
  // face the arena centre (also undoes the menu's orbit camera)
  camera.quaternion.setFromEuler(new THREE.Euler(0, Math.atan2(camera.position.x, camera.position.z), 0, 'YXZ'));
  player.velocityY = 0; player.moveVel.set(0, 0, 0);
  player.resetStance();
  playerHp = HP_MAX; updateHpBar();
  refillAmmo();
  startCountdown();                    // "get ready" freeze before the match
}

// --- Title / cover screen: Enter Arena cross-fades into the main menu ---
const titleEl = document.getElementById('title');
const startBtn = document.getElementById('start-btn');
let started = false;

function startGame() {
  if (started) return;
  started = true;
  audio.resume();                 // Start is a user gesture — unlock audio here
  startBtn.classList.add('hit');
  // short beat for the press, then cross-fade (the logo stays pinned)
  setTimeout(() => {
    titleEl.classList.add('title-out');
    showStart();                  // reveal the main menu
    setTimeout(() => { titleEl.style.display = 'none'; }, 500);
  }, 120);
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
  if (gameConfig.rule === 'rifle') switchWeapon(0);
  else if (gameConfig.rule === 'rocket') switchWeapon(1);
  enterGame();
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
  try { localStorage.setItem('ffa.map', String(mapId)); } catch {}
  scene.remove(arena.group);                        // dispose the old arena
  arena.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  for (const m of arena.materials) m.dispose();
  arena = buildArena(scene, mapId);                 // build + re-wire everything holding an arena ref
  captureArenaReflections();
  setupFloorReflection();
  setArenaSize(arena.size);
  player.setWorld(arena.blockers, arena.groundMeshes, arena.ceilings, bots.bots, arena.size);
  bots.arena = arena;
  refreshMapPicker();
}
const mapPickerEl = document.getElementById('map-picker');
const lcArenaName = document.getElementById('lc-arena-name');
const lcArenaSub = document.getElementById('lc-arena-sub');
function refreshMapPicker() {
  if (!mapPickerEl) return;
  const locked = netplay.active; // the map is chosen in free play; MP map sync is a follow-up
  for (const b of mapPickerEl.querySelectorAll('.map-btn')) {
    b.classList.toggle('on', +b.dataset.map === arena.mapId);
    b.classList.toggle('disabled', locked);
  }
  // reflect the active map in the Featured Arena card
  const m = MAPS.find((x) => x.id === arena.mapId);
  if (lcArenaName && m) lcArenaName.textContent = m.name;
  if (lcArenaSub) lcArenaSub.textContent = '38M · OCTAGON';
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
// Home screen (launcher) wiring. The visible tiles drive the existing menu
// flows: the real game actions run through the same code paths as before, and
// the legacy hook buttons (#open-*) still own those handlers — we just click
// them. Cosmetic economy/social tiles show a "coming soon" toast so every
// control responds instead of sitting dead.
// ---------------------------------------------------------------------------
const playBtn = document.getElementById('play-btn');
const lcModes = [...document.querySelectorAll('.lc-mode')];
function setActiveMode(el) {
  for (const m of lcModes) m.classList.toggle('is-active', m === el);
}
// QUICK MATCH / PRACTICE start a local match; they differ only in whether bots
// fill the arena. PLAY NOW keeps its own handler (bots per the current setting).
function startLocalPlay(withBots, modeEl) {
  if (!netplay.active && !sessionLive) guiState.bots5v5 = withBots;
  if (modeEl) setActiveMode(modeEl);
  playBtn.click();
}
document.getElementById('mode-quick').addEventListener('click', (e) => startLocalPlay(true, e.currentTarget));
document.getElementById('mode-practice').addEventListener('click', (e) => startLocalPlay(false, e.currentTarget));
document.getElementById('mode-private').addEventListener('click', (e) => {
  setActiveMode(e.currentTarget); document.getElementById('open-private-btn').click();
});
document.getElementById('mode-custom').addEventListener('click', (e) => {
  setActiveMode(e.currentTarget); document.getElementById('open-public-btn').click();
});

// bottom nav + top-right gear + how-to
document.getElementById('nav-settings').addEventListener('click', () => document.getElementById('open-settings-btn').click());
document.getElementById('lc-top-settings').addEventListener('click', () => document.getElementById('open-settings-btn').click());
document.getElementById('lc-howto').addEventListener('click', () => document.getElementById('open-howto-btn').click());

// EXIT → back to the title / cover screen
document.getElementById('nav-exit').addEventListener('click', () => {
  hideAllMenus();
  started = false;
  startBtn.classList.remove('hit');
  titleEl.style.display = '';
  titleEl.classList.remove('title-out');
});

// profile name mirrors the name field
const lcPname = document.getElementById('lc-pname');
function refreshLcName() { lcPname.textContent = getPlayerName() || 'Recruit'; }
refreshLcName();
nameInput.addEventListener('input', refreshLcName);

function bindSegments(ids, value, apply) {
  for (const [id, v] of ids) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.addEventListener('click', () => {
      for (const [other] of ids) document.getElementById(other)?.classList.toggle('is-active', other === id);
      apply(v);
    });
  }
  apply(value);
}
bindSegments([['btn-size-4', 4], ['btn-size-3', 3], ['btn-size-2', 2]], 4, (v) => { gameConfig.size = v; });
bindSegments([['btn-rule-free', 'free'], ['btn-rule-rifle', 'rifle'], ['btn-rule-rocket', 'rocket']], 'free', (v) => { gameConfig.rule = v; });
bindSegments([['btn-score-15', 15], ['btn-score-25', 25], ['btn-score-40', 40]], 25, (v) => { match.target = v; });

// "coming soon" toast for tiles whose systems aren't built yet
let _toastEl = null, _toastTimer = 0;
function showToast(label) {
  if (!_toastEl) {
    _toastEl = document.createElement('div');
    _toastEl.className = 'lc-toast';
    document.body.appendChild(_toastEl);
  }
  _toastEl.innerHTML = `<strong>${label}</strong> &middot; coming soon`;
  _toastEl.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => _toastEl.classList.remove('show'), 1800);
}
for (const el of document.querySelectorAll('[data-soon]')) {
  el.addEventListener('click', () => showToast(el.dataset.soon));
}

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
  onTagged: (shooterTeamId, hex, name, fromPos) => { if (hurtPlayer(hex, 50, false, fromPos)) onPlayerTagged(shooterTeamId, hex, name); },
  showKill,
  onRosterChange: () => { updateNetHud(); renderLobby(); refreshNightToggle(); refreshMapPicker(); },
  onStart: () => startNetMatchLocal(),  // clients: (re)start — fresh scoreline
  onClock: (secondsLeft) => setNetClock(secondsLeft),
  onMatchEnd: (winner, scores, rows) => showOnlineResult(winner, scores, rows),
  getLocalStats: () => ({ kills: playerStats.kills, deaths: playerStats.deaths, shots: playerStats.shots }),
  getPlayerName: () => getPlayerName(),
  getBotSnapshot: () => bots.netSnapshot(),
  moveFlags: () => (player.onGround ? 0 : 1) | (player.diving ? 2 : 0) | (player.sliding ? 4 : 0),
  tagBot: (idx, team) => bots.tagBotByIndex(idx, team),
  onGhostBotDied: (pos) => bodyDown(pos),
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

// host: when a real bot dies, score it for everyone (the avatar ragdolls
// itself down in bots.js — no extra FX needed here)
bots.onBotDown = (idx, byTeam) => {
  if (netplay.isHost && netplay.active) netplay.hostBotDied(idx, byTeam);
};

// ---- Lobby rendering + flow ------------------------------------------------
const TEAM_DOT = ['#ff6000', '#f4f6f8'];

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
  for (let i = 0; i < blueBots; i++) botRoster.push({ name: FIRE_NAMES[i % FIRE_NAMES.length], team: 0 });
  for (let i = 0; i < redBots; i++) botRoster.push({ name: WHITE_NAMES[i % WHITE_NAMES.length], team: 1 });

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
  player.velocityY = 0; player.moveVel.set(0, 0, 0);
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
  enterGame();
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

// ===========================================================================
// Combat: weapons, ammo + reloads, projectiles, rockets + explosions, FX
// ===========================================================================
const PLAYER_TEAM = 0; // free play: the player fights on the FIRE team
function myTeamId() { return (netplay.active && netplay.me) ? netplay.me.team : PLAYER_TEAM; }

// Loadout. `interval` is the minimum ms between shots; `mag` rounds per reload.
const WEAPONS = [
  { name: 'BATTLE RIFLE', mag: 20, reloadMs: 1500, interval: 210, speed: 260 },
  { name: 'TWIN ROCKET', mag: 2, reloadMs: 2300, interval: 480, speed: 34 },
];
const ammo = WEAPONS.map((w) => w.mag);
const reload = { active: false, slot: 0, t0: 0, dur: 0, stage: 0 };
const lastShotAt = [0, 0];
let pendingShotUntil = 0;      // buffered trigger press (fires as soon as the gun is up)
let shootWasHeld = false;
let crossBloom = 0;            // reticle bloom 0..1, kicked by each shot

const raycaster = new THREE.Raycaster();
const _forward = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _aimPt = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _wpnRay = new THREE.Raycaster();
const _wpnDir = new THREE.Vector3();
const _wpnHit = new THREE.Vector3();
const _segEnd = new THREE.Vector3();
const _tmpV = new THREE.Vector3();

// World point under the screen-centre reticle; player rounds fly flat to it so
// they land exactly where you aim (no muzzle parallax).
function crosshairAimPoint() {
  camera.getWorldDirection(_aimDir);
  const eye = camera.getWorldPosition(_aimPt);
  raycaster.set(eye, _aimDir);
  raycaster.far = 500;
  const wall = raycaster.intersectObjects(arena.losBlockers, false)[0];
  if (wall) return _aimPt.copy(wall.point);
  return _aimPt.addScaledVector(_aimDir, 300);
}

// muzzle position in world space: rifle fires from the top barrel, rockets
// alternate the two lower tubes
let rocketSide = 1;
function muzzleOrigin(slot) {
  camera.getWorldDirection(_forward);
  _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  _camRight.crossVectors(_forward, _camUp).normalize();
  const o = camera.getWorldPosition(new THREE.Vector3());
  if (slot === 0) return o.addScaledVector(_forward, 0.6).addScaledVector(_camRight, 0.2).addScaledVector(_camUp, -0.13);
  rocketSide = -rocketSide;
  return o.addScaledVector(_forward, 0.8).addScaledVector(_camRight, 0.2 + rocketSide * 0.06).addScaledVector(_camUp, -0.24);
}

// ---- HUD: ammo, reload bar, low-ammo prompt, reticle ring/bloom -------------
const weapModeEl = document.getElementById('weap-mode-label');
const weapAmmoEl = document.getElementById('weap-ammo');
const weapReloadEl = document.getElementById('weap-reload-bar');
const weapReloadFillEl = document.getElementById('weap-reload-fill');
const reloadPromptEl = document.getElementById('reload-prompt');
const reloadPromptKeyEl = document.getElementById('reload-prompt-key');
const chReloadEl = document.getElementById('ch-reload');
function updateWeaponHud() {
  const w = WEAPONS[currentWeapon];
  if (weapModeEl) weapModeEl.textContent = w.name;
  if (weapAmmoEl) {
    weapAmmoEl.innerHTML = reload.active
      ? 'RELOADING'
      : `<b>${ammo[currentWeapon]}</b> / ${w.mag}`;
    weapAmmoEl.classList.toggle('low', !reload.active && ammo[currentWeapon] <= Math.max(1, Math.floor(w.mag * 0.25)));
  }
  weapReloadEl?.classList.toggle('hidden', !reload.active);
  const low = !reload.active && ammo[currentWeapon] <= Math.max(0, Math.floor(w.mag * 0.25));
  if (reloadPromptEl) {
    reloadPromptEl.classList.toggle('show', low && active && !playerDead);
    reloadPromptEl.classList.toggle('empty', ammo[currentWeapon] === 0);
    if (reloadPromptKeyEl) reloadPromptKeyEl.textContent = input.gamepadConnected ? 'X' : 'R';
  }
}

// ---- reloads ---------------------------------------------------------------
function refillAmmo() {
  for (let i = 0; i < WEAPONS.length; i++) ammo[i] = WEAPONS[i].mag;
  cancelReload();
  updateWeaponHud();
}
function startReload() {
  const slot = currentWeapon, w = WEAPONS[slot];
  if (reload.active || ammo[slot] >= w.mag || playerDead) return;
  Object.assign(reload, { active: true, slot, t0: performance.now(), dur: w.reloadMs, stage: 0 });
  audio.play('reloadOut', { volume: 0.8 });
  updateWeaponHud();
}
function cancelReload() {
  if (!reload.active) return;
  reload.active = false;
  if (chReloadEl) chReloadEl.style.setProperty('--p', 0);
  updateWeaponHud();
}
function updateReload() {
  if (!reload.active) return;
  const k = Math.min(1, (performance.now() - reload.t0) / reload.dur);
  if (weapReloadFillEl) weapReloadFillEl.style.width = `${k * 100}%`;
  if (chReloadEl) chReloadEl.style.setProperty('--p', k);
  if (reload.stage === 0 && k >= 0.55) { reload.stage = 1; audio.play('reloadIn', { volume: 0.8 }); }
  if (reload.stage === 1 && k >= 0.8) { reload.stage = 2; audio.play('reloadRack', { volume: 0.75 }); }
  if (k >= 1) {
    ammo[reload.slot] = WEAPONS[reload.slot].mag;
    reload.active = false;
    if (chReloadEl) chReloadEl.style.setProperty('--p', 0);
    updateWeaponHud();
  }
}

// ---- firing ----------------------------------------------------------------
// The gun must be up (not mid sprint-lower or mid swap) to fire; a press made
// while it's coming up is buffered briefly and fires the moment it's ready.
function gunReady() { return weapon.sprintT < 0.3 && weapon.swapT >= 1 && !reload.active; }

function fireCurrent() {
  const slot = currentWeapon, w = WEAPONS[slot];
  const now = performance.now();
  if (now - lastShotAt[slot] < w.interval) return false;
  if (ammo[slot] <= 0) { audio.play('dryFire', { volume: 0.6 }); startReload(); return false; }
  lastShotAt[slot] = now;
  ammo[slot]--;
  const origin = muzzleOrigin(slot);
  const dir = crosshairAimPoint().sub(origin).normalize().clone();
  if (slot === 0) {
    spawnProjectile(origin, dir, TEAM_HEX[myTeamId()], myTeamId(), w.speed, true, playerStats, { gravity: 0 });
    weapon.kick(1);
    audio.play('rifleShot', { volume: 0.9, rate: 0.97 + Math.random() * 0.06 });
    netplay.sendShot(origin, dir, TEAM_HEX[myTeamId()], myTeamId(), { speed: w.speed });
  } else {
    spawnProjectile(origin, dir, 0xff6000, myTeamId(), w.speed, true, playerStats, { kind: 'rocket', gravity: 0 });
    weapon.kick(1.8);
    kickView(0.5, 0, (Math.random() - 0.5) * 0.3);
    audio.play('rocketLaunch', { volume: 0.9, rate: 0.95 + Math.random() * 0.1 });
    netplay.sendShot(origin, dir, 0xff6000, myTeamId(), { kind: 'rocket', speed: w.speed });
  }
  playerStats.shots++;
  crossBloom = 1;
  if (ammo[slot] === 0) setTimeout(() => { if (ammo[slot] === 0 && currentWeapon === slot) startReload(); }, 180);
  updateWeaponHud();
  return true;
}

function updateShooting(ready) {
  const held = input.shootHeld;
  const now = performance.now();
  if (held && !shootWasHeld) pendingShotUntil = now + 200; // press edge: buffer it
  shootWasHeld = held;
  if (!ready) return;
  if (input.consumeReload()) startReload();
  if (pendingShotUntil > now) {
    if (reload.active) {
      // Halo-style: pulling the trigger on a partial mag doesn't cancel the
      // reload; an empty mag just clicks
      if (ammo[currentWeapon] === 0) { pendingShotUntil = 0; audio.play('dryFire', { volume: 0.5 }); }
    } else if (gunReady() && fireCurrent()) {
      pendingShotUntil = 0;
    }
  }
}

function stopFiring() {
  shootWasHeld = false;
  pendingShotUntil = 0;
}

// Aim-down-sights zoom: blend the FOV toward the weapon's aim FOV and slow the
// mouse while zoomed.
let _lastFov = -1;
function activeWeapon() { return weapon; }
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

function setWeaponsVisible(show) {
  weapon.root.visible = show;
  weapon.setMode(currentWeapon);
}
function switchWeapon(slot) {
  slot = slot ? 1 : 0;
  if (gameConfig.rule === 'rifle') slot = 0;
  if (gameConfig.rule === 'rocket') slot = 1;
  if (slot === currentWeapon) return;
  cancelReload();
  currentWeapon = slot;
  weapon.swap(() => weapon.setMode(currentWeapon)); // dips out, swaps, comes back up
  audio.play('weaponSwap', { volume: 0.7 });
  updateWeaponHud();
}

// Reticle: bloom on each shot, red over an enemy in range (like Halo).
const _rtTo = new THREE.Vector3();
function aimOnEnemy() {
  camera.getWorldDirection(_aimDir);
  const eye = camera.position;
  const test = (pos, y = 1.3, r = 0.8) => {
    _rtTo.set(pos.x - eye.x, pos.y + y - eye.y, pos.z - eye.z);
    const along = _rtTo.dot(_aimDir);
    if (along <= 0 || along > 70) return false;
    return _rtTo.lengthSq() - along * along < r * r;
  };
  const me = myTeamId();
  for (const b of bots.bots) if (b.alive && b.team.id !== me && test(b.pos)) return true;
  if (netplay.active) for (const t of netplay.getBotTargets()) if (t.alive && t.team !== me && test(t.pos, -0.4)) return true;
  return false;
}
function updateReticle(dt) {
  crossBloom = Math.max(0, crossBloom - dt * 6);
  crosshair.style.setProperty('--bloom', (1 + crossBloom * 0.28).toFixed(3));
  crosshair.classList.toggle('on-enemy', active && !playerDead && aimOnEnemy());
}

// ---- movement sounds ----------------------------------------------------------
let slideLoop = null;
function updateSlideSound() {
  const scraping = player.sliding || player.diving;
  if (scraping && !slideLoop) slideLoop = audio.playLoop('slide', { volume: 0.6 });
  else if (!scraping && slideLoop) { audio.stopLoop(slideLoop); slideLoop = null; }
}
function stopSlideSound() {
  if (slideLoop) { audio.stopLoop(slideLoop); slideLoop = null; }
}

// ---- projectiles -------------------------------------------------------------
// 'bullet' = stretched tracer bolt, 'rocket' = finned warhead with a lit
// exhaust + contrail, 'spark' = fast-fading ember for impacts and blasts.
const projectiles = [];
const _zAxis = new THREE.Vector3(0, 0, 1);
const tracerGeo = new THREE.CylinderGeometry(0.035, 0.035, 1.4, 6).rotateX(Math.PI / 2);
const sparkGeo = new THREE.TetrahedronGeometry(0.05);
const rocketBodyGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.62, 12).rotateX(Math.PI / 2);
const rocketNoseGeo = new THREE.ConeGeometry(0.09, 0.26, 12).rotateX(Math.PI / 2);
const rocketBandGeo = new THREE.CylinderGeometry(0.113, 0.113, 0.05, 12).rotateX(Math.PI / 2);
const rocketFinGeo = new THREE.BoxGeometry(0.018, 0.16, 0.22);
const rocketFlameGeo = new THREE.ConeGeometry(0.085, 0.42, 10).rotateX(-Math.PI / 2);
const rocketShellMat = new THREE.MeshStandardMaterial({ color: 0xe9ebee, metalness: 0.2, roughness: 0.35 });
const rocketNoseMat = new THREE.MeshStandardMaterial({ color: 0x1b1e23, metalness: 0.4, roughness: 0.4 });
const rocketBandMat = new THREE.MeshStandardMaterial({ color: 0xff6000, emissive: 0xff6000, emissiveIntensity: 1.2 });
const rocketFinMat = new THREE.MeshStandardMaterial({ color: 0x1b1e23, roughness: 0.6 });
const rocketFlameMat = new THREE.MeshBasicMaterial({ color: 0xffb24a, transparent: true, opacity: 0.95, toneMapped: false });
const glowMats = new Map(); // hex -> shared unlit material; tracers + embers stay full-bright
function glowMat(hex) {
  let m = glowMats.get(hex);
  if (!m) { m = new THREE.MeshBasicMaterial({ color: hex, toneMapped: false }); glowMats.set(hex, m); }
  return m;
}
const _radialTex = (() => { // soft round sprite for glows, smoke and fireballs
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.45, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
function makeRocketMesh() {
  const g = new THREE.Group();
  const nose = new THREE.Mesh(rocketNoseGeo, rocketNoseMat); nose.position.z = 0.44;
  const band = new THREE.Mesh(rocketBandGeo, rocketBandMat); band.position.z = 0.2;
  const flame = new THREE.Mesh(rocketFlameGeo, rocketFlameMat); flame.position.z = -0.5;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: _radialTex, color: 0xffa040, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false,
  }));
  glow.scale.setScalar(1.1); glow.position.z = -0.45; glow.layers.set(NO_OUTLINE_LAYER);
  g.add(new THREE.Mesh(rocketBodyGeo, rocketShellMat), nose, band, flame, glow);
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.Mesh(rocketFinGeo, rocketFinMat);
    const a = k * Math.PI / 2 + Math.PI / 4;
    fin.position.set(Math.cos(a) * 0.12, Math.sin(a) * 0.12, -0.24);
    fin.rotation.z = a;
    g.add(fin);
  }
  g.userData.flame = flame; g.userData.glow = glow;
  return g;
}
function spawnProjectile(origin, dir, hex, team, speed = 70, isPlayer = false, shooter = null, opts = {}) {
  const kind = opts.kind || (opts.rocket ? 'rocket' : 'bullet');
  let mesh;
  if (kind === 'rocket') mesh = makeRocketMesh();
  else mesh = new THREE.Mesh(kind === 'spark' ? sparkGeo : tracerGeo, glowMat(hex));
  mesh.position.copy(origin);
  if (kind !== 'spark') mesh.quaternion.setFromUnitVectors(_zAxis, dir);
  if (kind === 'bullet') flashes.flash(origin, hex, 5, 6, 0.06);
  else if (kind === 'rocket') flashes.flash(origin, 0xff8a30, 10, 9, 0.12);
  scene.add(mesh);
  const proj = {
    mesh, kind, hex, team, isPlayer, shooter,
    dir: dir.clone(),
    vel: dir.clone().multiplyScalar(speed),
    // rockets leave the tube slow and accelerate to cruise
    speed, cruise: kind === 'rocket' ? speed * 2.1 : speed,
    prev: origin.clone(),
    born: performance.now(),
    ttl: opts.ttl || (kind === 'rocket' ? 5000 : 3000),
    gravity: opts.gravity != null ? opts.gravity : (kind === 'spark' ? -18 : 0),
  };
  projectiles.push(proj);
  return proj;
}

// Does the segment a->b pass within radius r of a sphere centred at c?
function segHitsSphere(a, b, c, r) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = ab2 > 0 ? ((c.x - a.x) * abx + (c.y - a.y) * aby + (c.z - a.z) * abz) / ab2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = c.x - (a.x + abx * t), dy = c.y - (a.y + aby * t), dz = c.z - (a.z + abz * t);
  return dx * dx + dy * dy + dz * dz <= r * r;
}

function updateProjectiles(dt) {
  const now = performance.now();
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.prev.copy(p.mesh.position);
    if (p.kind === 'rocket') {
      p.speed = Math.min(p.cruise, p.speed + 150 * dt);
      p.vel.copy(p.dir).multiplyScalar(p.speed);
      emitTrail(p, p.mesh.position);
      const f = p.mesh.userData.flame;
      if (f) f.scale.set(1, 1, 0.75 + Math.random() * 0.6);
      p.mesh.userData.glow.material.opacity = 0.75 + Math.random() * 0.25;
    } else {
      p.vel.y += p.gravity * dt;
    }
    p.mesh.position.addScaledVector(p.vel, dt);

    if (p.kind === 'spark') { // embers: bounce off the floor, fade by age
      if (p.mesh.position.y < 0.04 && p.vel.y < 0) { p.mesh.position.y = 0.04; p.vel.y *= -0.35; p.vel.x *= 0.6; p.vel.z *= 0.6; }
      const life = (now - p.born) / p.ttl;
      p.mesh.scale.setScalar(Math.max(0.05, 1 - life));
      p.mesh.rotation.x += dt * 9; p.mesh.rotation.y += dt * 7;
      if (life >= 1) removeProjectile(i);
      continue;
    }

    const seg = _tmpV.subVectors(p.mesh.position, p.prev);
    const dist = seg.length();
    if (dist > 1e-5) {
      const dir = seg.clone().multiplyScalar(1 / dist);
      // the first solid surface along this step caps every hit test, so
      // nothing is ever hit through a wall
      raycaster.set(p.prev, dir);
      raycaster.far = dist + 0.13;
      const wallHit = raycaster.intersectObjects(arena.losBlockers, false)[0];
      const reach = wallHit ? Math.min(dist + 0.13, wallHit.distance) : dist + 0.13;
      const segEnd = wallHit ? _segEnd.copy(p.prev).addScaledVector(dir, reach) : p.mesh.position;
      const isNetGhost = p.shooter && p.shooter.netGhost; // relayed shots are visual only

      if (p.kind === 'rocket') {
        let blast = wallHit ? wallHit.point.clone().addScaledVector(dir, -0.15) : null;
        if (!isNetGhost) {
          for (const bot of bots.bots) {
            if (!bot.alive || bot.team.id === p.team) continue;
            _tmpV.copy(bot.pos); _tmpV.y += 1.2;
            if (segHitsSphere(p.prev, segEnd, _tmpV, 0.9)) { blast = _tmpV.clone(); break; }
          }
        }
        if (blast) { rocketImpact(p, i, blast, isNetGhost); continue; }
      } else {
        // online: MY shots test remote players + the host's ghost bots
        if (p.isPlayer && netplay.active) {
          const victim = netplay.testHit(p.prev, dir, reach);
          if (victim) {
            audio.play('hitArmor', { volume: 0.9 });
            showHitmarker(true);
            showKill(victim.name);
            playerStats.kills++;
            if (victim.kind === 'bot') netplay.sendBotHit(victim.index);
            else netplay.sendTag(victim.id, p.hex);
            removeProjectile(i);
            continue;
          }
        }
        // host: my bots' rounds can hit remote human players
        if (!isNetGhost && !p.isPlayer && netplay.isHost && netplay.active) {
          const rv = netplay.hostTestRemoteHit(p.prev, dir, reach, p.team);
          if (rv) { netplay.broadcastTag(rv.id, p.hex, p.team, p.shooter && p.shooter.name); removeProjectile(i); continue; }
        }
        if (!isNetGhost && bots.hitscan(p.prev, dir, reach, p.team, p.hex, p.shooter)) {
          removeProjectile(i);
          continue;
        }
        if (wallHit) { bulletImpact(wallHit, p.hex); removeProjectile(i); continue; }
      }
    }
    if (now - p.born > p.ttl) removeProjectile(i);
  }
}

function removeProjectile(i) {
  const p = projectiles[i];
  scene.remove(p.mesh);
  if (p.kind === 'rocket') p.mesh.userData.glow.material.dispose();
  projectiles.splice(i, 1);
}

// ---- impact + explosion FX ----------------------------------------------------
// smoke / dust puffs (pooled sprites, tinted per puff)
const puffs = [];
for (let i = 0; i < 260; i++) {
  const mat = new THREE.SpriteMaterial({ map: _radialTex, color: 0x9aa0a8, transparent: true, opacity: 0, depthWrite: false });
  const s = new THREE.Sprite(mat); s.visible = false; s.layers.set(NO_OUTLINE_LAYER); scene.add(s);
  puffs.push({ sprite: s, age: 0, life: 1, size0: 0.6, vel: new THREE.Vector3(), maxOp: 0.4, grow: 1.5 });
}
function spawnPuff(x, y, z, opts = {}) {
  const p = puffs.find((s) => !s.sprite.visible); if (!p) return;
  const j = opts.jitter ?? 0.25;
  p.sprite.position.set(x + (Math.random() - .5) * j, y + (Math.random() - .5) * j * 0.8, z + (Math.random() - .5) * j);
  const sp = opts.spread ?? 0.5;
  p.vel.set((Math.random() - .5) * sp, (opts.rise ?? 0.35) + Math.random() * 0.4, (Math.random() - .5) * sp);
  p.age = 0; p.life = (opts.life ?? 0.8) + Math.random() * 0.4;
  p.size0 = (opts.size ?? 0.42) + Math.random() * 0.18;
  p.maxOp = opts.opacity ?? 0.4;
  p.grow = opts.grow ?? 1.5;
  p.sprite.material.color.setHex(opts.color ?? 0x9aa0a8);
  p.sprite.scale.setScalar(p.size0); p.sprite.material.opacity = p.maxOp; p.sprite.visible = true;
}
// contrail: puffs laid at fixed spacing along the path actually travelled
const _smkSeg = new THREE.Vector3();
function emitTrail(p, pos) {
  const step = 0.55;
  if (!p._smokePrev) { p._smokePrev = pos.clone(); p._smokeCarry = 0; return; }
  _smkSeg.subVectors(pos, p._smokePrev);
  const dist = _smkSeg.length();
  if (dist < 1e-4) return;
  _smkSeg.multiplyScalar(1 / dist);
  let d = step - (p._smokeCarry || 0);
  while (d <= dist) {
    spawnPuff(p._smokePrev.x + _smkSeg.x * d, p._smokePrev.y + _smkSeg.y * d, p._smokePrev.z + _smkSeg.z * d,
      { size: 0.3, opacity: 0.42, grow: 2.4, life: 1.1, rise: 0.15, spread: 0.3, jitter: 0.08, color: 0xd8dade });
    d += step;
  }
  p._smokeCarry = dist - (d - step);
  p._smokePrev.copy(pos);
}

// fireballs: additive sprites that bloom out and cool from white-hot to ember
const fireballs = [];
for (let i = 0; i < 40; i++) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: _radialTex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false,
  }));
  s.visible = false; s.layers.set(NO_OUTLINE_LAYER); scene.add(s);
  fireballs.push({ sprite: s, age: 0, life: 0.4, size: 1, vel: new THREE.Vector3() });
}
const _fbCol = new THREE.Color(), _fbHot = new THREE.Color(0xfff1c4), _fbMid = new THREE.Color(0xff7a1a), _fbCool = new THREE.Color(0x5a2208);
// ground shockwave rings + scorch marks
const ringGeo = new THREE.RingGeometry(0.82, 1, 48).rotateX(-Math.PI / 2);
const rings = [];
for (let i = 0; i < 6; i++) {
  const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    color: 0xffe2b8, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  }));
  m.visible = false; m.layers.set(NO_OUTLINE_LAYER); scene.add(m);
  rings.push({ mesh: m, age: 0, life: 0.38, r: 6 });
}
const scorchTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(10,8,6,0.85)'); g.addColorStop(0.55, 'rgba(20,16,12,0.45)'); g.addColorStop(1, 'rgba(20,16,12,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
const scorchGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const scorches = [];
for (let i = 0; i < 12; i++) {
  const m = new THREE.Mesh(scorchGeo, new THREE.MeshBasicMaterial({ map: scorchTex, transparent: true, opacity: 0, depthWrite: false }));
  m.visible = false; m.layers.set(NO_OUTLINE_LAYER); m.renderOrder = 2; scene.add(m);
  scorches.push({ mesh: m, age: 0 });
}
let _scorchNext = 0;

function spawnSparks(pos, n, { speed = [6, 16], colors = [0xffe0a0, 0xff8a30], up = 0.55, ttl = 650 } = {}) {
  const dir = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    const a = Math.random() * Math.PI * 2, el = Math.random() * up + 0.05;
    dir.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)).normalize();
    const sp = speed[0] + Math.random() * (speed[1] - speed[0]);
    spawnProjectile(pos.clone().addScaledVector(dir, 0.1), dir.clone(), colors[k % colors.length], -1, sp, false,
      { netGhost: true }, { kind: 'spark', ttl: ttl * (0.6 + Math.random() * 0.6) });
  }
}

// a round hitting the arena shell: a few sparks, a small puff, a ricochet tick
function bulletImpact(hit, hex) {
  const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize() : _tmpV.set(0, 1, 0);
  const pos = hit.point.clone().addScaledVector(n, 0.05);
  flashes.flash(pos, hex, 3, 4, 0.08);
  spawnSparks(pos, 4, { speed: [3, 7], colors: [0xfff4dc, hex], up: 0.9, ttl: 320 });
  spawnPuff(pos.x, pos.y, pos.z, { size: 0.16, opacity: 0.35, grow: 2.2, life: 0.45, rise: 0.2, spread: 0.2, jitter: 0.02, color: 0xc9ccd2 });
  const k = Math.max(0, 1 - camera.position.distanceTo(pos) / 40);
  if (k > 0) audio.playAt('impact', pos, { volume: 0.55 * k, rate: 0.9 + Math.random() * 0.25, refDistance: 4, maxDistance: 40 });
}

function explode(point) {
  flashes.flash(point, 0xff8a30, 34, 18, 0.32);
  for (let k = 0; k < 9; k++) {
    const f = fireballs.find((o) => !o.sprite.visible); if (!f) break;
    f.sprite.position.set(point.x + (Math.random() - .5) * 0.8, point.y + (Math.random() - .3) * 0.7, point.z + (Math.random() - .5) * 0.8);
    f.vel.set((Math.random() - .5) * 3, 0.8 + Math.random() * 2.2, (Math.random() - .5) * 3);
    f.age = 0; f.life = 0.32 + Math.random() * 0.25; f.size = 1.6 + Math.random() * 1.6;
    f.sprite.visible = true;
  }
  for (let k = 0; k < 10; k++) {
    spawnPuff(point.x, point.y + 0.3, point.z, { size: 0.9, opacity: 0.5, grow: 2.6, life: 1.4, rise: 0.9, spread: 2.2, jitter: 1.1, color: 0x5d6168 });
  }
  spawnSparks(point, 22, { speed: [7, 20], colors: [0xfff0c0, 0xffa040, 0xff6000], up: 0.9, ttl: 800 });
  if (point.y < 1.6) { // ground burst: shockwave ring + scorch mark
    const r = rings.find((o) => !o.mesh.visible);
    if (r) { r.mesh.position.set(point.x, 0.05, point.z); r.age = 0; r.mesh.visible = true; }
    const s = scorches[_scorchNext++ % scorches.length];
    s.mesh.position.set(point.x, 0.012, point.z); s.mesh.scale.setScalar(3.4 + Math.random());
    s.mesh.rotation.y = Math.random() * Math.PI * 2; s.age = 0; s.mesh.visible = true;
  }
  // camera shake that falls off with distance
  const d = camera.position.distanceTo(point);
  const k = Math.max(0, 1 - d / 20);
  if (k > 0) kickView(1.6 * k, (Math.random() - 0.5) * 0.8 * k, (Math.random() - 0.5) * 1.2 * k);
  audio.playAt('explosion', point, { volume: 1.2, rate: 0.95 + Math.random() * 0.1, refDistance: 10, maxDistance: 140 });
}

function rocketImpact(p, i, point, visualOnly) {
  if (!visualOnly) {
    const tagged = bots.applyBlast(point, 6.5, 110, p.team, p.shooter);
    if (p.isPlayer && tagged) showHitmarker(true);
  }
  explode(point);
  removeProjectile(i);
}

function updateFx(dt) {
  for (const p of puffs) {
    if (!p.sprite.visible) continue;
    p.age += dt; if (p.age >= p.life) { p.sprite.visible = false; continue; }
    p.sprite.position.addScaledVector(p.vel, dt);
    p.vel.multiplyScalar(1 - 0.9 * dt); p.vel.y += 0.25 * dt;
    const t = p.age / p.life;
    p.sprite.scale.setScalar(p.size0 * (1 + t * p.grow));
    p.sprite.material.opacity = (1 - t) * (1 - t) * p.maxOp;
  }
  for (const f of fireballs) {
    if (!f.sprite.visible) continue;
    f.age += dt; const t = f.age / f.life;
    if (t >= 1) { f.sprite.visible = false; continue; }
    f.sprite.position.addScaledVector(f.vel, dt);
    f.sprite.scale.setScalar(f.size * (0.35 + Math.sqrt(t) * 1.1));
    if (t < 0.35) _fbCol.copy(_fbHot).lerp(_fbMid, t / 0.35); else _fbCol.copy(_fbMid).lerp(_fbCool, (t - 0.35) / 0.65);
    f.sprite.material.color.copy(_fbCol);
    f.sprite.material.opacity = 1 - t * t;
  }
  for (const r of rings) {
    if (!r.mesh.visible) continue;
    r.age += dt; const t = r.age / r.life;
    if (t >= 1) { r.mesh.visible = false; continue; }
    r.mesh.scale.setScalar(0.5 + (r.r - 0.5) * (1 - (1 - t) * (1 - t)));
    r.mesh.material.opacity = 0.7 * (1 - t);
  }
  for (const s of scorches) {
    if (!s.mesh.visible) continue;
    s.age += dt;
    s.mesh.material.opacity = s.age < 8 ? 0.85 : Math.max(0, 0.85 * (1 - (s.age - 8) / 4));
    if (s.age > 12) s.mesh.visible = false;
  }
}

// Keep the sun following the player so shadows stay crisp across the arena.
function updateSun() {
  const p = camera.position;
  sun.target.position.set(p.x, 0, p.z);
  sun.position.set(p.x + 30, 48, p.z + 20);
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
  // environment
  environmentContrast: 0.74,
  shadowIntensity: 0.38,
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
};

function applyEnvironment() {
  if (nightMode) return; // Lights Out owns the lighting while it's active
  renderer.toneMappingExposure = guiState.environmentContrast;
  // High ambient/hemi baseline keeps unlit faces bright white so the map does
  // not read as gray. Shadow intensity trades fill for a stronger directional
  // light, which makes cast/attached shadows more pronounced.
  const fill = 1 - guiState.shadowIntensity;
  ambient.intensity = 0.04 + fill * 0.1;
  hemi.intensity = 0.2 + fill * 0.25;
  sun.intensity = 1.1 + guiState.shadowIntensity * 1.2;
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
fWeapon.add(weapon, 'cant', -1.4, 1.4, 0.02).name('Cant');
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

const fBots = gui.addFolder('Bots (5v5)');
fBots.add(guiState, 'bots5v5').name('Enable 5v5')
  .onChange(v => { bots.setEnabled(v); scoreboard.classList.toggle('hidden', !v); });
fBots.add({ respawn: () => bots.respawnAll() }, 'respawn').name('Respawn Teams');
fBots.open();

const fInvisible = gui.addFolder('Invisible Mode');
fInvisible.add(guiState, 'invisibleMode').name('Enable Invisible Mode')
  .onChange(applyInvisibleMode);
fInvisible.open();

// DEV-only debug hooks (DEV is false in the shipped itch/Steam build, so this
// never exists for players). Lets a headless/browser-pane session drive play
// where pointer-lock isn't available.
if (DEV) window.__wo = {
  get active() { return active; },
  setActive: (v) => { active = !!v; },   // pause/resume the movement+camera loop for clean FX captures
  enterGame, resetMatch,
  skipCountdown: () => { countdownMs = COUNTDOWN_GO_MS; countdownEl.classList.add('hidden'); },
  fire: () => fireCurrent(),
  fireRocket: () => { currentWeapon = 1; weapon.setMode(1); fireCurrent(); },
  spawn: (kind) => { // stage a frozen round in front of the camera for FX captures
    const o = camera.getWorldPosition(new THREE.Vector3())
      .addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 2.2);
    const d = camera.getWorldDirection(new THREE.Vector3());
    return spawnProjectile(o, d, 0xff6000, PLAYER_TEAM, 0, true, playerStats, { kind, gravity: 0, ttl: 60000 });
  },
  camera, player, arena, bots, weapon,
  get ammo() { return [...ammo]; }, get reload() { return { ...reload }; }, get slot() { return currentWeapon; },
  swap: (s) => switchWeapon(s), reloadNow: () => startReload(),
  render: () => outline.render(), // draw one frame on demand (background tabs pause rAF)
};

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
      'border:none;cursor:pointer;font:700 13px var(--font);background:#1c1f24;color:#fff';
    return b;
  };
  const vBtn = mkBtn('Record Video + Audio');
  const aBtn = mkBtn('Record Audio Only');
  const toggleVideo = async () => {
    if (rec.recordingVideo) { rec.stopVideo(); vBtn.textContent = 'Record Video + Audio'; vBtn.style.background = '#1c1f24'; }
    else if (await rec.startVideo()) { vBtn.textContent = 'Stop + Download Video'; vBtn.style.background = 'var(--grad)'; }
  };
  const toggleAudio = () => {
    if (rec.recordingAudio) { rec.stopAudio(); aBtn.textContent = 'Record Audio Only'; aBtn.style.background = '#1c1f24'; }
    else if (rec.startAudio()) { aBtn.textContent = 'Stop + Download Audio'; aBtn.style.background = 'var(--grad)'; }
  };
  vBtn.onclick = toggleVideo;
  aBtn.onclick = toggleAudio;

  // dev-only recorder section, appended into the Settings menu
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:14px;padding-top:12px;border-top:1px solid rgba(0,0,0,.12)';
  const label = document.createElement('div');
  label.textContent = 'DEV — RECORDER';
  label.style.cssText = 'font:700 11px/1 var(--font);letter-spacing:.16em;color:#8a9099;margin-bottom:8px';
  wrap.append(label, vBtn, aBtn);
  document.getElementById('settings-body').appendChild(wrap);

  document.addEventListener('keydown', (e) => {
    if (e.code === 'F9') { e.preventDefault(); toggleVideo(); }
    else if (e.code === 'F10') { e.preventDefault(); toggleAudio(); }
  });
}).catch((err) => console.warn('dev recorder unavailable:', err));
} // end DEV

// bots stay OFF until a match actually starts — no phantom battle raging
// behind the title screen and menus

// ---------------------------------------------------------------------------
// Player-facing Settings (persisted). The dev tuning panel above is gated on
// DEV, so players use only this Settings menu.
// ---------------------------------------------------------------------------
const settings = new Settings();
settings.buildUI(document.getElementById('settings-body'));
settings.apply({ controls, player, camera, match, audio, weapon, bots });

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
  if (floorRefl) floorRefl.resize();
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

// Fresh menu (no match underway): a slow orbit over the live arena behind the
// glass UI. Never runs while a match is paused, so it can't move the player.
let menuOrbitT = 0;
let menuOrbiting = false;
function updateMenuOrbit(dt) {
  const idle = !active && !sessionLive && !netplay.active;
  if (idle) {
    menuOrbitT += dt;
    const a = 0.7 + menuOrbitT * 0.045;
    camera.position.set(Math.sin(a) * 15, 3.6 + Math.sin(menuOrbitT * 0.21) * 0.35, Math.cos(a) * 15);
    camera.lookAt(0, 3.4, 0);
    if (!menuOrbiting) { menuOrbiting = true; camera.layers.disable(VIEWMODEL_LAYER); }
  } else if (menuOrbiting) {
    menuOrbiting = false;
    camera.layers.enable(VIEWMODEL_LAYER);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  flashes.update(dt);
  updateMenuOrbit(dt);
  outline.tick(performance.now() / 1000);

  input.poll();

  // Ambient / vehicle-FX / gamepad systems. Wrapped so a failure in ANY of them
  // (e.g. a mismatched module after a bad cache load) can never skip the
  // movement block below and freeze the player — the exact class of "can't move"
  // bug. Movement stays independent of all of this.
  try {
    daySky.update(dt, camera);   // sun/clouds follow the camera (day only)
    nightSky.update(dt, camera); // moon/stars follow the camera + twinkle (night only)
    checkSteamAchievements();     // Steam unlocks (no-op in the browser build)

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
    // hp refill: kicks in after a few clean seconds, tops off fast
    if (playerHp < HP_MAX && performance.now() - lastHurtAt > HP_DELAY) {
      playerHp = Math.min(HP_MAX, playerHp + HP_RATE * dt);
      updateHpBar();
    }
    // online: also collide with remote humans + ghost bots so nobody overlaps
    player.extraSolids = netplay.active ? netplay.collisionActors() : [];
    const crouchPress = ready && input.consumeCrouch();
    // Pulling the trigger or raising the scope CANCELS sprint (like other
    // shooters): the gun comes up and you drop to normal move speed.
    const firing = ready && input.shootHeld;
    const aiming = ready && input.aimHeld;
    player.update(
      dt,
      ready
        ? {
            forward: input.move.forward, strafe: input.move.strafe, sprint: input.sprint && !firing && !aiming,
            crouchPress, crouchHeld: input.crouchHeld,
          }
        : { forward: 0, strafe: 0, sprint: false, crouchPress: false, crouchHeld: false },
      input.look); // looking around is always allowed
    if (ready) {
      if (input.consumeJump() && player.jump()) audio.play('jump', { volume: 0.7 });
    } else {
      input.consumeJump();
    }
    const wsw = input.consumeWeapon();
    if (wsw !== null) switchWeapon(wsw === -1 ? (currentWeapon ^ 1) : wsw);
    updateShooting(ready); // fire + reload for whichever weapon is out
    updateReload();        // progress the reload ring + finish the mag swap
    if (!ready && shootWasHeld) stopFiring();
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
    // sprint pose: holding sprint, moving, grounded, not aiming or sliding.
    // slide pose: while the player is sliding (it takes over from sprint).
    const moving = Math.hypot(input.move.forward, input.move.strafe) > 0.1;
    const sprinting = ready && input.sprint && moving && !aiming && !firing &&
      player.onGround && !player.sliding && !player.diving;
    weapon.update(dt, aiming, settings.get('fov'), sprinting, player.sliding,
      Math.hypot(player.moveVel.x, player.moveVel.z) / player.sprintSpeed, reload.active);
    applyAimZoom();
    updateSun();
  } else if (active && playerDead) {
    // frozen while the respawn timer counts down (mouse look still works).
    // The timer advances by dt so it only ticks during actual play — pausing
    // to a menu preserves it, so you always serve a full countdown.
    input.consumeJump();
    input.consumeCrouch();
    if (shootWasHeld) stopFiring();
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
    if (shootWasHeld) stopFiring(); // paused / match over
    stopSlideSound();
  }

  audio.updateListener(camera); // keep 3D audio anchored to the view

  netplay.update(dt); // sync remote players (no-op when offline)

  // the world only simulates during play — menus, match-end, and the
  // match-start countdown all freeze it (bots hold at their spawns)
  const frozen = match.over || netplay.matchOver || countdownMs > 0;
  const simRunning = active || netplay.active;
  if (!frozen && simRunning) {
    // host: bots also hunt the remote human players (local player's team below)
    bots.extraTargets = netplay.isHost ? netplay.getBotTargets() : [];
    bots.update(dt, {
      playerPos: camera.position,
      playerTeam: netplay.active && netplay.me ? netplay.me.team : PLAYER_TEAM,
      playerAlive: active && !playerDead,
      now: performance.now(),
    });
  }

  if (simRunning) updateProjectiles(dt);

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

  outline.render();
  drawScopeOverlay(); // full-screen scope view while zoomed
}
animate();

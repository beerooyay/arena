import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import GUI from 'lil-gui';

import { buildArena } from './arena.js';
import { PaintSystem } from './paint.js';
import { createOutline } from './outline.js';
import { PlayerController } from './player.js';
import { InputManager } from './input.js';
import { BotSystem, BLUE_NAMES, RED_NAMES } from './bots.js';
import { Settings } from './settings.js';
import { SplatDesigner } from './splatDesigner.js';
import { Weapon } from './weapon.js';
import { AudioManager } from './audio.js';
import { NetClient, signalUrl } from './net.js';
import { NetPlay } from './netplay.js';

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
const arena = buildArena(scene);
const paint = new PaintSystem(scene);
const outline = createOutline(renderer, scene, camera);

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

const PLAYER_SPAWN = new THREE.Vector3(0, 1.7, 26);
let playerPaintHits = 0;

// The human's scoreline, shaped like a bot's so kill crediting is uniform.
const playerStats = { name: 'YOU', kills: 0, deaths: 0, shots: 0, isPlayer: true };

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
  playerPaintHits = 0;
  stopFiring();
  showKilledBy(shooterName);
  respawnEl.classList.remove('hidden');
}

function respawnPlayer() {
  playerDead = false;
  respawnEl.classList.add('hidden');
  camera.position.copy(PLAYER_SPAWN);
  player.velocityY = 0;
  playerPaintHits = 0;
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
  killfeedEl.classList.add('hidden');
  killedbyEl.classList.add('hidden');
  scoreboard.classList.add('hidden'); // re-shown on entering play
  netHudEl.classList.add('hidden');
  netStatusEl.classList.add('hidden');
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
  playerDead = false;
  respawnEl.classList.add('hidden');
  killfeedEl.classList.add('hidden');
  killedbyEl.classList.add('hidden');
  playerStats.kills = 0; playerStats.deaths = 0; playerStats.shots = 0;
  if (bots.enabled) bots.respawnAll(); // resets scores + stats, respawns teams
  camera.position.copy(PLAYER_SPAWN);
  player.velocityY = 0;
  playerPaintHits = 0;
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

document.getElementById('play-btn').addEventListener('click', () => {
  // fresh single-player match on first Play; resume if paused mid-match
  if (!netplay.active && !sessionLive) {
    bots.setEnabled(guiState.bots5v5);
    resetMatch();
  }
  controls.lock();
});
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
  const m = Math.floor(secondsLeft / 60);
  const s = Math.max(0, secondsLeft % 60);
  netStatusEl.classList.remove('hidden');
  netStatusEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
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
  onRosterChange: () => { updateNetHud(); renderLobby(); },
  onStart: () => startNetMatchLocal(),  // clients: (re)start — fresh scoreline
  onClock: (secondsLeft) => setNetClock(secondsLeft),
  onMatchEnd: (winner, scores, rows) => showOnlineResult(winner, scores, rows),
  getLocalStats: () => ({ kills: playerStats.kills, deaths: playerStats.deaths, shots: playerStats.shots }),
  getBotSnapshot: () => bots.netSnapshot(),
  tagBot: (idx, team) => bots.tagBotByIndex(idx, team),
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
  },
});

// host: when a real bot dies, score it for everyone
bots.onBotDown = (idx, byTeam) => {
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
  killfeedEl.classList.add('hidden');
  killedbyEl.classList.add('hidden');
  onlineResultShowing = false;
  if (controls.isLocked) controls.unlock();
  lobbyOverlay.classList.remove('hidden');
  renderLobby();
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

  bots.setEnabledCounts(blueBots, redBots); // host owns the real bot AI
  netplay.hostStart(botRoster);             // tells clients to spawn ghosts + drop in
  startNetMatchLocal();
}

// Fresh start of a net match: wipe my scoreline, spawn on my team's side.
function startNetMatchLocal() {
  playerStats.kills = 0; playerStats.deaths = 0; playerStats.shots = 0;
  playerDead = false;
  respawnEl.classList.add('hidden');
  killfeedEl.classList.add('hidden');
  killedbyEl.classList.add('hidden');
  camera.position.set(0, 1.7, netplay.mySpawnZ());
  player.velocityY = 0;
  setNetStatusHud();
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
    await net.joinRoom(code);
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
const PLAYER_TEAM = 0; // player fights on the BLUE team
const FIRE_INTERVAL = 90; // ms — shared by player and bots
let lastShot = 0;

// Generic projectile spawner shared by the player and bots. `isPlayer` marks the
// human's shots so their impacts can stamp the custom-designed splatter.
function spawnProjectile(origin, dir, hex, team, speed = 70, isPlayer = false, shooter = null) {
  const mat = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.4 });
  const mesh = new THREE.Mesh(projGeo, mat);
  mesh.position.copy(origin);
  scene.add(mesh);
  projectiles.push({
    mesh,
    vel: dir.clone().multiplyScalar(speed),
    prev: origin.clone(),
    born: performance.now(),
    hex,
    team,
    isPlayer,
    shooter,
  });
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
  spawnProjectile(origin, _forward.clone(), hex, PLAYER_TEAM, 70, true, playerStats);
  playerStats.shots++;
  weapon.kick();
  netplay.sendShot(origin, _forward, hex); // no-op unless an online match is live
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
function applyAimZoom() {
  const base = settings ? settings.get('fov') : 75;
  const fov = THREE.MathUtils.lerp(base, weapon.aimFov, weapon.aimT);
  if (Math.abs(fov - _lastFov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
    _lastFov = fov;
  }
  const sens = settings ? settings.get('mouseSensitivity') : 1;
  controls.pointerSpeed = sens * THREE.MathUtils.lerp(1, 0.55, weapon.aimT);
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

function updateProjectiles(dt) {
  const PROJ_GRAV = -12;
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.prev.copy(p.mesh.position);
    p.vel.y += PROJ_GRAV * dt;
    p.mesh.position.addScaledVector(p.vel, dt);

    const seg = new THREE.Vector3().subVectors(p.mesh.position, p.prev);
    const dist = seg.length();
    if (dist > 1e-5) {
      const dir = seg.clone().normalize();

      // Relayed shots from other players are visual only — the authoritative
      // shooter already resolved their hits. Skip combatant detection; still
      // let them splat on walls below.
      const isNetGhost = p.shooter && p.shooter.netGhost;

      // online: MY shots test against remote players + the host's ghost bots
      if (p.isPlayer && netplay.active) {
        const victim = netplay.testHit(p.prev, dir, dist + 0.13);
        if (victim) {
          audio.play('bodyHit', { volume: 0.9, rate: 0.96 + Math.random() * 0.08 });
          showKill(victim.name);
          playerStats.kills++;
          if (victim.kind === 'bot') netplay.sendBotHit(victim.index);
          else netplay.sendTag(victim.id, p.hex);
          removeProjectile(i);
          continue;
        }
      }

      // host: my bots' paintballs can tag remote human players
      if (!isNetGhost && !p.isPlayer && netplay.isHost && netplay.active) {
        const rv = netplay.hostTestRemoteHit(p.prev, dir, dist + 0.13, p.team);
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
        const hitResult = bots.hitscanPaint(p.prev, dir, dist + 0.13, p.team, guiState.paintKillThreshold, p.hex);
        if (hitResult) {
          removeProjectile(i);
          continue;
        }
      } else {
        // Normal mode: instant tag on hit
        if (bots.hitscan(p.prev, dir, dist + 0.13, p.team, p.hex, p.shooter)) {
          removeProjectile(i);
          continue;
        }
      }

      raycaster.set(p.prev, dir);
      raycaster.far = dist + 0.13;
      const hits = raycaster.intersectObjects(arena.paintTargets, false);
      if (hits.length) {
        const h = hits[0];
        const n = h.face
          ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
          : new THREE.Vector3(0, 1, 0);
        paint.splat(h.object, h.point, n, p.hex, 1, p.isPlayer);
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
const splatNumEl = document.getElementById('splat-num');

function setColor(i) {
  colorIndex = i;
  const c = COLORS[i];
  swatchEl.style.background = '#' + c.hex.toString(16).padStart(6, '0');
  nameEl.textContent = c.name;
  weapon.setPaintColor(c.hex); // hopper balls match the selected paint
  guiState.paintColor = c.name;
  colorCtrl.updateDisplay();
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
  // bots
  bots5v5: true,
  // invisible mode
  invisibleMode: false,
  paintKillThreshold: 5,
};

function applyEnvironment() {
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
// GUI
// ---------------------------------------------------------------------------
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

const fPaint = gui.addFolder('Paint');
const colorCtrl = fPaint.add(guiState, 'paintColor', COLORS.map(c => c.name)).name('Color')
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

// keep dev panel from stealing pointer-lock clicks
gui.domElement.addEventListener('mousedown', e => e.stopPropagation());

setColor(1); // start on BLUE (the player's team color)
// bots stay OFF until a match actually starts — no phantom battle raging
// behind the title screen and menus

// ---------------------------------------------------------------------------
// Player-facing Settings (persisted) + dev-only panel toggle.
// The lil-gui Dev Panel is for deep tuning only, so it starts hidden and is
// summoned with the backtick key; players use the Settings menu instead.
// ---------------------------------------------------------------------------
const settings = new Settings();
settings.buildUI(document.getElementById('settings-body'));
settings.apply({ controls, player, camera, match, audio, weapon });

// Custom splatter designer (loads any saved design into the paint system)
const splatDesigner = new SplatDesigner(paint, COLORS);
document.getElementById('open-splat-btn').addEventListener('click', () => splatDesigner.show());

gui.hide();
let devPanelVisible = false;
document.addEventListener('keydown', (e) => {
  if (e.code === 'Backquote') {
    devPanelVisible = !devPanelVisible;
    if (devPanelVisible) gui.show(); else gui.hide();
  }
});

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  outline.setSize(w, h);
});

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  input.poll();

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

  if (active && !playerDead) {
    const crouchPress = input.consumeCrouch();
    player.update(
      dt,
      {
        forward: input.move.forward, strafe: input.move.strafe, sprint: input.sprint,
        crouchPress, crouchHeld: input.crouchHeld,
      },
      input.look);
    if (input.consumeJump() && player.jump()) audio.play('jump', { volume: 0.7 });
    const cd = input.consumeColorDelta();
    if (cd) setColor((colorIndex + cd + COLORS.length) % COLORS.length);
    updateShooting();
    updateSlideSound();
    weapon.update(dt, input.aimHeld, settings.get('fov'));
    applyAimZoom();
    updateSun();
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
    respawnCountEl.textContent = Math.max(1, Math.ceil(playerRespawnMs / 1000));
    if (playerRespawnMs <= 0) respawnPlayer();
  } else {
    input.consumeJump();
    input.consumeCrouch();
    input.consumeColorDelta();
    if (gunLoop || shootWasHeld) stopFiring(); // paused / match over
    stopSlideSound();
  }

  audio.updateListener(camera); // keep 3D audio anchored to the view

  netplay.update(dt); // sync remote players (no-op when offline)

  // the world only simulates during play — menus and match-end freeze it
  const frozen = match.over || netplay.matchOver;
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
  paint.update(dt);
  splatNumEl.textContent = paint.count;

  if (netplay.active) {
    // online skirmish: live team tag totals (endless — no match end in v1)
    scoreBlueEl.textContent = netplay.scores[0];
    scoreRedEl.textContent = netplay.scores[1];
  } else if (bots.enabled) {
    scoreBlueEl.textContent = bots.scores[0];
    scoreRedEl.textContent = bots.scores[1];
    if (!match.over) {
      if (bots.scores[0] >= match.target) endMatch(0);
      else if (bots.scores[1] >= match.target) endMatch(1);
    }
  }

  outline.render();
}
animate();

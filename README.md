# WhiteOut Paintball — Prototype

A Three.js/WebGL prototype proving the core mechanic: a clean **white test arena**
that becomes covered in **colorful paint splatters** through combat, with a faint
**contour outline** system keeping geometry readable.

## Run

No build step, and **no network at runtime** — `three`, its addons, and `lil-gui`
are vendored under `vendor/` and wired through the importmap, so the game runs
fully offline (and inside the itch.io sandbox). Serve the folder with any static
server (needed for ES modules):

```bash
python3 -m http.server 5178
# then open http://localhost:5178
```

## Controls

### Keyboard + mouse

| Input | Action |
|-------|--------|
| `W A S D` / arrows | Move |
| Mouse | Look (click **Play** to lock pointer) |
| Left click | Shoot paintball |
| `Space` | Jump (climb ramps/crates) |
| `Shift` | Sprint |
| `Ctrl` / `C` | Stance: **tap** steps up (prone→crouch→stand), **hold** steps down (stand→crouch→prone). Sprint + tap = slide, sprint + hold = dive |
| Right click | Aim / zoom |
| `1`–`6` | Switch paint color |
| `Esc` | Release mouse |

### Xbox / standard gamepad

| Input | Action |
|-------|--------|
| Left stick | Move |
| Right stick | Look |
| RT | Shoot |
| A | Jump |
| B | Stance (tap up / hold down) · sprint + tap = slide · sprint + hold = dive |
| LT | Aim / zoom |
| LB / RB | Previous / next paint color |
| Start / A | Begin session (no pointer lock needed) |
| L3 | Sprint |

## Match flow

Bots play 5v5; the first team to reach the **Score to Win** target (default 25
tags, set in Settings) wins. A **game-over screen** shows the result and final
score with **Play Again** (resets scores + positions and drops you back in).

## Sound

- **Single shot** — every shot plays the crisp one-shot clip while tapping.
- **Held fire** — the gun fires at a steady rate the whole time you hold; after
  ~200ms a sustained gun-fire loop takes over from the one-shot clips (they
  overlap so there's no gap), and it stops the instant you release.
- **Slide** — a seamless synthesized scrape that loops for exactly as long as the
  slide lasts, so it still covers the full duration if you raise **Slide Duration**.
- **Splat** — paintball impacts play a splat, quieter with distance.
- **Jump** — plays on liftoff.
- **Enemy fire** — bot shots are 3D-positional (panned + distance-attenuated)
  with a voice cap, so a firefight stays readable instead of turning to mush.

- **Body hit** — a wet splat plays whenever a paintball tags a player (positional
  for bots, full volume when it's you).

Master Volume lives in Settings.

## The marker (paintball gun)

A first-person marker viewmodel: barrel with porting, receiver, rail + iron
sights, grip, trigger guard, air tank, and a **clear hopper loaded with
paintballs that match your selected paint colour**.

- **Real ball physics** — the paintballs are rigid spheres run by a small
  self-contained solver (`src/hopperPhysics.js`; no physics library). The hopper
  is simulated in its own local space against a static bin while the *gravity
  vector* is rotated each frame, so tilting your view tumbles the balls and
  moving sloshes them, without fighting the fact that the hopper is bolted to a
  moving camera. Rendered as one `InstancedMesh`, so a full hopper is ~1 draw call.
- **Aim / zoom** — right mouse (gamepad `LT`) zooms in. The marker **cants**
  as it comes up so the loader tips out of the sight line, the same thing real
  players do; the loader also rides an angled feedneck so it starts off-axis.
  The viewmodel is scaled inversely to the zoom so it doesn't balloon at low FOV.

Tune all of it live in the Dev Panel under **Weapon / Aim** (hip + aim position,
cant angle, zoom FOV, aim speed, recoil).

## Scoring & the combat report

Tagging someone flashes **KILLED <name>** under your crosshair. Every combatant
tracks kills, deaths and paintballs fired, and the game-over screen shows a full
**after-action combat report** — all ten players ranked by kills, with your row
highlighted. Other players visibly carry their own markers, loaded in their
team's colour.

## Title & menu

The game opens on a **cover title screen** (`assets/CoverPhoto.jpg`) with a **START**
button — clicking it splats paint onto the button, then reveals the main menu:
**Play**, **Find Public Server**, **Find Private Server**, **Design Splat**,
**Settings**, **How to Play**.

## Multiplayer (v1: drop-in PvP skirmish)

Players host their own games — **Find Public Server** browses public rooms (name,
player count, Join), and **Find Private Server** hosts a room with a shareable
**5-char code** or joins one. Connections are **WebRTC peer-to-peer** (star
topology: everyone connects to the host, who relays), brokered by the tiny
signaling server in `server/`.

**Lobby + bot backfill:** hosting opens a **lobby** (room code, roster, player
count). The host starts the match whenever they want; any empty slots up to 5v5
**fill with bots** the host simulates and syncs to everyone. Joiners wait in the
lobby (or drop straight in if the match is already running).

**Win condition:** in the lobby the host picks **Score limit** (first team to N
tags) or **Time limit** (match ends after M minutes); it's synced to everyone and
shown in the HUD (target, or a live countdown). When it's met the host ends the
match authoritatively and everyone sees the **combat report** (per-player K/D/shots,
winner, final score) → Back to Menu.

What syncs in v1: player positions/look (12Hz + smoothing), shots (real colored
projectiles), tags (paint-hit + respawn + shared team score + kill feed), and the
host's bots (position/state + kills, resolved host-authoritatively). Teams alternate
as players join. Room code + player count + match status show in a HUD pill top-right.

**Online is LIVE:** the signaling server is deployed at
`wss://whiteout-signal.onrender.com` (Render free tier, via `render.yaml` in this
repo) and `DEFAULT_SIGNAL_URL` in `src/net.js` points at it. TURN relay is
configured (Open Relay community servers) for players behind strict NATs — for
guaranteed relay capacity, swap in free metered.ca credentials in `net.js`.
For local dev against a local server: `cd server && npm start`, then open the
game with `?signal=ws://localhost:8765`.

Known v1 limits: Render's free tier sleeps after ~15 min idle (first player to
open the browser wakes it, ~30–60s), community TURN is best-effort, a
backgrounded host tab throttles updates, and match flow/combat report are
single-player only.

## Design Your Splat

From the main menu, **Design Splat** opens a painting canvas at the same
resolution as the generated splat textures (256px). Paint with the game palette
(plus black, white, an eraser and a brush-size slider) on a transparent
background, hit **Save & Use**, and your artwork becomes the splatter your
paintballs stamp in the world — full color, randomly rotated per hit. Saved to
`localStorage`; **Default Splats** reverts to the generated blobs. Bots keep the
default team-colored splats.

## Settings menu

Reachable from the start screen and the game-over screen. Persists to
`localStorage`, so choices survive reloads:

- **Master Volume** · **Mouse Sensitivity** · **Gamepad Look Speed** ·
  **Field of View** · **Aim Zoom (FOV)** · **Score to Win**

## Dev Panel (press `` ` ``)

Hidden by default — press the backtick key in-game to toggle it. This is the
deep-tuning panel for development, not player-facing settings.

- **Outline** — strength, thickness, color, depth/normal edge sensitivity
- **Paint** — color, splat size + variation, opacity, fade toggle + lifetime, **drips (toggle + amount + length)**, clear all
- **Environment** — contrast (tone-mapping exposure), shadow intensity
- **Player / Controls** — move speed, sprint speed, gamepad look sensitivity
- **Bots (5v5)** — enable/disable 5v5, respawn teams

## Structure

- `index.html` — shell, importmap (three + lil-gui vendored locally), HUD/overlays
- `styles.css` — UI styling
- `vendor/` — bundled `three` (+ addons) and `lil-gui`, so nothing loads from a CDN
- `src/weapon.js` — **marker viewmodel**: model, hopper, aim/cant, recoil
- `src/hopperPhysics.js` — **ball sim**: sphere/sphere + bin collision in hopper space
- `assets/` — sound clips (WAV)
- `src/settings.js` — **settings**: player options + `localStorage` persistence + menu UI
- `src/audio.js` — **audio**: WebAudio clip player (one-shots + loops, master volume)
- `src/arena.js` — **map objects**: white arena floor, walls, ramps, crates, pillars, barriers + colliders
- `src/paint.js` — **paint system**: splatters (canvas blob textures + `DecalGeometry` projection)
- `src/outline.js` — **outline system**: screen-space contour via depth + normal edge detection
- `src/player.js` — **player controller**: movement, gravity/jump, collision, look
- `src/input.js` — **input**: unified keyboard + mouse + Xbox gamepad state
- `src/bots.js` — **bots**: 5v5 team AI (movement, targeting, firing, tagging, scoring)
- `src/main.js` — orchestrator: renderer, lights, systems wiring, GUI, loop

Each system is isolated so it can be iterated on independently.

## How the key systems work

- **Splatters** are projected onto the exact hit mesh with `DecalGeometry`, so paint
  wraps to the surface and looks stuck. Each splat gets a random blob texture, random
  roll, and randomized scale.
- **Outline** renders the scene once with a normal material into a buffer (plus depth
  texture), then a full-screen pass blends a faint gray contour wherever depth/normal
  discontinuities occur — readable without looking cartoonish.

## Not included (intentionally)

Matchmaking, multiplayer, inventory, map streaming, menus — this prototype is only
about proving the paint-the-white-world feel.

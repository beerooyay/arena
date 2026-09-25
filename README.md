# Free Fire Arena

A fast, enclosed-octagon team deathmatch shooter built on Three.js/WebGL.
Two squads — **FIRE** (`#FF6000`) and **WHITE** (`#F4F6F8`) — fight in a compact
walled arena with a high trussed ceiling, a central pillar, and four low cover
pieces. No build step, no runtime CDN dependencies.

Repurposed from the WhiteOut Paintball engine: same movement, netcode, and bot
framework — new branding, weapons, arena, and ruleset.

## Run

```bash
python3 devserver.py     # static server with no-cache headers
# then open http://localhost:5178
```

Any static file server works — ES modules just need HTTP, not `file://`.
Same-network players can join via `http://<your-lan-ip>:5178`.

## Match modes

- **Squad size** — 4v4, 3v3, or 2v2
- **Ruleset** — Free Fire (both weapons), Rifle Only, or Rocket Only
- **Score limit** — 15 / 25 / 40 eliminations
- **Team deathmatch** is the launch mode; more to come

## Weapons

| Weapon | Behavior |
|--------|----------|
| Battle rifle | Semi-auto tracer rounds. One-shot headshots, two body shots. Precision scope + sniper reticle on aim. Fires from the top barrel. |
| Twin rocket | Two rockets per loadout, alternating lower barrels, then an automatic 2.4s reload. Radial blast damage, smoke trail, lit exhaust. |

Swap with `Q` (or the weapon HUD) in Free Fire.

## Controls

| Input | Action |
|-------|--------|
| `W A S D` | Move |
| Mouse | Look (click Play to lock pointer) |
| Left click | Fire |
| Right click | Aim / scope |
| `Q` | Swap weapon |
| `Space` | Jump |
| `Shift` | Sprint |
| `Ctrl` / `C` | Stance — tap steps up, hold steps down; sprint + tap = slide, sprint + hold = dive |
| `Esc` | Pause / release mouse |

Standard Xbox-style gamepads are supported (left stick move, right stick look,
RT fire, LT aim, Start pause).

## Characters & combat

Armored soldiers — black plates for FIRE, white plates over a graphite
undersuit for WHITE — with glowing orange V-visors, flame shoulder emblems, and
the twin-tube rifle gripped two-handed (arms are posed by a small IK solve). Legs and arms swing through a real walk cycle, and kills topple a
ragdoll that stays down until respawn. Players have 100 HP with regen; hits
flash a team-colored edge vignette.

## Lights Out

Toggle night mode from the HUD: the arena drops to dark neutrals with orange
and crimson emissive accents, glowing tracers, and lit rocket exhausts.

## Multiplayer

WebRTC peer-to-peer with host-authoritative bots filling empty slots, a lobby
with a shareable room code, public server list, and a synced scoreboard +
kill feed. Signaling runs through the tiny server in `server/` (see
`render.yaml` / `DEFAULT_SIGNAL_URL` in `src/net.js`).

## Structure

- `index.html` — shell, importmap (vendored `three` + `lil-gui`), HUD/overlays
- `styles.css` — liquid-glass UI, HUD, scoreboard, palette
- `src/main.js` — orchestrator: renderer, lighting, match flow, projectiles, netcode wiring
- `src/outline.js` — post chain: contour outline → bloom → tone map / sRGB output
- `src/arena.js` — octagonal arena: polished tile floor, seamed wall panels, LED coves, faceted dome, pillar, cover, colliders
- `src/gunModel.js` — shared twin-tube rifle model (viewmodel + avatars), flame emblem, glow material
- `src/weapon.js` — first-person viewmodel: gloved hand, hip/ADS/sprint poses, FOV-independent framing
- `src/playerGlow.js` — shared avatar rig (bots, remotes) with limb pivots + nameplates
- `src/bots.js` — team AI: movement, targeting, walk cycle, ragdoll, scoring
- `src/player.js` — movement physics, collision, slide/dive
- `src/netplay.js` — remote avatars, ghost bots, shot/tag relay
- `src/settings.js` — player-facing settings + persistence
- `server/` — WebRTC signaling server

Legacy paintball-era systems (tanks, jet, nuke, splat decals) remain in the
tree but are inert — gated behind `LEGACY_VEHICLES` and unused in this ruleset.

## Credits

Built on Corey Bourgeois's [WhiteOut Paintball](https://github.com/ceeboozwah/WhiteOutPaintball)
engine. Free Fire Arena branding and redesign by the arena crew.

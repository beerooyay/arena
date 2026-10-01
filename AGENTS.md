# development

- this is a static browser app with vendored three.js; there is no runtime build step.
- run `python3 devserver.py` from the repository root for the no-cache server on port 5178.
- check changed javascript with `node --check <file>` and run `git diff --check`.
- verify gameplay in a browser; local-only `window.__wo` hooks can drive deterministic combat and lifecycle checks when pointer lock is unavailable. keep those hooks disabled on public hosts.
- bake avatar clips from `tools/` with `node bake-avatars.mjs --animations`; this updates animation json without rebuilding suit meshes. the full bake remains `npm run bake-avatars`.
- animation sources live in `assets/*.fbx`; ship retargeted `assets/players/anims-p1.json` and `anims-p2.json`, not the source fbx files.
- grenade toss clips are mirrored onto the support hand during retargeting; runtime throws only override that arm after locomotion and rifle grip correction.
- ragdolls use vendored cannon-es 0.20.0. after installing dependencies in `tools/`, run `node vendor.mjs` there to refresh `vendor/cannon/` and its license.
- `src/physics.js` owns the shared corpse world, arena colliders, impact impulses, and 120 hz stepping. dispose bodies and joints on avatar respawn/removal; freeze stepping with local pause and match-end state.
- keep joint twist references aligned in world space, preserve non-root bone translations, and avoid overlapping decorative wall colliders. low-energy corpses settle together rather than leaving limbs jittering.
- grenade holding freezes the toss before release; the fuse starts only on impact. cancel/refund held charges when opening menus, and relay hold/release/cancel state online.
- runtime sound effects are synthesized in `src/sfx.js`; legacy wav files are not loaded. combat, movement, ui, and ambience have separate volume buses and persistent settings.

/**
 * Copies the shipped static game into desktop/app so Electron can bundle it.
 * Keeps a single source of truth: the same files that go to itch.io are the
 * ones packaged into the desktop app. Run automatically before every build.
 */

import { rm, mkdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const dest = path.join(here, 'app');

// The exact set that ships to itch (server/, README, node_modules excluded).
const GAME_FILES = ['index.html', 'styles.css', 'src', 'assets', 'vendor'];

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });

for (const name of GAME_FILES) {
  await cp(path.join(root, name), path.join(dest, name), { recursive: true });
}

console.log(`[copy-game] copied ${GAME_FILES.length} entries into desktop/app`);

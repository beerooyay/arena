import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const source = new URL('./node_modules/cannon-es/', import.meta.url);
const target = new URL('../vendor/cannon/', import.meta.url);
fs.mkdirSync(target, { recursive: true });
for (const [from, to] of [['dist/cannon-es.js', 'cannon.js'], ['LICENSE', 'LICENSE']]) {
  fs.copyFileSync(new URL(from, source), new URL(to, target));
}
console.log(`vendored cannon-es: ${fileURLToPath(target)}`);

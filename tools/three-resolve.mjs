// Lets game modules under src/ (which import bare 'three', mapped by the
// browser importmap) resolve to tools/node_modules/three when run in Node.
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export async function resolve(specifier, context, next) {
  if (specifier === 'three' || specifier.startsWith('three/')) {
    const sub = specifier === 'three' ? 'three' : specifier;
    return { url: pathToFileURL(require.resolve(sub)).href, shortCircuit: true };
  }
  return next(specifier, context);
}

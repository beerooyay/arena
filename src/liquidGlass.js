/**
 * Apple-style liquid glass for every `.glass` element.
 *
 * The glass stays nearly clear in the middle; the backdrop is bent like a lens
 * only along the rim (content near the edge is pulled inward and magnified),
 * with a touch of chromatic dispersion. Each element gets its own SVG filter
 * whose displacement map is generated from the element's exact size and corner
 * radius, and rebuilt when it resizes.
 *
 * Chromium applies SVG filters in `backdrop-filter`; other engines keep the
 * plain blur declared in styles.css.
 */
const SVGNS = 'http://www.w3.org/2000/svg';
const RIM = 30;      // px: how far in from the edge the lensing reaches
const BEND = 46;     // feDisplacementMap scale (max shift = BEND / 2 px)
const DISPERSE = [1, 0.94, 0.88]; // per-channel bend: R, G, B

let defs = null;
let seq = 0;
const maps = new Map(); // "w×h×r" -> data URL (panels of the same size share a map)

function ensureDefs() {
  if (defs) return defs;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  defs = document.createElementNS(SVGNS, 'defs');
  svg.appendChild(defs);
  document.body.appendChild(svg);
  return defs;
}

// Signed distance to a rounded rectangle centred at the origin (negative inside).
function sdRoundRect(px, py, hw, hh, r) {
  const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// R/G encode the x/y displacement (128 = none). Inside the rim band the
// backdrop is sampled from further inward, easing to zero toward the centre.
function displacementMap(W, H, R) {
  const key = `${W}x${H}x${R}`;
  if (maps.has(key)) return maps.get(key);
  // the field is smooth, so build it at half resolution; feImage scales it up
  const S = 0.5, w = Math.max(8, Math.round(W * S)), h = Math.max(8, Math.round(H * S)), r = R * S;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const hw = w / 2, hh = h / 2;
  const band = Math.max(2, Math.min(RIM * S, Math.min(w, h) * 0.4));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hw, py = y + 0.5 - hh;
      const d = sdRoundRect(px, py, hw, hh, r);
      const t = Math.min(1, Math.max(0, -d / band)); // 0 at the rim -> 1 past the band
      let dx = 0, dy = 0;
      if (t < 1) {
        // outward normal from the SDF gradient
        const gx = sdRoundRect(px + 1, py, hw, hh, r) - sdRoundRect(px - 1, py, hw, hh, r);
        const gy = sdRoundRect(px, py + 1, hw, hh, r) - sdRoundRect(px, py - 1, hw, hh, r);
        const gl = Math.hypot(gx, gy) || 1;
        const mag = (1 - t) * (1 - t); // strongest right at the rim
        dx = (-gx / gl) * mag; dy = (-gy / gl) * mag;
      }
      const o = (y * w + x) * 4;
      img.data[o] = 128 + dx * 127;
      img.data[o + 1] = 128 + dy * 127;
      img.data[o + 2] = 128;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL('image/png');
  maps.set(key, url);
  return url;
}

function el(tag, attrs) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function buildFilter(id, w, h, r) {
  const f = el('filter', {
    id, x: 0, y: 0, width: w, height: h,
    filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse',
    'color-interpolation-filters': 'sRGB',
  });
  // the map is keyed on a 16px-rounded size (smooth field, stretched to fit) so
  // small layout shifts reuse it instead of regenerating mid-animation
  const q = (v) => Math.max(16, Math.round(v / 16) * 16);
  f.appendChild(el('feImage', { href: displacementMap(q(w), q(h), r), x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'none', result: 'map' }));
  const keep = ['1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'];
  DISPERSE.forEach((k, i) => {
    f.appendChild(el('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: BEND * k, xChannelSelector: 'R', yChannelSelector: 'G', result: `d${i}` }));
    f.appendChild(el('feColorMatrix', { in: `d${i}`, type: 'matrix', values: keep[i], result: `c${i}` }));
  });
  f.appendChild(el('feBlend', { in: 'c0', in2: 'c1', mode: 'screen', result: 'rg' }));
  f.appendChild(el('feBlend', { in: 'rg', in2: 'c2', mode: 'screen' }));
  return f;
}

function apply(node, tail) {
  const rect = node.getBoundingClientRect();
  const w = Math.round(rect.width), h = Math.round(rect.height);
  if (w < 8 || h < 8) return; // hidden
  const r = Math.min(parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0, w / 2, h / 2);
  const sig = `${w}x${h}x${r}`;
  if (node.dataset.lgSig === sig) return;
  node.dataset.lgSig = sig;
  const id = node.dataset.lgId || (node.dataset.lgId = `lg-${++seq}`);
  const old = defs.querySelector(`#${id}`);
  if (old) old.remove();
  defs.appendChild(buildFilter(id, w, h, r));
  node.style.backdropFilter = `url(#${id}) ${tail}`;
}

/** Upgrade every `.glass` element on the page (call once at boot). */
export function initLiquidGlass() {
  if (!CSS.supports('backdrop-filter', 'url(#x) blur(1px)')) return; // non-Chromium: CSS fallback
  ensureDefs();
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) apply(e.target, e.target.dataset.lgTail);
  });
  for (const node of document.querySelectorAll('.glass')) {
    // Keep the same backdrop treatment on menu and HUD glass.
    node.dataset.lgTail = 'blur(12px) saturate(135%) brightness(.55)';
    ro.observe(node);
  }
  // Pre-build the menu's filters at boot: lay the (hidden) menu out invisibly
  // for one synchronous measure so nothing is generated mid-transition.
  const menu = document.getElementById('overlay');
  if (menu && menu.classList.contains('hidden')) {
    menu.style.visibility = 'hidden';
    menu.classList.remove('hidden');
    for (const node of menu.querySelectorAll('.glass')) apply(node, node.dataset.lgTail);
    menu.classList.add('hidden');
    menu.style.visibility = '';
  }
}

/**
 * SplatDesigner
 * A main-menu modal where the player paints their own splatter on a square
 * canvas the same resolution as the generated blob textures (256px). Whatever
 * they draw (full color, transparent background) becomes their in-game paint
 * splatter. Persists to localStorage and pushes the result into the PaintSystem.
 */

const STORAGE_KEY = 'whiteout.customSplat';
const SIZE = 256; // matches the generated splat texture resolution

export class SplatDesigner {
  constructor(paint, colors) {
    this.paint = paint;
    this.colors = colors;
    this.brush = 20;
    this.color = '#' + colors[0].hex.toString(16).padStart(6, '0');
    this.erasing = false;
    this._drawing = false;
    this._last = null;
    this._build();
    this._loadSaved();
  }

  _build() {
    const overlay = document.createElement('div');
    overlay.id = 'splat-designer';
    overlay.className = 'menu-overlay hidden';

    const card = document.createElement('div');
    card.className = 'menu-card splat-card';
    card.innerHTML = `
      <h2>Design Your Splat</h2>
      <p class="tagline">Paint it here — this becomes your splatter in the game.</p>
      <div class="splat-stage"><canvas width="${SIZE}" height="${SIZE}"></canvas></div>
      <div class="splat-palette"></div>
      <label class="set-row splat-brush">
        <div class="set-head"><span class="set-name">Brush Size</span><span class="set-val">20</span></div>
        <input type="range" min="4" max="56" step="2" value="20">
      </label>
      <div class="menu-actions">
        <button class="splat-save">Save &amp; Use</button>
        <button class="splat-clear secondary-btn">Clear</button>
        <button class="splat-default secondary-btn">Default Splats</button>
        <button class="splat-cancel secondary-btn">Cancel</button>
      </div>`;
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    this.overlay = overlay;
    this.canvas = card.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';

    // palette: the game paint colors + black + white, then an eraser
    const pal = card.querySelector('.splat-palette');
    const swatches = [
      ...this.colors.map(c => '#' + c.hex.toString(16).padStart(6, '0')),
      '#111318', '#ffffff',
    ];
    this._swatchEls = [];
    for (const hex of swatches) {
      const b = document.createElement('button');
      b.className = 'splat-swatch';
      b.style.background = hex;
      b.addEventListener('click', () => this._pickColor(hex, b));
      pal.appendChild(b);
      this._swatchEls.push(b);
    }
    const eraser = document.createElement('button');
    eraser.className = 'splat-swatch splat-eraser';
    eraser.textContent = 'Erase';
    eraser.addEventListener('click', () => this._pickEraser(eraser));
    pal.appendChild(eraser);
    this._eraserEl = eraser;
    this._pickColor(this.color, this._swatchEls[1]); // start on BLUE

    // brush size slider
    const brushInput = card.querySelector('.splat-brush input');
    const brushVal = card.querySelector('.splat-brush .set-val');
    brushInput.addEventListener('input', () => {
      this.brush = parseInt(brushInput.value, 10);
      brushVal.textContent = brushInput.value;
    });

    // drawing
    const cv = this.canvas;
    cv.addEventListener('pointerdown', (e) => {
      this._drawing = true;
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* non-capturable pointer */ }
      this._last = this._pos(e);
      this._stroke(this._last, this._last);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this._drawing) return;
      const p = this._pos(e);
      this._stroke(this._last, p);
      this._last = p;
    });
    const end = () => { this._drawing = false; this._last = null; };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', end);

    // buttons
    card.querySelector('.splat-save').addEventListener('click', () => this._save());
    card.querySelector('.splat-clear').addEventListener('click', () => this._clearCanvas());
    card.querySelector('.splat-default').addEventListener('click', () => this._useDefault());
    card.querySelector('.splat-cancel').addEventListener('click', () => this.hide());
  }

  _pickColor(hex, el) {
    this.color = hex;
    this.erasing = false;
    this._markActive(el);
  }
  _pickEraser(el) {
    this.erasing = true;
    this._markActive(el);
  }
  _markActive(el) {
    for (const s of this._swatchEls) s.classList.remove('active');
    this._eraserEl.classList.remove('active');
    if (el) el.classList.add('active');
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (SIZE / r.width),
      y: (e.clientY - r.top) * (SIZE / r.height),
    };
  }

  _stroke(a, b) {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = this.erasing ? 'destination-out' : 'source-over';
    ctx.strokeStyle = this.erasing ? 'rgba(0,0,0,1)' : this.color;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = this.brush;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    // round dot so single taps register
    ctx.beginPath();
    ctx.arc(b.x, b.y, this.brush / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  _clearCanvas() {
    this.ctx.clearRect(0, 0, SIZE, SIZE);
  }

  _isBlank() {
    const d = this.ctx.getImageData(0, 0, SIZE, SIZE).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return false;
    return true;
  }

  _save() {
    if (this._isBlank()) { this._useDefault(); return; }
    const url = this.canvas.toDataURL('image/png');
    try { localStorage.setItem(STORAGE_KEY, url); } catch (e) { /* storage may be blocked */ }
    this.paint.setCustomTexture(url);
    this.hide();
  }

  _useDefault() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    this.paint.setCustomTexture(null);
    this._clearCanvas();
    this.hide();
  }

  _loadSaved() {
    let url = null;
    try { url = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    if (!url) return;
    this.paint.setCustomTexture(url);
    const img = new Image();
    img.onload = () => this.ctx.drawImage(img, 0, 0, SIZE, SIZE);
    img.src = url;
  }

  show() { this.overlay.classList.remove('hidden'); }
  hide() { this.overlay.classList.add('hidden'); }
}

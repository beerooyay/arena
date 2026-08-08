/**
 * DevRecorder — DEV-ONLY screen + audio capture. NOT part of the itch build.
 *
 * This file is dynamically imported only when DEV is true (localhost / ?dev),
 * and is excluded from the release zip, so players never receive it.
 *
 *   - Video: the whole TAB (getDisplayMedia) so the HUD, crosshair, kill feed,
 *     scoreboard etc. are all captured — muxed with the game audio -> .webm.
 *     (canvas.captureStream only grabs the WebGL canvas, missing every DOM
 *     overlay, which is why the UI was absent from clips.) Falls back to
 *     canvas-only if screen capture is denied.
 *   - Audio: just the game audio -> .webm
 *
 * Both download automatically when you stop. Uses the browser's MediaRecorder;
 * .webm is what Chrome produces and plays everywhere / imports into editors.
 */

export class DevRecorder {
  constructor(canvas, audio) {
    this.canvas = canvas;
    this.audio = audio;        // AudioManager — has .ctx (AudioContext) + .master (GainNode)
    this.videoRec = null;
    this.audioRec = null;
    this._tapNode = null;      // MediaStreamAudioDestinationNode (created lazily, kept)
    this._indicator = null;
  }

  get recordingVideo() { return !!this.videoRec; }
  get recordingAudio() { return !!this.audioRec; }

  // Tap the master bus into a MediaStream without muting the speakers.
  _audioStream() {
    const a = this.audio;
    if (!a || !a.ctx || !a.master) return null;
    if (a.ctx.state === 'suspended') a.ctx.resume();
    if (!this._tapNode) {
      this._tapNode = a.ctx.createMediaStreamDestination();
      a.master.connect(this._tapNode); // master still feeds ctx.destination too
    }
    return this._tapNode.stream;
  }

  _pickMime(list) {
    for (const t of list) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  async startVideo(fps = 60) {
    if (this.videoRec) return false;
    let stream, displayTrack = null;
    try {
      // Capture the whole tab so every DOM overlay (crosshair, HUD, scoreboard,
      // kill feed, tank sight) is included — canvas.captureStream would miss them.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: fps },
        audio: false,
        preferCurrentTab: true, // Chrome: surfaces "This Tab" as the default pick
      });
      displayTrack = stream.getVideoTracks()[0];
    } catch (e) {
      // denied / unsupported → fall back to canvas-only (records, but no UI)
      console.warn('[rec] screen capture unavailable, falling back to canvas:', e);
      if (!this.canvas.captureStream) return false;
      stream = this.canvas.captureStream(fps);
    }
    const a = this._audioStream();
    if (a) for (const t of a.getAudioTracks()) stream.addTrack(t);
    const mime = this._pickMime([
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ]);
    const rec = new MediaRecorder(stream, mime
      ? { mimeType: mime, videoBitsPerSecond: 12_000_000 }
      : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      this._download(new Blob(chunks, { type: 'video/webm' }), 'whiteout-clip', 'webm');
      if (displayTrack) displayTrack.stop(); // release the tab-share (removes the banner)
    };
    rec.start();
    this.videoRec = rec;
    // if the user hits the browser's own "Stop sharing", end the recording cleanly
    if (displayTrack) displayTrack.addEventListener('ended', () => this.stopVideo());
    this._showIndicator();
    return true;
  }

  stopVideo() {
    if (!this.videoRec) return;
    this.videoRec.stop(); // onstop downloads + releases the tab-share track
    this.videoRec = null;
    this._syncIndicator();
  }

  startAudio() {
    const a = this._audioStream();
    if (this.audioRec || !a) return false;
    const mime = this._pickMime(['audio/webm;codecs=opus', 'audio/webm']);
    const rec = new MediaRecorder(a, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => this._download(new Blob(chunks, { type: 'audio/webm' }), 'whiteout-audio', 'webm');
    rec.start();
    this.audioRec = rec;
    this._showIndicator();
    return true;
  }

  stopAudio() {
    if (!this.audioRec) return;
    this.audioRec.stop();
    this.audioRec = null;
    this._syncIndicator();
  }

  _download(blob, name, ext) {
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}-${ts}.${ext}`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  }

  // --- tiny on-screen indicator so you know capture is live ---------------
  _showIndicator() {
    if (!this._indicator) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:fixed;top:10px;right:12px;z-index:9999;display:flex;align-items:center;' +
        'gap:7px;padding:5px 10px;border-radius:6px;background:rgba(20,20,22,.72);' +
        'color:#fff;font:700 12px/1 system-ui,sans-serif;letter-spacing:.12em;pointer-events:none';
      const dot = document.createElement('span');
      dot.style.cssText = 'width:9px;height:9px;border-radius:50%;background:#ff3b3b;' +
        'animation:wo-rec-blink 1s steps(1) infinite';
      const label = document.createElement('span');
      label.className = 'wo-rec-label';
      el.append(dot, label);
      const style = document.createElement('style');
      style.textContent = '@keyframes wo-rec-blink{50%{opacity:.25}}';
      document.head.appendChild(style);
      document.body.appendChild(el);
      this._indicator = el;
    }
    this._syncIndicator();
  }

  _syncIndicator() {
    if (!this._indicator) return;
    const parts = [];
    if (this.videoRec) parts.push('VIDEO');
    if (this.audioRec) parts.push('AUDIO');
    if (!parts.length) { this._indicator.style.display = 'none'; return; }
    this._indicator.style.display = 'flex';
    this._indicator.querySelector('.wo-rec-label').textContent = 'REC ' + parts.join(' + ');
  }
}

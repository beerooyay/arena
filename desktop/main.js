/**
 * WhiteOut Paintball — desktop shell (Electron).
 *
 * Wraps the exact same static game (index.html + src + assets + vendor) in a
 * native window so it installs and runs like any other downloaded game — no
 * browser, its own icon. The game files are copied into ./app at build time
 * (see copy-game.mjs) and served here over a private `whiteout://` scheme.
 *
 * Why a custom scheme instead of file:// —
 *   • ES modules + importmap and fetch() of the .wav assets need a real,
 *     secure origin; file:// blocks fetch and is flaky for module graphs.
 *   • The origin's hostname is `app`, not localhost, so the in-game dev panel
 *     (gated on localhost) stays hidden in the shipped build automatically.
 *
 * Multiplayer is unchanged: the game still dials the Render signaling server
 * and forms WebRTC connections directly between players.
 */

const { app, BrowserWindow, protocol, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, 'app'); // the copied static game

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
};

// Register BEFORE app ready so the scheme is treated as standard + secure
// (needed for module graphs, importmap, fetch, and localStorage).
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'whiteout',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#eef0f2',
    title: 'WhiteOut Paintball',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep the sim running when unfocused
    },
  });

  win.setMenuBarVisibility(false);
  win.loadURL('whiteout://app/index.html');

  // Any window.open / external link opens in the real browser, not the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  protocol.handle('whiteout', async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    // Resolve inside ROOT and refuse anything that escapes it.
    const target = path.normalize(path.join(ROOT, pathname));
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data = await fs.promises.readFile(target);
      const ext = path.extname(target).toLowerCase();
      return new Response(data, {
        status: 200,
        headers: { 'content-type': MIME[ext] || 'application/octet-stream' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

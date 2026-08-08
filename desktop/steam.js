/**
 * Steam integration — desktop (Electron MAIN process) only.
 *
 * Thin wrapper around steamworks.js so the rest of the app stays agnostic:
 * if Steam isn't running, isn't installed, or this isn't the Steam build, every
 * call is a safe no-op and the game runs exactly like the itch/browser build.
 *
 * The renderer (the actual game) never touches this directly — it goes through
 * preload.js -> IPC -> here, keeping nodeIntegration off in the game window.
 */

const APP_ID = 5039050; // WhiteOut Paintball (Steamworks AppID)

let steamworks = null;
let client = null; // the initialised Steam client, or null when unavailable

try {
  steamworks = require('steamworks.js');
} catch (e) {
  console.warn('[steam] steamworks.js unavailable:', e.message);
}

/**
 * Append the Electron/overlay command-line switches and frame-invalidation hook.
 * MUST be called BEFORE app "ready" (it mutates the command line).
 */
function enableOverlay() {
  if (!steamworks) return;
  try {
    steamworks.electronEnableSteamOverlay();
  } catch (e) {
    console.warn('[steam] overlay setup failed:', e.message);
  }
}

/** Initialise Steam. Call once the app is ready. Returns true if connected. */
function init() {
  if (client) return true;
  if (!steamworks) return false;
  try {
    client = steamworks.init(APP_ID);
    console.log('[steam] connected — AppID', APP_ID);
    return true;
  } catch (e) {
    // Steam not running / not launched via Steam / no steam_appid.txt in dev.
    console.warn('[steam] not connected:', e.message.split('\n')[0]);
    client = null;
    return false;
  }
}

function isAvailable() {
  return !!client;
}

/** Unlock an achievement by its Steamworks API name. No-op if unavailable. */
function unlockAchievement(apiName) {
  if (!client || !apiName) return false;
  try {
    if (client.achievement.isActivated(apiName)) return true;
    return client.achievement.activate(apiName);
  } catch (e) {
    console.warn('[steam] achievement failed:', apiName, e.message);
    return false;
  }
}

module.exports = { APP_ID, enableOverlay, init, isAvailable, unlockAchievement };

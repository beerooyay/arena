/**
 * Steam bridge (game side). In the desktop Steam build, `window.steam` is
 * injected by Electron's preload; in the browser/itch build it's undefined, so
 * every function here is a silent no-op. Import and call these anywhere in the
 * game without worrying about which build is running.
 */

/** True only in the desktop build (whether or not Steam is actually connected). */
export function onSteam() {
  return typeof window !== 'undefined' && !!window.steam;
}

/** Fire-and-forget achievement unlock by its Steamworks API name. */
export function unlockAchievement(apiName) {
  try {
    window.steam?.unlock?.(apiName);
  } catch (_) { /* never let a store call break gameplay */ }
}

# WhiteOut Paintball — signaling server

This tiny Node service is what makes online multiplayer work. It keeps the list
of public rooms and introduces players to each other (WebRTC signaling); the
actual game traffic then flows browser-to-browser, not through this server.

**itch.io only hosts the static game files — it cannot run this.** Deploy it once
on any free/cheap Node host, then point the game at it.

## Run locally (for development)

```bash
cd server
npm install
npm start        # listens on ws://localhost:8765
```

The game auto-uses `ws://localhost:8765` when you play from `localhost`.

## Deploy for real (pick one)

### Render (free tier)
1. Push this `server/` folder to a GitHub repo (or a subfolder of one).
2. render.com → New → **Web Service** → connect the repo.
3. Root directory: `server` · Build: `npm install` · Start: `npm start`.
4. Render gives you `https://yourapp.onrender.com` → your signal URL is
   `wss://yourapp.onrender.com`.

### Fly.io
```bash
cd server
fly launch --no-deploy     # accept defaults; internal port 8765
fly deploy
```
Signal URL: `wss://yourapp.fly.dev`.

## Point the game at it

In `src/net.js`, set:

```js
const DEFAULT_SIGNAL_URL = 'wss://yourapp.onrender.com';
```

Then rebuild the itch zip. (You can also test any URL without rebuilding by
opening the game with `?signal=wss://yourapp.onrender.com`.)

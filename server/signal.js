/**
 * WhiteOut Paintball — signaling server.
 *
 * A tiny WebSocket service with two jobs:
 *   1. Room registry — players host public rooms (listed in the in-game server
 *      browser) or private rooms (join by 5-char code).
 *   2. WebRTC signaling — relays SDP offers/answers and ICE candidates between
 *      a room's host and its joiners so their browsers can connect directly
 *      (peer-to-peer). Game traffic never touches this server.
 *
 * Deploy anywhere that runs Node (Render / Fly / Railway — see README.md).
 * NOT part of the itch.io upload; itch only hosts the static game files.
 *
 * Protocol (JSON messages):
 *   client -> server
 *     {t:'create', public:bool, name:string}      -> {t:'created', code}
 *     {t:'list'}                                  -> {t:'rooms', rooms:[...]}
 *     {t:'join', code}                            -> {t:'join-ok', code} | {t:'join-fail', reason}
 *                                                    (host gets {t:'peer-join', id})
 *     {t:'signal', to, data}                      -> relayed as {t:'signal', from, data}
 *   server -> host on joiner disconnect: {t:'peer-leave', id}
 *   server -> joiners on host disconnect: {t:'host-gone'}
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8765;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
const MAX_PLAYERS = 10;

const rooms = new Map(); // code -> { code, name, public, host, clients: Map<id, ws> }
let nextPeerId = 1;

function makeCode() {
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0];
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function roomInfo(room) {
  return {
    code: room.code,
    name: room.name,
    players: 1 + room.clients.size,
    maxPlayers: MAX_PLAYERS,
  };
}

function closeRoom(room, reason) {
  for (const ws of room.clients.values()) send(ws, { t: 'host-gone', reason });
  rooms.delete(room.code);
}

// Plain HTTP layer so hosting platforms' health checks get a 200, with the
// WebSocket server attached on top of it.
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
});
const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, () => console.log(`[signal] listening on :${PORT}`));

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.meta = { role: null, code: null, id: null }; // what this socket is doing

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const meta = ws.meta;

    switch (msg.t) {
      case 'create': {
        if (meta.role) return; // already in a room
        const room = {
          code: makeCode(),
          name: String(msg.name || 'Paintball Match').slice(0, 32),
          public: !!msg.public,
          host: ws,
          clients: new Map(),
        };
        rooms.set(room.code, room);
        meta.role = 'host';
        meta.code = room.code;
        send(ws, { t: 'created', code: room.code });
        break;
      }

      case 'list': {
        const list = [...rooms.values()]
          .filter((r) => r.public && 1 + r.clients.size < MAX_PLAYERS)
          .slice(0, 50)
          .map(roomInfo);
        send(ws, { t: 'rooms', rooms: list });
        break;
      }

      case 'join': {
        if (meta.role) return;
        const room = rooms.get(String(msg.code || '').toUpperCase());
        if (!room) { send(ws, { t: 'join-fail', reason: 'Room not found.' }); return; }
        if (1 + room.clients.size >= MAX_PLAYERS) {
          send(ws, { t: 'join-fail', reason: 'Room is full.' });
          return;
        }
        const id = 'p' + nextPeerId++;
        meta.role = 'joiner';
        meta.code = room.code;
        meta.id = id;
        room.clients.set(id, ws);
        send(ws, { t: 'join-ok', code: room.code, id });
        send(room.host, { t: 'peer-join', id });
        break;
      }

      case 'signal': {
        const room = rooms.get(meta.code);
        if (!room) return;
        if (meta.role === 'host') {
          const target = room.clients.get(msg.to);
          send(target, { t: 'signal', from: 'host', data: msg.data });
        } else if (meta.role === 'joiner') {
          send(room.host, { t: 'signal', from: meta.id, data: msg.data });
        }
        break;
      }

      case 'leave': {
        ws.close();
        break;
      }
    }
  });

  ws.on('close', () => {
    const { role, code, id } = ws.meta;
    const room = rooms.get(code);
    if (!room) return;
    if (role === 'host') closeRoom(room, 'Host left.');
    else if (role === 'joiner') {
      room.clients.delete(id);
      send(room.host, { t: 'peer-leave', id });
    }
  });
});

// heartbeat: drop dead sockets so rooms don't linger forever
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

// ScreenShare server: rooms, members, chat and WebRTC signaling.
// Deploy this folder online (e.g. Render) so friends anywhere can join.
// Video/audio never pass through here — they go peer-to-peer with WebRTC.
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const MAX_MEMBERS = 10;

function iceServers() {
  // Full control: ICE_SERVERS='[{"urls":"stun:..."},{"urls":"turn:...","username":"..","credential":".."}]'
  if (process.env.ICE_SERVERS) {
    try { return JSON.parse(process.env.ICE_SERVERS); } catch { console.warn('Invalid ICE_SERVERS JSON'); }
  }
  const list = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS,
    });
  }
  return list;
}

const clean = (s, n) => String(s ?? '').trim().slice(0, n);
const cleanShare = (s) => (s && typeof s === 'object'
  ? { title: clean(s.title, 120) || 'Screen', audio: !!s.audio, paused: !!s.paused }
  : null);

function startServer({ port = 3000 } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1e5 });

  app.get('/config.json', (_req, res) => res.json({ iceServers: iceServers() }));
  app.get('/health', (_req, res) => res.send('ok'));
  app.use(express.static(path.join(__dirname, 'public'), { index: 'room.html' }));

  // code -> { password, ownerId, members: Map(id -> { id, name, share }) }
  const rooms = new Map();
  const pub = (m) => ({ id: m.id, name: m.name, share: m.share });
  const roomOf = (socket) => rooms.get(socket.data.room);
  const inSameRoom = (socket, otherId) => {
    const r = roomOf(socket);
    return !!(r && r.members.has(socket.id) && r.members.has(otherId));
  };

  function leave(socket) {
    const code = socket.data.room;
    const r = rooms.get(code);
    socket.data.room = null;
    if (!r) return;
    socket.leave(code);
    if (!r.members.delete(socket.id)) return;
    io.to(code).emit('member:left', socket.id);
    if (!r.members.size) return rooms.delete(code);
    if (r.ownerId === socket.id) {
      r.ownerId = r.members.keys().next().value;
      io.to(code).emit('owner', r.ownerId);
    }
  }

  io.on('connection', (socket) => {
    const noop = () => {};

    socket.on('room:join', (p = {}, ack = noop) => {
      if (typeof ack !== 'function') return;
      if (socket.data.room) leave(socket);
      const code = clean(p.room, 32).toUpperCase();
      const name = clean(p.name, 32) || 'Guest';
      const password = clean(p.password, 64);
      if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return ack({ ok: false, error: 'Room code must be 3+ letters/numbers' });

      let r = rooms.get(code);
      if (!r) {
        r = { password, ownerId: socket.id, members: new Map() };
        rooms.set(code, r);
      } else if (r.password && password !== r.password) {
        return ack({ ok: false, error: 'password' });
      } else if (r.members.size >= MAX_MEMBERS) {
        return ack({ ok: false, error: 'This room is full' });
      }

      const member = { id: socket.id, name, share: null };
      r.members.set(socket.id, member);
      socket.join(code);
      socket.data.room = code;
      socket.to(code).emit('member:joined', pub(member));
      ack({
        ok: true,
        id: socket.id,
        room: code,
        ownerId: r.ownerId,
        hasPassword: !!r.password,
        members: [...r.members.values()].map(pub),
      });
    });

    socket.on('room:leave', () => leave(socket));

    socket.on('share:update', (share) => {
      const r = roomOf(socket);
      const m = r?.members.get(socket.id);
      if (!m) return;
      m.share = cleanShare(share);
      socket.to(socket.data.room).emit('member:updated', pub(m));
    });

    // "I want to watch your stream" / "I stopped watching"
    for (const ev of ['watch', 'unwatch']) {
      socket.on(ev, ({ to } = {}) => {
        if (inSameRoom(socket, to)) io.to(to).emit(ev, { from: socket.id });
      });
    }

    socket.on('signal', ({ to, data } = {}) => {
      if (inSameRoom(socket, to)) io.to(to).emit('signal', { from: socket.id, data });
    });

    socket.on('chat', ({ text } = {}) => {
      const r = roomOf(socket);
      const m = r?.members.get(socket.id);
      text = clean(text, 500);
      if (!m || !text) return;
      io.to(socket.data.room).emit('chat', { id: m.id, name: m.name, text, ts: Date.now() });
    });

    socket.on('kick', (id) => {
      const r = roomOf(socket);
      if (!r || r.ownerId !== socket.id || id === socket.id || !r.members.has(id)) return;
      const target = io.sockets.sockets.get(id);
      if (target) {
        target.emit('kicked');
        leave(target);
      }
    });

    socket.on('disconnect', () => leave(socket));
  });

  return new Promise((resolve, reject) => {
    const tryListen = (p, attemptsLeft) => {
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) tryListen(p + 1, attemptsLeft - 1);
        else reject(err);
      };
      server.once('error', onError);
      server.listen(p, () => {
        server.removeListener('error', onError);
        resolve({ port: p, server, io });
      });
    };
    tryListen(port, 10);
  });
}

module.exports = { startServer };

if (require.main === module) {
  startServer({ port: Number(process.env.PORT) || 3000 })
    .then(({ port }) => console.log(`ScreenShare server listening on port ${port}`));
}

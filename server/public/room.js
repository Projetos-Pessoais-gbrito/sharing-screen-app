// ScreenShare room client — runs in the desktop app and in normal browsers.
// Everyone can share; everyone can watch any number of streams.
// Each stream goes directly from the sharer to each person watching it (WebRTC mesh).
const $ = (s) => document.querySelector(s);
const desktop = window.desktop || null; // present only inside the ScreenShare app

const QUALITY = {
  '720p30':  { label: '720p · 30 fps',  w: 1280, h: 720,  fps: 30, kbps: 2500 },
  '1080p30': { label: '1080p · 30 fps', w: 1920, h: 1080, fps: 30, kbps: 4500 },
  '1080p60': { label: '1080p · 60 fps', w: 1920, h: 1080, fps: 60, kbps: 8000 },
  '1440p60': { label: '1440p · 60 fps', w: 2560, h: 1440, fps: 60, kbps: 12000 },
  'source':  { label: 'Source · 60 fps', w: null, h: null, fps: 60, kbps: 16000 },
};

const S = {
  info: null,                  // desktop info (null in browsers)
  ice: [{ urls: 'stun:stun.l.google.com:19302' }],
  me: null, room: null, name: '', password: '', ownerId: null,
  members: new Map(),          // id -> { id, name, share }
  // my stream
  stream: null, sourceName: '', paused: false, muted: false,
  outgoing: new Map(),         // watcherId -> { pc, video, audio }
  // streams I watch
  watching: new Set(),         // sharer ids I want to watch
  incoming: new Map(),         // sharerId -> { pc, stream, state }
  focus: null,
  // picker
  sources: [], tab: 'screen', selectedId: null, pickFor: 'start',
};
const tiles = new Map();       // id -> DOM refs

// ---------------- helpers ----------------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const quality = () => QUALITY[$('#quality').value] || QUALITY['1080p30'];
const mode = () => $('#mode').value;
const videoTrack = () => S.stream?.getVideoTracks()[0] || null;
const audioTrack = () => S.stream?.getAudioTracks()[0] || null;
const colorFor = (id) => `hsl(${[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 55% 45%)`;
const memberName = (id) => (id === S.me ? `${S.name} (you)` : S.members.get(id)?.name || 'Someone');

const socket = io();
const emitAck = (event, payload) => new Promise((resolve) => {
  socket.timeout(8000).emit(event, payload, (err, res) =>
    resolve(err ? { ok: false, error: 'The server did not respond. Try again.' } : res));
});

// ---------------- setup ----------------
(async function init() {
  fetch('/config.json').then((r) => r.json()).then((c) => { S.ice = c.iceServers; }).catch(() => {});

  const q = $('#quality');
  for (const [key, v] of Object.entries(QUALITY)) q.append(new Option(v.label, key));
  q.value = store.get('ss-quality') || '1080p30';
  $('#mode').value = store.get('ss-mode') || 'motion';
  $('#autoWatch').checked = store.get('ss-autowatch') !== '0';

  const params = new URLSearchParams(location.search);
  $('#name').value = store.get('ss-name') || '';
  $('#room').value = (params.get('room') || '').toUpperCase();
  ($('#name').value ? ($('#room').value ? $('#password') : $('#room')) : $('#name')).focus();

  if (desktop) {
    S.info = await desktop.info();
    $('#serverRow').classList.remove('hidden');
    $('#serverLabel').textContent = S.info?.local ? 'This computer' : location.host;
    if (S.info?.audioSupported) {
      $('#audioNote').textContent = 'Sends everything your computer plays (game, music…).';
    } else {
      $('#audio').checked = false;
      $('#audio').disabled = true;
      $('#audioNote').textContent = 'Computer audio sharing is only available on Windows.';
    }
  }
})();

$('#changeServer').onclick = () => desktop?.openSettings();
$('#newRoom').onclick = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  $('#room').value = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => chars[b % chars.length]).join('');
  $('#password').focus();
};
$('#quality').onchange = () => { store.set('ss-quality', $('#quality').value); applyStreamSettings(); };
$('#mode').onchange = () => { store.set('ss-mode', mode()); applyStreamSettings(); };
$('#autoWatch').onchange = () => store.set('ss-autowatch', $('#autoWatch').checked ? '1' : '0');

// ---------------- join / leave ----------------
$('#joinForm').onsubmit = async (e) => {
  e.preventDefault();
  S.name = $('#name').value.trim();
  S.password = $('#password').value;
  store.set('ss-name', S.name);
  const btn = $('#joinForm button.primary');
  btn.disabled = true;
  const ok = await join($('#room').value.trim().toUpperCase());
  btn.disabled = false;
  if (ok) showRoom();
};

async function join(code) {
  const res = await emitAck('room:join', { room: code, name: S.name, password: S.password });
  if (!res.ok) {
    showJoinError(res.error === 'password'
      ? (S.password ? 'Wrong password.' : 'This room has a password.')
      : res.error);
    if (res.error === 'password') $('#password').focus();
    return false;
  }
  S.room = res.room;
  S.me = res.id;
  S.ownerId = res.ownerId;
  S.members = new Map(res.members.map((m) => [m.id, m]));
  $('#joinError').classList.add('hidden');
  return true;
}

function showJoinError(text) {
  $('#joinError').textContent = text;
  $('#joinError').classList.remove('hidden');
}

function showRoom() {
  $('#joinView').classList.add('hidden');
  $('#roomView').classList.remove('hidden');
  $('#roomCode').textContent = S.room;
  document.title = `${S.room} — ScreenShare`;
  history.replaceState(null, '', `?room=${encodeURIComponent(S.room)}`);
  $('#messages').replaceChildren();
  systemMessage(S.members.size === 1
    ? 'You created the room. Copy the invite and send it to your friends.'
    : 'You joined the room.');
  for (const m of S.members.values()) if (m.share && m.id !== S.me) maybeAutoWatch(m.id);
  renderAll();
}

function resetRoomState() {
  for (const id of [...S.outgoing.keys()]) closeOutgoing(id);
  for (const id of [...S.incoming.keys()]) closeIncoming(id);
  S.stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  S.stream = null;
  S.watching.clear();
  S.focus = null;
  S.room = null;
  S.me = null;
  S.members.clear();
  for (const id of [...tiles.keys()]) removeTile(id);
}

function leaveRoom(message) {
  socket.emit('room:leave');
  resetRoomState();
  $('#roomView').classList.add('hidden');
  $('#joinView').classList.remove('hidden');
  closePicker();
  history.replaceState(null, '', location.pathname);
  document.title = 'ScreenShare';
  if (message) showJoinError(message);
}
$('#leaveBtn').onclick = () => leaveRoom();

// Reconnect: the server forgot us, so join again and restore what we were doing
socket.on('disconnect', () => { if (S.room) toast('Connection lost — reconnecting…', 10000); });
socket.on('connect', async () => {
  if (!S.room) return;
  const code = S.room;
  const wasWatching = [...S.watching];
  for (const id of [...S.outgoing.keys()]) closeOutgoing(id);
  for (const id of [...S.incoming.keys()]) closeIncoming(id);
  if (!(await join(code))) return leaveRoom('Could not rejoin the room.');
  toast('Reconnected');
  if (S.stream) announceShare();
  S.watching = new Set(wasWatching.filter((id) => S.members.get(id)?.share));
  for (const id of S.watching) socket.emit('watch', { to: id });
  renderAll();
});

// ---------------- room events ----------------
socket.on('member:joined', (m) => {
  S.members.set(m.id, m);
  systemMessage(`${m.name} joined`);
  renderMembers();
});

socket.on('member:left', (id) => {
  const m = S.members.get(id);
  if (!m) return;
  S.members.delete(id);
  closeOutgoing(id);
  stopWatchingLocal(id);
  systemMessage(`${m.name} left`);
  renderAll();
});

socket.on('member:updated', (m) => {
  const before = S.members.get(m.id);
  S.members.set(m.id, m);
  if (!m.share) {
    if (before?.share) systemMessage(`${m.name} stopped sharing`);
    stopWatchingLocal(m.id);
  } else if (!before?.share) {
    systemMessage(`${m.name} started sharing ${m.share.title}`);
    maybeAutoWatch(m.id);
  }
  renderAll();
});

socket.on('owner', (id) => {
  S.ownerId = id;
  if (id === S.me) systemMessage('You are now the room owner.');
  renderMembers();
});

socket.on('kicked', () => leaveRoom('You were removed from the room by the owner.'));

// ---------------- chat ----------------
socket.on('chat', ({ id, name, text }) => {
  const box = $('#messages');
  const m = el('div', 'msg');
  const b = el('b', null, id === S.me ? `${name} (you)` : name);
  b.style.color = colorFor(id);
  m.append(b, document.createTextNode(text));
  box.append(m);
  box.scrollTop = box.scrollHeight;
});
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  socket.emit('chat', { text });
  $('#chatInput').value = '';
};
function systemMessage(text) {
  const box = $('#messages');
  box.append(el('div', 'msg system', text));
  box.scrollTop = box.scrollHeight;
}

$('#copyInvite').onclick = async () => {
  let base = location.origin;
  // In local mode "localhost" means nothing to others: use this computer's network address
  if (S.info?.local && S.info.addresses?.length) base = `http://${S.info.addresses[0]}:${S.info.port}`;
  const link = `${base}/?room=${encodeURIComponent(S.room)}`;
  try {
    if (desktop) await desktop.copy(link);
    else await navigator.clipboard.writeText(link);
    toast(`Invite copied: ${link}`);
  } catch {
    prompt('Copy this invite link:', link);
  }
};

// ---------------- sharing my screen ----------------
$('#shareBtn').onclick = () => (S.stream ? stopShare() : openPicker('start'));
$('#changeBtn').onclick = () => openPicker('switch');
$('#pauseBtn').onclick = () => { S.paused = !S.paused; applyPauseMute(); announceShare(); renderAll(); };
$('#muteBtn').onclick = () => { S.muted = !S.muted; applyPauseMute(); announceShare(); renderAll(); };

async function openPicker(purpose) {
  S.pickFor = purpose;
  if (!desktop) return shareSource(null); // browsers show their own picker
  $('#goBtn').textContent = purpose === 'switch' ? 'Switch to this' : 'Share';
  $('#pickerModal').classList.remove('hidden');
  await refreshSources();
}
function closePicker() { $('#pickerModal').classList.add('hidden'); }
$('#cancelPick').onclick = closePicker;
$('#pickerModal').onclick = (e) => { if (e.target.id === 'pickerModal') closePicker(); };
$('#goBtn').onclick = () => S.selectedId && shareSource(S.selectedId);
$('#refreshBtn').onclick = refreshSources;
document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    S.tab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    renderSources();
  };
});

async function refreshSources() {
  $('#refreshBtn').disabled = true;
  try {
    S.sources = await desktop.listSources();
    if (!S.sources.some((s) => s.id === S.selectedId)) S.selectedId = null;
  } catch (e) {
    toast('Could not list screens: ' + e.message);
  }
  $('#refreshBtn').disabled = false;
  renderSources();
}

function renderSources() {
  const grid = $('#sourceGrid');
  grid.replaceChildren();
  const list = S.sources.filter((s) => s.kind === S.tab);
  if (!list.length) grid.append(el('p', 'empty', 'Nothing found here. Try Refresh.'));
  for (const s of list) {
    const card = el('button', 'source' + (s.id === S.selectedId ? ' selected' : ''));
    const thumb = el('div', 'thumb', s.thumbnail ? null : 'No preview');
    if (s.thumbnail) thumb.style.backgroundImage = `url("${s.thumbnail}")`;
    const name = el('div', 'source-name');
    if (s.icon) { const img = el('img'); img.src = s.icon; name.append(img); }
    name.append(el('span', null, s.name));
    card.append(thumb, name);
    card.title = s.name;
    card.onclick = () => { S.selectedId = s.id; renderSources(); };
    card.ondblclick = () => { S.selectedId = s.id; shareSource(s.id); };
    grid.append(card);
  }
  $('#goBtn').disabled = !S.selectedId;
}

async function capture(sourceId) {
  const q = quality();
  let wantAudio = true; // browsers: Chrome/Edge show a "share audio" checkbox
  if (desktop) {
    wantAudio = $('#audio').checked && !!S.info?.audioSupported;
    await desktop.selectSource(sourceId, wantAudio);
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: q.fps } },
    audio: wantAudio,
  });
  const v = stream.getVideoTracks()[0];
  v.contentHint = mode();
  await applyTrackQuality(v);
  return stream;
}

async function applyTrackQuality(track) {
  if (!track) return;
  const q = quality();
  const c = { frameRate: { max: q.fps } };
  if (q.w) { c.width = { max: q.w }; c.height = { max: q.h }; }
  try { await track.applyConstraints(c); } catch (e) { console.warn('applyConstraints', e); }
}

function nameForSource(sourceId, stream) {
  const fromPicker = S.sources.find((s) => s.id === sourceId)?.name;
  if (fromPicker) return fromPicker;
  const label = stream.getVideoTracks()[0]?.label || '';
  return /^(screen|window|web-contents)/i.test(label) || !label ? 'Screen' : label;
}

async function shareSource(sourceId) {
  const switching = S.pickFor === 'switch' && S.stream;
  $('#goBtn').disabled = true;
  let next;
  try {
    next = await capture(sourceId);
  } catch (e) {
    $('#goBtn').disabled = !S.selectedId;
    if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast('Could not capture: ' + e.message);
    return;
  }
  closePicker();
  const old = S.stream;
  S.stream = next;
  S.sourceName = nameForSource(sourceId, next);
  if (!switching) { S.paused = false; S.muted = false; }
  applyPauseMute();
  next.getVideoTracks()[0].onended = () => {
    if (S.stream !== next) return;
    toast('The shared window was closed.');
    stopShare();
  };
  if (switching) {
    await Promise.all([...S.outgoing.values()].map(attachTracks));
    old.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  } else if (desktop && $('#audio').checked && !audioTrack()) {
    toast('No audio was captured — sharing video only.');
  }
  guardAgainstEcho();
  announceShare();
  renderAll();
}

function stopShare() {
  for (const id of [...S.outgoing.keys()]) closeOutgoing(id);
  S.stream?.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  S.stream = null;
  if (S.focus === S.me) S.focus = null;
  announceShare();
  renderAll();
}

function announceShare() {
  socket.emit('share:update', S.stream
    ? { title: S.sourceName, audio: !!audioTrack() && !S.muted, paused: S.paused }
    : null);
}

function applyPauseMute() {
  const v = videoTrack(), a = audioTrack();
  if (v) v.enabled = !S.paused;
  if (a) a.enabled = !S.muted;
}

async function applyStreamSettings() {
  const v = videoTrack();
  if (!v) return;
  v.contentHint = mode();
  await applyTrackQuality(v);
  for (const peer of S.outgoing.values()) await tuneSender(peer.video.sender);
  toast('Stream settings updated');
}

// Computer audio ("loopback") records everything your PC plays — including the friends'
// streams you're watching. Mute those so their sound isn't sent back to everyone.
function sharingComputerAudio() {
  return !!(desktop && audioTrack() && !S.muted);
}
function guardAgainstEcho() {
  if (!sharingComputerAudio()) return;
  let mutedAny = false;
  for (const [id, t] of tiles) {
    if (id !== S.me && !t.video.muted) { t.video.muted = true; mutedAny = true; updateTile(id); }
  }
  if (mutedAny) toast("Muted the streams you're watching so their sound isn't sent back through your computer audio.", 6000);
}

// ---------------- WebRTC: sending my stream ----------------
socket.on('watch', ({ from }) => {
  if (!S.stream || !S.members.has(from)) return;
  createOutgoing(from).catch((e) => console.error('outgoing', e));
});
socket.on('unwatch', ({ from }) => { closeOutgoing(from); renderMyStats(); });

async function createOutgoing(id) {
  closeOutgoing(id);
  const pc = new RTCPeerConnection({ iceServers: S.ice });
  const peer = {
    pc,
    video: pc.addTransceiver('video', { direction: 'sendonly' }),
    audio: pc.addTransceiver('audio', { direction: 'sendonly' }),
  };
  S.outgoing.set(id, peer);
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: id, data: { dir: 'toViewer', candidate: e.candidate.toJSON() } });
  };
  await attachTracks(peer);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: id, data: { dir: 'toViewer', sdp: { type: offer.type, sdp: offer.sdp } } });
}

async function attachTracks(peer) {
  await peer.video.sender.replaceTrack(videoTrack());
  await peer.audio.sender.replaceTrack(audioTrack());
}

async function tuneSender(sender) {
  const q = quality();
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) return;
  p.encodings[0].maxBitrate = q.kbps * 1000;
  p.encodings[0].maxFramerate = q.fps;
  p.degradationPreference = mode() === 'motion' ? 'maintain-framerate' : 'maintain-resolution';
  try {
    await sender.setParameters(p);
  } catch {
    delete p.degradationPreference;
    try { await sender.setParameters(p); } catch (e) { console.warn('setParameters', e); }
  }
}

function closeOutgoing(id) {
  S.outgoing.get(id)?.pc.close();
  S.outgoing.delete(id);
}

// ---------------- WebRTC: watching others ----------------
function maybeAutoWatch(id) {
  if ($('#autoWatch').checked) watch(id);
}

function watch(id) {
  if (id === S.me || !S.members.get(id)?.share || S.watching.has(id)) return;
  S.watching.add(id);
  socket.emit('watch', { to: id });
  renderAll();
}

function unwatch(id) {
  if (!S.watching.has(id)) return;
  socket.emit('unwatch', { to: id });
  stopWatchingLocal(id);
  renderAll();
}

function stopWatchingLocal(id) {
  S.watching.delete(id);
  closeIncoming(id);
  if (S.focus === id) S.focus = null;
}

function closeIncoming(id) {
  S.incoming.get(id)?.pc.close();
  S.incoming.delete(id);
}

async function setupIncoming(from, sdp) {
  if (!S.watching.has(from)) { socket.emit('unwatch', { to: from }); return; }
  closeIncoming(from);
  const pc = new RTCPeerConnection({ iceServers: S.ice });
  const entry = { pc, stream: new MediaStream(), state: 'connecting' };
  S.incoming.set(from, entry);
  pc.ontrack = (e) => {
    entry.stream.addTrack(e.track);
    updateTile(from);
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: from, data: { dir: 'toSharer', candidate: e.candidate.toJSON() } });
  };
  pc.onconnectionstatechange = () => {
    if (S.incoming.get(from) !== entry) return;
    entry.state = pc.connectionState;
    updateTile(from);
  };
  await pc.setRemoteDescription(sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('signal', { to: from, data: { dir: 'toSharer', sdp: { type: answer.type, sdp: answer.sdp } } });
  updateTile(from);
}

// Handle signals one at a time so ICE candidates never arrive before their offer/answer
let signalQueue = Promise.resolve();
socket.on('signal', (msg) => {
  signalQueue = signalQueue.then(() => handleSignal(msg)).catch((e) => console.error('signal', e));
});

async function handleSignal({ from, data }) {
  if (data.dir === 'toViewer') {          // from someone whose stream I watch
    if (data.sdp) return setupIncoming(from, data.sdp);
    const entry = S.incoming.get(from);
    if (entry && data.candidate) await entry.pc.addIceCandidate(data.candidate);
  } else if (data.dir === 'toSharer') {   // from someone watching my stream
    const peer = S.outgoing.get(from);
    if (!peer) return;
    if (data.sdp) {
      await peer.pc.setRemoteDescription(data.sdp);
      await tuneSender(peer.video.sender);
      renderMyStats();
    } else if (data.candidate) {
      await peer.pc.addIceCandidate(data.candidate);
    }
  }
}

// ---------------- tiles (stream views) ----------------
function createTile(id) {
  const root = el('div', 'tile');
  const video = el('video');
  video.autoplay = true;
  video.playsInline = true;
  const cover = el('div', 'tile-cover');
  const badge = el('div', 'tile-badge', 'LIVE');
  const bar = el('div', 'tile-bar');
  const nameEl = el('span', 'tile-name');
  const statsEl = el('span', 'tile-stats');
  const muteBtn = el('button', null, '🔊');
  const vol = el('input');
  vol.type = 'range'; vol.min = 0; vol.max = 1; vol.step = 0.05; vol.value = 1;
  const focusBtn = el('button', null, '⤢');
  const fsBtn = el('button', null, '⛶');
  const closeBtn = el('button', null, 'Stop watching');
  muteBtn.title = 'Mute'; focusBtn.title = 'Focus'; fsBtn.title = 'Fullscreen';

  muteBtn.onclick = () => {
    video.muted = !video.muted;
    if (!video.muted && id !== S.me && sharingComputerAudio()) {
      toast('Heads up: while you share computer audio, this stream\'s sound goes back out to everyone.', 6000);
    }
    updateTile(id);
  };
  vol.oninput = () => { video.volume = +vol.value; video.muted = false; updateTile(id); };
  focusBtn.onclick = () => { S.focus = S.focus === id ? null : id; renderStage(); };
  fsBtn.onclick = () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen?.());
  video.ondblclick = fsBtn.onclick;
  closeBtn.onclick = () => unwatch(id);

  bar.append(nameEl, statsEl, muteBtn, vol, focusBtn, fsBtn, closeBtn);
  root.append(video, cover, badge, bar);
  const refs = { root, video, cover, badge, nameEl, statsEl, muteBtn, vol, focusBtn, closeBtn };
  tiles.set(id, refs);
  return refs;
}

function removeTile(id) {
  const t = tiles.get(id);
  if (!t) return;
  t.video.srcObject = null;
  t.root.remove();
  tiles.delete(id);
}

function setVideo(t, stream, muted) {
  if (t.video.srcObject === stream) return;
  t.video.srcObject = stream;
  if (muted != null) t.video.muted = muted;
  if (stream) {
    t.video.play().catch((e) => {
      if (e.name !== 'NotAllowedError') return;
      // Autoplay with sound blocked by the browser: play muted instead
      t.video.muted = true;
      t.video.play().catch(() => {});
      toast('Click 🔊 on a stream to turn its sound on');
    });
  }
}

function updateTile(id) {
  const t = tiles.get(id);
  if (!t) return;
  const isMe = id === S.me;
  const share = isMe
    ? { title: S.sourceName, paused: S.paused, audio: !!audioTrack() && !S.muted }
    : S.members.get(id)?.share;
  if (!share) return;

  t.root.classList.toggle('me', isMe);
  t.nameEl.textContent = `${memberName(id)} — ${share.title}`;
  t.badge.textContent = share.paused ? 'PAUSED' : 'LIVE';
  t.badge.classList.toggle('paused', !!share.paused);
  t.focusBtn.textContent = S.focus === id ? '⤡' : '⤢';

  let cover = null; // null = show the video
  if (isMe) {
    setVideo(t, S.stream, true);
    const n = S.outgoing.size;
    t.statsEl.textContent = n ? `${n} watching` : 'No one watching yet';
    if (S.paused) cover = { msg: 'Your video is paused' };
  } else if (!S.watching.has(id)) {
    setVideo(t, null);
    cover = { watch: true };
  } else {
    const entry = S.incoming.get(id);
    setVideo(t, entry ? entry.stream : null, sharingComputerAudio() ? true : null);
    if (!entry || entry.state === 'new' || entry.state === 'connecting') cover = { msg: 'Connecting…' };
    else if (entry.state === 'failed') cover = { msg: "Couldn't connect. One of your networks blocks direct connections — the server needs a TURN relay (see README)." };
    else if (entry.state === 'disconnected') cover = { msg: 'Connection unstable… recovering' };
    else if (share.paused) cover = { msg: 'Paused by the sharer' };
  }

  // audio controls only make sense for streams with sound that I watch
  const showAudio = !isMe && S.watching.has(id);
  t.muteBtn.classList.toggle('hidden', !showAudio);
  t.vol.classList.toggle('hidden', !showAudio);
  t.muteBtn.textContent = t.video.muted || t.video.volume === 0 ? '🔇' : '🔊';
  t.closeBtn.classList.toggle('hidden', isMe || !S.watching.has(id));

  t.cover.replaceChildren();
  t.cover.classList.toggle('hidden', !cover);
  t.root.classList.toggle('cover-on', !!cover);
  if (cover) {
    const box = el('div');
    box.append(el('div', 'who', memberName(id)), el('div', 'what', `is sharing ${share.title}`));
    if (cover.watch) {
      const btn = el('button', 'btn primary', 'Watch stream');
      btn.onclick = () => watch(id);
      btn.style.marginTop = '10px';
      box.append(btn);
    }
    if (cover.msg) box.append(el('div', 'msg', cover.msg));
    t.cover.append(box);
  }
}

function renderStage() {
  const stage = $('#stage');
  const ids = [];
  if (S.stream) ids.push(S.me);
  for (const m of S.members.values()) if (m.share && m.id !== S.me) ids.push(m.id);

  for (const id of [...tiles.keys()]) if (!ids.includes(id)) removeTile(id);
  if (S.focus && !ids.includes(S.focus)) S.focus = null;

  ids.forEach((id) => {
    const t = tiles.get(id) || createTile(id);
    if (t.root.parentNode !== stage) stage.append(t.root);
    t.root.classList.toggle('big', S.focus === id);
    updateTile(id);
  });
  // keep DOM order stable: me first, then others
  ids.forEach((id) => stage.append(tiles.get(id).root));

  stage.classList.toggle('has-focus', !!S.focus && ids.length > 1);
  stage.classList.toggle('single', ids.length === 1);
  $('#emptyStage').classList.toggle('hidden', ids.length > 0);
}

// ---------------- members & controls ----------------
function renderMembers() {
  const list = $('#memberList');
  list.replaceChildren();
  $('#memberCount').textContent = S.members.size;
  for (const m of S.members.values()) {
    const li = el('li');
    const av = el('span', 'avatar', (m.name[0] || '?').toUpperCase());
    av.style.background = colorFor(m.id);
    li.append(av, el('span', 'name', (m.id === S.ownerId ? '👑 ' : '') + memberName(m.id)));
    const sharing = m.id === S.me ? !!S.stream : !!m.share;
    if (sharing) {
      const tag = el('span', 'tag', 'LIVE');
      tag.title = m.id === S.me ? S.sourceName : m.share.title;
      li.append(tag);
    }
    if (S.ownerId === S.me && m.id !== S.me) {
      const kick = el('button', null, 'Kick');
      kick.onclick = () => { if (confirm(`Remove ${m.name} from the room?`)) socket.emit('kick', m.id); };
      li.append(kick);
    }
    list.append(li);
  }
}

function renderControls() {
  const sharing = !!S.stream;
  $('#shareBtn').textContent = sharing ? 'Stop sharing' : 'Share screen';
  $('#shareBtn').className = 'btn ' + (sharing ? 'danger' : 'primary');
  $('#changeBtn').classList.toggle('hidden', !sharing);
  $('#pauseBtn').classList.toggle('hidden', !sharing);
  $('#pauseBtn').textContent = S.paused ? 'Resume' : 'Pause';
  $('#pauseBtn').classList.toggle('on', S.paused);
  $('#muteBtn').classList.toggle('hidden', !sharing || !audioTrack());
  $('#muteBtn').textContent = S.muted ? 'Unmute my audio' : 'Mute my audio';
  $('#muteBtn').classList.toggle('on', S.muted);
}

function renderAll() {
  renderStage();
  renderMembers();
  renderControls();
  renderMyStats();
}

// ---------------- stats ----------------
let lastUpload = null;
function renderMyStats(text) {
  if (text != null) { $('#myStats').textContent = text; return; }
  if (!S.stream) { $('#myStats').textContent = S.room ? `${S.members.size} in room` : ''; }
  const t = tiles.get(S.me);
  if (t) t.statsEl.textContent = S.outgoing.size ? `${S.outgoing.size} watching` : 'No one watching yet';
}

setInterval(async () => {
  if (!S.room) return;

  // my upload
  if (S.stream) {
    let bytes = 0, w = null, h = null, fps = null;
    for (const peer of S.outgoing.values()) {
      try {
        (await peer.pc.getStats()).forEach((r) => {
          if (r.type !== 'outbound-rtp') return;
          bytes += r.bytesSent || 0;
          if (r.kind === 'video' && w == null && r.frameWidth) { w = r.frameWidth; h = r.frameHeight; fps = r.framesPerSecond; }
        });
      } catch {}
    }
    if (w == null) { const s = videoTrack()?.getSettings() || {}; w = s.width; h = s.height; fps = s.frameRate; }
    const now = performance.now();
    const mbps = lastUpload && bytes >= lastUpload.bytes ? ((bytes - lastUpload.bytes) * 8) / ((now - lastUpload.t) * 1000) : 0;
    lastUpload = { bytes, t: now };
    const parts = [`Sharing ${S.sourceName}`];
    if (w) parts.push(`${w}×${h}`);
    if (fps) parts.push(`${Math.round(fps)} fps`);
    parts.push(`${S.outgoing.size} watching`);
    if (S.outgoing.size) parts.push(`${mbps.toFixed(1)} Mbps upload`);
    renderMyStats(parts.join(' · '));
  } else {
    lastUpload = null;
    renderMyStats();
  }

  // streams I watch
  for (const [id, entry] of S.incoming) {
    const t = tiles.get(id);
    if (!t) continue;
    try {
      (await entry.pc.getStats()).forEach((r) => {
        if (r.type !== 'inbound-rtp' || r.kind !== 'video') return;
        const kbps = entry.last ? ((r.bytesReceived - entry.last.bytes) * 8) / (r.timestamp - entry.last.t) : 0;
        entry.last = { bytes: r.bytesReceived, t: r.timestamp };
        const parts = [];
        if (r.frameWidth) parts.push(`${r.frameWidth}×${r.frameHeight}`);
        if (r.framesPerSecond) parts.push(`${Math.round(r.framesPerSecond)} fps`);
        if (kbps > 0) parts.push(`${(kbps / 1000).toFixed(1)} Mbps`);
        t.statsEl.textContent = parts.join(' · ');
      });
    } catch {}
  }
}, 2000);

// Keyboard: F = fullscreen focused stream, Esc closes picker
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePicker();
  if (e.target.tagName === 'INPUT' || !S.room) return;
  if (e.key === 'f' || e.key === 'F') {
    const id = S.focus || [...tiles.keys()].find((k) => k !== S.me) || S.me;
    const t = tiles.get(id);
    if (t) (document.fullscreenElement ? document.exitFullscreen() : t.root.requestFullscreen?.());
  }
});

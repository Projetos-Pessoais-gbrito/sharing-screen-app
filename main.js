// Electron main process: window, server choice, screen/window picker, system audio.
const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('./server/server');

// System audio capture ("loopback") is supported by Electron on Windows
const AUDIO_SUPPORTED = process.platform === 'win32';
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

let win = null;
let settings = loadSettings(); // { mode: 'local' | 'remote', serverUrl }
let localPort = null;
let allowedOrigin = null;      // the only site allowed to use the desktop features
let pendingChoice = null;      // source picked in our UI, consumed by getDisplayMedia

if (!app.requestSingleInstanceLock()) app.quit();

// Screen capture needs a "secure" page. A plain-http server on another machine
// (e.g. http://192.168.0.10:3000 on your LAN) must be whitelisted before startup.
if (settings?.mode === 'remote' && settings.serverUrl?.startsWith('http://')) {
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', new URL(settings.serverUrl).origin);
}

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return null; }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && (i.family === 'IPv4' || i.family === 4) && !i.internal)
    .map((i) => i.address);
}

function isTrusted(event) {
  const url = event.senderFrame?.url || '';
  if (url.startsWith('file:')) return true;
  try { return allowedOrigin && new URL(url).origin === allowedOrigin; } catch { return false; }
}

function openSetup(error) {
  allowedOrigin = null;
  win.loadFile(path.join(__dirname, 'setup', 'setup.html'), { query: error ? { error } : {} });
}

async function openRoom() {
  if (!settings) return openSetup();
  let url;
  if (settings.mode === 'local') {
    if (!localPort) ({ port: localPort } = await startServer({ port: Number(process.env.PORT) || 3000 }));
    url = `http://localhost:${localPort}`;
  } else {
    url = settings.serverUrl.replace(/\/+$/, '');
  }
  allowedOrigin = new URL(url).origin;
  win.loadURL(url + '/');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    title: 'ScreenShare',
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // Links to other sites open in the normal browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    let ok = url.startsWith('file:');
    try { ok = ok || new URL(url).origin === allowedOrigin; } catch {}
    if (!ok) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || url.startsWith('file:')) return; // -3 = navigation aborted
    openSetup(`Could not reach the server (${desc}). Check the address, or wait a minute if it was sleeping.`);
  });

  openRoom();
}

app.whenReady().then(() => {
  // Called when the page runs navigator.mediaDevices.getDisplayMedia()
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const choice = pendingChoice;
    pendingChoice = null;
    const deny = () => { try { callback({}); } catch { /* denied */ } };
    if (!choice) return deny();
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((s) => s.id === choice.id);
      if (!source) return deny();
      const result = { video: source };
      if (choice.audio && AUDIO_SUPPORTED) result.audio = 'loopback';
      callback(result);
    } catch {
      deny();
    }
  });
  createWindow();
});

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});
app.on('window-all-closed', () => app.quit());

// ---------------- IPC ----------------
ipcMain.on('app:allowed-origin', (e) => { e.returnValue = allowedOrigin; });

ipcMain.handle('app:info', (e) => {
  if (!isTrusted(e)) return null;
  return {
    platform: process.platform,
    audioSupported: AUDIO_SUPPORTED,
    local: settings?.mode === 'local',
    port: localPort,
    addresses: lanAddresses(),
    server: allowedOrigin,
  };
});

ipcMain.handle('settings:get', (e) => (isTrusted(e) ? settings : null));

ipcMain.handle('settings:save', (e, s) => {
  if (!isTrusted(e)) return { ok: false, error: 'Not allowed' };
  let next;
  if (s?.mode === 'local') {
    next = { mode: 'local' };
  } else {
    let url;
    try { url = new URL(String(s?.serverUrl || '').trim()); } catch { return { ok: false, error: 'That is not a valid address' }; }
    if (!/^https?:$/.test(url.protocol)) return { ok: false, error: 'Use an http:// or https:// address' };
    next = { mode: 'remote', serverUrl: url.origin };
  }
  const needsRestart = next.mode === 'remote' && next.serverUrl.startsWith('http://') &&
    !(settings?.mode === 'remote' && settings.serverUrl === next.serverUrl);
  settings = next;
  saveSettings(settings);
  if (needsRestart) { app.relaunch(); app.exit(0); return { ok: true }; }
  openRoom();
  return { ok: true };
});

ipcMain.handle('settings:open', (e) => { if (isTrusted(e)) openSetup(); });

ipcMain.handle('sources:list', async (e) => {
  if (!isTrusted(e)) return [];
  const ownId = win ? win.getMediaSourceId() : null;
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 400, height: 225 },
    fetchWindowIcons: true,
  });
  return sources
    .filter((s) => s.id !== ownId)
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
});

ipcMain.handle('sources:select', (e, { id, audio } = {}) => {
  if (!isTrusted(e)) return false;
  pendingChoice = { id: String(id), audio: !!audio };
  return true;
});

ipcMain.handle('clipboard:write', (e, text) => {
  if (!isTrusted(e)) return false;
  clipboard.writeText(String(text));
  return true;
});

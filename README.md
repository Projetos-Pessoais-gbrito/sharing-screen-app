# ScreenShare v3: rooms like Discord

Everyone joins a **room** from wherever they are. **Anyone can share** their screen or a game, and everyone **watches inside the app**. You can watch several streams at once.

```
          ┌──────────── online server (rooms, chat, connecting people) ────────────┐
   Ana (São Paulo)            Bia (Rio)             Caio (Lisbon)           Duda (browser)
      │  ◄───── video/audio go directly between people (WebRTC) ─────►   │
```
The server only introduces people to each other. Video never passes through it, so a free server is enough.

## Features
- Rooms with a code and an optional password. The creator is the owner 👑 and can kick people.
- **Several people can share at the same time.** Each stream shows as a tile.
- **Watch inside the app**: focus one stream big, go fullscreen (`F` / double-click), and set volume per stream.
- **Auto-watch** new streams, or click *Watch stream* only for the ones you want. Nobody's upload is used for streams no one watches.
- **Screen/window picker** with thumbnails, including games.
- **Computer audio** (Windows). Streams you're watching are auto-muted while you share audio, so their sound doesn't echo back to everyone.
- Quality presets (720p30 → 1440p60/source), and *Motion* vs *Detail* mode.
- Change source, pause, or mute while live.
- Chat, and live stats (resolution, FPS, Mbps).
- **Friends without the app** can open the invite link in Chrome or Edge to watch *and* share, using the browser's own picker.

## 1. Put the server online (once, free)
Using [Render](https://render.com):
1. Upload this project to a GitHub repository.
2. On Render: **New → Web Service** and pick the repo.
3. Set **Root Directory** to `server`, **Build Command** to `npm install`, and **Start Command** to `npm start`.
4. Choose the free plan and deploy. You get an address like `https://screenshare-xyz.onrender.com`.

The free plan sleeps after about 15 minutes with no one connected, and the first open can take up to a minute. Railway and Fly.io work the same way.

### Strongly recommended: a TURN server
Friends on different networks sometimes can't connect directly. Mobile data and some routers or ISPs block it, and a TURN relay fixes that. Get free credentials (for example from metered.ca or Cloudflare TURN). Then, in Render → *Environment*, add:
```
TURN_URL  = turn:your.turn.host:3478,turns:your.turn.host:443
TURN_USER = your-username
TURN_PASS = your-password
```
Alternatively, set `ICE_SERVERS` to the full JSON list your TURN provider gives you.

## 2. Build the app
On Windows (Node.js 18+):
```bash
npm install
npm start           # try it
npm run dist:win    # -> dist/ScreenShare Setup 3.0.0.exe (installer) + portable .exe
```
(`dist:linux` → AppImage/.deb, and `dist:mac` → .dmg, each built on that OS.)

## 3. Use it
1. On first launch, choose **Online server** and paste your Render address. Everyone uses the same one.
2. Type your name and a room code (or click **New**), then **Join room**.
3. Click **Copy invite** and send it. Friends with the app type the same room code; friends without it open the link.
4. Click **Share screen**, pick a screen or game, and **Share**.

**This computer** mode runs the server on your own PC, which is for testing or the same Wi-Fi. Friends on your network choose *Online server* and enter `http://YOUR-PC-IP:3000`. The app restarts once when you set an `http://` address. The first time, allow it through the Windows firewall on Private networks.

## Limits worth knowing
| Situation | What happens |
|---|---|
| Upload | Each person watching you gets their own copy of your stream. 3 watchers at 1080p30 ≈ 13 Mbps upload. Lower the quality if it stutters. |
| Room size | 10 people max. More would need a media server (LiveKit/mediasoup) that sends your stream once. |
| Game shows black | Use borderless/windowed mode, or share the whole screen. |
| Netflix/Disney+ black | DRM. It can't be captured by anyone, Discord included. |
| Computer audio | Windows only in the app. In Chrome/Edge you can share a *tab's* audio (or the whole system on Windows). |
| "Couldn't connect" on a stream | That network blocks direct connections. Add TURN (above). |

## Project layout
```
main.js            Electron: window, server choice, screen picker, system audio
preload.js         safe bridge (only for the setup screen and your server)
setup/setup.html   first-run "which server?" screen
server/            deploy this folder
  server.js        rooms, owners, kick, chat, WebRTC signaling
  public/          the room UI (used by the app AND by browsers)
```

## Next ideas
- Voice chat in the room (the same WebRTC connections, plus the microphone)
- A media server (LiveKit) for bigger rooms and lower upload
- Native game capture and per-app audio (C++), like Discord
- Auto-update (electron-updater) and an app icon

# PeerCast

A tiny, dependency-free web app for streaming **camera, microphone or screen** from one
device to **exactly one** other device, peer-to-peer over WebRTC. Pairing takes a
6-digit code that you can read out loud.

Two options, as requested:

| Option | What it does |
| --- | --- |
| **Stream this device** | Captures a local source and opens a subscription (one viewer slot) for that stream. |
| **Watch a stream** | Joins that subscription from any other device using its 6-digit code. |

Plain HTML + CSS + JS on the front end, plus one ~400-line, dependency-free Node
file that relays the WebRTC handshake (`server/index.mjs`). Media never touches it.

## How the connection works

WebRTC still needs *signaling* — the two sides must swap their session descriptions.
Instead of pasting those (they are kilobytes of text), the app parks them in the
relay for a few minutes and the humans only trade a short, speakable code:

```
broadcaster ──6-digit code──▶ viewer ──▶ relay hands the answer back
                                              │
   audio/video flow device ══════════════════╧═ device (DTLS-SRTP)
```

The code is exactly six digits — `482913`:

- values are `100000`–`999999`, so no leading zeros to get lost
- spaces or dashes typed along the way are ignored (`482 913` works)
- one viewer per code, and the code dies when that viewer is accepted
- expires after 10 minutes; the viewer sends nothing back

Because 900 000 combinations is a small space, the relay also rate-limits lookups
per IP (20/min) and caps *wrong* codes globally (300/min) so a code cannot be
guessed before it expires. For a hostile network, prefer a TURN-less LAN share or
short-lived codes over reading them out loudly.

A side data channel delivers an instant "bye" so hanging up is immediate.

## Run it

The app must be served over **HTTPS or `localhost`** — browsers only expose
camera/microphone APIs in secure contexts (`file://` won't work), and the page needs
the relay on the same origin for `/api`.

```bash
# complete dev server: static files + signaling relay on one port
cd /home/mardel/kod/ai-poc
PORT=8080 STATIC_DIR=. node server/index.mjs
# open http://localhost:8080
```

`STATIC_DIR` is optional; without it the process only answers `/api/*`, which is
exactly how production runs it behind Caddy. Requires Node 18+ and no packages.

To let two physically separate devices reach it, expose that port over HTTPS:

```bash
cloudflared tunnel --url http://localhost:8080     # or: ngrok http 8080
```

## Use it

1. On the sending device open the app → **Stream this device** → pick a source → **Start broadcast**.
2. The broadcaster gets a 6-digit code such as `482913` — send it over any chat.
3. On the viewer's device open the app → **Watch a stream** → type the code → **Join stream**.
   Their reply goes back through the relay by itself, nothing to copy.
4. The broadcaster presses **Accept viewer** — the stream starts.
5. While watching, **⛶ Full screen** (or the `F` key) expands the stream and **⤡ Back to page**
   (or `Esc`) returns to the normal size.

## Deploying at `https://niania.deldev.fyi/`

PeerCast has its **own** Caddy container and gets its **own hostname**; the
home-dashboard stack (containers, Caddyfile, compose file) is not touched at all.

```
Cloudflare edge ──TLS──▶ existing tunnel (cloudflared) ──▶ 127.0.0.1:8088 (caddy)
        niania.deldev.fyi                                     │
                                                     ┌────────┴────────┐
                                                     │                 │
                                              / (static files)   /api/* → peercast-api:8080
                                                                  (offer/answer, ~10 min)
```

There are two containers: `peercast` (Caddy, static files + reverse proxy) and
`peercast-api` (the relay, no published ports). Only Caddy is bound to loopback, so
the app is reachable from the internet exclusively through the tunnel; the relay is
reached at `peercast-api:8080` over the compose network.

```bash
cd /home/mardel/kod/ai-poc
docker compose -f deploy/docker-compose.yml up -d     # start / update both containers
curl -s http://127.0.0.1:8088/api/health              # {"ok":true,...}
curl -I http://127.0.0.1:8088/                        # local smoke check
docker exec peercast caddy reload --config /etc/caddy/Caddyfile   # after editing the Caddyfile
```

`restart: unless-stopped` plus an enabled Docker service means it comes back after reboot.

### Point the tunnel at it (Cloudflare side, one-time)

Both tunnels on this host are **token-managed** (remote config), so the route is
added in the Cloudflare UI rather than in a local `config.yml`:

1. Zero Trust dashboard → **Networks → Tunnels** → the tunnel that serves
   `dashboard.deldev.fyi` → **Public Hostname** → **Add a public hostname**.
2. Fill in:

   | Field | Value |
   | --- | --- |
   | Subdomain | `niania` |
   | Domain | `deldev.fyi` |
   | Path | *(leave empty)* |
   | Type | `HTTP` |
   | URL | `127.0.0.1:8088` |
   | TLS (origin) | off / no TLS — Caddy speaks plain HTTP on loopback |

3. Save, then check:

   ```bash
   curl -I https://niania.deldev.fyi/            # 200, text/html
   curl -I https://niania.deldev.fyi/app.js      # 200, text/javascript
   curl -I https://dashboard.deldev.fyi/         # unchanged dashboard
   ```

If you already created the earlier `dashboard.deldev.fyi` + `/niania/*` rule, delete
it — nothing depends on it. The Caddyfile still answers `/niania/*` as an optional
alias, but the public URL is now the root of `niania.deldev.fyi`.

Notes:

- Use `127.0.0.1:8088` rather than `localhost:8088` — the container listens on both
  loopback families, but the explicit IPv4 target avoids any resolution surprise.
- Keep the tunnel's TLS/origin setting on **HTTP** (no "No TLS Verify" gymnastics):
  Caddy intentionally has `auto_https off`, TLS is Cloudflare's job.
- Only the handshake travels through the tunnel; audio/video is peer-to-peer, so the
  tunnel is never a media bottleneck.
- The relay keeps a session in memory for 10 minutes and nothing is written to disk.
  Restarting the relay just invalidates codes that are still waiting for a viewer.
- Public hostnames are rate-limited per IP so codes cannot be enumerated in bulk.
- Cloudflare terminates TLS, so the page is a secure context and camera/mic work on
  phones. Do not put Cloudflare Access in front of `niania.deldev.fyi` if a second
  person (or a phone without the app) has to open it.

## Files

```
index.html             layout: role chooser, broadcaster panel, viewer panel
styles.css             dark responsive theme, video framing, code display
app.js                 capture, peer connection, relay calls, UI state machine
server/index.mjs       signaling relay: 10-char codes, /api, optional static serving
deploy/Caddyfile       loopback-only HTTP server + /api reverse proxy
deploy/docker-compose.yml  `peercast` (Caddy) + `peercast-api` (relay)
test/e2e.mjs           self-contained two-tab WebRTC smoke test (headless Chrome)
```

## Tests

```bash
node test/e2e.mjs        # CHROME_BIN=/path/to/chrome to override the browser

# or run the same suite against the deployed app behind Caddy:
APP_URL=https://niania.deldev.fyi/ node test/e2e.mjs
```

It starts the relay in static mode, launches headless Chrome with fake camera/mic
devices, and drives a broadcaster tab and a viewer tab through the real handshake:
6-digit code → viewer joins → broadcaster accepts → connected → video frames and
audio track received → instant disconnect on hang-up, plus unknown-code handling,
autoplay/mute behaviour and a fullscreen round trip. 19 checks, no npm installs.

## Notes and limits

- **One viewer by design.** A new viewer needs a fresh broadcast (the code is single-use).
- **Codes expire after 10 minutes** and stop working the moment the broadcaster accepts
  a viewer or stops the stream. The relay keeps no history.
- **Six digits is a small keyspace.** Lookups are limited to 20/min per IP and wrong
  codes to 300/min in total, so a live code is not affordable to brute-force — but a
  six-digit code is guessable in principle; treat it like a one-time PIN.
- **Viewer fullscreen** is the whole viewer panel, so the sound and disconnect controls
  stay reachable; on iOS it falls back to the native `<video>` fullscreen.
- **Picture never waits for a tap.** Browsers forbid autoplaying sound, so the video
  starts muted (visible immediately) and sound unlocks via **🔊 Enable sound**, by tapping
  the video, or — in browsers that allow it after the *Join stream* click — right away.
- **STUN only.** Public STUN servers are used for NAT traversal. Symmetric NAT / strict
  corporate firewalls will need a TURN server — add it to `ICE_SERVERS` at the top of `app.js`.
- **Screen audio** is only offered by some browsers (Chrome/Edge on desktop); the app
  falls back to video-only when the audio request is rejected.
- Video is sent as-is (browser default codecs, ~720p/30fps requested); there is no
  server-side transcoding or recording.
- Codes are ~2–3 KB of text, so paste them rather than typing them by hand.

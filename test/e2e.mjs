// End-to-end smoke test for PeerCast.
//
//   node test/e2e.mjs                         (CHROME_BIN=/path/to/chrome to override)
//   APP_URL=http://127.0.0.1:8088/ node test/e2e.mjs
//                                             (test an already running deployment)
//
// Starts a throwaway static server, launches headless Chrome with fake
// camera/microphone devices, then drives two tabs over the DevTools protocol:
// a broadcaster and a viewer complete a real WebRTC handshake, media flows,
// and stopping the broadcast disconnects the viewer immediately.
//
// No npm dependencies. Requires Node 22+ and Google Chrome/Chromium.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------- app server ------------------------------- */

// Without APP_URL we start the relay in static mode: it serves the app and
// /api from one port, exactly like Caddy does in production.

let relay = null;
let appUrl = process.env.APP_URL;

if (!appUrl) {
  const port = 18000 + Math.floor(Math.random() * 900);
  appUrl = `http://127.0.0.1:${port}/`;
  relay = spawn(process.execPath, [join(ROOT, 'server/index.mjs')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', STATIC_DIR: ROOT },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await (await fetch(`${appUrl}api/health`)).json()).ok) break;
    } catch {
      /* not listening yet */
    }
    await sleep(150);
  }
}
const debugPort = 9000 + Math.floor(Math.random() * 900);
const profileDir = await mkdtemp(join(tmpdir(), 'peercast-e2e-'));
const chromeBin = process.env.CHROME_BIN || 'google-chrome';

const chrome = spawn(chromeBin, [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profileDir}`,
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  'about:blank',
], { stdio: 'ignore' });

chrome.on('error', (err) => {
  console.error(`Could not start "${chromeBin}": ${err.message}`);
  process.exit(1);
});

/* ------------------------------- CDP plumbing ------------------------------ */

const BASE = `http://127.0.0.1:${debugPort}`;

async function browserWebSocket() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const version = await (await fetch(`${BASE}/json/version`)).json();
      if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('Chrome did not expose a DevTools endpoint');
}

const ws = new WebSocket(await browserWebSocket());
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let seq = 0;
const pending = new Map();
const pageProblems = [];

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    pageProblems.push(`exception: ${d.exception?.description || d.text}`);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    pageProblems.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
};

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

async function openPage(name) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: appUrl }, sessionId);
  await sleep(900);
  return { name, sessionId };
}

async function evaluate(page, expression, { userGesture = false } = {}) {
  const r = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture },
    page.sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error(`${page.name}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  }
  return r.result.value;
}

async function waitFor(page, expression, label, timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await evaluate(page, expression);
    if (value) return value;
    await sleep(300);
  }
  throw new Error(`${page.name}: timed out waiting for ${label}`);
}

/* ---------------------------------- checks -------------------------------- */

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log(`testing ${appUrl}\n`);
const host = await openPage('host');
const viewer = await openPage('viewer');

try {
  await evaluate(host, `document.querySelector('#pickHost').click()`);
  await evaluate(host, `document.querySelector('#source').value = 'camera-mic'`);
  await evaluate(host, `document.querySelector('#channelName').value = 'Test cam'`);
  await evaluate(host, `document.querySelector('#hostStart').click()`);

  const code = await waitFor(host, `(() => {
    const text = document.querySelector('#hostCode').textContent.trim();
    return /^\\d{6}$/.test(text) ? text : null;
  })()`, 'connection code');
  check('broadcaster shows a 6-digit code', /^\d{6}$/.test(code), code);
  check('code panel is visible to the broadcaster', await evaluate(host,
    `!document.querySelector('#hostSteps').hidden &&
     document.querySelector('#hostCode').getBoundingClientRect().height > 0`));
  check('capture preview is playing', await evaluate(host,
    `document.querySelector('#localVideo').srcObject.getVideoTracks().length === 1`));

  await evaluate(viewer, `document.querySelector('#pickViewer').click()`);
  await evaluate(viewer, `document.querySelector('#codeIn').value = ${JSON.stringify(code)}`);
  await evaluate(viewer, `document.querySelector('#viewerConnect').click()`);

  await waitFor(viewer, `document.querySelector('#joinTitle').textContent.includes('Test cam')`, 'stream name');
  check('viewer shows the stream name', true);
  await waitFor(viewer, `document.querySelector('#viewerReply').hidden === false`, 'waiting notice');
  check('viewer needs no reply code to copy', await evaluate(viewer,
    `document.querySelectorAll('#viewerCodes textarea').length === 0`));

  await waitFor(host, `document.querySelector('#hostConnect').disabled === false`, 'viewer answer');
  check('broadcaster sees a viewer waiting', await evaluate(host,
    `document.querySelector('#hostWait').dataset.kind === 'ok'`));
  await evaluate(host, `document.querySelector('#hostConnect').click()`);

  await waitFor(host, `document.querySelector('#hostBadge').dataset.kind === 'live'`, 'host connected');
  await waitFor(viewer, `document.querySelector('#viewerBadge').dataset.kind === 'live'`, 'viewer connected');
  check('both devices reached the connected state', true);
  check('host shows the live panel', await evaluate(host, `!document.querySelector('#hostLive').hidden`));
  check('code panels collapse once connected', await evaluate(host,
    `document.querySelector('#hostSteps').hidden`) &&
    await evaluate(viewer, `document.querySelector('#viewerCodes').hidden`));

  const media = await waitFor(viewer, `(() => {
    const v = document.querySelector('#remoteVideo');
    if (!v.srcObject) return null;
    return v.videoWidth > 0
      ? { w: v.videoWidth, h: v.videoHeight, audio: v.srcObject.getAudioTracks().length }
      : null;
  })()`, 'remote media');
  check('viewer receives video frames', media.w > 0, `${media.w}x${media.h}`);
  check('viewer receives the audio track', media.audio === 1);
  check('viewer picture plays without an extra click', await evaluate(viewer,
    `(() => { const v = document.querySelector('#remoteVideo'); return !v.paused && !v.ended; })()`));
  check('sound prompt matches the real mute state', await evaluate(viewer,
    `(() => {
       const v = document.querySelector('#remoteVideo');
       const prompt = document.querySelector('#enableSound');
       return v.muted ? !prompt.hidden : prompt.hidden;
     })()`));
  const sound = await evaluate(viewer, `(async () => {
    const button = document.querySelector('#enableSound');
    if (button.hidden) return { skipped: true };
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const v = document.querySelector('#remoteVideo');
    return { muted: v.muted, promptHidden: button.hidden, paused: v.paused };
  })()`, { userGesture: true });
  check('sound tap never blanks the picture', sound.skipped || !sound.paused,
    JSON.stringify(sound));

  check('viewer gets a fullscreen control', await evaluate(viewer,
    `!document.querySelector('#viewerFullscreen').hidden &&
     document.querySelector('#viewerFullscreen').textContent.includes('Full screen')`));

  const fullscreen = await evaluate(viewer, `(async () => {
    const button = document.querySelector('#viewerFullscreen');
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    button.click();
    await wait(700);
    const entered = document.fullscreenElement !== null;
    const label = button.textContent;
    button.click();
    await wait(700);
    return { entered, left: document.fullscreenElement === null, label };
  })()`, { userGesture: true });
  check('fullscreen can be entered and left again', fullscreen.entered && fullscreen.left,
    JSON.stringify(fullscreen));

  await evaluate(host, `document.querySelector('#hostEnd').click()`);
  await sleep(1500);
  check('stopping the broadcast disconnects the viewer', await evaluate(viewer,
    `document.querySelector('#viewerBadge').dataset.kind === 'idle'`),
    await evaluate(viewer, `document.querySelector('#viewerStatus').textContent`));

  await evaluate(viewer, `document.querySelector('#codeIn').value = '000000'`);
  await evaluate(viewer, `document.querySelector('#viewerConnect').click()`);
  const message = await waitFor(viewer, `(() => {
    const el = document.querySelector('#viewerStatus');
    return el.dataset.kind === 'error' ? el.textContent : null;
  })()`, 'error message', 15000);
  check('unknown code reports a friendly error', message.includes('no stream with that code'), message);

  check('no page exceptions or console errors', pageProblems.length === 0, pageProblems.join(' | ') || 'clean');
} catch (err) {
  check(err.message, false);
  for (const page of [host, viewer]) {
    const status = await evaluate(page,
      `['#hostStatus','#hostWait','#viewerStatus'].map((s) => { const el = document.querySelector(s); return el ? s + ': ' + el.textContent : null; }).filter(Boolean).join(' | ')`,
    ).catch(() => '');
    if (status) console.log(`  ${page.name}: ${status}`);
  }
  if (pageProblems.length) console.log(`  page problems: ${pageProblems.join(' | ')}`);
} finally {
  ws.close();
  chrome.kill('SIGKILL');
  if (relay) relay.kill('SIGKILL');
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);

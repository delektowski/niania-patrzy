'use strict';

/* ------------------------------------------------------------------ *
 * PeerCast — one broadcaster, one viewer.
 *
 * WebRTC still needs signaling, but a session description cannot fit in
 * ten characters. So the two descriptions (offer + answer) are parked in
 * the tiny relay in server/index.mjs for a few minutes and the humans only
 * pass along a short 6-digit code such as "482913". Media never touches the
 * relay — it flows device → device over DTLS-SRTP.
 *
 * ICE candidates are gathered before the offer is published, so a single
 * relay round-trip per side is enough (no trickle ICE).
 * ------------------------------------------------------------------ */

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const state = {
  pc: null,
  localStream: null,
  control: null,
  code: null,
  pendingAnswer: null,
  watcher: null,
};

const CONTROL_CHANNEL = 'peercast-control';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const views = {
  choose: $('#view-choose'),
  host: $('#view-host'),
  viewer: $('#view-viewer'),
};

/* ----------------------------- tiny UI helpers ----------------------------- */

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.classList.toggle('active', key === name);
  }
  window.scrollTo({ top: 0 });
}

function setStatus(el, text, kind = 'idle') {
  el.textContent = text;
  el.dataset.kind = kind;
}

function setBadge(el, text, kind = 'idle') {
  el.textContent = text;
  el.dataset.kind = kind;
}

function flash(button, text) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.textContent = text;
  clearTimeout(button._flashTimer);
  button._flashTimer = setTimeout(() => {
    button.textContent = button.dataset.label;
  }, 1700);
}

async function copyText(text, button) {
  const value = String(text || '').trim();
  if (!value) {
    flash(button, 'Nothing to copy');
    return;
  }

  let copied = true;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    copied = false;
  }
  flash(button, copied ? 'Copied ✓' : `Copy it by hand: ${value}`);
}

/* ---------------------------- signaling relay ------------------------------ */

async function api(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      signal,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error('the signaling relay is unreachable — is it running?');
  }

  if (response.status === 204) return null;

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) throw new Error(payload?.error || `the relay answered HTTP ${response.status}`);
  return payload;
}

const codePath = (code) => `/session/${encodeURIComponent(String(code || '').trim())}`;
const createSession = (name, sdp) => api('/session', { method: 'POST', body: { name, sdp } });
const fetchStream = (code) => api(codePath(code));
const sendAnswer = (code, sdp) => api(`${codePath(code)}/answer`, { method: 'POST', body: { sdp } });
const waitForAnswer = (code, signal) => api(`${codePath(code)}/answer?wait=20`, { signal });
const dropSession = (code) =>
  api(codePath(code), { method: 'DELETE' }).catch(() => {
    /* the broadcaster is going away; a missing session is fine */
  });

/* -------------------------------- media & RTC ------------------------------- */

async function captureSource(kind) {
  if (!navigator.mediaDevices) {
    throw new Error('this browser has no media capture support (needs HTTPS or localhost)');
  }

  if (kind === 'screen') {
    if (typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      throw new Error('screen sharing is not supported in this browser');
    }
    try {
      return await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,
      });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'AbortError') throw err;
      // audio capture of the screen is not available everywhere
      return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } } });
    }
  }

  return navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio:
      kind === 'camera-mic'
        ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        : false,
  });
}

/** Resolves once ICE gathering is finished (or the timeout expires). */
function waitForIce(pc, timeoutMs = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve) => {
    let timer = null;

    const finish = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      pc.removeEventListener('icecandidate', onCandidate);
      resolve();
    };

    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };

    const onCandidate = (event) => {
      if (!event.candidate) finish();
    };

    pc.addEventListener('icegatheringstatechange', onChange);
    pc.addEventListener('icecandidate', onCandidate);
    timer = setTimeout(finish, timeoutMs);
  });
}

function buildPeerConnection() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  state.pc = pc;
  return pc;
}

function closePeer() {
  const pc = state.pc;
  state.pc = null;
  state.control = null;
  if (!pc) return;
  try {
    pc.close();
  } catch {
    /* already closed */
  }
}

/* Small side channel so "hang up" is instant instead of waiting for ICE to time out. */

function parseControlMessage(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function attachControlChannel(pc, onMessage) {
  const channel = pc.createDataChannel(CONTROL_CHANNEL, { ordered: true });
  channel.addEventListener('message', (event) => onMessage(parseControlMessage(event.data)));
  state.control = channel;
  return channel;
}

function acceptControlChannel(pc, onMessage) {
  pc.addEventListener('datachannel', (event) => {
    if (event.channel.label !== CONTROL_CHANNEL) return;
    state.control = event.channel;
    event.channel.addEventListener('message', (msg) => onMessage(parseControlMessage(msg.data)));
  });
}

function sendBye() {
  const channel = state.control;
  if (!channel || channel.readyState !== 'open') return;
  try {
    channel.send(JSON.stringify({ type: 'bye' }));
  } catch {
    /* channel already closing */
  }
}

function releaseMedia() {
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }
}

/* ---------------------------------- host ----------------------------------- */

function resetHostUI(message = 'Not streaming — start a broadcast to get your 6-digit code.') {
  const video = $('#localVideo');
  video.srcObject = null;
  video.classList.remove('mirror');

  $('#localHint').hidden = false;
  $('#hostSteps').hidden = true;
  $('#hostLive').hidden = true;
  $('#hostStop').hidden = true;
  $('#hostEnd').hidden = false;

  $('#hostCode').textContent = '••••••';
  $('#hostWait').textContent = 'Waiting for a viewer to enter the code…';
  $('#hostWait').dataset.kind = 'busy';
  $('#hostSteps').classList.remove('attention');
  $('#hostStart').textContent = 'Start broadcast';
  $('#hostStart').disabled = false;
  $('#hostConnect').disabled = true;

  setBadge($('#hostBadge'), 'idle');
  setStatus($('#hostStatus'), message, 'idle');
}

function stopWatching() {
  if (state.watcher) {
    state.watcher.abort();
    state.watcher = null;
  }
}

async function stopBroadcast(message = 'Broadcast stopped.', notifyViewer = true) {
  if (notifyViewer) {
    sendBye();
    await sleep(180); // let the bye message leave before the connection is torn down
  }
  stopWatching();
  const code = state.code;
  state.code = null;
  state.pendingAnswer = null;
  if (code) dropSession(code);
  closePeer();
  releaseMedia();
  resetHostUI(message);
}

async function startBroadcast() {
  if (state.pc || state.localStream) await stopBroadcast();

  const startBtn = $('#hostStart');
  startBtn.disabled = true;
  startBtn.textContent = 'Starting…';
  $('#hostStop').hidden = true;
  setBadge($('#hostBadge'), 'starting', 'busy');
  setStatus($('#hostStatus'), 'Requesting access to your device…', 'busy');

  try {
    const kind = $('#source').value;
    const stream = await captureSource(kind);
    state.localStream = stream;

    const video = $('#localVideo');
    video.srcObject = stream;
    video.classList.toggle('mirror', kind !== 'screen');
    $('#localHint').hidden = true;
    $('#hostStop').hidden = false;

    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) {
      videoTrack.addEventListener('ended', () => {
        if (state.pc) stopBroadcast('Capture ended — the broadcast has been stopped.');
      });
    }

    const pc = buildPeerConnection();
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    pc.addEventListener('connectionstatechange', onHostConnectionState);
    attachControlChannel(pc, (msg) => {
      if (msg && msg.type === 'bye') {
        stopBroadcast('The viewer left — broadcast stopped.', false);
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    setStatus($('#hostStatus'), 'Gathering network candidates…', 'busy');
    await waitForIce(pc);

    const name = $('#channelName').value.trim() || 'Live stream';
    setStatus($('#hostStatus'), 'Opening a subscription…', 'busy');
    const { code } = await createSession(name, pc.localDescription.sdp);

    state.code = code;
    state.pendingAnswer = null;
    $('#hostCode').textContent = code;
    $('#hostLiveTitle').textContent = name;

    $('#hostSteps').hidden = false;
    $('#hostLive').hidden = true;
    $('#hostConnect').disabled = true;
    startBtn.textContent = 'Restart broadcast';
    startBtn.disabled = false;

    setBadge($('#hostBadge'), 'awaiting viewer', 'busy');
    setStatus($('#hostStatus'), `Broadcast ready — your code is ${code}.`, 'ok');
    setStatus($('#hostWait'), 'Waiting for a viewer to enter the code…', 'busy');
    drawAttentionToCode();
    watchForAnswer();
  } catch (err) {
    closePeer();
    releaseMedia();
    resetHostUI(`Could not start: ${describeError(err)}`);
    setBadge($('#hostBadge'), 'error', 'error');
  }
}

/** Scrolls the share code into view and flashes it — on phones it sits below the preview. */
function drawAttentionToCode() {
  const panel = $('#hostSteps');
  panel.classList.remove('attention');
  requestAnimationFrame(() => {
    panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    void panel.offsetWidth; // restart the animation
    panel.classList.add('attention');
    setTimeout(() => panel.classList.remove('attention'), 3000);
  });
}

function shareCodeText() {
  const code = $('#hostCode').textContent.trim();
  return `Watch my live stream on PeerCast — code: ${code} — ${location.origin}/`;
}

const CODE_PATTERN = /^\d{6}$/;
const digitsOnly = (value) => String(value || '').replace(/\D+/g, '');

async function shareCode(button) {
  const code = digitsOnly($('#hostCode').textContent);
  if (!CODE_PATTERN.test(code)) {
    flash(button, 'Start a broadcast first');
    return;
  }

  const text = shareCodeText();
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'PeerCast — watch my stream', text });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  await copyText(text, button);
}

/** Long-polls the relay for a viewer's answer, then enables "Accept viewer". */
async function watchForAnswer() {
  const code = state.code;
  if (!code) return;

  stopWatching();
  const controller = new AbortController();
  state.watcher = controller;

  try {
    while (!controller.signal.aborted && state.code === code) {
      const reply = await waitForAnswer(code, controller.signal);
      if (!reply) continue; // long-poll timed out, ask again
      if (controller.signal.aborted || state.code !== code) return;

      state.pendingAnswer = reply.sdp;
      $('#hostConnect').disabled = false;
      setBadge($('#hostBadge'), 'viewer waiting', 'warn');
      setStatus($('#hostWait'), 'A viewer entered the code — accept them to go live.', 'ok');
      return;
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    if (state.code === code) {
      setStatus($('#hostWait'), `Lost contact with the relay: ${describeError(err)}`, 'error');
    }
  } finally {
    if (state.watcher === controller) state.watcher = null;
  }
}

async function acceptViewer() {
  const pc = state.pc;
  const answerSdp = state.pendingAnswer;
  const button = $('#hostConnect');

  if (!pc) {
    setStatus($('#hostStatus'), 'Start the broadcast first.', 'warn');
    return;
  }
  if (!answerSdp) {
    setStatus($('#hostWait'), 'Nobody has entered the code yet.', 'warn');
    return;
  }
  if (pc.signalingState !== 'have-local-offer') {
    setStatus($('#hostStatus'), 'This subscription already has an answer. Restart to accept a new viewer.', 'warn');
    return;
  }

  button.disabled = true;
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    state.pendingAnswer = null;
    stopWatching();

    // The handshake is complete over the relay; the code is now useless.
    const code = state.code;
    state.code = null;
    if (code) dropSession(code);

    setBadge($('#hostBadge'), 'connecting', 'busy');
    setStatus($('#hostStatus'), 'Handshaking with the viewer…', 'busy');
    setStatus($('#hostWait'), 'Viewer accepted.', 'ok');
  } catch (err) {
    setStatus($('#hostStatus'), `Could not accept the viewer: ${describeError(err)}`, 'error');
  }
}

function onHostConnectionState() {
  const pc = state.pc;
  if (!pc) return;

  switch (pc.connectionState) {
    case 'connecting':
      setBadge($('#hostBadge'), 'connecting', 'busy');
      setStatus($('#hostStatus'), 'Connecting to the viewer…', 'busy');
      break;

    case 'connected':
      setBadge($('#hostBadge'), 'live', 'live');
      setStatus($('#hostStatus'), 'Live — one viewer is connected.', 'ok');
      $('#hostSteps').hidden = true;
      $('#hostLive').hidden = false;
      $('#hostStart').textContent = 'Restart broadcast';
      break;

    case 'disconnected':
      setBadge($('#hostBadge'), 'unstable', 'warn');
      setStatus($('#hostStatus'), 'The viewer dropped — waiting for the connection to recover…', 'warn');
      break;

    case 'failed':
      setBadge($('#hostBadge'), 'failed', 'error');
      setStatus($('#hostStatus'), 'Connection failed. Restart the broadcast and share a fresh code.', 'error');
      break;

    default:
      break;
  }
}

/* --------------------------------- viewer ---------------------------------- */

function resetViewerUI(message = "Enter the broadcaster's code to begin.") {
  const video = $('#remoteVideo');
  video.srcObject = null;

  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});

  $('#remoteHint').hidden = false;
  $('#remoteVideo').muted = true;
  $('#viewerCodes').hidden = false;
  $('#viewerInput').hidden = false;
  $('#viewerReply').hidden = true;
  $('#viewerLeave').hidden = true;
  $('#enableSound').hidden = true;
  $('#viewerFullscreen').hidden = true;
  $('#codeIn').value = '';
  $('#viewerConnect').textContent = 'Join stream';
  $('#viewerConnect').disabled = false;
  $('#joinTitle').textContent = 'Watch a stream';

  setBadge($('#viewerBadge'), 'idle');
  setStatus($('#viewerStatus'), message, 'idle');
}

function closeViewer(message = 'Disconnected.') {
  closePeer();
  resetViewerUI(message);
}

function leaveStream() {
  sendBye();
  closeViewer('You left the stream.');
}

/** Fullscreen for the viewer: the whole stage, so the exit button stays reachable. */
const viewerStage = $('#viewerStage');
const fullscreenButton = $('#viewerFullscreen');

const inFullscreen = () =>
  document.fullscreenElement === viewerStage ||
  document.webkitFullscreenElement === viewerStage ||
  $('#remoteVideo').webkitDisplayingFullscreen === true;

function syncFullscreenButton() {
  const active = inFullscreen();
  fullscreenButton.textContent = active ? '⤡ Back to page' : '⛶ Full screen';
  fullscreenButton.setAttribute('aria-pressed', String(active));
}

async function toggleFullscreen() {
  if (inFullscreen()) {
    try {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      else if (document.webkitCancelFullScreen) document.webkitCancelFullScreen();
    } catch {
      /* the browser already left fullscreen */
    }
    syncFullscreenButton();
    return;
  }

  // Prefer the wrapper (video + sound/exit buttons); fall back to the bare
  // element on iOS, where only <video> can go fullscreen.
  try {
    if (viewerStage.requestFullscreen) await viewerStage.requestFullscreen({ navigationUI: 'hide' });
    else if (viewerStage.webkitRequestFullscreen) viewerStage.webkitRequestFullscreen();
    else if ($('#remoteVideo').webkitEnterFullscreen) $('#remoteVideo').webkitEnterFullscreen();
    else throw new Error('fullscreen is not supported here');
  } catch (err) {
    const video = $('#remoteVideo');
    if (typeof video.webkitEnterFullscreen === 'function') {
      video.webkitEnterFullscreen();
    } else {
      flash(fullscreenButton, err.message === 'fullscreen is not supported here' ? 'Full screen is not supported' : 'Full screen was blocked');
    }
  }
  syncFullscreenButton();
}

for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(event, syncFullscreenButton);
}
$('#remoteVideo').addEventListener('webkitbeginfullscreen', syncFullscreenButton);
$('#remoteVideo').addEventListener('webkitendfullscreen', syncFullscreenButton);

function onViewerControlMessage(msg) {
  if (msg && msg.type === 'bye') {
    closeViewer('The broadcaster ended the stream.');
  }
}

function handleRemoteTrack(event) {
  const video = $('#remoteVideo');
  const incoming = event.streams && event.streams[0];

  if (incoming) {
    video.srcObject = incoming;
  } else {
    const stream = video.srcObject instanceof MediaStream ? video.srcObject : new MediaStream();
    stream.addTrack(event.track);
    video.srcObject = stream;
  }

  $('#remoteHint').hidden = true;
  startPlayback();
}

/**
 * Browsers only autoplay muted media, so the picture is started muted — it must
 * appear the moment the broadcaster accepts, with no extra click. Sound is then
 * unlocked separately; if the browser refuses, playback simply stays muted and
 * the "Enable sound" button appears.
 */
async function startPlayback() {
  const video = $('#remoteVideo');

  if (video.paused) {
    video.muted = true;
    try {
      await video.play();
    } catch {
      /* very unusual: the element itself is blocked */
    }
  }

  video.muted = false;
  try {
    await video.play();
    $('#enableSound').hidden = true;
  } catch {
    video.muted = true;
    $('#enableSound').hidden = false;
    try {
      await video.play();
    } catch {
      /* muted autoplay blocked too — the tap-to-play path still works */
    }
  }
}

async function viewerConnect() {
  if (state.pc) closeViewer('Starting over…');

  const button = $('#viewerConnect');
  const code = digitsOnly($('#codeIn').value);
  button.disabled = true;
  setStatus($('#viewerStatus'), 'Looking up the code…', 'busy');

  try {
    if (!CODE_PATTERN.test(code)) {
      throw new Error('enter the 6 digits the broadcaster sent you');
    }

    const stream = await fetchStream(code);
    $('#joinTitle').textContent = stream.name ? `Watch “${stream.name}”` : 'Watch a stream';

    const pc = buildPeerConnection();
    pc.addEventListener('connectionstatechange', onViewerConnectionState);
    pc.addEventListener('track', handleRemoteTrack);
    acceptControlChannel(pc, onViewerControlMessage);

    await pc.setRemoteDescription({ type: 'offer', sdp: stream.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    setStatus($('#viewerStatus'), 'Gathering network candidates…', 'busy');
    await waitForIce(pc);

    // The reply travels through the relay; there is nothing to copy back.
    await sendAnswer(code, pc.localDescription.sdp);

    $('#viewerReply').hidden = false;
    $('#viewerLeave').hidden = false;
    button.textContent = 'Start over';
    button.disabled = false;

    setBadge($('#viewerBadge'), 'waiting', 'busy');
    setStatus($('#viewerStatus'), 'Waiting for the broadcaster to accept you…', 'ok');
  } catch (err) {
    closePeer();
    button.disabled = false;
    setBadge($('#viewerBadge'), 'error', 'error');
    setStatus($('#viewerStatus'), `Could not join: ${describeError(err)}`, 'error');
  }
}

function onViewerConnectionState() {
  const pc = state.pc;
  if (!pc) return;

  switch (pc.connectionState) {
    case 'connecting':
      setBadge($('#viewerBadge'), 'connecting', 'busy');
      setStatus($('#viewerStatus'), 'Waiting for the broadcaster to accept your reply…', 'busy');
      break;

    case 'connected':
      setBadge($('#viewerBadge'), 'live', 'live');
      setStatus($('#viewerStatus'), 'You are watching the live stream.', 'ok');
      $('#viewerCodes').hidden = true;
      $('#viewerLeave').hidden = false;
      $('#viewerFullscreen').hidden = false;
      $('#viewerConnect').textContent = 'Start over';
      break;

    case 'disconnected':
      setBadge($('#viewerBadge'), 'unstable', 'warn');
      setStatus($('#viewerStatus'), 'Connection unstable — trying to recover…', 'warn');
      break;

    case 'failed':
      setBadge($('#viewerBadge'), 'failed', 'error');
      setStatus(
        $('#viewerStatus'),
        'Connection failed. Make sure the broadcaster is still live, then start over with a fresh code.',
        'error',
      );
      $('#viewerCodes').hidden = false;
      break;

    default:
      break;
  }
}

/* ---------------------------------- misc ----------------------------------- */

function describeError(err) {
  if (!err) return 'unknown error';
  if (err.name === 'NotAllowedError') return 'permission was denied';
  if (err.name === 'NotFoundError') return 'no matching camera/microphone found';
  if (err.name === 'NotReadableError') return 'the device is already in use by another app';
  if (err.name === 'OverconstrainedError') return 'the requested media settings are unsupported';
  if (err.name === 'SecurityError' || err.name === 'TypeError') {
    return `${err.message || 'blocked'} (HTTPS or localhost is required)`;
  }
  return err.message || String(err);
}

async function teardownAll() {
  sendBye();
  await sleep(150);
  stopWatching();
  const code = state.code;
  state.code = null;
  state.pendingAnswer = null;
  if (code) dropSession(code);
  closePeer();
  releaseMedia();
  resetHostUI();
  resetViewerUI();
}

/* ---------------------------------- wiring ---------------------------------- */

$('#pickHost').addEventListener('click', () => showView('host'));
$('#pickViewer').addEventListener('click', () => showView('viewer'));

$$('[data-back]').forEach((button) => {
  button.addEventListener('click', async () => {
    await teardownAll();
    showView('choose');
  });
});

$('#hostStart').addEventListener('click', startBroadcast);
$('#hostStop').addEventListener('click', () => stopBroadcast());
$('#hostEnd').addEventListener('click', () => stopBroadcast());
$('#hostConnect').addEventListener('click', acceptViewer);
$('#copyOffer').addEventListener('click', (event) =>
  copyText(digitsOnly($('#hostCode').textContent), event.currentTarget),
);
$('#shareOffer').addEventListener('click', (event) => shareCode(event.currentTarget));
if (typeof navigator.share === 'function') $('#shareOffer').hidden = false;

$('#viewerConnect').addEventListener('click', viewerConnect);
$('#viewerLeave').addEventListener('click', leaveStream);
$('#viewerFullscreen').addEventListener('click', toggleFullscreen);

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName || '');
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'f' || event.key === 'F') {
    if (!$('#viewerFullscreen').hidden) {
      event.preventDefault();
      toggleFullscreen();
    }
  }
  if (event.key === 'Escape' && inFullscreen()) {
    event.preventDefault();
    toggleFullscreen();
  }
});
$('#codeIn').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') viewerConnect();
});
$('#codeIn').addEventListener('input', () => {
  const clean = digitsOnly($('#codeIn').value).slice(0, 6);
  if ($('#codeIn').value !== clean) $('#codeIn').value = clean;
});
$('#hostCode').addEventListener('click', () => {
  const range = document.createRange();
  range.selectNodeContents($('#hostCode'));
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
});

$('#enableSound').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const video = $('#remoteVideo');
  video.muted = false;
  try {
    await video.play();
    button.hidden = true;
  } catch {
    video.muted = true;
    flash(button, 'Still blocked — tap the video');
  }
});

$('#remoteVideo').addEventListener('playing', () => {
  // only offer the sound prompt when sound is really off
  if (!$('#remoteVideo').muted) $('#enableSound').hidden = true;
});

$('#remoteVideo').addEventListener('click', async () => {
  const video = $('#remoteVideo');
  if (video.paused || video.muted) {
    video.muted = false;
    try {
      await video.play();
      $('#enableSound').hidden = true;
    } catch {
      video.muted = true;
    }
  }
});

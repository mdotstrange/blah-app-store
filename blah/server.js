// BLAH - a dead-simple local chat server. No dependencies, no database.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'messages.json');
const MAX_MESSAGES = 200;
const MAX_NAME = 24;
const MAX_TEXT = 500;
const POLL_TIMEOUT_MS = 10000; // a window counts as online this long after its last poll
const SEND_WINDOW_MS = 10000; // flood window for /send
const SEND_BURST = 15; // messages one name may send per window
const CLEAR_COOLDOWN_MS = 3000; // minimum gap between /clear calls

let nextId = 1;
let generation = 1; // bumped on every clear so polling clients can detect it
let lastClear = 0;
const messages = []; // {id, name, text, time}
const sseClients = new Map(); // res -> {name}
const pollers = new Map(); // window id -> {name, seen}
const sendTimes = new Map(); // name -> recent send timestamps

const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
// Lets the browser revalidate instead of reusing a stale page after an update
const indexEtag = `"${crypto.createHash('sha1').update(indexHtml).digest('hex').slice(0, 16)}"`;

// Used for the favicon and the notification popup icon. Optional: if the file
// isn't bundled the chat still runs, the icon just comes up blank.
let iconSvg = null;
try {
  iconSvg = fs.readFileSync(path.join(__dirname, 'icon.svg'));
} catch (err) {
  console.warn(`BLAH: icon.svg is missing (${err.message}); notifications will have no icon`);
}

// History persists to HISTORY_FILE so it survives app restarts. If the
// data dir isn't writable, BLAH still works, just without persistence.
let persistenceReady = false;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const probe = path.join(DATA_DIR, '.write-test');
  fs.writeFileSync(probe, '');
  fs.unlinkSync(probe);
  persistenceReady = true;
} catch (err) {
  console.warn(`BLAH: ${DATA_DIR} is not writable (${err.message}); history will not persist`);
}

// History is stored as {generation, messages}. Older versions stored a bare
// array, which we still read. Keeping the generation on disk stops polling
// clients from announcing a bogus "history was cleared" after a restart.
if (persistenceReady && fs.existsSync(HISTORY_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    const savedMessages = Array.isArray(saved) ? saved : saved && saved.messages;
    const savedGeneration = Array.isArray(saved) ? 1 : Number(saved && saved.generation);
    if (Array.isArray(savedMessages)) {
      for (const m of savedMessages.slice(-MAX_MESSAGES)) {
        if (m && typeof m.id === 'number' && typeof m.name === 'string' && typeof m.text === 'string') {
          messages.push({ id: m.id, name: m.name, text: m.text, time: m.time || Date.now() });
        }
      }
      if (messages.length > 0) nextId = messages[messages.length - 1].id + 1;
      if (Number.isInteger(savedGeneration) && savedGeneration > 0) generation = savedGeneration;
    }
  } catch (err) {
    console.warn(`BLAH: ignoring unreadable history file (${err.message})`);
  }
}

function saveHistory() {
  if (!persistenceReady) return;
  try {
    fs.writeFileSync(HISTORY_FILE + '.tmp', JSON.stringify({ generation, messages }));
    fs.renameSync(HISTORY_FILE + '.tmp', HISTORY_FILE);
  } catch (err) {
    console.warn(`BLAH: failed to save history (${err.message})`);
  }
}

// A client that went away mid-write throws here or (more often) emits an error
// on the response, so every write goes through this and dead clients are dropped.
function safeWrite(res, line) {
  try {
    res.write(line);
    return true;
  } catch (err) {
    dropClient(res);
    return false;
  }
}

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients.keys()) safeWrite(res, line);
}

function addClient(req, res, name) {
  sseClients.set(res, { name });
  res.on('error', () => dropClient(res));
  req.on('close', () => dropClient(res));
}

function dropClient(res) {
  if (!sseClients.delete(res)) return;
  try {
    res.end();
  } catch (err) {
    // the socket is already gone
  }
  broadcastOnline();
}

function onlineCount() {
  const cutoff = Date.now() - POLL_TIMEOUT_MS;
  let pollCount = 0;
  for (const [id, poller] of pollers) {
    if (poller.seen < cutoff) pollers.delete(id);
    else pollCount++;
  }
  return sseClients.size + pollCount;
}

// Screen names of everyone signed on, for the buddy list. Clients that never
// told us a name (older pages, or a poll straight after a reload) are skipped.
function onlineNames() {
  const names = new Set();
  for (const client of sseClients.values()) if (client.name) names.add(client.name);
  for (const poller of pollers.values()) if (poller.name) names.add(poller.name);
  return [...names].sort((a, b) => a.localeCompare(b));
}

function broadcastOnline() {
  broadcast({ type: 'online', count: onlineCount(), names: onlineNames() });
}

// Simple per-name flood control for /send. Anyone can rename to dodge it, but
// it keeps a single open window from filling the history for everyone.
function tooFast(name) {
  const now = Date.now();
  const recent = (sendTimes.get(name) || []).filter(t => now - t < SEND_WINDOW_MS);
  if (recent.length >= SEND_BURST) {
    sendTimes.set(name, recent);
    return true;
  }
  recent.push(now);
  sendTimes.set(name, recent);
  return false;
}

function pruneTracking() {
  const now = Date.now();
  for (const [id, poller] of pollers) if (poller.seen < now - POLL_TIMEOUT_MS) pollers.delete(id);
  for (const [name, times] of sendTimes) {
    const recent = times.filter(t => now - t < SEND_WINDOW_MS);
    if (recent.length === 0) sendTimes.delete(name);
    else sendTimes.set(name, recent);
  }
}

// Keep SSE connections alive through proxies
setInterval(() => {
  pruneTracking();
  for (const res of sseClients.keys()) safeWrite(res, ': hb\n\n');
}, 25000);

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad request');
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('\n');
    addClient(req, res, String(url.searchParams.get('u') || '').trim().slice(0, MAX_NAME));
    res.write(`data: ${JSON.stringify({ type: 'history', messages })}\n\n`);
    broadcastOnline();
    return;
  }

  if (url.pathname === '/messages' && req.method === 'GET') {
    // Polling fallback for clients where SSE can't get through
    const since = Number(url.searchParams.get('since')) || 0;
    // Key on the chat window: behind Umbrel's app proxy every poll arrives
    // from the proxy's IP, so remoteAddress can't tell devices apart. The name
    // feeds the buddy list, and doubles as a fallback window id.
    const who = String(url.searchParams.get('u') || '').trim().slice(0, MAX_NAME);
    const windowId = String(url.searchParams.get('w') || who || req.socket.remoteAddress || 'anon').slice(0, 64);
    pollers.set(windowId, { name: who, seen: Date.now() });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      messages: messages.filter(m => m.id > since),
      online: onlineCount(),
      names: onlineNames(),
      generation,
    }));
    return;
  }

  if (url.pathname === '/clear' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2048) req.destroy();
    });
    req.on('end', () => {
      let name = '';
      try {
        name = String(JSON.parse(body).name || '').trim().slice(0, MAX_NAME);
      } catch {
        // name is optional
      }
      if (Date.now() - lastClear < CLEAR_COOLDOWN_MS) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('history was just cleared');
        return;
      }
      lastClear = Date.now();
      messages.length = 0;
      nextId = 1;
      generation++;
      saveHistory();
      broadcast({ type: 'cleared', name: name || 'someone', generation });
      res.writeHead(204);
      res.end();
    });
    return;
  }

  if (url.pathname === '/send' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => {
      let name, text;
      try {
        ({ name, text } = JSON.parse(body));
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('bad request');
        return;
      }
      name = String(name || '').trim().slice(0, MAX_NAME);
      text = String(text || '').trim().slice(0, MAX_TEXT);
      if (!name || !text) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('name and text required');
        return;
      }
      if (tooFast(name)) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('slow down');
        return;
      }
      const message = { id: nextId++, name, text, time: Date.now() };
      messages.push(message);
      if (messages.length > MAX_MESSAGES) messages.shift();
      saveHistory();
      broadcast({ type: 'message', message });
      res.writeHead(204);
      res.end();
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    if (req.headers['if-none-match'] === indexEtag) {
      res.writeHead(304, { 'Cache-Control': 'no-cache', ETag: indexEtag });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      ETag: indexEtag,
    });
    res.end(indexHtml);
    return;
  }

  if (url.pathname === '/icon.svg') {
    if (!iconSvg) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    res.end(iconSvg);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`BLAH chat listening on port ${PORT}`);
});

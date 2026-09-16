// BLAH - a dead-simple local chat server. No dependencies, no database.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'messages.json');
const MAX_MESSAGES = 200;
const MAX_NAME = 24;
const MAX_TEXT = 500;

let nextId = 1;
let generation = 1; // bumped on every clear so polling clients can detect it
const messages = []; // {id, name, text, time}
const sseClients = new Set();
const pollers = new Map(); // name -> last seen (ms)

const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

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

if (persistenceReady && fs.existsSync(HISTORY_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(saved)) {
      for (const m of saved) {
        if (m && typeof m.id === 'number' && typeof m.name === 'string' && typeof m.text === 'string') {
          messages.push({ id: m.id, name: m.name, text: m.text, time: m.time || Date.now() });
        }
      }
      if (messages.length > 0) nextId = messages[messages.length - 1].id + 1;
    }
  } catch (err) {
    console.warn(`BLAH: ignoring unreadable history file (${err.message})`);
  }
}

function saveHistory() {
  if (!persistenceReady) return;
  try {
    fs.writeFileSync(HISTORY_FILE + '.tmp', JSON.stringify(messages));
    fs.renameSync(HISTORY_FILE + '.tmp', HISTORY_FILE);
  } catch (err) {
    console.warn(`BLAH: failed to save history (${err.message})`);
  }
}

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(line);
}

function onlineCount() {
  const cutoff = Date.now() - 10000;
  let pollCount = 0;
  for (const [ip, seen] of pollers) {
    if (seen < cutoff) pollers.delete(ip);
    else pollCount++;
  }
  return sseClients.size + pollCount;
}

function broadcastOnline() {
  broadcast({ type: 'online', count: onlineCount() });
}

// Keep SSE connections alive through proxies
setInterval(() => {
  for (const res of sseClients) res.write(': hb\n\n');
}, 25000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('\n');
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'history', messages })}\n\n`);
    broadcastOnline();
    req.on('close', () => {
      sseClients.delete(res);
      broadcastOnline();
    });
    return;
  }

  if (url.pathname === '/messages' && req.method === 'GET') {
    // Polling fallback for clients where SSE can't get through
    const since = Number(url.searchParams.get('since')) || 0;
    // Key on the chatter's name: behind Umbrel's app proxy every poll
    // arrives from the proxy's IP, so remoteAddress can't tell devices apart
    const who = String(url.searchParams.get('u') || req.socket.remoteAddress).slice(0, MAX_NAME);
    pollers.set(who, Date.now());
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      messages: messages.filter(m => m.id > since),
      online: onlineCount(),
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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`BLAH chat listening on port ${PORT}`);
});

// BLAH - a dead-simple local chat server. No dependencies, no database.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'messages.json');
const BOARD_FILE = path.join(DATA_DIR, 'board.json');
const FILES_DIR = path.join(DATA_DIR, 'files');
const MAX_MESSAGES = 200;
const MAX_NAME = 24;
const MAX_TEXT = 500;
const POLL_TIMEOUT_MS = 10000; // a window counts as online this long after its last poll
const SEND_WINDOW_MS = 10000; // flood window for /send
const SEND_BURST = 15; // messages one name may send per window
const CLEAR_COOLDOWN_MS = 3000; // minimum gap between /clear calls
const MAX_TASKS = 200;
const MAX_TASK_TEXT = 200;
const MAX_NOTE_TEXT = 1000;
const MAX_EVENTS = 300; // recent to-do activity shown on the calendar
const BOARD_BURST = 30; // to-do edits one name may make per window
const MAX_FILE_BYTES = Math.max(1, Number(process.env.BLAH_MAX_FILE_MB) || 50) * 1024 * 1024;
const MAX_FILE_NAME = 120;
const UPLOAD_BURST = 10; // files one name may share per window
const FILE_ID_PATTERN = /^[a-f0-9]{18}(\.[a-z0-9]{1,10})?$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

let nextId = 1;
let generation = 1; // bumped on every clear so polling clients can detect it
let lastClear = 0;
const messages = []; // {id, name, text, time}
const sseClients = new Map(); // res -> {name}
const pollers = new Map(); // window id -> {name, seen}
const sendTimes = new Map(); // name -> recent send timestamps
const boardTimes = new Map(); // name -> recent to-do write timestamps
const uploadTimes = new Map(); // name -> recent upload timestamps

// The shared to-do list and the per-day calendar notes.
let taskSeq = 0;
let boardRevision = 0;
const tasks = []; // {id, text, done, by, at, updatedBy, updatedAt}
const notes = {}; // 'YYYY-MM-DD' -> {text, by, at}
const boardEvents = []; // {at, type, taskId, text, by}

// BLAH_DEV=1 re-reads the page and the icon from disk on every request, so a
// plain browser refresh picks up UI edits. Unset (the default, and what the
// Umbrel app runs with) the files are read once at startup.
const DEV_RELOAD = process.env.BLAH_DEV === '1';
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
const ICON_PATH = path.join(__dirname, 'icon.svg');

function readIcon() {
  try {
    return fs.readFileSync(ICON_PATH);
  } catch (err) {
    console.warn(`BLAH: icon.svg is missing (${err.message}); notifications will have no icon`);
    return null;
  }
}

let indexHtml = fs.readFileSync(INDEX_PATH);
let iconSvg = readIcon();

function currentIndexHtml() {
  if (DEV_RELOAD) indexHtml = fs.readFileSync(INDEX_PATH);
  return indexHtml;
}

// Used for the favicon and the notification popup icon. Optional: if the file
// isn't bundled the chat still runs, the icon just comes up blank.
function currentIcon() {
  if (DEV_RELOAD) iconSvg = readIcon();
  return iconSvg;
}

// Lets the browser revalidate instead of reusing a stale page after an update
function etagFor(buffer) {
  return `"${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16)}"`;
}

// History persists to HISTORY_FILE so it survives app restarts. If the
// data dir isn't writable, BLAH still works, just without persistence.
let persistenceReady = false;
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });
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
          const message = { id: m.id, name: m.name, text: m.text, time: m.time || Date.now() };
          if (m.file && typeof m.file === 'object' && FILE_ID_PATTERN.test(String(m.file.id))) {
            message.file = {
              id: String(m.file.id),
              name: String(m.file.name || 'file').slice(0, MAX_FILE_NAME),
              size: Number(m.file.size) || 0,
              type: String(m.file.type || 'application/octet-stream').slice(0, 100),
            };
          }
          messages.push(message);
        }
      }
      if (messages.length > 0) nextId = messages[messages.length - 1].id + 1;
      if (Number.isInteger(savedGeneration) && savedGeneration > 0) generation = savedGeneration;
    }
  } catch (err) {
    console.warn(`BLAH: ignoring unreadable history file (${err.message})`);
  }
}

// Drop any file on disk that no surviving message points at, so the volume
// does not fill up with attachments whose chat message has been cleared.
if (persistenceReady) {
  try {
    const wanted = new Set(messages.filter(m => m.file).map(m => m.file.id));
    for (const entry of fs.readdirSync(FILES_DIR)) {
      if (wanted.has(entry)) continue;
      fs.unlinkSync(path.join(FILES_DIR, entry));
    }
  } catch (err) {
    console.warn(`BLAH: could not tidy the shared files folder (${err.message})`);
  }
}

if (persistenceReady && fs.existsSync(BOARD_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
    if (Array.isArray(saved.tasks)) {
      for (const t of saved.tasks.slice(-MAX_TASKS)) {
        if (t && Number.isInteger(t.id) && typeof t.text === 'string') {
          tasks.push({
            id: t.id,
            text: t.text.slice(0, MAX_TASK_TEXT),
            done: t.done === true,
            by: typeof t.by === 'string' ? t.by : '',
            at: Number(t.at) || Date.now(),
            updatedBy: typeof t.updatedBy === 'string' ? t.updatedBy : '',
            updatedAt: Number(t.updatedAt) || Number(t.at) || Date.now(),
          });
        }
      }
      taskSeq = tasks.reduce((highest, t) => Math.max(highest, t.id), 0);
    }
    if (saved.notes && typeof saved.notes === 'object') {
      for (const [day, note] of Object.entries(saved.notes)) {
        if (DAY_PATTERN.test(day) && note && typeof note.text === 'string') {
          notes[day] = {
            text: note.text.slice(0, MAX_NOTE_TEXT),
            by: typeof note.by === 'string' ? note.by : '',
            at: Number(note.at) || Date.now(),
          };
        }
      }
    }
    if (Array.isArray(saved.events)) {
      for (const e of saved.events.slice(-MAX_EVENTS)) {
        if (e && typeof e.type === 'string' && typeof e.text === 'string') {
          boardEvents.push({
            at: Number(e.at) || Date.now(),
            type: e.type,
            taskId: Number(e.taskId) || 0,
            text: e.text.slice(0, MAX_TASK_TEXT),
            by: typeof e.by === 'string' ? e.by : '',
          });
        }
      }
    }
  } catch (err) {
    console.warn(`BLAH: ignoring unreadable board file (${err.message})`);
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

function saveBoard() {
  if (!persistenceReady) return;
  try {
    fs.writeFileSync(BOARD_FILE + '.tmp', JSON.stringify({ tasks, notes, events: boardEvents }));
    fs.renameSync(BOARD_FILE + '.tmp', BOARD_FILE);
  } catch (err) {
    console.warn(`BLAH: failed to save the to-do list (${err.message})`);
  }
}

function boardPayload() {
  return { revision: boardRevision, tasks, notes, events: boardEvents };
}

function boardChanged() {
  boardRevision++;
  saveBoard();
  broadcast({ type: 'board', board: boardPayload() });
}

function logBoardEvent(type, task, by) {
  boardEvents.push({ at: Date.now(), type, taskId: task.id, text: task.text, by });
  while (boardEvents.length > MAX_EVENTS) boardEvents.shift();
}

// ---- shared files ------------------------------------------------------
function removeFile(message) {
  if (!message || !message.file) return;
  try {
    fs.unlinkSync(path.join(FILES_DIR, message.file.id));
  } catch (err) {
    // already gone, or it never made it to disk
  }
}

function findFile(id) {
  for (const message of messages) {
    if (message.file && message.file.id === id) return message.file;
  }
  return null;
}

// Attachments always come back as a download (never rendered in the page), and
// the original name travels in both the legacy and the UTF-8 form.
function contentDisposition(name) {
  const clean = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_').slice(0, MAX_FILE_NAME) || 'file';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${clean}"; filename*=UTF-8''${encoded}`;
}

function safeExtension(name) {
  const extension = path.extname(String(name)).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
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

// Simple per-name flood control. Anyone can rename to dodge it, but it keeps a
// single open window from filling the history or the to-do list for everyone.
function tooFast(map, name, limit) {
  const now = Date.now();
  const recent = (map.get(name) || []).filter(t => now - t < SEND_WINDOW_MS);
  if (recent.length >= limit) {
    map.set(name, recent);
    return true;
  }
  recent.push(now);
  map.set(name, recent);
  return false;
}

function pruneTracking() {
  const now = Date.now();
  for (const [id, poller] of pollers) if (poller.seen < now - POLL_TIMEOUT_MS) pollers.delete(id);
  for (const map of [sendTimes, boardTimes, uploadTimes]) {
    for (const [name, times] of map) {
      const recent = times.filter(t => now - t < SEND_WINDOW_MS);
      if (recent.length === 0) map.delete(name);
      else map.set(name, recent);
    }
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
    res.write(`data: ${JSON.stringify({ type: 'history', messages, maxFileBytes: MAX_FILE_BYTES })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'board', board: boardPayload() })}\n\n`);
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
      boardRevision,
      maxFileBytes: MAX_FILE_BYTES,
      generation,
    }));
    return;
  }

  if (url.pathname === '/board' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(boardPayload()));
    return;
  }

  if (url.pathname === '/board' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => {
      const fail = (code, message) => {
        res.writeHead(code, { 'Content-Type': 'text/plain' });
        res.end(message);
      };

      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        fail(400, 'bad request');
        return;
      }
      if (!payload || typeof payload !== 'object') {
        fail(400, 'bad request');
        return;
      }

      const name = String(payload.name || '').trim().slice(0, MAX_NAME);
      const action = String(payload.action || '');
      const text = String(payload.text || '').trim().slice(0, MAX_TASK_TEXT);
      if (!name) {
        fail(400, 'name required');
        return;
      }
      if (tooFast(boardTimes, name, BOARD_BURST)) {
        fail(429, 'slow down');
        return;
      }

      const task = action === 'add' ? null : tasks.find(t => t.id === Number(payload.id));

      if (action === 'add') {
        if (!text) {
          fail(400, 'text required');
          return;
        }
        if (tasks.length >= MAX_TASKS) {
          fail(409, 'the to-do list is full');
          return;
        }
        const now = Date.now();
        const created = { id: ++taskSeq, text, done: false, by: name, at: now, updatedBy: name, updatedAt: now };
        tasks.push(created);
        logBoardEvent('created', created, name);
      } else if (action === 'edit') {
        if (!task) {
          fail(404, 'no such task');
          return;
        }
        if (!text) {
          fail(400, 'text required');
          return;
        }
        task.text = text;
        task.updatedBy = name;
        task.updatedAt = Date.now();
        logBoardEvent('edited', task, name);
      } else if (action === 'toggle') {
        if (!task) {
          fail(404, 'no such task');
          return;
        }
        task.done = payload.done === true;
        task.updatedBy = name;
        task.updatedAt = Date.now();
        logBoardEvent(task.done ? 'done' : 'reopened', task, name);
      } else if (action === 'delete') {
        if (!task) {
          fail(404, 'no such task');
          return;
        }
        tasks.splice(tasks.indexOf(task), 1);
        // Drop the deleted task's history so the calendar only shows live work
        for (let i = boardEvents.length - 1; i >= 0; i--) {
          if (boardEvents[i].taskId === task.id) boardEvents.splice(i, 1);
        }
      } else if (action === 'note') {
        const day = String(payload.day || '');
        const parsedDay = new Date(day + 'T00:00:00Z');
        if (!DAY_PATTERN.test(day) || Number.isNaN(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== day) {
          fail(400, 'bad day');
          return;
        }
        const noteText = String(payload.text || '').trim().slice(0, MAX_NOTE_TEXT);
        if (!noteText) delete notes[day];
        else notes[day] = { text: noteText, by: name, at: Date.now() };
      } else {
        fail(400, 'unknown action');
        return;
      }

      boardChanged();
      res.writeHead(204);
      res.end();
    });
    return;
  }

  if (url.pathname === '/upload' && req.method === 'POST') {
    const fail = (code, message) => {
      res.writeHead(code, { 'Content-Type': 'text/plain' });
      res.end(message);
    };

    const name = String(url.searchParams.get('u') || '').trim().slice(0, MAX_NAME);
    const fileName = (String(url.searchParams.get('n') || '').trim() || 'file').slice(0, MAX_FILE_NAME);
    const contentType = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100);
    const declared = Number(req.headers['content-length']) || 0;

    if (!name) {
      fail(400, 'name required');
      return;
    }
    if (tooFast(uploadTimes, name, UPLOAD_BURST)) {
      fail(429, 'slow down');
      return;
    }
    if (declared > MAX_FILE_BYTES) {
      fail(413, 'file too big');
      req.resume(); // drain what is already on the wire
      return;
    }

    const chunks = [];
    let received = 0;
    let tooBig = false;
    req.on('data', chunk => {
      if (tooBig) return;
      received += chunk.length;
      if (received > MAX_FILE_BYTES) {
        tooBig = true;
        chunks.length = 0;
        fail(413, 'file too big');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!received) {
        fail(400, 'empty file');
        return;
      }
      const fileId = crypto.randomBytes(9).toString('hex') + safeExtension(fileName);
      try {
        fs.writeFileSync(path.join(FILES_DIR, fileId), Buffer.concat(chunks));
      } catch (err) {
        console.warn(`BLAH: could not store ${fileId} (${err.message})`);
        fail(500, 'could not store the file');
        return;
      }
      const message = {
        id: nextId++,
        name,
        text: '',
        time: Date.now(),
        file: { id: fileId, name: fileName, size: received, type: contentType },
      };
      messages.push(message);
      if (messages.length > MAX_MESSAGES) removeFile(messages.shift());
      saveHistory();
      broadcast({ type: 'message', message });
      res.writeHead(204);
      res.end();
    });
    return;
  }

  if (url.pathname.startsWith('/files/') && req.method === 'GET') {
    const fileId = decodeURIComponent(url.pathname.slice('/files/'.length));
    const file = FILE_ID_PATTERN.test(fileId) ? findFile(fileId) : null;
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const filePath = path.join(FILES_DIR, file.id);
    let stats;
    try {
      stats = fs.statSync(filePath);
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      // Always a download: a shared .html or .svg must never run in BLAH's origin
      'Content-Type': 'application/octet-stream',
      'Content-Length': stats.size,
      'Content-Disposition': contentDisposition(file.name),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=0, no-store',
    });
    fs.createReadStream(filePath).pipe(res);
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
      for (const message of messages) removeFile(message);
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
      if (tooFast(sendTimes, name, SEND_BURST)) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end('slow down');
        return;
      }
      const message = { id: nextId++, name, text, time: Date.now() };
      messages.push(message);
      if (messages.length > MAX_MESSAGES) removeFile(messages.shift());
      saveHistory();
      broadcast({ type: 'message', message });
      res.writeHead(204);
      res.end();
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const page = currentIndexHtml();
    const etag = etagFor(page);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'Cache-Control': 'no-cache', ETag: etag });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      ETag: etag,
    });
    res.end(page);
    return;
  }

  if (url.pathname === '/icon.svg') {
    const icon = currentIcon();
    if (!icon) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': DEV_RELOAD ? 'no-store' : 'public, max-age=86400',
    });
    res.end(icon);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`BLAH chat listening on port ${PORT}`);
  if (DEV_RELOAD) console.log('BLAH dev mode: the page and icon are re-read from disk on every request');
  if (!persistenceReady) console.log('BLAH: running without persistence');
});

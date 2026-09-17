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
const MAX_MEMOS = 200; // short notes in the side panel (text capped like a to-do)
const MAX_EVENTS = 300; // recent to-do activity shown on the calendar
const BOARD_BURST = 30; // to-do and note edits one name may make per window
const MAX_FILE_BYTES = Math.max(1, Number(process.env.BLAH_MAX_FILE_MB) || 50) * 1024 * 1024;
const MAX_FILE_NAME = 120;
const UPLOAD_BURST = 10; // files one name may share per window
const MAX_CONCURRENT_UPLOADS = 4; // in flight at once, across every name
const FILE_ID_PATTERN = /^[a-f0-9]{18}(\.[a-z0-9]{1,10})?$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

let nextId = 1;
let generation = 1; // bumped on every clear so polling clients can detect it
let lastClear = 0;
const messages = []; // {id, name, text, time}
const sseClients = new Map(); // res -> {name}
const pollers = new Map(); // window id -> {name, seen}
const sendTimes = new Map(); // name -> recent send timestamps
const boardTimes = new Map(); // name -> recent to-do / note write timestamps
const uploadTimes = new Map(); // name -> recent upload timestamps
let activeUploads = 0;

// The shared to-do list, the side-panel notes and the per-day calendar notes.
let taskSeq = 0;
let memoSeq = 0;
let boardRevision = 0;
const tasks = []; // {id, text, done, by, at, updatedBy, updatedAt}
const memos = []; // side-panel notes: {id, text, by, at, updatedBy, updatedAt}
const notes = {}; // calendar day notes: 'YYYY-MM-DD' -> {text, by, at}
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

// Lets the browser revalidate instead of reusing a stale page after an update.
// Hashed once per load, not once per request.
function etagFor(buffer) {
  return `"${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16)}"`;
}

function loadIndex() {
  const page = fs.readFileSync(INDEX_PATH);
  return { page, etag: etagFor(page) };
}

let index = loadIndex();
let iconSvg = readIcon();

function currentIndex() {
  if (DEV_RELOAD) index = loadIndex();
  return index;
}

// Used for the favicon and the notification popup icon. Optional: if the file
// isn't bundled the chat still runs, the icon just comes up blank.
function currentIcon() {
  if (DEV_RELOAD) iconSvg = readIcon();
  return iconSvg;
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
// does not fill up with attachments whose chat message has been cleared. This
// also sweeps up the .part file of any upload that a restart cut short.
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
    // The revision is kept on disk so a client that reconnects after a restart
    // can't mistake a rebuilt list for the one it already has.
    if (Number.isInteger(saved.revision) && saved.revision > 0) boardRevision = saved.revision;
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
    if (Array.isArray(saved.memos)) {
      for (const m of saved.memos.slice(-MAX_MEMOS)) {
        if (m && Number.isInteger(m.id) && typeof m.text === 'string' && m.text.trim()) {
          memos.push({
            id: m.id,
            text: m.text.slice(0, MAX_TASK_TEXT),
            by: typeof m.by === 'string' ? m.by : '',
            at: Number(m.at) || Date.now(),
            updatedBy: typeof m.updatedBy === 'string' ? m.updatedBy : '',
            updatedAt: Number(m.updatedAt) || Number(m.at) || Date.now(),
          });
        }
      }
      memoSeq = memos.reduce((highest, m) => Math.max(highest, m.id), 0);
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
    fs.writeFileSync(BOARD_FILE + '.tmp', JSON.stringify({ revision: boardRevision, tasks, notes, memos, events: boardEvents }));
    fs.renameSync(BOARD_FILE + '.tmp', BOARD_FILE);
  } catch (err) {
    console.warn(`BLAH: failed to save the board file (${err.message})`);
  }
}

function boardPayload() {
  return { revision: boardRevision, tasks, notes, memos, events: boardEvents };
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

// Screen names of everyone signed on, for People > Who's here. Clients that never
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

// ---- request plumbing --------------------------------------------------
// Any handler bug answers 500 for that one request instead of taking the whole
// room down with it (an uncaught throw in an http handler exits the process).
function guarded(req, res, fn) {
  try {
    fn();
  } catch (err) {
    console.warn(`BLAH: ${req.method} ${req.url} failed (${err.message})`);
    try {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('server error');
    } catch (ignored) {
      // the socket is already gone
    }
  }
}

function refuse(res, code, message) {
  res.writeHead(code, { 'Content-Type': 'text/plain' });
  res.end(message);
}

// For a request whose body we don't want: answer, then drop the connection once
// the answer is on the wire, rather than draining gigabytes into the void.
function refuseAndDrop(req, res, code, message) {
  res.writeHead(code, { 'Content-Type': 'text/plain', Connection: 'close' });
  res.end(message, () => req.destroy());
}

// ---- cross-site request forgery -----------------------------------------
// There is no login, so the only thing between a random web page and "post as
// anyone / wipe the room" is the browser saying where a request came from.
// Modern browsers label every request with Sec-Fetch-Site: BLAH's own page is
// same-origin, a form or script on another site is cross-site and is refused.
// On top of that the JSON endpoints insist on a JSON body (an HTML form can
// only send urlencoded, multipart or text/plain, which is how the classic
// text/plain trick smuggles JSON in) and the upload endpoint insists on a
// custom header, which a form can't set and a cross-site fetch can't add
// without a CORS preflight this server never approves. Plain curl on the LAN
// sends none of the browser headers and keeps working.
function rejectForgery(req, res, { header, drop } = {}) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  const answer = (code, message) => (drop ? refuseAndDrop(req, res, code, message) : refuse(res, code, message));
  if (site && site !== 'same-origin' && site !== 'none') {
    answer(403, 'cross-site request refused');
    return true;
  }
  if (header) {
    if (!req.headers[header]) {
      answer(403, `${header} header required`);
      return true;
    }
  } else if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    answer(415, 'send JSON');
    return true;
  }
  return false;
}

// Keep SSE connections alive through proxies
setInterval(() => {
  pruneTracking();
  for (const res of sseClients.keys()) safeWrite(res, ': hb\n\n');
}, 25000);

function handleRequest(req, res) {
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
    // feeds the who's-here list, and doubles as a fallback window id.
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
    if (rejectForgery(req, res)) return;
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => guarded(req, res, () => {
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
      // Validate before the request counts against the flood budget, so a
      // mistyped action or a stale task id doesn't eat into it
      const needsTask = action === 'edit' || action === 'toggle' || action === 'delete';
      const needsMemo = action === 'memo-edit' || action === 'memo-delete';
      const task = needsTask ? tasks.find(t => t.id === Number(payload.id)) : null;
      const memo = needsMemo ? memos.find(m => m.id === Number(payload.id)) : null;
      if (!['add', 'edit', 'toggle', 'delete', 'note', 'memo-add', 'memo-edit', 'memo-delete'].includes(action)) {
        fail(400, 'unknown action');
        return;
      }
      if (needsTask && !task) {
        fail(404, 'no such task');
        return;
      }
      if (needsMemo && !memo) {
        fail(404, 'no such note');
        return;
      }
      const writesText = action === 'add' || action === 'edit' || action === 'memo-add' || action === 'memo-edit';
      if (writesText && !text) {
        fail(400, 'text required');
        return;
      }
      if (tooFast(boardTimes, name, BOARD_BURST)) {
        fail(429, 'slow down');
        return;
      }

      if (action === 'add') {
        if (tasks.length >= MAX_TASKS) {
          fail(409, 'the to-do list is full');
          return;
        }
        const now = Date.now();
        const created = { id: ++taskSeq, text, done: false, by: name, at: now, updatedBy: name, updatedAt: now };
        tasks.push(created);
        logBoardEvent('created', created, name);
      } else if (action === 'edit') {
        task.text = text;
        task.updatedBy = name;
        task.updatedAt = Date.now();
        logBoardEvent('edited', task, name);
      } else if (action === 'toggle') {
        task.done = payload.done === true;
        task.updatedBy = name;
        task.updatedAt = Date.now();
        logBoardEvent(task.done ? 'done' : 'reopened', task, name);
      } else if (action === 'delete') {
        tasks.splice(tasks.indexOf(task), 1);
        // Drop the deleted task's history so the calendar only shows live work
        for (let i = boardEvents.length - 1; i >= 0; i--) {
          if (boardEvents[i].taskId === task.id) boardEvents.splice(i, 1);
        }
      } else if (action === 'memo-add') {
        if (memos.length >= MAX_MEMOS) {
          fail(409, 'the notes list is full');
          return;
        }
        const now = Date.now();
        memos.push({ id: ++memoSeq, text, by: name, at: now, updatedBy: name, updatedAt: now });
      } else if (action === 'memo-edit') {
        memo.text = text;
        memo.updatedBy = name;
        memo.updatedAt = Date.now();
      } else if (action === 'memo-delete') {
        memos.splice(memos.indexOf(memo), 1);
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
      }

      boardChanged();
      res.writeHead(204);
      res.end();
    }));
    return;
  }

  if (url.pathname === '/upload' && req.method === 'POST') {
    if (rejectForgery(req, res, { header: 'x-blah-upload', drop: true })) return;

    const name = String(url.searchParams.get('u') || '').trim().slice(0, MAX_NAME);
    const fileName = (String(url.searchParams.get('n') || '').trim() || 'file').slice(0, MAX_FILE_NAME);
    const contentType = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 100);
    const declared = Number(req.headers['content-length']) || 0;

    if (!name) {
      refuseAndDrop(req, res, 400, 'name required');
      return;
    }
    if (declared > MAX_FILE_BYTES) {
      refuseAndDrop(req, res, 413, 'file too big');
      return;
    }
    if (activeUploads >= MAX_CONCURRENT_UPLOADS || tooFast(uploadTimes, name, UPLOAD_BURST)) {
      refuseAndDrop(req, res, 429, 'slow down');
      return;
    }
    if (!persistenceReady) {
      refuseAndDrop(req, res, 500, 'could not store the file');
      return;
    }

    // Streamed straight to disk as <id>.part, so a big file never sits in
    // memory, then renamed into place once the last byte has landed. A cut-off
    // upload (too big, client gone, disk error) throws the .part away.
    const fileId = crypto.randomBytes(9).toString('hex') + safeExtension(fileName);
    const finalPath = path.join(FILES_DIR, fileId);
    const partPath = finalPath + '.part';
    const out = fs.createWriteStream(partPath, { flags: 'wx' });
    let received = 0;
    let settled = false;
    let abandoned = false;
    activeUploads++;

    const abandon = (code, message) => {
      if (settled) return;
      settled = true;
      abandoned = true;
      activeUploads--;
      req.unpipe(out);
      out.destroy();
      if (code) refuseAndDrop(req, res, code, message);
    };

    out.on('close', () => {
      if (abandoned) fs.unlink(partPath, () => {});
    });
    out.on('error', err => {
      if (!settled) console.warn(`BLAH: could not store ${fileId} (${err.message})`);
      abandon(500, 'could not store the file');
    });
    req.on('error', () => abandon(0));
    req.on('close', () => {
      if (!req.complete) abandon(0); // the client went away mid-upload
    });
    req.on('data', chunk => {
      received += chunk.length;
      if (received > MAX_FILE_BYTES) abandon(413, 'file too big');
    });
    out.on('finish', () => {
      if (settled) return;
      if (!received) {
        abandon(400, 'empty file');
        return;
      }
      settled = true;
      activeUploads--;
      try {
        fs.renameSync(partPath, finalPath);
      } catch (err) {
        console.warn(`BLAH: could not store ${fileId} (${err.message})`);
        fs.unlink(partPath, () => {});
        refuse(res, 500, 'could not store the file');
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
    req.pipe(out);
    return;
  }

  if (url.pathname.startsWith('/files/') && req.method === 'GET') {
    // No decodeURIComponent here: the id pattern only admits [a-f0-9.], which
    // never need escaping, and decoding a stray % would throw.
    const fileId = url.pathname.slice('/files/'.length);
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
    // The file can vanish between the stat and the open (a /clear racing a
    // download), and an unhandled stream error would exit the process.
    const stream = fs.createReadStream(filePath);
    stream.on('error', err => {
      console.warn(`BLAH: could not read ${file.id} (${err.message})`);
      res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }

  if (url.pathname === '/clear' && req.method === 'POST') {
    if (rejectForgery(req, res)) return;
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2048) req.destroy();
    });
    req.on('end', () => guarded(req, res, () => {
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
    }));
    return;
  }

  if (url.pathname === '/send' && req.method === 'POST') {
    if (rejectForgery(req, res)) return;
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => guarded(req, res, () => {
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
    }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const { page, etag } = currentIndex();
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
}

const server = http.createServer((req, res) => guarded(req, res, () => handleRequest(req, res)));

server.listen(PORT, () => {
  console.log(`BLAH chat listening on port ${PORT}`);
  if (DEV_RELOAD) console.log('BLAH dev mode: the page and icon are re-read from disk on every request');
  if (!persistenceReady) console.log('BLAH: running without persistence');
});

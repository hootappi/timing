'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const rules = require('./public/rules.js');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'scores.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_STORED = 100;
const TOP_N = 10;
const MAX_BODY_BYTES = 8192;   // room for MAX_ROUNDS press times
const GAME_TTL_MS = 6 * 60 * 60 * 1000;
const CLOCK_SLACK_S = 0.5;
const RESET_TZ = process.env.RESET_TZ || 'Europe/Copenhagen';
const [RESET_H, RESET_M] = (process.env.RESET_AT || '22:22').split(':').map(Number);
if (!(RESET_H >= 0 && RESET_H < 24 && RESET_M >= 0 && RESET_M < 60)) {
  console.error(`RESET_AT must be HH:MM, got ${process.env.RESET_AT}`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// --- persistence ---------------------------------------------------------

function loadScores() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`Cannot read ${DATA_FILE}: ${err.message}`);
  }
}

// Write to a temp file in the same directory, then rename: readers never see a half-written file.
function saveScores(scores) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(scores));
  fs.renameSync(tmp, DATA_FILE);
}

let scores;
try {
  scores = loadScores();
  saveScores(scores); // fail at startup, not on the first submit, if the data dir is not writable
} catch (err) {
  console.error(`Data directory problem: ${err.message}`);
  console.error(`DATA_DIR=${DATA_DIR} must be readable and writable by uid ${process.getuid()}.`);
  process.exit(1);
}

// --- daily reset ---------------------------------------------------------
// No timer: every request looks up the most recent reset time and ignores older scores,
// so a restart or downtime across the reset cannot skip it.

const tzParts = new Intl.DateTimeFormat('en-US', {
  timeZone: RESET_TZ, hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});

// Calendar fields of instant t as a clock in RESET_TZ shows them.
const wallClock = (t) => Object.fromEntries(tzParts.formatToParts(t).map(({ type, value }) => [type, Number(value)]));

// RESET_TZ's offset from UTC at instant t, in ms.
function tzOffset(t) {
  const p = wallClock(t);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}

// Instant of RESET_H:RESET_M on the given RESET_TZ calendar day (month 1-based; day may overflow).
function resetOn(year, month, day) {
  const wall = Date.UTC(year, month - 1, day, RESET_H, RESET_M);
  const guess = wall - tzOffset(wall);
  return wall - tzOffset(guess);   // second pass settles DST-change days
}

function lastReset(now = Date.now()) {
  const p = wallClock(now);
  const today = resetOn(p.year, p.month, p.day);
  return today <= now ? today : resetOn(p.year, p.month, p.day - 1);
}

function nextReset(now = Date.now()) {
  const p = wallClock(now);
  const today = resetOn(p.year, p.month, p.day);
  return today > now ? today : resetOn(p.year, p.month, p.day + 1);
}

const currentScores = () => {
  const since = lastReset();
  return scores.filter((s) => Date.parse(s.at) >= since);
};

// --- games ---------------------------------------------------------------
// A game is a signed token carrying a seed and issue time, so the server keeps no state per
// open game. Submitting replays the run from the seed; only tokens already used are remembered.

const GAME_SECRET = crypto.randomBytes(32); // per process: a restart voids runs in progress
const usedGames = new Map(); // signature -> expiry time

const sign = (payload) => crypto.createHmac('sha256', GAME_SECRET).update(payload).digest('base64url');

function newGame(res) {
  const seed = crypto.randomInt(2 ** 32);
  const payload = `${seed}.${Date.now()}`;
  sendJson(res, 201, { token: `${payload}.${sign(payload)}`, seed });
}

// Returns { seed, issuedAt, sig } or { error }.
function openGame(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return { error: 'missing or malformed game' };
  const [seedStr, atStr, sig] = parts;
  const expected = Buffer.from(sign(`${seedStr}.${atStr}`));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { error: 'invalid game' };
  const issuedAt = Number(atStr);
  const now = Date.now();
  if (now - issuedAt > GAME_TTL_MS) return { error: 'game expired' };
  for (const [s, expires] of usedGames) if (expires < now) usedGames.delete(s);
  if (usedGames.has(sig)) return { error: 'game already submitted' };
  return { seed: Number(seedStr), issuedAt, sig };
}

// --- http helpers --------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// --- routes --------------------------------------------------------------

function getLeaderboard(res) {
  sendJson(res, 200, {
    scores: currentScores().slice(0, TOP_N).map(({ name, score }) => ({ name, score })),
    resetsAt: new Date(nextReset()).toISOString(),
  });
}

async function postScore(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.message });
  }
  const name = typeof body?.name === 'string' ? body.name.toUpperCase() : '';
  if (!/^[A-Z0-9]{1,8}$/.test(name)) return sendJson(res, 400, { error: 'name must be 1 to 8 letters or digits' });

  const game = openGame(body?.game);
  if (game.error) return sendJson(res, 400, { error: game.error });
  const run = rules.replay(game.seed, body?.rounds);
  if (!run || run.score < 1) return sendJson(res, 400, { error: 'run did not verify' });
  if ((Date.now() - game.issuedAt) / 1000 + CLOCK_SLACK_S < run.minSeconds) {
    return sendJson(res, 400, { error: 'run did not verify' });
  }
  const score = run.score;

  const entry = { name, score, at: new Date().toISOString() };
  const next = [...currentScores(), entry].sort((a, b) => b.score - a.score).slice(0, MAX_STORED); // stable: ties keep earlier first
  try {
    saveScores(next);
  } catch (err) {
    console.error(`Failed to save scores: ${err.message}`);
    return sendJson(res, 500, { error: 'could not save score' });
  }
  scores = next;
  usedGames.set(game.sig, game.issuedAt + GAME_TTL_MS);
  const idx = scores.indexOf(entry);
  sendJson(res, 201, { ok: true, rank: idx === -1 ? null : idx + 1 });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'not found' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/api/leaderboard') {
    return req.method === 'GET' ? getLeaderboard(res) : sendJson(res, 405, { error: 'method not allowed' });
  }
  if (pathname === '/api/games') {
    return req.method === 'POST' ? newGame(res) : sendJson(res, 405, { error: 'method not allowed' });
  }
  if (pathname === '/api/scores') {
    return req.method === 'POST' ? postScore(req, res) : sendJson(res, 405, { error: 'method not allowed' });
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
  sendJson(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, () => console.log(`timing listening on :${PORT}, data in ${DATA_FILE}`));

// PID 1 in a container ignores SIGTERM unless handled; without this `docker stop` waits 10s.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

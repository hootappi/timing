'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const rules = require('./public/rules.js');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'leaderboard.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_STORED = 100;
const TOP_N = 10;
const WINNERS_SHOWN = 30;
const MAX_BODY_BYTES = 8192;   // room for MAX_ROUNDS press times
const GAME_TTL_MS = 2 * 60 * 60 * 1000;     // a run must finish within this of starting
const RESULT_TTL_MS = 60 * 60 * 1000;       // time to type a name after a run
// Real time between issuing a game and finishing it must match the game time the run claims.
// Less means forged presses; much more means the game clock was slowed down in the browser.
const CLOCK_EARLY_S = 0.5;
const CLOCK_LATE_S = (gameSeconds) => 2 + 0.1 * gameSeconds;   // network round trips and dropped frames
const RESET_TZ = process.env.RESET_TZ || 'Europe/Copenhagen';
// House score: added to each day's board at HOUSE_AT, as a mark to beat. HOUSE_SCORE=0 turns it off.
const HOUSE_NAME = process.env.HOUSE_NAME || 'HOOTAPPI';
const HOUSE_SCORE = Number(process.env.HOUSE_SCORE ?? 15);

function config(name, ok, hint) {
  if (ok) return;
  console.error(`${name} must be ${hint}, got ${process.env[name]}`);
  process.exit(1);
}

function parseTime(name, fallback) {
  const [h, m] = (process.env[name] || fallback).split(':').map(Number);
  config(name, h >= 0 && h < 24 && m >= 0 && m < 60, 'HH:MM');
  return [h, m];
}

const [RESET_H, RESET_M] = parseTime('RESET_AT', '22:22');
const [HOUSE_H, HOUSE_M] = parseTime('HOUSE_AT', '07:00');
config('HOUSE_NAME', /^[A-Z0-9]{1,8}$/.test(HOUSE_NAME), '1 to 8 capital letters or digits');
config('HOUSE_SCORE', Number.isInteger(HOUSE_SCORE) && HOUSE_SCORE >= 0, 'a whole number, 0 to turn off');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// --- daily reset ---------------------------------------------------------
// No timer: every request checks whether a reset time has passed since the board's day began,
// and if so closes that day. A restart or downtime across the reset cannot skip it.

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

// Instant of h:m on the given RESET_TZ calendar day (month 1-based; day may overflow).
function instantOn(year, month, day, h, m) {
  const wall = Date.UTC(year, month - 1, day, h, m);
  const guess = wall - tzOffset(wall);
  return wall - tzOffset(guess);   // second pass settles DST-change days
}

const resetOn = (year, month, day) => instantOn(year, month, day, RESET_H, RESET_M);

// First HOUSE_AT after the board's day began.
function houseTime(dayStart) {
  const p = wallClock(dayStart);
  const t = instantOn(p.year, p.month, p.day, HOUSE_H, HOUSE_M);
  return t >= dayStart ? t : instantOn(p.year, p.month, p.day + 1, HOUSE_H, HOUSE_M);
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

// YYYY-MM-DD in RESET_TZ.
function dayOf(t) {
  const p = wallClock(t);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// --- persistence ---------------------------------------------------------
// board: { dayStart: ms of the reset that opened today's board, scores: [...] best first,
//          winners: [{ day, name, score }] newest first, house: true once today's house score is in }

function loadBoard() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { dayStart: lastReset(), scores: [], winners: [] };
    throw new Error(`Cannot read ${DATA_FILE}: ${err.message}`);
  }
}

// Write to a temp file in the same directory, then rename: readers never see a half-written file.
function saveBoard(b) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(b));
  fs.renameSync(tmp, DATA_FILE);
}

let board;
try {
  board = loadBoard();
  saveBoard(board); // fail at startup, not on the first submit, if the data dir is not writable
} catch (err) {
  console.error(`Data directory problem: ${err.message}`);
  console.error(`DATA_DIR=${DATA_DIR} must be readable and writable by uid ${process.getuid()}.`);
  process.exit(1);
}

const byRank = (a, b) => b.score - a.score || Date.parse(a.at) - Date.parse(b.at);   // ties: earlier run first

// Bring the board up to now. Close the day if its reset has passed: its top score becomes that
// day's winner. Then add the house score if its time has come. Both are timed by the clock, not
// by when a request happens to arrive, so the result is the same as if a timer had done it.
function catchUp() {
  let next = board;
  const since = lastReset();
  if (next.dayStart < since) {
    const winners = [...next.winners];
    const top = next.scores[0];
    if (top) winners.unshift({ day: dayOf(nextReset(next.dayStart)), name: top.name, score: top.score });
    next = { dayStart: since, scores: [], winners };
  }
  const houseAt = houseTime(next.dayStart);
  if (HOUSE_SCORE > 0 && !next.house && Date.now() >= houseAt) {
    const entry = { name: HOUSE_NAME, score: HOUSE_SCORE, at: new Date(houseAt).toISOString() };
    next = { ...next, house: true, scores: [...next.scores, entry].sort(byRank).slice(0, MAX_STORED) };
  }
  if (next === board) return;
  try {
    saveBoard(next);
  } catch (err) {
    console.error(`Failed to save board: ${err.message}`);   // keep going in memory; the next save retries
  }
  board = next;
}

// --- games ---------------------------------------------------------------
// Tokens are signed, so the server keeps no state per open game:
//   game   "<seed>.<issuedAt>.<sig>"         from POST /api/games, played in the browser
//   result "<score>.<finishedAt>.<sig>"      from POST /api/games/finish, once the run verifies
// Each token works once; only used signatures are remembered, until the token would expire anyway.

const SECRET = crypto.randomBytes(32); // per process: a restart voids runs in progress
const used = new Map(); // signature -> expiry time

const sign = (kind, payload) => crypto.createHmac('sha256', SECRET).update(`${kind}|${payload}`).digest('base64url');

function issue(kind, a, b) {
  const payload = `${a}.${b}`;
  return `${payload}.${sign(kind, payload)}`;
}

// Returns { a, at, sig } with the token's two numbers, or { error }.
function redeem(kind, token, ttl) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return { error: `missing or malformed ${kind}` };
  const [aStr, atStr, sig] = parts;
  const expected = Buffer.from(sign(kind, `${aStr}.${atStr}`));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { error: `invalid ${kind}` };
  const at = Number(atStr);
  const now = Date.now();
  if (now - at > ttl) return { error: `${kind} expired` };
  for (const [s, expires] of used) if (expires < now) used.delete(s);
  if (used.has(sig)) return { error: `${kind} already used` };
  return { a: Number(aStr), at, sig };
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
  catchUp();
  sendJson(res, 200, {
    scores: board.scores.slice(0, TOP_N).map(({ name, score }) => ({ name, score })),
    resetsAt: new Date(nextReset()).toISOString(),
    winners: board.winners.slice(0, WINNERS_SHOWN),
  });
}

function newGame(res) {
  const seed = crypto.randomInt(2 ** 32);
  sendJson(res, 201, { token: issue('game', seed, Date.now()), seed });
}

async function finishGame(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.message });
  }
  const game = redeem('game', body?.game, GAME_TTL_MS);
  if (game.error) return sendJson(res, 400, { error: game.error });
  const run = rules.replay(game.a, body?.rounds, body?.lastT);
  const real = (Date.now() - game.at) / 1000;
  if (!run || real < run.seconds - CLOCK_EARLY_S || real > run.seconds + CLOCK_LATE_S(run.seconds)) {
    return sendJson(res, 400, { error: 'run did not verify' });
  }
  used.set(game.sig, game.at + GAME_TTL_MS);
  const result = run.score > 0 ? issue('result', run.score, Date.now()) : null;
  sendJson(res, 200, { score: run.score, result });
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
  const result = redeem('result', body?.result, RESULT_TTL_MS);
  if (result.error) return sendJson(res, 400, { error: result.error });

  catchUp();
  if (result.at < board.dayStart) return sendJson(res, 400, { error: 'the board reset after this run' });

  const entry = { name, score: result.a, at: new Date(result.at).toISOString() };
  const scores = [...board.scores, entry]
    .sort(byRank)
    .slice(0, MAX_STORED);
  const next = { ...board, scores };
  try {
    saveBoard(next);
  } catch (err) {
    console.error(`Failed to save scores: ${err.message}`);
    return sendJson(res, 500, { error: 'could not save score' });
  }
  board = next;
  used.set(result.sig, result.at + RESULT_TTL_MS);
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

const routes = {
  'GET /api/leaderboard': (req, res) => getLeaderboard(res),
  'POST /api/games': (req, res) => newGame(res),
  'POST /api/games/finish': finishGame,
  'POST /api/scores': postScore,
};

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const route = routes[`${req.method} ${pathname}`];
  if (route) return route(req, res);
  if (pathname.startsWith('/api/')) return sendJson(res, 405, { error: 'method not allowed' });
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
  sendJson(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, () => console.log(`timing listening on :${PORT}, data in ${DATA_FILE}`));

// PID 1 in a container ignores SIGTERM unless handled; without this `docker stop` waits 10s.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

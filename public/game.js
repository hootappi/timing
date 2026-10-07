(() => {
  'use strict';

  // --- config ------------------------------------------------------------
  const R = window.TimingRules;   // gameplay rules, shared with the server (rules.js)
  const RETRY_LOCKOUT = 0.5;  // seconds after game over before space/tap restarts
  const MAX_BAR_W = 960;      // keeps the bar sane on wide desktop windows

  const C = {
    bg: '#0d1117', bar: '#21262d', barEdge: '#3a414a', zone: '#ffd23f', good: '#3ddc84',
    bad: '#ff5a5f', text: '#e6edf3', muted: '#8b949e', marker: '#ffffff',
  };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const autofocusOk = window.matchMedia('(hover: hover) and (pointer: fine)').matches;  // a phone keyboard popping up unasked is worse than a tap
  const verb = touch ? 'tap' : 'click';

  // --- dom ---------------------------------------------------------------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const panel = document.getElementById('panel');
  const overPanel = document.getElementById('over');
  const overScore = document.getElementById('over-score');
  const scoreForm = document.getElementById('score-form');
  const nameInput = document.getElementById('name');
  const scoreMsg = document.getElementById('score-msg');
  const againBtn = document.getElementById('again');
  const boardEl = document.getElementById('board');
  const boardTitle = document.getElementById('board-title');
  const boardBtn = document.getElementById('board-btn');
  const fsBtn = document.getElementById('fs-btn');
  const safeProbe = document.getElementById('safe');

  // --- layout ------------------------------------------------------------
  // The canvas fills the viewport. Everything is placed from W/H on each resize;
  // game state is stored in bar fractions so it survives rotation.
  let W = 0, H = 0, dpr = 1, u = 1;   // u: size unit, scales text and effects
  let inset = { t: 0, r: 0, b: 0, l: 0 };
  const BAR = { x: 0, y: 0, w: 0, h: 0 };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function layout() {
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);

    const cs = getComputedStyle(safeProbe);
    inset = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };

    u = clamp(Math.min(W, H) / 450, 0.8, 1.4);
    const margin = clamp(W * 0.05, 16, 48);
    const left = Math.max(margin, inset.l + 8);
    const right = W - Math.max(margin, inset.r + 8);
    BAR.w = Math.min(right - left, MAX_BAR_W);
    BAR.x = left + (right - left - BAR.w) / 2;
    BAR.h = clamp(Math.min(W, H) * 0.16, 44, 84);
    BAR.y = H * 0.36 - BAR.h / 2;   // high enough to stay visible above the bottom sheet
  }

  // --- state -------------------------------------------------------------
  let state = 'idle';        // idle | ready | sweep | hit | over
  let stateT = 0;
  let hits = 0;
  let best = store('timing.best') | 0;
  let pos = 0, sweepT = 0, zoneX = 0.5, zoneW = R.START_ZONE, speed = R.START_SPEED;
  let next = Math.random;    // zone positions; seeded from the server's game for ranked runs
  let game = null;           // { token, seed } of the run in progress; null means unranked
  let nextGame = null;       // fetched ahead so a run can start without waiting on the network
  let rounds = [];           // sweepT of each hit, submitted for the server to replay
  let overReason = '';
  let shake = 0, flash = { color: '', t: 0, dur: 0.3 };
  let particles = [], rings = [], floaters = [];

  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch { /* storage unavailable: run without it */ }
    return null;
  }

  const rand = (a, b) => a + Math.random() * (b - a);

  // --- game flow ---------------------------------------------------------
  let boardOpen = false;

  function setState(s) { state = s; stateT = 0; syncPanel(); }

  // The sheet shows on game over, or on demand from the idle screen. Never during play.
  function syncPanel() {
    if (state !== 'idle') boardOpen = false;
    overPanel.hidden = state !== 'over';
    panel.hidden = state !== 'over' && !boardOpen;
    boardBtn.hidden = state !== 'idle';
  }

  function prepareRound() {
    ({ zoneW, zoneX, speed } = R.round(next, hits));
    pos = 0;
    sweepT = 0;
    setState('ready');
  }

  function startGame() {
    game = nextGame;
    nextGame = null;
    next = game ? R.rng(game.seed) : Math.random;
    rounds = [];
    hits = 0;
    particles = []; rings = []; floaters = [];
    prepareRound();
  }

  const markerX = () => BAR.x + pos * BAR.w;

  function judge() {
    if (R.isHit({ zoneX, zoneW, speed }, sweepT)) { rounds.push(sweepT); hit(); } else miss('missed');
  }

  function hit() {
    hits++;
    const x = markerX(), y = BAR.y + BAR.h / 2;
    burst(x, y, C.good, 26, 320 * u);
    rings.push({ x, y, t: 0 });
    floaters.push({ text: '+1', x, y: BAR.y - 20 * u, t: 0 });
    flash = { color: C.good, t: 0.18, dur: 0.18 };
    if (!reducedMotion) shake = 4 * u;
    tone(440 * Math.pow(1.0595, Math.min(hits, 24)), 0.14, 'triangle', 0.1);
    setState('hit');
  }

  function miss(reason) {
    overReason = reason;
    const x = markerX(), y = BAR.y + BAR.h / 2;
    burst(x, y, C.bad, 22, 260 * u);
    flash = { color: C.bad, t: 0.35, dur: 0.35 };
    if (!reducedMotion) shake = 16 * u;
    tone(150, 0.35, 'sawtooth', 0.09, 60);
    if (hits > best) { best = hits; store('timing.best', String(best)); }
    setState('over');
    showOver();
  }

  function act() {
    if (state === 'idle') startGame();
    else if (state === 'sweep') judge();
    else if (state === 'over' && stateT > RETRY_LOCKOUT) startGame();
    // 'ready' and 'hit' ignore input so an early tap is not punished
  }

  // --- effects -----------------------------------------------------------
  function burst(x, y, color, n, power) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), s = rand(0.3, 1) * power;
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, life: rand(0.4, 0.8), max: 0.8, color, size: rand(2, 5) * u });
    }
  }

  let audio;
  function tone(freq, dur, type, gain, endFreq) {
    try {
      audio = audio || new AudioContext();
      if (audio.state === 'suspended') audio.resume();
      const t = audio.currentTime, osc = audio.createOscillator(), g = audio.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(audio.destination);
      osc.start(t);
      osc.stop(t + dur);
    } catch { /* audio unavailable: play silent */ }
  }

  // --- update ------------------------------------------------------------
  function update(dt) {
    stateT += dt;
    if (state === 'ready' && stateT >= R.READY_TIME) setState('sweep');
    else if (state === 'sweep') {
      sweepT += dt;
      pos = speed * sweepT;   // same formula the server replays
      if (pos > 1) { pos = 1; miss('too late'); }
    } else if (state === 'hit' && stateT >= R.HIT_TIME) prepareRound();

    for (const p of particles) { p.life -= dt; p.vy += 700 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
    particles = particles.filter((p) => p.life > 0);
    for (const r of rings) r.t += dt;
    rings = rings.filter((r) => r.t < 0.45);
    for (const f of floaters) f.t += dt;
    floaters = floaters.filter((f) => f.t < 0.7);
    shake = Math.max(0, shake - 40 * dt);
    flash.t = Math.max(0, flash.t - dt);
  }

  // --- draw --------------------------------------------------------------
  function text(str, x, y, size, color, align = 'center', weight = 800) {
    ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    if (shake > 0.5) ctx.translate(rand(-shake, shake), rand(-shake, shake));
    drawHud();
    drawBar();
    drawMarker();
    drawEffects();
    drawMessages();
    ctx.restore();

    if (flash.t > 0) {
      ctx.globalAlpha = (flash.t / flash.dur) * 0.28;
      ctx.fillStyle = flash.color;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  function drawHud() {
    const y = inset.t + 34 * u;
    text(`SCORE ${hits}`, BAR.x, y, 38 * u, C.text, 'left');
    text(`BEST ${best}`, BAR.x, y + 32 * u, 18 * u, C.muted, 'left', 700);
  }

  function drawBar() {
    const missed = state === 'over';
    const r = 12 * u;
    ctx.fillStyle = C.bar;
    ctx.beginPath(); ctx.roundRect(BAR.x, BAR.y, BAR.w, BAR.h, r); ctx.fill();

    const zx = BAR.x + zoneX * BAR.w, zw = zoneW * BAR.w;
    const color = state === 'hit' ? C.good : C.zone;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = (state === 'hit' ? 40 : 18) * u;
    ctx.fillStyle = color;
    ctx.fillRect(zx, BAR.y, zw, BAR.h);
    ctx.restore();

    if (missed) {   // pulse an outline so the player sees where the zone was
      ctx.strokeStyle = C.zone;
      ctx.lineWidth = 3 * u;
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(stateT * 10);
      ctx.strokeRect(zx - 4 * u, BAR.y - 4 * u, zw + 8 * u, BAR.h + 8 * u);
      ctx.globalAlpha = 1;
    }

    ctx.strokeStyle = missed ? C.bad : state === 'hit' ? C.good : C.barEdge;
    ctx.lineWidth = (missed || state === 'hit' ? 4 : 2) * u;
    ctx.beginPath(); ctx.roundRect(BAR.x, BAR.y, BAR.w, BAR.h, r); ctx.stroke();
  }

  function drawMarker() {
    const x = markerX(), top = BAR.y - 18 * u, bottom = BAR.y + BAR.h + 18 * u;
    const color = state === 'over' ? C.bad : state === 'hit' ? C.good : C.marker;

    if (state === 'sweep') {   // motion trail, longer the faster it goes
      const len = Math.min(0.12, speed * 0.08) * BAR.w;
      const from = Math.max(BAR.x, x - len);
      const g = ctx.createLinearGradient(from, 0, x, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(1, 'rgba(255,255,255,0.35)');
      ctx.fillStyle = g;
      ctx.fillRect(from, BAR.y, x - from, BAR.h);
    }

    ctx.fillStyle = color;
    ctx.fillRect(x - 2.5 * u, top, 5 * u, bottom - top);
    ctx.beginPath();
    ctx.moveTo(x - 11 * u, top - 12 * u); ctx.lineTo(x + 11 * u, top - 12 * u); ctx.lineTo(x, top + 2 * u);
    ctx.closePath(); ctx.fill();
  }

  function drawEffects() {
    for (const r of rings) {
      const k = r.t / 0.45;
      ctx.strokeStyle = C.good;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 4 * u;
      ctx.beginPath(); ctx.arc(r.x, r.y, (10 + k * 80) * u, 0, Math.PI * 2); ctx.stroke();
    }
    for (const p of particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    for (const f of floaters) {
      ctx.globalAlpha = 1 - f.t / 0.7;
      text(f.text, f.x, f.y - f.t * 60 * u, 32 * u, C.good);
    }
    ctx.globalAlpha = 1;
  }

  function drawMessages() {
    const cx = W / 2;
    const below = BAR.y + BAR.h + 26 * u;   // clear of the marker's overhang
    const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 300);
    if (state === 'idle') {
      text('TIMING', cx, below + 60 * u, 60 * u, C.zone, 'center', 900);
      text('STOP THE MARKER IN THE ZONE', cx, below + 118 * u, 20 * u, C.text);
      ctx.globalAlpha = pulse;
      text(touch ? 'tap to start' : 'click or press SPACE to start', cx, below + 150 * u, 18 * u, C.muted, 'center', 600);
      ctx.globalAlpha = 1;
    } else if (state === 'over') {
      text(overReason.toUpperCase(), cx, BAR.y - 46 * u, 52 * u, C.bad);
    } else if (state === 'ready' || (state === 'sweep' && hits === 0)) {
      text(state === 'ready' ? 'GET READY' : 'NOW!', cx, below + 44 * u, 26 * u, C.muted, 'center', 700);
    }
  }

  // --- loop --------------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  // --- input -------------------------------------------------------------
  canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); act(); });
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLButtonElement) return;
    e.preventDefault();
    act();
  });
  againBtn.addEventListener('click', () => { againBtn.blur(); startGame(); });

  boardBtn.addEventListener('click', () => {
    boardBtn.blur();   // so space still means "play", not "press the focused button"
    boardOpen = !boardOpen;
    if (boardOpen) loadBoard();
    syncPanel();
  });

  if (document.fullscreenEnabled) {   // absent on iPhone Safari; there, Add to Home Screen gives full screen
    fsBtn.hidden = false;
    fsBtn.addEventListener('click', () => {
      fsBtn.blur();
      const req = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      req.catch(() => { /* refused: stay windowed */ });
    });
    document.addEventListener('fullscreenchange', () => {
      fsBtn.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
    });
  }

  window.addEventListener('resize', layout);

  // --- leaderboard -------------------------------------------------------
  async function fetchGame() {
    try {
      const res = await fetch('/api/games', { method: 'POST' });
      if (res.ok) nextGame = await res.json();
    } catch { /* offline: the next run is unranked */ }
  }

  async function loadBoard(highlightRank) {
    boardEl.replaceChildren();
    let list;
    try {
      const res = await fetch('/api/leaderboard');
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      list = data.scores;
      const at = new Date(data.resetsAt);
      boardTitle.textContent = `Today's top 10 · resets ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch {
      list = null;
    }
    if (!list || list.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = list ? 'No scores yet. Be the first.' : 'Leaderboard offline.';
      boardEl.append(li);
      return;
    }
    list.forEach((s, i) => {
      const li = document.createElement('li');
      if (i + 1 === highlightRank) li.className = 'mine';
      for (const [cls, val] of [['rank', i + 1], ['name', s.name], ['pts', s.score]]) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = val;
        li.append(span);
      }
      boardEl.append(li);
    });
  }

  function showOver() {
    scoreMsg.textContent = '';
    loadBoard();
    fetchGame();
    if (hits > 0 && !game) {
      overScore.textContent = `Score: ${hits}`;
      scoreForm.hidden = true;
      scoreMsg.textContent = 'Leaderboard was offline when this run started, so it cannot be saved.';
    } else if (hits > 0) {
      overScore.textContent = `Score: ${hits} ${hits === 1 ? 'round' : 'rounds'} survived`;
      scoreForm.hidden = false;
      nameInput.value = (store('timing.name') || '').slice(0, 8);
      if (autofocusOk) nameInput.focus();
    } else {
      overScore.textContent = 'Score: 0';
      scoreForm.hidden = true;
      scoreMsg.textContent = 'Survive at least one round to make the board.';
    }
  }

  nameInput.addEventListener('input', () => {
    nameInput.value = nameInput.value.replace(/[^a-z0-9]/gi, '').toUpperCase();
  });

  scoreForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value;
    if (!/^[A-Z0-9]{1,8}$/.test(name)) { scoreMsg.textContent = 'Use 1 to 8 letters or digits.'; return; }
    const submit = scoreForm.querySelector('button');
    submit.disabled = true;
    try {
      const res = await fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game: game.token, name, rounds }),
      });
      if (!res.ok) throw new Error((await res.json()).error || String(res.status));
      const { rank } = await res.json();
      store('timing.name', name);
      scoreForm.hidden = true;
      nameInput.blur();
      scoreMsg.textContent = rank && rank <= 10 ? `Saved. You are #${rank}.` : 'Saved.';
      loadBoard(rank);
    } catch (err) {
      scoreMsg.textContent = `Could not save: ${err.message}`;
    } finally {
      submit.disabled = false;
    }
  });

  // --- boot --------------------------------------------------------------
  layout();
  prepareRound();
  setState('idle');   // show a demo zone behind the title
  loadBoard();
  fetchGame();
  requestAnimationFrame(frame);
})();

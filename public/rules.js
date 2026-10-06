// Game rules shared by the browser (window.TimingRules) and the server (require).
// The server replays a submitted run with these same functions, so they are the single source of truth.
(() => {
  'use strict';

  const R = {
    START_ZONE: 0.28,    // zone width, fraction of bar
    ZONE_SHRINK: 0.88,   // per hit
    MIN_ZONE: 0.035,
    START_SPEED: 0.55,   // bar-lengths per second
    SPEED_UP: 1.12,      // per hit
    READY_TIME: 0.6,     // marker parked at the left before each sweep
    HIT_TIME: 0.6,       // celebration before the next round
    MAX_ROUNDS: 200,     // far beyond human reach: speed is ~3e9 bar/s by then
  };

  const EPS = 1e-9;      // absorbs last-bit differences in Math.pow between browser engines

  // mulberry32: integer-only, so every engine produces the same sequence from a seed.
  R.rng = (seed) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // Round n (0-based). Consumes one number from `next`, so rounds must be generated in order.
  R.round = (next, n) => {
    const zoneW = Math.max(R.MIN_ZONE, R.START_ZONE * Math.pow(R.ZONE_SHRINK, n));
    const minX = 0.15, maxX = 0.97 - zoneW;   // leave reaction room after the start
    return { zoneW, zoneX: minX + next() * (maxX - minX), speed: R.START_SPEED * Math.pow(R.SPEED_UP, n) };
  };

  // t: seconds the marker had been sweeping when the player pressed.
  R.isHit = (round, t) => {
    const pos = round.speed * t;
    return pos >= round.zoneX - EPS && pos <= round.zoneX + round.zoneW + EPS;
  };

  // Replays a run from its seed and press times. Returns null if any press missed,
  // otherwise the score and the least wall-clock time the run can have taken.
  R.replay = (seed, times) => {
    if (!Array.isArray(times) || times.length > R.MAX_ROUNDS) return null;
    const next = R.rng(seed);
    let minSeconds = 0;
    for (let n = 0; n < times.length; n++) {
      const t = times[n];
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || !R.isHit(R.round(next, n), t)) return null;
      minSeconds += R.READY_TIME + t + R.HIT_TIME;
    }
    return { score: times.length, minSeconds };
  };

  if (typeof module === 'object' && module.exports) module.exports = R;
  else window.TimingRules = R;
})();

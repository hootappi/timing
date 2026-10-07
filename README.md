# Timing

One-button browser game. A marker sweeps left to right across a bar. Click (or press space) while it is inside the target zone. Each hit shrinks the zone and speeds the marker up. One miss ends the run; your score is the number of rounds survived. Top ten scores are kept in a global leaderboard.

Plain HTML, CSS and vanilla JS on a canvas. A small dependency-free Node server. No build step, no database.

## Rules

- The marker must be inside the zone when you click or tap. Clicking outside it, or letting the marker reach the right edge, ends the game.
- Each hit: zone width x0.88 (floor at 3.5% of the bar), marker speed x1.12.
- The leaderboard clears every day at 22:22 Copenhagen time. That day's top score is kept as the day's winner (on a tie, whoever reached it first).
- Every day at 07:00 the house score, HOOTAPPI with 15, is added to the board as a mark to beat. If nobody beats it, HOOTAPPI is that day's winner.
- Only scores of 1 or more can be submitted. Names are 1 to 8 letters or digits.

## Screen and devices

The game fills the whole viewport on phones, tablets and desktop. Safe-area insets (notches, home indicator) are respected, page scroll and pull-to-refresh are disabled, and the name field does not auto-focus on touch devices so the keyboard stays down until you tap it.

- **Android / desktop:** a Fullscreen button appears (browser Fullscreen API).
- **iPhone:** Safari has no Fullscreen API for pages. Use Share > Add to Home Screen; it then launches without browser chrome.

## Run locally

Node 20 or newer:

```bash
npm start
```

Open <http://localhost:3000>. The board is stored in `./data/leaderboard.json`.

Or with Docker:

```bash
docker build -t timing .
docker run --rm -p 3000:3000 -v "$PWD/data:/app/data" timing
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `DATA_DIR` | `./data` (`/app/data` in the image) | Directory holding `leaderboard.json` |
| `RESET_AT` | `22:22` | Daily leaderboard reset, `HH:MM` |
| `RESET_TZ` | `Europe/Copenhagen` | IANA time zone for `RESET_AT` and `HOUSE_AT` |
| `HOUSE_AT` | `07:00` | When the daily house score is added, `HH:MM` |
| `HOUSE_NAME` | `HOOTAPPI` | House score name, 1 to 8 capital letters or digits |
| `HOUSE_SCORE` | `15` | House score; `0` turns it off |

The reset needs no timer or cron: each request checks whether a reset time has passed since the board's day began, and if so records the winner and clears the board. The house score works the same way: it appears at the first request after 07:00, stamped 07:00, so it ranks exactly as if it had been added on the minute. A restart or downtime across 22:22 still resets it.

## Endpoints

### `GET /api/leaderboard`

Today's top ten (best first), when the board next clears, and the last 30 daily winners (newest first).

```json
{
  "scores": [{ "name": "ABC", "score": 17 }],
  "resetsAt": "2026-10-07T20:22:00.000Z",
  "winners": [{ "day": "2026-10-06", "name": "XYZ", "score": 21 }]
}
```

### `POST /api/games`

Starts a ranked run. Returns `201 { "token": "...", "seed": 123456789 }`. The client calls this the moment the player starts, because the server times the run from here. If it fails (server unreachable), the run is played unranked.

### `POST /api/games/finish`

Sent the moment a run ends. Body:

```json
{ "game": "<token>", "rounds": [0.912, 0.774, 0.803], "lastT": 0.41 }
```

- `rounds`: for each hit, seconds the marker had been sweeping when the player pressed.
- `lastT`: how long the final, missed round had been sweeping when it ended.

Returns `200 { "score": 3, "result": "<token>" }` (`result` is `null` for a score of 0), or `400`.

### `POST /api/scores`

Puts a verified result on the board. Body: `{ "result": "<token>", "name": "ABC" }`. `name` is 1 to 8 letters or digits (lowercase is uppercased). Returns `201 { "ok": true, "rank": 4 }` (`rank` is `null` outside the stored top 100), or `400`/`413`.

### How runs are verified

The client never sends a score. The server regenerates every zone from the seed (`public/rules.js`, shared with the browser) and checks that each press landed inside its zone. It also compares the game time the run claims with the real time between `POST /api/games` and `POST /api/games/finish`: less means invented presses, much more (over 2 s + 10%) means the game clock was slowed down in the browser. Game and result tokens are signed, work once, and expire (game 2 h, result 1 h). A server restart voids runs in progress.

Side effect: switching tabs mid-run pauses the game but not the server's clock, so that run cannot be saved.

Limits: this stops edited game logic, a slowed-down game clock and hand-crafted requests. It does not stop a script that watches the marker and presses when it is in the zone, playing in real time. Nothing in a browser game can; the input is whatever the browser sends. There is no auth and no rate limiting.

## Deploy (lab VPS, level 2)

Follows the `vps-setup-lab` runbook. Compose is bound to the tailnet IP `100.74.23.114` on host port **3001** (Homepage already holds 3000 on that IP), with data bind-mounted from `/home/hootappi/data/timing`.

```bash
cd ~/stacks
git clone https://github.com/hootappi/timing.git
cd timing
mkdir -p ~/data/timing
docker compose up -d --build
docker compose logs -f
```

Open `http://100.74.23.114:3001`.

The container runs as the image's `node` user (uid 1000). `~/data/timing` must be writable by that uid; if `id -u` for `hootappi` on the box is not 1000, the server exits at startup with a clear message. Fix with `sudo chown 1000:1000 ~/data/timing`, or set `user:` in `compose.yaml`.

Update: `cd ~/stacks/timing && git pull && docker compose up -d --build`.

Going public (level 3): add `timing.lab.hootappi.com { reverse_proxy timing:3000 }` to the Caddyfile, restart Caddy, then drop the `ports:` line.

## Layout

```
server.js        HTTP server, leaderboard API, static files
public/          index.html, style.css, game.js, rules.js (gameplay rules, also used by the server)
Dockerfile       multi-stage, alpine, runs as non-root
compose.yaml     lab stack: edge network, tailnet port, bind mount
```

# Timing

One-button browser game. A marker sweeps left to right across a bar. Click (or press space) while it is inside the target zone. Each hit shrinks the zone and speeds the marker up. One miss ends the run; your score is the number of rounds survived. Top ten scores are kept in a global leaderboard.

Plain HTML, CSS and vanilla JS on a canvas. A small dependency-free Node server. No build step, no database.

## Rules

- The marker must be inside the zone when you click or tap. Clicking outside it, or letting the marker reach the right edge, ends the game.
- Each hit: zone width x0.88 (floor at 3.5% of the bar), marker speed x1.12.
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

Open <http://localhost:3000>. Scores are stored in `./data/scores.json`.

Or with Docker:

```bash
docker build -t timing .
docker run --rm -p 3000:3000 -v "$PWD/data:/app/data" timing
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `DATA_DIR` | `./data` (`/app/data` in the image) | Directory holding `scores.json` |

## Endpoints

### `GET /api/leaderboard`

Returns the top ten scores, best first.

```json
{ "scores": [{ "name": "ABC", "score": 17 }] }
```

### `POST /api/games`

Starts a ranked run. Returns `201 { "token": "...", "seed": 123456789 }`. The client fetches one ahead of time so a run never waits on the network; if it has none (server unreachable), the run is played unranked and cannot be submitted.

### `POST /api/scores`

Submit a finished run. Body:

```json
{ "game": "<token>", "name": "ABC", "rounds": [0.912, 0.774, 0.803] }
```

- `game`: token from `POST /api/games`. Each token can be submitted once and expires after 6 hours.
- `name`: 1 to 8 characters, letters or digits (lowercase is uppercased).
- `rounds`: for each hit, seconds the marker had been sweeping when the player pressed.

The client never sends a score. The server regenerates every zone from the seed (`public/rules.js`, shared with the browser), checks that each press landed inside its zone, and checks that at least as much real time has passed since the token was issued as the run needs. The score is the number of verified rounds.

Returns `201 { "ok": true, "rank": 4 }` (`rank` is `null` if outside the stored top 100), or `400`/`413` with `{ "error": "..." }`.

Limits: this stops edited game logic and hand-crafted requests, but not a script that reads the zone and presses at the right moment. Any score computed in the player's browser can be botted; the replay only makes cheating cost a bot instead of a one-line edit. There is no auth and no rate limiting.

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

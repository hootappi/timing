# CLAUDE.md — timing

Inherits from ~/.claude/CLAUDE.md.

One-button timing game. Vanilla HTML/CSS/JS canvas frontend in `public/`, dependency-free Node server in `server.js`, scores in a JSON file at `$DATA_DIR/scores.json`.

## Constraints

- No frameworks, no build step, no database, no npm dependencies unless justified.
- Deployed per the `vps-setup-lab` runbook: compose joins external `edge` network, binds tailnet IP only (never 0.0.0.0), bind-mounts `/home/hootappi/data/timing`. Never use named volumes.
- Host port 3001 (3000 is taken by Homepage on the tailnet IP). Container port stays 3000.
- Container runs non-root (`node`, uid 1000); only `/app/data` is writable.
- Source is edited on the Mac only. The box does `git pull && docker compose up -d --build`.

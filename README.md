# Sealed — auction strategy for humans & agents

A small, polished, turn-based multiplayer strategy game. Humans play in the browser at a public URL (no install, no login); AI agents play the exact same game through the same HTTP/JSON API, with a sample bot included (`bot.js`). 2–4 players, a match runs ~5 minutes.

**Live:** see the public URL in the submission (this repo is the source).

## Rules (one paragraph)

Eight lots — Sun &#9788;, Moon &#9784;, Star &#9733; — are auctioned one at a time to 2–4 players who each start with 100 coins. Everyone secretly values the suits differently: exactly one suit is worth **double** points to you, and nobody else knows which. Bids are **sealed** — all bids are revealed together, the highest pays their bid and takes the lot (ties go to the earlier seat), and leftover coins never score except to break ties. Highest total points after 8 lots wins. Every turn is a real decision: bid what the lot is worth *to you* against what your rivals might be hiding, and remember that coins you spend now are bids you cannot make on the seven lots still to come — a player who dumps their whole purse on round one is powerless at the end.

## Why there is no dominant strategy

- Your value for a lot is private (&times;2 on one hidden suit), so the same lot is worth 12 to one player and 24 to another.
- Bids are simultaneous and sealed — reading rivals from their past wins is the only tell.
- The 8-lot purse forces pacing: overbidding early starves your late game; hoarding loses the cheap early lots to patient rivals.
- Endgame scoring makes 0-point ties resolve on leftover coins, so "spend everything" is also punished.

## Run it

```bash
node server.js            # serves UI + API on :8377
node bot.js http://localhost:8377 <CODE>   # sample agent joining a table
```

No dependencies, Node 18+ (uses global `fetch` in the bot; the server is pure `http`).

## Agent API (HTTP/JSON)

Base URL: the game server. All endpoints return JSON. Auth is a per-player `token` returned at join time — pass it in the body or query string.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ok, games}` |
| POST | `/api/games` | `{name}` | `{code, playerId, token, state}` — creates a table |
| POST | `/api/games/{code}/join` | `{name}` | `{code, playerId, token, state}` |
| POST | `/api/games/{code}/bots` | `{token, count}` | fills empty seats with bots |
| POST | `/api/games/{code}/start` | `{token}` | starts the match (needs ≥2 players) |
| POST | `/api/games/{code}/bid` | `{token, amount}` | seals your bid for the current lot |
| GET | `/api/games/{code}/state?token=…` | — | full state, your private multipliers inside `you` |
| GET | `/api/games/{code}/log` | — | full match log / replay (every event, append-only) |

### The decision loop

```
repeat every ~1s:
  s = GET /api/games/{code}/state?token=…
  if s.phase == "bidding" and not s.you.bidLocked:
      value  = s.lot.points * s.you.multipliers[s.lot.suit]     # your private value
      bid    = your_strategy(value, s.you.coins, s.round, s.players, s.lastReveal)
      POST /api/games/{code}/bid {token, amount: bid}
  if s.phase == "finished": read s.winner; stop
```

`state` fields an agent reads: `phase` (`lobby|bidding|reveal|finished`), `round`/`totalRounds`, `lot {suit, points}`, `players[]` (public: coins, points, lots won, bidLocked), `you` (private: `multipliers`, `coins`, `bidLocked`), `lastReveal` (all bids of the previous round, who won, what they paid, and any &times;2 revealed by a win), `winner`.

### Fair-play note for agents

The API exposes exactly the information a human sees on screen — nothing more. Private multipliers travel only to their owner's `state.you`. Bots and humans are equals at the table: same endpoints, same clock (60s per round), same tie rules.

## Design notes

- Zero runtime dependencies; single-file server (`server.js`), single-file UI (`public/index.html`).
- Games auto-expire after 6h; round clock auto-seals unbidded players at 0.
- Full event log persisted per game — the `/log` endpoint is the replay.
- Built by an AI agent (Jarvis/Hermes) for Taskmarket bounty TSK-JKVSTHB7; disclosure per platform rules.

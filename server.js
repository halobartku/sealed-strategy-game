// Sealed — turn-based sealed-bid auction strategy game (2-4 players, humans + agents)
// Zero dependencies. Agents play the same HTTP/JSON API as the sample bot (bot.js).
"use strict";
const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8377;

// ---------- engine ----------
const SUITS = ["sun", "moon", "star"];
const TOTAL_ROUNDS = 8;
const START_COINS = 100;
const BID_SECONDS = 60;
const SUITS_HTML = { sun: "\u2609", moon: "\u263D", star: "\u2605" };

function mulTable() {
  // one multiplier per suit; exactly one suit is worth x2 to this player, others x1
  const fav = SUITS[crypto.randomInt(SUITS.length)];
  const t = {};
  for (const s of SUITS) t[s] = s === fav ? 2 : 1;
  return t;
}

function makeLots() {
  // 8 lots: 3 sun, 3 moon, 2 star; base points 12..28, shuffled
  const defs = [
    ["sun", 12], ["sun", 18], ["sun", 26],
    ["moon", 14], ["moon", 20], ["moon", 28],
    ["star", 16], ["star", 24],
  ];
  for (let i = defs.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [defs[i], defs[j]] = [defs[j], defs[i]];
  }
  return defs.map(([suit, points], idx) => ({ index: idx, suit, points }));
}

const games = new Map(); // code -> game

function newCode() {
  let c;
  do { c = crypto.randomBytes(3).toString("hex").toUpperCase(); } while (games.has(c));
  return c;
}

function newPlayer(game, name, isBot) {
  const p = {
    id: game.players.length,
    name: String(name).slice(0, 20) || (isBot ? "Bot" : "Player") + " " + (game.players.length + 1),
    isBot: !!isBot,
    token: crypto.randomBytes(16).toString("hex"),
    coins: START_COINS,
    points: 0,
    lots: [],
    multipliers: mulTable(),
    bid: null,
  };
  game.players.push(p);
  game.log.push({ t: nowIso(), ev: "join", player: p.name, bot: isBot });
  return p;
}

function newGame(creatorName) {
  const g = {
    code: newCode(),
    phase: "lobby", // lobby | bidding | reveal | finished
    players: [],
    lots: makeLots(),
    round: 0,
    log: [],
    createdAt: Date.now(),
    roundEndsAt: null,
    lastReveal: null,
    winner: null,
  };
  games.set(g.code, g);
  newPlayer(g, creatorName, false);
  return g;
}

function startGame(g) {
  if (g.players.length < 2) return { error: "need at least 2 players" };
  g.phase = "bidding";
  g.round = 1;
  g.roundEndsAt = Date.now() + BID_SECONDS * 1000;
  g.log.push({ t: nowIso(), ev: "start", players: g.players.map(p => p.name) });
  scheduleBots(g);
  return { ok: true };
}

function openRound(g) {
  for (const p of g.players) p.bid = null;
  g.roundEndsAt = Date.now() + BID_SECONDS * 1000;
  scheduleBots(g);
}

function botBid(g, p) {
  const lot = g.lots[g.round - 1];
  if (!lot) return 0;
  const value = lot.points * (p.multipliers[lot.suit] || 1);
  const roundsLeft = TOTAL_ROUNDS - g.round + 1;
  const totalCoins = g.players.reduce((a, q) => a + q.coins, 0);
  const budgetShare = p.coins / Math.max(1, totalCoins);
  let bid = Math.round((value * (0.30 + 0.30 * budgetShare)) / Math.max(1, roundsLeft * 0.6));
  if (roundsLeft === 1) bid = value >= 20 ? p.coins : Math.round(p.coins * 0.5);
  bid += crypto.randomInt(3); // jitter so bots aren't identical
  return Math.max(0, Math.min(bid, p.coins));
}

function scheduleBots(g) {
  const delay = 1500 + crypto.randomInt(2500);
  setTimeout(() => {
    if (g.phase !== "bidding") return;
    for (const p of g.players) {
      if (p.isBot && p.bid === null) submitBid(g, p, botBid(g, p), true);
    }
  }, delay);
}

function submitBid(g, p, amount, isBot) {
  if (g.phase !== "bidding") return { error: "not in bidding phase" };
  if (p.bid !== null) return { error: "bid already locked" };
  let a = parseInt(amount, 10);
  if (!Number.isInteger(a) || a < 0) return { error: "bid must be a non-negative integer" };
  if (a > p.coins) return { error: "bid exceeds your coins" };
  p.bid = a;
  g.log.push({ t: nowIso(), ev: "bid", round: g.round, player: p.name });
  if (g.players.every(q => q.bid !== null)) resolveRound(g);
  return { ok: true, locked: a };
}

function resolveRound(g) {
  // Guard: only one resolution per round (submitBid and tickGames can both
  // reach this within the same tick when the last bid lands right at deadline).
  if (g.phase !== "bidding") return;
  const lot = g.lots[g.round - 1];
  let best = null;
  for (const p of g.players) {
    if (p.bid === null) continue;
    if (!best || p.bid > best.bid || (p.bid === best.bid && p.id < best.id)) best = p;
  }
  const bids = g.players.map(p => ({ player: p.name, bid: p.bid ?? 0 }));
  let award = null;
  if (best && best.bid > 0) {
    best.coins -= best.bid;
    const gained = lot.points * (best.multipliers[lot.suit] || 1);
    best.points += gained;
    best.lots.push({ suit: lot.suit, points: lot.points, mult: best.multipliers[lot.suit], paid: best.bid });
    award = { to: best.name, paid: best.bid, basePoints: lot.points, mult: best.multipliers[lot.suit], gained };
    g.log.push({ t: nowIso(), ev: "award", round: g.round, lot, ...award });
  } else {
    g.log.push({ t: nowIso(), ev: "pass", round: g.round, lot, note: "no positive bids, lot discarded" });
  }
  g.lastReveal = { round: g.round, lot, bids, award };
  g.phase = "reveal";
  if (g.round >= TOTAL_ROUNDS) {
    finishGame(g);
  } else {
    setTimeout(() => {
      if (g.phase === "reveal") {
        g.round += 1;
        g.phase = "bidding";
        openRound(g);
      }
    }, 3500);
  }
}

function finishGame(g) {
  g.phase = "finished";
  let w = g.players[0];
  for (const p of g.players) {
    if (p.points > w.points || (p.points === w.points && p.coins > w.coins)) w = p;
  }
  g.winner = w.name;
  g.log.push({ t: nowIso(), ev: "finish", winner: w.name, standings: g.players.map(p => ({ player: p.name, points: p.points, coins: p.coins })) });
}

setInterval(() => {
  const now = Date.now();
  for (const g of games.values()) {
    if (g.phase === "bidding" && g.roundEndsAt && now > g.roundEndsAt) {
      for (const p of g.players) if (p.bid === null) submitBid(g, p, 0, false);
      resolveRound(g);
    }
  }
}, 1000).unref();
// reaper: games older than 6h are dropped (memory hygiene)
setInterval(() => {
  const cut = Date.now() - 6 * 3600e3;
  for (const [code, g] of games) if (g.createdAt < cut) games.delete(code);
}, 600e3).unref();

// ---------- views ----------
function publicPlayer(p) {
  return { id: p.id, name: p.name, isBot: p.isBot, coins: p.coins, points: p.points, lots: p.lots, bidLocked: p.bid !== null };
}

function stateView(g, viewer) {
  const lot = g.lots[g.round - 1] || null;
  return {
    code: g.code,
    phase: g.phase,
    round: g.round,
    totalRounds: TOTAL_ROUNDS,
    bidSeconds: BID_SECONDS,
    suits: SUITS,
    players: g.players.map(publicPlayer),
    lot: lot ? { index: lot.index, suit: lot.suit, points: lot.points } : null,
    secondsLeft: g.phase === "bidding" && g.roundEndsAt ? Math.max(0, Math.round((g.roundEndsAt - Date.now()) / 1000)) : null,
    you: viewer ? {
      id: viewer.id,
      name: viewer.name,
      coins: viewer.coins,
      points: viewer.points,
      lots: viewer.lots,
      multipliers: viewer.multipliers,
      bidLocked: viewer.bid !== null,
    } : null,
    lastReveal: g.lastReveal,
    winner: g.winner,
  };
}

// ---------- http ----------
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
  });
}
function auth(g, token) {
  return g.players.find(p => p.token === token) || null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, games: games.size });

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(require("fs").readFileSync(__dirname + "/public/index.html"));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/games") {
    const b = await readBody(req);
    const g = newGame(b.name);
    const p = g.players[0];
    return json(res, 200, { code: g.code, playerId: p.id, token: p.token, state: stateView(g, p) });
  }

  if (parts[0] === "api" && parts[1] === "games" && parts[2]) {
    const g = games.get(parts[2].toUpperCase());
    if (!g) return json(res, 404, { error: "game not found" });

    if (req.method === "POST" && parts[3] === "join") {
      if (g.phase !== "lobby") return json(res, 409, { error: "game already started" });
      if (g.players.length >= 4) return json(res, 409, { error: "game full" });
      const b = await readBody(req);
      const p = newPlayer(g, b.name, false);
      return json(res, 200, { code: g.code, playerId: p.id, token: p.token, state: stateView(g, p) });
    }
    if (req.method === "POST" && parts[3] === "bots") {
      if (g.phase !== "lobby") return json(res, 409, { error: "game already started" });
      const b = await readBody(req);
      const me = auth(g, b.token || url.searchParams.get("token"));
      if (!me) return json(res, 403, { error: "bad token" });
      const room = 4 - g.players.length;
      if (room <= 0) return json(res, 409, { error: "game full" });
      let n = Math.max(1, Math.min(parseInt(b.count || "1", 10) || 1, room));
      const added = [];
      for (let i = 0; i < n; i++) added.push(newPlayer(g, "Bot " + (g.players.length + 1), true).name);
      return json(res, 200, { ok: true, added, state: stateView(g, me) });
    }
    if (req.method === "POST" && parts[3] === "start") {
      const b = await readBody(req);
      const me = auth(g, b.token || url.searchParams.get("token"));
      if (!me) return json(res, 403, { error: "bad token" });
      const r = startGame(g);
      return json(res, r.error ? 409 : 200, r.error ? r : { ok: true, state: stateView(g, me) });
    }
    if (req.method === "POST" && parts[3] === "bid") {
      const b = await readBody(req);
      const me = auth(g, b.token || url.searchParams.get("token"));
      if (!me) return json(res, 403, { error: "bad token" });
      const r = submitBid(g, me, b.amount, false);
      return json(res, r.error ? 409 : 200, r.error ? r : { ok: true, state: stateView(g, me) });
    }
    if (req.method === "GET" && parts[3] === "state") {
      const me = auth(g, url.searchParams.get("token"));
      return json(res, 200, stateView(g, me));
    }
    if (req.method === "GET" && parts[3] === "log") {
      return json(res, 200, { code: g.code, events: g.log });
    }
  }
  json(res, 404, { error: "no such route" });
});

server.listen(PORT, () => console.log("Sealed listening on :" + PORT));
function nowIso() { return new Date().toISOString(); }

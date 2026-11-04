#!/usr/bin/env node
// Sample bot for Sealed — plays the same public HTTP/JSON API an agent would.
// Usage: node bot.js <baseUrl> <code> [name]
"use strict";
const [, , base, codeArg, nameArg] = process.argv;
if (!base || !codeArg) {
  console.error("usage: node bot.js <baseUrl> <matchCode> [name]");
  process.exit(1);
}
const base_ = base.replace(/\/$/, "");
const code = codeArg.toUpperCase();
const name = nameArg || "AgentBot";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const r = await fetch(base_ + path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(path + " -> " + r.status + " " + JSON.stringify(j));
  return j;
}

function decide(state) {
  // Tiny heuristic: bid a share of what the lot is worth to us, scaled by budget.
  const lot = state.lot;
  if (!lot) return 0;
  const myMult = state.you.multipliers[lot.suit] || 1;
  const value = lot.points * myMult;
  const roundsLeft = state.totalRounds - state.round + 1;
  const share = 0.30 + 0.25 * (state.you.coins / 100);
  let bid = Math.round((value * share) / Math.sqrt(roundsLeft));
  if (roundsLeft === 1) bid = Math.min(state.you.coins, Math.round(value * 0.8));
  return Math.max(0, Math.min(bid, state.you.coins));
}

(async () => {
  console.log("joining", code, "as", name);
  const j = await api(`/api/games/${code}/join`, { name });
  const token = j.token;
  console.log("joined as", j.state.you.name, "— waiting for game start");
  let lastRound = -1;
  for (;;) {
    await sleep(1000);
    const s = await api(`/api/games/${code}/state?token=${token}`);
    const st = s.state || s;
    if (st.phase === "finished") {
      console.log("game over — winner:", st.winner);
      console.log(st.players.map((p) => `${p.name}: ${p.points} pts, ${p.coins} coins`).join(" | "));
      break;
    }
    if (st.phase === "bidding" && st.round !== lastRound) {
      lastRound = st.round;
      if (st.you && !st.you.bidLocked) {
        const bid = decide(st);
        await api(`/api/games/${code}/bid`, { token, amount: bid });
        console.log(`round ${st.round}/${st.totalRounds}: lot ${st.lot.suit}(${st.lot.points}) -> sealed ${bid}`);
      }
    }
  }
})().catch((e) => { console.error("bot failed:", e.message); process.exit(1); });

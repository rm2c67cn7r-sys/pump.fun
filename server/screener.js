import WebSocket from "ws";
import { upsertLaunch, recordLaunchTrade, scoreLaunch, markAlerted, insertTrade, recalcCandidate, recalcWallet, getWallet, addWallet } from "./db.js";
import { notifyLaunch } from "./notify.js";
import { refreshSubscriptions } from "./pump.js";

const DISCOVER_MIN_SCORE = Number(process.env.DISCOVER_MIN_SCORE ?? 70);
const DISCOVER_MIN_TRADES = Number(process.env.DISCOVER_MIN_TRADES ?? 3);

let socket = null, retry = null;
const watching = new Set();
const MAX_WATCH = Number(process.env.SCREENER_MAX_WATCH ?? 150);
const WATCH_WINDOW_SEC = Number(process.env.SCREENER_WATCH_WINDOW_SEC ?? 600);

function send(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function connect() {
  const base = process.env.PUMPDEV_WS_URL || "wss://pumpdev.io/ws";
  const url = process.env.PUMPDEV_API_KEY ? `${base}?key=${encodeURIComponent(process.env.PUMPDEV_API_KEY)}` : base;
  socket = new WebSocket(url);

  socket.on("open", () => {
    send({ method: "subscribeNewToken" });
    console.log("Screener: watching new pump.fun launches");
  });

  socket.on("message", raw => {
    let e;
    try { e = JSON.parse(raw.toString()); } catch { return; }

    if (e.txType === "create" && e.mint) {
      upsertLaunch({
        mint: e.mint,
        source: "pumpfun",
        name: e.name || "",
        symbol: e.symbol || "",
        creator: e.traderPublicKey || "",
        created_at: Math.floor(Date.now() / 1000),
      });
      if (watching.size < MAX_WATCH) {
        watching.add(e.mint);
        send({ method: "subscribeTokenTrade", keys: [e.mint] });
        setTimeout(() => {
          watching.delete(e.mint);
          send({ method: "unsubscribeTokenTrade", keys: [e.mint] });
        }, WATCH_WINDOW_SEC * 1000);
      }
      return;
    }

    if (e.mint && watching.has(e.mint) && ["buy", "sell"].includes(e.txType)) {
      const solAmount = Number(e.solAmount ?? e.quoteAmount ?? 0);
      const marketCapSol = Number(e.marketCapSol ?? e.marketCapQuote ?? 0);

      recordLaunchTrade(e.mint, e.traderPublicKey, e.txType, solAmount, marketCapSol);
      const scored = scoreLaunch(e.mint);
      if (scored && !scored.alerted && scored.score >= Number(process.env.MIN_LAUNCH_SCORE ?? 65)) {
        markAlerted(e.mint);
        notifyLaunch(scored);
      }

      if (e.traderPublicKey) {
        const inserted = insertTrade({
          signature: e.signature || `${e.traderPublicKey}:${e.mint}:${e.txType}:${Date.now()}`,
          wallet: e.traderPublicKey, mint: e.mint, side: e.txType,
          sol_amount: solAmount, market_cap_sol: marketCapSol,
          ts: Math.floor(Date.now() / 1000),
        });
        if (inserted) {
          const c = recalcCandidate(e.traderPublicKey);
          if (c.trades >= DISCOVER_MIN_TRADES && c.score >= DISCOVER_MIN_SCORE && !getWallet(e.traderPublicKey)) {
            addWallet(e.traderPublicKey, "auto-discovered");
            recalcWallet(e.traderPublicKey);
            refreshSubscriptions();
            console.log(`Discovered profitable wallet ${e.traderPublicKey} (score ${c.score})`);
          }
        }
      }
    }
  });

  socket.on("close", () => { clearTimeout(retry); retry = setTimeout(connect, 3000); });
  socket.on("error", err => console.error("Screener WS:", err.message));
}

export function startScreener() {
  if (process.env.SCREENER_ENABLED === "false") return;
  connect();
}

import { listWallets, insertTrade, recalcWallet } from "./db.js";
import { notifyBuy } from "./notify.js";
import { onFeedMessage, onFeedOpen, sendFeed } from "./feed.js";

onFeedOpen(() => {
  const keys = listWallets().map(w => w.address);
  if (keys.length) sendFeed({ method: "subscribeAccountTrade", keys });
  console.log("Wallet alerts: watching", keys.length, "wallets");
});

onFeedMessage(e => {
  if (!e.traderPublicKey || !["buy", "sell"].includes(e.txType) || !e.mint) return;
  const ok = insertTrade({
    signature: e.signature || `${e.traderPublicKey}:${e.mint}:${e.txType}:${Date.now()}`,
    wallet: e.traderPublicKey, mint: e.mint, side: e.txType,
    sol_amount: Number(e.quoteAmount ?? e.solAmount ?? 0),
    market_cap_sol: Number(e.marketCapSol ?? e.marketCapQuote ?? 0),
    ts: Math.floor(Date.now() / 1000),
  });
  if (ok) {
    recalcWallet(e.traderPublicKey);
    if (e.txType === "buy") notifyBuy(e);
  }
});

export function refreshSubscriptions() {
  sendFeed({ method: "subscribeAccountTrade", keys: listWallets().map(w => w.address) });
}

export function startPumpFeed() {}

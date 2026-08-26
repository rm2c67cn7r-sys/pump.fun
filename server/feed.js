import WebSocket from "ws";

// PumpDev's free/basic tier caps connections at 1 per IP. Running two
// separate sockets (wallet-alerts + screener) from the same server kept
// tripping that cap and forcing constant reconnects, which meant trade
// events were being missed in the gaps. This module owns the ONE
// connection; pump.js and screener.js both register handlers on it
// instead of opening their own.

let socket = null, retry = null;
const messageHandlers = [];
const openHandlers = [];
const pending = [];

function flushPending() {
  while (pending.length && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(pending.shift()));
  }
}

function connect() {
  const base = process.env.PUMPDEV_WS_URL || "wss://pumpdev.io/ws";
  const url = process.env.PUMPDEV_API_KEY ? `${base}?key=${encodeURIComponent(process.env.PUMPDEV_API_KEY)}` : base;
  socket = new WebSocket(url);

  socket.on("open", () => {
    console.log("PumpDev: connected (shared feed)");
    for (const fn of openHandlers) fn();
    flushPending();
  });

  socket.on("message", raw => {
    let e;
    try { e = JSON.parse(raw.toString()); } catch { return; }
    for (const fn of messageHandlers) fn(e);
  });

  socket.on("close", () => { clearTimeout(retry); retry = setTimeout(connect, 3000); });
  socket.on("error", err => console.error("PumpDev:", err.message));
}

export function startFeed() { if (!socket) connect(); }

export function sendFeed(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  else pending.push(msg);
}

export function onFeedMessage(fn) { messageHandlers.push(fn); }

export function onFeedOpen(fn) { openHandlers.push(fn); }

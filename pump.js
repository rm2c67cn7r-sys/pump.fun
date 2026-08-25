import WebSocket from "ws";
import { listWallets,insertTrade,recalcWallet } from "./db.js";
import { notifyBuy } from "./notify.js";

let socket=null,retry=null;

function connect(){
 const base=process.env.PUMPDEV_WS_URL||"wss://pumpdev.io/ws";
 const url=process.env.PUMPDEV_API_KEY?`${base}?key=${encodeURIComponent(process.env.PUMPDEV_API_KEY)}`:base;
 socket=new WebSocket(url);

 socket.on("open",()=>{
  const keys=listWallets().map(w=>w.address);
  if(keys.length) socket.send(JSON.stringify({method:"subscribeAccountTrade",keys}));
  console.log("PumpDev connected; watching",keys.length,"wallets");
 });
 socket.on("message",raw=>{
  try{
   const e=JSON.parse(raw.toString());
   if(!e.traderPublicKey||!["buy","sell"].includes(e.txType)||!e.mint)return;
   const ok=insertTrade({
    signature:e.signature||`${e.traderPublicKey}:${e.mint}:${e.txType}:${Date.now()}`,
    wallet:e.traderPublicKey,mint:e.mint,side:e.txType,
    sol_amount:Number(e.quoteAmount??e.solAmount??0),
    market_cap_sol:Number(e.marketCapSol??e.marketCapQuote??0),
    ts:Math.floor(Date.now()/1000)
   });
   if(ok){recalcWallet(e.traderPublicKey);if(e.txType==="buy")notifyBuy(e)}
  }catch(err){console.error("feed parse:",err.message)}
 });
 socket.on("close",()=>{clearTimeout(retry);retry=setTimeout(connect,3000)});
 socket.on("error",err=>console.error("PumpDev:",err.message));
}

export function startPumpFeed(){connect()}
export function refreshSubscriptions(){
 if(!socket||socket.readyState!==WebSocket.OPEN)return;
 socket.send(JSON.stringify({method:"subscribeAccountTrade",keys:listWallets().map(w=>w.address)}));
}

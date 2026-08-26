import https from "node:https";
import { getWallet, consensus } from "./db.js";

function telegram(text){
 const token=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;
 if(!token||!chat){console.error("Telegram: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing, skipping alert");return Promise.resolve();}
 const body=new URLSearchParams({chat_id:chat,text}).toString();
 return new Promise(resolve=>{
  const req=https.request({
   hostname:"api.telegram.org",
   path:`/bot${token}/sendMessage`,
   method:"POST",
   headers:{"content-type":"application/x-www-form-urlencoded","content-length":Buffer.byteLength(body)}
  },res=>{
   let data="";
   res.on("data",chunk=>data+=chunk);
   res.on("end",()=>{
    if(res.statusCode>=200&&res.statusCode<300){
     console.log("Telegram: alert sent ("+res.statusCode+")");
    }else{
     console.error("Telegram: send FAILED, status "+res.statusCode+", response: "+data);
    }
    resolve();
   });
  });
  req.on("error",err=>{console.error("Telegram: request error:",err.message);resolve();});
  req.end(body);
 });
}

export async function notifyLaunch(l){
 const ageMin=(l.ageSec/60).toFixed(1);
 const text=`🎯 SCREENER HIT (${l.source})

${l.name||"(unnamed)"} ${l.symbol?`$${l.symbol}`:""}
Score: ${l.score}/100
Age: ${ageMin}m
Unique buyers: ${l.unique_buyers}
Buy/Sell (SOL): ${l.buy_sol.toFixed(2)} / ${l.sell_sol.toFixed(2)}
Market cap: ${l.last_market_cap_sol.toFixed(1)} SOL

Contract: ${l.mint}
https://pump.fun/coin/${l.mint}

⚠️ Heuristic momentum signal, not a profit guarantee. DYOR before buying.`;
 console.log("Telegram: attempting screener alert for "+(l.symbol||l.mint)+" score "+l.score);
 await telegram(text);
}

export async function notifyBuy(e){
 const w=getWallet(e.traderPublicKey);
 if(!w)return;
 const amount=Number(e.quoteAmount??e.solAmount??0);
 const minSol=Number(process.env.MIN_ALERT_SOL??1);
 const minScore=Number(process.env.MIN_TRADER_SCORE??70);
 if(amount<minSol||Number(w.score)<minScore)return;

 const c=consensus(e.mint,180);
 const consensusLine=c.n>=2?`\n🔥 ${c.n} tracked traders bought this token in 3m`:``;
 const text=`🚨 SMART MONEY BUY

${w.label||e.traderPublicKey.slice(0,6)+"..."+e.traderPublicKey.slice(-4)}
Score: ${w.score}/100
Observed P&L: ${Number(w.realized_pnl_sol).toFixed(2)} SOL
Buy: ${amount.toFixed(3)} SOL
Token: ${e.mint}${consensusLine}

https://pump.fun/coin/${e.mint}`;
 console.log("Telegram: attempting wallet-buy alert for "+e.traderPublicKey);
 await telegram(text);
}

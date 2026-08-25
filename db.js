import Database from "better-sqlite3";

export const db=new Database("smart-money.sqlite");
db.pragma("journal_mode=WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS wallets(
 address TEXT PRIMARY KEY,
 label TEXT DEFAULT '',
 score REAL DEFAULT 0,
 realized_pnl_sol REAL DEFAULT 0,
 wins INTEGER DEFAULT 0,
 losses INTEGER DEFAULT 0,
 trades INTEGER DEFAULT 0,
 last_trade_at INTEGER,
 created_at INTEGER DEFAULT(unixepoch())
);
CREATE TABLE IF NOT EXISTS trades(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 signature TEXT UNIQUE,
 wallet TEXT NOT NULL,
 mint TEXT NOT NULL,
 side TEXT NOT NULL,
 sol_amount REAL DEFAULT 0,
 market_cap_sol REAL,
 ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);
CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);

CREATE TABLE IF NOT EXISTS launches(
 mint TEXT PRIMARY KEY,
 source TEXT DEFAULT 'pumpfun',
 name TEXT DEFAULT '',
 symbol TEXT DEFAULT '',
 creator TEXT DEFAULT '',
 created_at INTEGER NOT NULL,
 buys INTEGER DEFAULT 0,
 sells INTEGER DEFAULT 0,
 unique_buyers INTEGER DEFAULT 0,
 buy_sol REAL DEFAULT 0,
 sell_sol REAL DEFAULT 0,
 last_market_cap_sol REAL DEFAULT 0,
 peak_market_cap_sol REAL DEFAULT 0,
 score REAL DEFAULT 0,
 alerted INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS launch_buyers(
 mint TEXT NOT NULL,
 wallet TEXT NOT NULL,
 PRIMARY KEY(mint,wallet)
);
CREATE TABLE IF NOT EXISTS candidates(
 address TEXT PRIMARY KEY,
 score REAL DEFAULT 0,
 realized_pnl_sol REAL DEFAULT 0,
 wins INTEGER DEFAULT 0,
 losses INTEGER DEFAULT 0,
 trades INTEGER DEFAULT 0,
 last_trade_at INTEGER
);
`);

export const addWallet=(address,label='')=>db.prepare(
 `INSERT OR IGNORE INTO wallets(address,label) VALUES(?,?)`).run(address,label);

export const listWallets=()=>db.prepare(
 `SELECT * FROM wallets ORDER BY score DESC, realized_pnl_sol DESC`).all();

export const getWallet=(address)=>db.prepare(
 `SELECT * FROM wallets WHERE address=?`).get(address);

export function insertTrade(t){
 try{
  db.prepare(`INSERT INTO trades(signature,wallet,mint,side,sol_amount,market_cap_sol,ts)
   VALUES(@signature,@wallet,@mint,@side,@sol_amount,@market_cap_sol,@ts)`).run(t);
  return true;
 }catch{return false;}
}

export const recentTrades=(limit=100)=>db.prepare(
 `SELECT * FROM trades ORDER BY ts DESC LIMIT ?`).all(limit);

function computeStats(address){
 const rows=db.prepare(`
   SELECT mint,
    SUM(CASE WHEN side='buy' THEN sol_amount ELSE 0 END) spent,
    SUM(CASE WHEN side='sell' THEN sol_amount ELSE 0 END) received
   FROM trades WHERE wallet=? GROUP BY mint`).all(address);

 let pnl=0,wins=0,losses=0;
 for(const r of rows){
   const p=r.received-r.spent;
   pnl+=p;
   if(r.spent>0 && r.received>0){ if(p>=0) wins++; else losses++; }
 }
 const trades=db.prepare(`SELECT COUNT(*) n FROM trades WHERE wallet=?`).get(address).n;
 const winRate=(wins+losses)?wins/(wins+losses):0;
 const pnlComponent=Math.min(25,Math.max(-25,pnl/10));
 const score=Math.round(Math.max(0,Math.min(100,winRate*60+pnlComponent+Math.min(15,trades/4))));
 return {pnl,wins,losses,trades,score};
}

export function recalcWallet(address){
 const {pnl,wins,losses,trades,score}=computeStats(address);
 db.prepare(`UPDATE wallets SET realized_pnl_sol=?,wins=?,losses=?,trades=?,score=?,
   last_trade_at=unixepoch() WHERE address=?`).run(pnl,wins,losses,trades,score,address);
}

// Scores wallets that aren't (yet) opted into the tracked/alerted `wallets`
// table, so we can auto-discover profitable traders from raw trade flow
// without subscribing to every wallet that ever touches a screened token.
export function recalcCandidate(address){
 const {pnl,wins,losses,trades,score}=computeStats(address);
 db.prepare(`INSERT INTO candidates(address,realized_pnl_sol,wins,losses,trades,score,last_trade_at)
   VALUES(?,?,?,?,?,?,unixepoch())
   ON CONFLICT(address) DO UPDATE SET realized_pnl_sol=excluded.realized_pnl_sol,
     wins=excluded.wins,losses=excluded.losses,trades=excluded.trades,
     score=excluded.score,last_trade_at=excluded.last_trade_at`)
  .run(address,pnl,wins,losses,trades,score);
 return {address,pnl,wins,losses,trades,score};
}

export function consensus(mint,windowSeconds=180){
 return db.prepare(`SELECT COUNT(DISTINCT wallet) n, SUM(sol_amount) sol
   FROM trades WHERE mint=? AND side='buy' AND ts>=?`).get(mint,Math.floor(Date.now()/1000)-windowSeconds);
}

// ---- Launch screener ----
export function upsertLaunch(l){
 db.prepare(`INSERT INTO launches(mint,source,name,symbol,creator,created_at)
   VALUES(@mint,@source,@name,@symbol,@creator,@created_at)
   ON CONFLICT(mint) DO NOTHING`).run(l);
}

export const getLaunch=(mint)=>db.prepare(`SELECT * FROM launches WHERE mint=?`).get(mint);

export function recordLaunchTrade(mint,wallet,side,solAmount,marketCapSol){
 const isNewBuyer = side==='buy' &&
   db.prepare(`INSERT OR IGNORE INTO launch_buyers(mint,wallet) VALUES(?,?)`).run(mint,wallet).changes>0;
 db.prepare(`UPDATE launches SET
   buys = buys + CASE WHEN @side='buy' THEN 1 ELSE 0 END,
   sells = sells + CASE WHEN @side='sell' THEN 1 ELSE 0 END,
   unique_buyers = unique_buyers + @newBuyer,
   buy_sol = buy_sol + CASE WHEN @side='buy' THEN @sol ELSE 0 END,
   sell_sol = sell_sol + CASE WHEN @side='sell' THEN @sol ELSE 0 END,
   last_market_cap_sol = @mc,
   peak_market_cap_sol = MAX(peak_market_cap_sol,@mc)
   WHERE mint=@mint`).run({mint,side,sol:solAmount,mc:marketCapSol||0,newBuyer:isNewBuyer?1:0});
}

export function scoreLaunch(mint){
 const l=getLaunch(mint);
 if(!l)return null;
 const ageSec=Math.max(1,Math.floor(Date.now()/1000)-l.created_at);
 const buySellRatio = l.sell_sol>0 ? l.buy_sol/l.sell_sol : (l.buy_sol>0?3:0);
 const buyerVelocity = l.unique_buyers/(ageSec/60); // unique buyers per minute
 const mcGrowth = l.last_market_cap_sol; // simple proxy while young
 let score=0;
 score += Math.min(35, buyerVelocity*7);        // fast-growing unique buyer count
 score += Math.min(25, Math.min(buySellRatio,5)*5); // buy pressure vs sells
 score += Math.min(20, l.unique_buyers/2);       // breadth, not one wallet farming volume
 score += Math.min(20, mcGrowth/5);              // market cap traction (SOL terms)
 score = Math.round(Math.max(0,Math.min(100,score)));
 db.prepare(`UPDATE launches SET score=? WHERE mint=?`).run(score,mint);
 return {...l,score,buySellRatio,buyerVelocity,ageSec};
}

export const recentLaunches=(limit=100)=>db.prepare(
 `SELECT * FROM launches ORDER BY created_at DESC LIMIT ?`).all(limit);

export const markAlerted=(mint)=>db.prepare(`UPDATE launches SET alerted=1 WHERE mint=?`).run(mint);

import "dotenv/config";
import express from "express";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {addWallet,listWallets,recentTrades,consensus,recentLaunches} from "./db.js";
import {refreshSubscriptions} from "./pump.js";
import "./screener.js";
import {startFeed} from "./feed.js";

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express();
app.use(express.json());
app.use(express.static(path.join(__dirname,"../public")));

app.get("/api/health",(req,res)=>res.json({ok:true,time:Date.now()}));
app.get("/api/wallets",(req,res)=>res.json(listWallets()));
app.get("/api/trades",(req,res)=>res.json(recentTrades(200)));
app.get("/api/consensus/:mint",(req,res)=>res.json(consensus(req.params.mint)));
app.get("/api/launches",(req,res)=>res.json(recentLaunches(200)));

app.post("/api/wallets",(req,res)=>{
 const {address,label}=req.body||{};
 if(!address||address.length<20)return res.status(400).json({error:"Invalid wallet address"});
 addWallet(address.trim(),(label||"").trim());
 refreshSubscriptions();
 res.json({ok:true});
});

app.get("/",(req,res)=>res.sendFile(path.join(__dirname,"../public/index.html")));
app.listen(Number(process.env.PORT||3000),()=>console.log("Smart Money Tracker: http://localhost:"+Number(process.env.PORT||3000)));
startFeed();

[Reading 67 lines from start (total: 67 lines, 0 remaining)]

import { calculateSignal } from "./signal.js";
import { recordTrade, getSummary } from "./ledger.js";

function tg(token, method, body={}) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body)
  }).then(async r=>{const d=await r.json(); if(!r.ok||!d.ok) throw new Error(d.description||`Telegram HTTP ${r.status}`); return d.result;});
}
function allowed(id){const raw=process.env.TELEGRAM_ALLOWED_CHAT_IDS||"";return !raw.trim()||raw.split(",").map(x=>x.trim()).includes(String(id));}
const METHODS=["BankTransfer","BkashMerchant","BkashAgent","NagadAgent","BkashPersonal","NagadPersonal"];
const sessions=new Map();
const FEE={
 BankTransfer:{buy:0,sell:0}, BkashMerchant:{buy:0,sell:.018},
 BkashAgent:{buy:.004,sell:.004}, NagadAgent:{buy:.004,sell:.004},
 BkashPersonal:{buy:.007,sell:.007}, NagadPersonal:{buy:.007,sell:.007}
};
function ask(s){return ["Capital amount (BDT)?","Target cycles today?","Payment method?\n"+METHODS.map((x,i)=>`${i+1}. ${x}`).join("\n"),"Current BDT amount?","Current USDT amount?"][s.step];}
async function begin(chatId,send){
 sessions.set(String(chatId),{step:0,data:{},paused:false});
 await send(chatId,"P2P session initialized. I need 5 inputs.\n\nCapital amount (BDT)?");
}
function parseMethod(v){const n=Number(v);if(n>=1&&n<=METHODS.length)return METHODS[n-1];const x=v.toLowerCase();return METHODS.find(m=>m.toLowerCase()===x)||null;}
async function sessionInput(chatId,text,send){
 const s=sessions.get(String(chatId)); if(!s)return false;
 if(text.startsWith("/"))return false;
 const d=s.data;
 if(s.step===0){d.capital=Number(text);if(!(d.capital>0))throw Error("Enter a valid BDT capital amount.");}
 if(s.step===1){d.cycles=Math.floor(Number(text));if(!(d.cycles>0))throw Error("Enter a valid target cycle count.");}
 if(s.step===2){d.method=parseMethod(text);if(!d.method)throw Error("Choose a method by number or exact name.");}
 if(s.step===3){d.bdt=Number(text);if(d.bdt<0)throw Error("Enter a valid BDT amount.");}
 if(s.step===4){d.usdt=Number(text);if(d.usdt<0)throw Error("Enter a valid USDT amount.");}
 s.step++;
 if(s.step<5){await send(chatId,ask(s));return true;}
 const f=FEE[d.method]||{buy:0,sell:0};
 d.fees=f;
 d.targetProfitBdt=d.capital*.01*d.cycles;
 await send(chatId,
  `SESSION READY\nCapital: ${d.capital.toFixed(2)} BDT\nTarget cycles: ${d.cycles}\nMethod: ${d.method}\nStarting BDT: ${d.bdt.toFixed(2)}\nStarting USDT: ${d.usdt.toFixed(2)}\nMethod BUY cost: ${(f.buy*100).toFixed(2)}%\nMethod SELL cost: ${(f.sell*100).toFixed(2)}%\n1% target/cycle: ${(d.capital*.01).toFixed(2)} BDT\nIllustrative daily target: ${d.targetProfitBdt.toFixed(2)} BDT\n\nUse /p2p <buy> <sell> to analyze a cycle.\nUse /buy or /sell to record actual fills.\nUse /report24 for the session report.`);
 return true;
}
export function startTelegramBot({getStatus,store}){
 const token=process.env.TELEGRAM_BOT_TOKEN;if(!token){console.log("Telegram disabled");return;}
 let offset=0;
 async function send(id,text){return tg(token,"sendMessage",{chat_id:id,text});}
 async function loop(){while(true){try{
  const updates=await tg(token,"getUpdates",{offset,timeout:25,allowed_updates:["message"]});
  for(const u of updates){offset=u.update_id+1;const m=u.message;if(!m?.chat?.id||!m.text||!allowed(m.chat.id))continue;
   const id=m.chat.id,text=m.text.trim(),parts=text.split(/\s+/),c=parts[0].toLowerCase(),a=parts.slice(1);
   try{
    if(sessions.has(String(id))&& !text.startsWith("/")){await sessionInput(id,text,send);continue;}
    if(c==="/starttrade"){await begin(id,send);continue;}
    if(c==="/help"||c==="/start"){await send(id,"P2connect P2P Control\n/starttrade\n/status\n/price <buy> <sell> [fee]\n/spread <buy> <sell> [fee]\n/p2p <buy> <sell> [fee]\n/buy <USDT> <BDT> [note]\n/sell <USDT> <BDT> [note]\n/balance\n/report24\n/pause\n/resume\n/stoptrade");continue;}
    if(c==="/status"){const x=getStatus();await send(id,`P2connect: ${x.status}\nBinance configured: ${x.binanceConfigured?"yes":"no"}\nSession: ${sessions.has(String(id))?"active":"none"}`);continue;}
    if(c==="/chatid"){await send(id,`Chat ID: ${id}`);continue;}
    if(c==="/pause"){const s=sessions.get(String(id));if(s)s.paused=true;await send(id,"P2P session PAUSED. No new trade signal should be acted on.");continue;}
    if(c==="/resume"){const s=sessions.get(String(id));if(s)s.paused=false;await send(id,"P2P session RESUMED.");continue;}
    if(c==="/stoptrade"){sessions.delete(String(id));await send(id,"P2P session stopped. Existing ledger records are preserved.");continue;}
    if(c==="/balance"||c==="/report24"){const x=await getSummary(store);await send(id,`24H USDT ledger\nBought: ${x.bought_qty.toFixed(2)} USDT\nAvg buy: ${x.average_buy_bdt.toFixed(2)} BDT\nSold: ${x.sold_qty.toFixed(2)} USDT\nAvg sell: ${x.average_sell_bdt.toFixed(2)} BDT\nNet USDT: ${x.net_qty.toFixed(2)}\nGross BDT difference: ${x.gross_bdt.toFixed(2)}\nStorage: ${store.persistent?"persistent":"temporary"}`);continue;}
    if(c==="/price"||c==="/spread"||c==="/p2p"){const s=sessions.get(String(id));if(s?.paused){await send(id,"Session is paused. Use /resume first.");continue;}const [buy,sell,fee="0"]=a;if(!(buy&&sell)){await send(id,"Usage: /p2p 126.80 127.70 0.0085");continue;}const feeRate=Number(fee)||(s?.data?.fees?.buy||0)+(s?.data?.fees?.sell||0);const z=calculateSignal({buyPrice:buy,sellPrice:sell,feeRate});await send(id,`CYCLE ANALYSIS\nBuy: ${z.buy_price_bdt.toFixed(2)}\nSell: ${z.sell_price_bdt.toFixed(2)}\nEffective buy: ${z.effective_buy_bdt.toFixed(4)}\nEffective sell: ${z.effective_sell_bdt.toFixed(4)}\nNet spread: ${z.spread_bdt.toFixed(4)} BDT/USDT\nNet margin: ${z.spread_pct.toFixed(3)}%\nSignal: ${z.signal}\nExecution: HUMAN CONFIRMATION REQUIRED`);continue;}
    if(c==="/buy"||c==="/sell"){const [qty,price,...note]=a;const r=await recordTrade(store,{side:c==="/buy"?"BUY":"SELL",quantity:qty,price_bdt:price,note:note.join(" ")});await send(id,`Recorded ${r.side}: ${r.quantity} USDT @ ${r.price_bdt} BDT\nTotal: ${r.total_bdt.toFixed(2)} BDT`);continue;}
    await send(id,"Unknown command. Use /help.");
   }catch(e){await send(id,`Error: ${e.message}`);}
  }
 }catch(e){console.error("Telegram polling error:",e.message);await new Promise(r=>setTimeout(r,5000));}}}
 loop();console.log("Telegram P2P control bot enabled");
}


[executed on device: DESKTOP-9NBB4E3 (b3552ab2-7a45-4f09-83a8-bb7fd7363e4e)]
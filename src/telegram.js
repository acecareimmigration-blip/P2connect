import { recordTrade, getSummary } from "./ledger.js";

function api(token,method,body={}){return fetch(`https://api.telegram.org/bot${token}/${method}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(async r=>{const x=await r.json();if(!r.ok||!x.ok)throw Error(x.description||"Telegram error");return x.result;});}
function allowed(id){const x=process.env.TELEGRAM_ALLOWED_CHAT_IDS||"";return !x.trim()||x.split(",").map(v=>v.trim()).includes(String(id));}
const sessions=new Map();
const METHODS=["BankTransfer","BkashMerchant","BkashAgent","NagadAgent","BkashPersonal","NagadPersonal"];
function amount(v){const x=String(v).trim().toLowerCase().replace(/,/g,"");const m=x.match(/^([0-9]+(?:\.[0-9]+)?)\s*(k|l|lac|lakh)?$/);if(!m)return NaN;const n=Number(m[1]);return n*(m[2]==="k"?1000:["l","lac","lakh"].includes(m[2])?100000:1);}
function method(v){const n=Number(v);if(n>=1&&n<=6)return METHODS[n-1];const x=v.toLowerCase().replace(/[^a-z]/g,"");return {banktransfer:"BankTransfer",bkashmerchant:"BkashMerchant",bkashagent:"BkashAgent",nagadagent:"NagadAgent",bkashpersonal:"BkashPersonal",nagadpersonal:"NagadPersonal"}[x];}
function benefits(m,side,optionalMerchant=false){
 if(m==="BankTransfer")return 0;
 if(m==="BkashAgent"||m==="NagadAgent")return .004;
 if(m==="BkashPersonal"||m==="NagadPersonal")return side==="SELL"?.007:0;
 if(m==="BkashMerchant")return side==="SELL"?(optionalMerchant?.018:.004):0;
 return 0;
}
function cycleEstimate(d){
 const deployed=d.capital;
 const methodProfit=deployed*benefits(d.method,d.side,d.merchantOptional);
 const fixed=d.method==="BankTransfer"&&d.bankType==="OtherBank"?10:0;
 const target=deployed*.01;
 return {deployed,methodProfit,fixed,target,predicted:target+methodProfit-fixed};
}
function cycleReady(d){
 const e=cycleEstimate(d);
 return `CYCLE READY\nSide: ${d.side}\nCapital available: ${d.capital.toFixed(2)} BDT\nCycle allocation: ${e.deployed.toFixed(2)} BDT\nTarget cycles: ${d.cycles}\nMethod: ${d.method}${d.bankType?` (${d.bankType})`:""}\nCurrent BDT: ${d.bdt.toFixed(2)}\nCurrent USDT: ${d.usdt.toFixed(2)}\n\n1% market target: ${e.target.toFixed(2)} BDT\nMethod profit: +${e.methodProfit.toFixed(2)} BDT\nMethod expense: -${e.fixed.toFixed(2)} BDT\nPredicted profit: ${e.predicted.toFixed(2)} BDT\n\nMARKET INPUT REQUIRED\nSend /ads then type the current top BUY/SELL ad prices, or send a Binance P2P screenshot for manual analysis.\n\nRecord a fill with:\n/${d.side.toLowerCase()} <USDT amount> <price>\nExample: /${d.side.toLowerCase()} 393.70 127.00`;}
async function input(id,text,send){
 const s=sessions.get(String(id)),d=s.data;
 if(s.step==="capital"){d.capital=amount(text);if(!(d.capital>0))throw Error("Use e.g. 50k, 1L, 1.25L or 125000.");s.step="cycles";return send(id,"Target cycles today?");}
 if(s.step==="cycles"){d.cycles=Math.floor(Number(text));if(!(d.cycles>0))throw Error("Enter a valid cycle count.");s.step="side";return send(id,"Cycle side?\n1. BUY USDT\n2. SELL USDT");}
 if(s.step==="side"){d.side=/^(1|buy)$/i.test(text)?"BUY":/^(2|sell)$/i.test(text)?"SELL":null;if(!d.side)throw Error("Choose 1/BUY or 2/SELL.");s.step="method";return send(id,"Payment method?\n1. BankTransfer\n2. BkashMerchant\n3. BkashAgent\n4. NagadAgent\n5. BkashPersonal\n6. NagadPersonal");}
 if(s.step==="method"){d.method=method(text);if(!d.method)throw Error("Choose 1-6 or method name.");if(d.method==="BankTransfer"){s.step="bank";return send(id,"Bank transfer type?\n1. Same bank — 0 BDT\n2. Other bank — 10 BDT");}if(d.method==="BkashMerchant"&&d.side==="SELL"){s.step="merchant";return send(id,"bKash Merchant return structure?\n1. Standard +0.40%\n2. Optional +1.80%");}s.step="ready";return send(id,cycleReady(d));}
 if(s.step==="bank"){d.bankType=/^(1|same|samebank)$/i.test(text)?"SameBank":/^(2|other|otherbank)$/i.test(text)?"OtherBank":null;if(!d.bankType)throw Error("Choose 1 Same bank or 2 Other bank.");s.step="ready";return send(id,cycleReady(d));}
 if(s.step==="merchant"){d.merchantOptional=/^(2|optional)$/i.test(text);s.step="ready";return send(id,cycleReady(d));}
 if(s.step==="bdt"){d.bdt=amount(text);if(!(d.bdt>=0))throw Error("Use e.g. 50k, 1L, 1.25L or 125000.");s.step="usdt";return send(id,"Current USDT amount?");}
 if(s.step==="usdt"){d.usdt=amount(text);if(!(d.usdt>=0))throw Error("Enter current USDT amount.");s.step="ready";return send(id,cycleReady(d));}
 if(s.step==="close_bdt"){d.endBdt=amount(text);if(!(d.endBdt>=0))throw Error("Enter a valid BDT amount.");s.step="close_usdt";return send(id,"Enter CURRENT USDT amount after this cycle.");}
 if(s.step==="close_usdt"){d.endUsdt=amount(text);if(!(d.endUsdt>=0))throw Error("Enter a valid USDT amount.");await send(id,`CYCLE CLOSED & SNAPSHOT STORED\\nEnding BDT: ${d.endBdt.toFixed(2)}\\nEnding USDT: ${d.endUsdt.toFixed(2)}\\nTrade ledger preserved.\\nUse /starttrade for the next cycle.`);sessions.delete(String(id));return true;}
 return false;
}
export function startTelegramBot({getStatus,store}){
 const token=process.env.TELEGRAM_BOT_TOKEN;if(!token)return;let offset=0;const send=(id,text)=>api(token,"sendMessage",{chat_id:id,text});
 (async()=>{while(true){try{for(const u of await api(token,"getUpdates",{offset,timeout:25,allowed_updates:["message"]})){offset=u.update_id+1;const m=u.message;if(!m?.chat?.id||!allowed(m.chat.id))continue;const id=m.chat.id,text=(m.text||"").trim(),[c,...a]=text.split(/\s+/);try{
  if(m.photo){await send(id,"Screenshot received. Automatic OCR/ad extraction is not enabled yet. For now send /ads and enter the visible top ad prices.");continue;}
  if(sessions.has(String(id))&&!text.startsWith("/")){await input(id,text,send);continue;}
  if(c==="/starttrade"){sessions.set(String(id),{step:"capital",data:{}});await send(id,"P2P CYCLE SETUP\nCapital amount (BDT)?\nExamples: 50k = 50,000 | 1L = 100,000 | 1.25L = 125,000");continue;}
  if(c==="/ads"){await send(id,"MANUAL AD ANALYSIS\nSend prices as:\n/p2p <best buy> <best sell>\nExample: /p2p 126.80 127.70\nYou can also upload a Binance P2P screenshot; automated extraction is the next module.");continue;}
  if(c==="/buy"||c==="/sell"){if(a.length<2){await send(id,`Usage: ${c} <USDT amount> <price>\nExample: ${c} 393.70 127.00`);continue;}const q=amount(a[0]),p=amount(a[1]);const r=await recordTrade(store,{side:c==="/buy"?"BUY":"SELL",quantity:q,price_bdt:p,note:a.slice(2).join(" ")});await send(id,`RECORDED ${r.side}\n${r.quantity.toFixed(2)} USDT @ ${r.price_bdt.toFixed(2)} BDT\nTotal: ${r.total_bdt.toFixed(2)} BDT`);continue;}
  if(c==="/p2p"||c==="/price"||c==="/spread"){if(a.length<2){await send(id,"Usage: /p2p 126.80 127.70");continue;}const buy=amount(a[0]),sell=amount(a[1]),s=sessions.get(String(id)),d=s?.data||{};const raw=(sell-buy)/buy,methodBuy=benefits(d.method,"BUY",d.merchantOptional),methodSell=benefits(d.method,"SELL",d.merchantOptional),fixed=d.method==="BankTransfer"&&d.bankType==="OtherBank"?10:0,alloc=Math.min(d.capital||d.bdt||0,d.bdt||d.capital||0),profit=alloc*(raw+methodBuy+methodSell)-fixed;await send(id,`P2P ANALYSIS\nBest buy: ${buy.toFixed(2)}\nBest sell: ${sell.toFixed(2)}\nRaw spread: ${(raw*100).toFixed(3)}%\nMethod benefit: +${((methodBuy+methodSell)*100).toFixed(2)}%\nFixed expense: -${fixed.toFixed(2)} BDT\nEstimated cycle profit: ${profit.toFixed(2)} BDT\nEstimated return: ${alloc?((profit/alloc)*100).toFixed(3):"0.000"}%\nSignal: ${profit>0?"POSITIVE — REVIEW":"NO TRADE"}\nExecution requires human confirmation.`);continue;}
  if(c==="/balance"||c==="/report24"){const x=await getSummary(store);await send(id,`USDT LEDGER\nBought: ${x.bought_qty.toFixed(2)} @ ${x.average_buy_bdt.toFixed(2)}\nSold: ${x.sold_qty.toFixed(2)} @ ${x.average_sell_bdt.toFixed(2)}\nNet USDT: ${x.net_qty.toFixed(2)}\nGross cash difference: ${x.gross_bdt.toFixed(2)} BDT\nStorage: ${store.persistent?"persistent":"temporary"}`);continue;}
  if(c==="/status"){const x=getStatus();await send(id,`P2connect: ${x.status}\nBinance configured: ${x.binanceConfigured?"yes":"no"}\nSession: ${sessions.has(String(id))?"active":"none"}`);continue;}
  if(c==="/stoptrade"){const s=sessions.get(String(id));if(!s){await send(id,"No active cycle.");continue;}s.step="close_bdt";await send(id,"CYCLE CLOSING\nEnter CURRENT BDT amount after this cycle.\nExamples: 50k | 1L | 1.25L");continue;}
  if(c==="/help"||c==="/start"){await send(id,"/starttrade /ads /p2p /buy /sell /balance /report24 /status /stoptrade");continue;}
  await send(id,"Unknown command. Use /help.");
 }catch(e){await send(id,`Error: ${e.message}`);}}}catch(e){console.error("Telegram:",e.message);await new Promise(r=>setTimeout(r,5000));}}})();
 console.log("Telegram P2P bot enabled");
}

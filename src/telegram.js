import { calculateSignal } from "./signal.js";
import { recordTrade, getSummary } from "./ledger.js";

function tokenCall(token, method, body={}) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body)
  }).then(async r=>{const d=await r.json(); if(!r.ok||!d.ok) throw new Error(d.description||`Telegram HTTP ${r.status}`); return d.result;});
}
function allowed(chatId) {
  const raw=process.env.TELEGRAM_ALLOWED_CHAT_IDS||"";
  return !raw.trim() || raw.split(",").map(x=>x.trim()).includes(String(chatId));
}
const help="Commands:\n/status /health /chatid\n/price <buy> <sell> [fee]\n/spread <buy> <sell> [fee]\n/p2p <buy> <sell> [fee]\n/buy <USDT> <BDT> [note]\n/sell <USDT> <BDT> [note]\n/balance";
export function startTelegramBot({ getStatus, store }) {
  const token=process.env.TELEGRAM_BOT_TOKEN; if(!token){console.log("Telegram disabled");return;}
  let offset=0;
  async function send(chatId,text){return tokenCall(token,"sendMessage",{chat_id:chatId,text});}
  async function loop(){
    while(true){try{
      const updates=await tokenCall(token,"getUpdates",{offset,timeout:25,allowed_updates:["message"]});
      for(const u of updates){offset=u.update_id+1; const m=u.message;if(!m?.chat?.id||!m.text||!allowed(m.chat.id))continue;
        const [cmd,...a]=m.text.trim().split(/\s+/); const c=cmd.toLowerCase();
        try{
          if(["/start","/help"].includes(c)) await send(m.chat.id,help);
          else if(c==="/status"){const s=getStatus();await send(m.chat.id,`P2connect: ${s.status}\nBinance configured: ${s.binanceConfigured?"yes":"no"}`);}
          else if(c==="/health") await send(m.chat.id,"P2connect health: OK");
          else if(c==="/chatid") await send(m.chat.id,`Chat ID: ${m.chat.id}`);
          else if(["/price","/spread","/p2p"].includes(c)){const [buy,sell,fee="0"]=a;if(!buy||!sell) await send(m.chat.id,"Usage: /price 126.8 127.6 0.0085");else {const s=calculateSignal({buyPrice:buy,sellPrice:sell,feeRate:Number(fee)});await send(m.chat.id,`BUY ${s.buy_price_bdt.toFixed(2)} | SELL ${s.sell_price_bdt.toFixed(2)}\nNet spread: ${s.spread_bdt.toFixed(4)} BDT/USDT (${s.spread_pct.toFixed(3)}%)\nSignal: ${s.signal}\nExecution: HUMAN CONFIRMATION REQUIRED`);}}
          else if(c==="/buy"||c==="/sell"){const [qty,price,...note]=a;const r=await recordTrade(store,{side:c==="/buy"?"BUY":"SELL",quantity:qty,price_bdt:price,note:note.join(" ")});await send(m.chat.id,`Recorded ${r.side}: ${r.quantity} USDT @ ${r.price_bdt} BDT\nTotal: ${r.total_bdt.toFixed(2)} BDT`);}
          else if(c==="/balance"){const s=await getSummary(store);await send(m.chat.id,`USDT ledger\nBought: ${s.bought_qty.toFixed(2)} @ avg ${s.average_buy_bdt.toFixed(2)}\nSold: ${s.sold_qty.toFixed(2)} @ avg ${s.average_sell_bdt.toFixed(2)}\nNet quantity: ${s.net_qty.toFixed(2)}\nGross cash difference: ${s.gross_bdt.toFixed(2)} BDT\nStorage: ${store.persistent?"persistent":"temporary"}`);}
        }catch(e){await send(m.chat.id,`Error: ${e.message}`);}
      }
    }catch(e){console.error("Telegram polling error:",e.message);await new Promise(r=>setTimeout(r,5000));}}
  }
  loop(); console.log("Telegram bot polling enabled");
}

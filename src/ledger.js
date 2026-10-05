const memory=[]; let memoryCycleSeq=0;

export async function initLedger(){
 if(!process.env.DATABASE_URL)return {persistent:false};
 const {Pool}=await import("pg"); const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
 await pool.query(`CREATE TABLE IF NOT EXISTS p2p_trades(id BIGSERIAL PRIMARY KEY,cycle_id TEXT,side TEXT NOT NULL,asset TEXT NOT NULL,quantity NUMERIC NOT NULL,price_bdt NUMERIC NOT NULL,total_bdt NUMERIC NOT NULL,note TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
 await pool.query(`ALTER TABLE p2p_trades ADD COLUMN IF NOT EXISTS cycle_id TEXT`);
 await pool.query(`CREATE TABLE IF NOT EXISTS p2p_cycles(id BIGSERIAL PRIMARY KEY,cycle_id TEXT NOT NULL UNIQUE,started_at TIMESTAMPTZ NOT NULL,ended_at TIMESTAMPTZ,side TEXT NOT NULL,payment_method TEXT NOT NULL,bank_type TEXT,capital_bdt NUMERIC NOT NULL,start_bdt NUMERIC,start_usdt NUMERIC,end_bdt NUMERIC,end_usdt NUMERIC,expected_profit_bdt NUMERIC,actual_profit_bdt NUMERIC,status TEXT NOT NULL,notes TEXT)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS p2p_sequence(name TEXT PRIMARY KEY,value BIGINT NOT NULL)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS p2p_chat_memory(id BIGSERIAL PRIMARY KEY,chat_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
 await pool.query(`CREATE INDEX IF NOT EXISTS p2p_chat_memory_chat_time_idx ON p2p_chat_memory(chat_id,created_at DESC)`);
 await pool.query(`INSERT INTO p2p_sequence(name,value) VALUES('cycle',0) ON CONFLICT(name) DO NOTHING`);
 return {persistent:true,pool};
}
export async function nextCycleId(store){
 if(!store.persistent){memoryCycleSeq++;return "AC"+String(memoryCycleSeq).padStart(2,"0");}
 const r=await store.pool.query("UPDATE p2p_sequence SET value=value+1 WHERE name='cycle' RETURNING value");
 return "AC"+String(r.rows[0].value).padStart(2,"0");
}
export async function recordTrade(store,{cycleId=null,side,asset="USDT",quantity,price_bdt,note=""}){
 const q=Number(quantity),p=Number(price_bdt); if(!(q>0&&p>0)||!["BUY","SELL"].includes(side))throw new Error("Invalid trade"); const total=q*p;
 if(store.persistent){const r=await store.pool.query("INSERT INTO p2p_trades(cycle_id,side,asset,quantity,price_bdt,total_bdt,note) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,created_at",[cycleId,q?side:side,asset,q,p,total,note]);return {id:r.rows[0].id,cycleId,side,asset,quantity:q,price_bdt:p,total_bdt:total,created_at:r.rows[0].created_at};}
 const row={id:memory.length+1,cycleId,side,asset,quantity:q,price_bdt:p,total_bdt:total,note,created_at:new Date().toISOString()};memory.push(row);return row;
}
export async function getSummary(store,asset="USDT"){
 let rows;if(store.persistent)rows=(await store.pool.query("SELECT side,COALESCE(SUM(quantity),0) quantity,COALESCE(SUM(total_bdt),0) total_bdt FROM p2p_trades WHERE asset=$1 GROUP BY side",[asset])).rows;else rows=["BUY","SELL"].map(side=>{const a=memory.filter(x=>x.asset===asset&&x.side===side);return {side,quantity:a.reduce((s,x)=>s+x.quantity,0),total_bdt:a.reduce((s,x)=>s+x.total_bdt,0)}});
 const buy=rows.find(x=>x.side==="BUY")||{quantity:0,total_bdt:0},sell=rows.find(x=>x.side==="SELL")||{quantity:0,total_bdt:0};
 return {asset,bought_qty:Number(buy.quantity),bought_bdt:Number(buy.total_bdt),sold_qty:Number(sell.quantity),sold_bdt:Number(sell.total_bdt),net_qty:Number(buy.quantity)-Number(sell.quantity),average_buy_bdt:buy.quantity?Number(buy.total_bdt)/Number(buy.quantity):0,average_sell_bdt:sell.quantity?Number(sell.total_bdt)/Number(sell.quantity):0,gross_bdt:Number(sell.total_bdt)-Number(buy.total_bdt)};
}
export async function getCycleReport(store,cycleId){
 if(!store.persistent)return null;
 const c=(await store.pool.query("SELECT * FROM p2p_cycles WHERE cycle_id=$1",[cycleId])).rows[0];
 const t=(await store.pool.query("SELECT * FROM p2p_trades WHERE cycle_id=$1 ORDER BY created_at",[cycleId])).rows;
 return c?{cycle:c,trades:t}:null;
}
export async function recordCycle(store,cycle){
 const required=["cycleId","startedAt","side","paymentMethod","capitalBdt","status"];for(const k of required)if(cycle[k]===undefined||cycle[k]===null)throw new Error("Missing cycle field: "+k);
 if(!store.persistent)return {...cycle,persisted:false};
 const r=await store.pool.query(`INSERT INTO p2p_cycles(cycle_id,started_at,ended_at,side,payment_method,bank_type,capital_bdt,start_bdt,start_usdt,end_bdt,end_usdt,expected_profit_bdt,actual_profit_bdt,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,[cycle.cycleId,cycle.startedAt,cycle.endedAt||null,cycle.side,cycle.paymentMethod,cycle.bankType||null,cycle.capitalBdt,cycle.startBdt??null,cycle.startUsdt??null,cycle.endBdt??null,cycle.endUsdt??null,cycle.expectedProfitBdt??null,cycle.actualProfitBdt??null,cycle.status,cycle.notes||null]);
 return {...cycle,dbId:r.rows[0].id,persisted:true};
}
export async function saveChatMessage(store,chatId,role,content){
 if(!store.persistent)return;
 const text=String(content||"").trim(); if(!text)return;
 await store.pool.query("INSERT INTO p2p_chat_memory(chat_id,role,content) VALUES($1,$2,$3)",[String(chatId),role,text.slice(0,4000)]);
}
export async function getRecentChat(store,chatId,limit=12){
 if(!store.persistent)return [];
 const n=Math.max(1,Math.min(Number(limit)||12,30));
 const r=await store.pool.query("SELECT role,content,created_at FROM p2p_chat_memory WHERE chat_id=$1 ORDER BY created_at DESC LIMIT $2",[String(chatId),n]);
 return r.rows.reverse();
}
export async function getActiveCycleSnapshot(store,cycleId){
 if(!cycleId)return null;
 let trades=[];
 if(store.persistent) trades=(await store.pool.query("SELECT side,quantity,price_bdt,total_bdt,created_at FROM p2p_trades WHERE cycle_id=$1 ORDER BY created_at",[cycleId])).rows;
 else trades=memory.filter(x=>x.cycleId===cycleId);
 const buys=trades.filter(x=>x.side==="BUY"), sells=trades.filter(x=>x.side==="SELL");
 const bq=buys.reduce((s,x)=>s+Number(x.quantity),0), sq=sells.reduce((s,x)=>s+Number(x.quantity),0);
 const bb=buys.reduce((s,x)=>s+Number(x.total_bdt),0), sb=sells.reduce((s,x)=>s+Number(x.total_bdt),0);
 return {cycleId,bought_usdt:bq,sold_usdt:sq,remaining_usdt:bq-sq,buy_bdt:bb,sell_bdt:sb,avg_buy:bq?bb/bq:0,avg_sell:sq?sb/sq:0,realized_cashflow_bdt:sb-bb,trades};
}

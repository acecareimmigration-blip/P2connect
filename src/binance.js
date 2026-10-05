import crypto from "node:crypto";

const BASE="https://api.binance.com";
function credentials(){
 const apiKey=process.env.BINANCE_API_KEY;
 const raw=process.env.BINANCE_PRIVATE_KEY;
 if(!apiKey||!raw) throw new Error("BINANCE_NOT_CONFIGURED");
 const privateKey=raw.replace(/\\n/g,"\n").trim();
 return {apiKey,privateKey};
}
async function signedGet(path,params={}){
 const {apiKey,privateKey}=credentials();
 const qs=new URLSearchParams({...params,timestamp:String(Date.now()),recvWindow:"5000"}).toString();
 const signature=crypto.sign(null,Buffer.from(qs),privateKey).toString("base64");
 const url=`${BASE}${path}?${qs}&signature=${encodeURIComponent(signature)}`;
 const r=await fetch(url,{headers:{"X-MBX-APIKEY":apiKey}});
 const body=await r.json().catch(()=>({}));
 if(!r.ok) throw new Error(`BINANCE_HTTP_${r.status}: ${body.msg||"request failed"}`);
 return body;
}
export async function getSpotBalances(){
 const account=await signedGet("/api/v3/account",{omitZeroBalances:"true"});
 return (account.balances||[]).map(x=>({asset:x.asset,free:Number(x.free),locked:Number(x.locked),total:Number(x.free)+Number(x.locked)})).filter(x=>x.total>0);
}
export async function getApiPermissions(){
 const p=await signedGet("/sapi/v1/account/apiRestrictions");
 return {enableReading:Boolean(p.enableReading),enableWithdrawals:Boolean(p.enableWithdrawals),enableSpotAndMarginTrading:Boolean(p.enableSpotAndMarginTrading),ipRestrict:Boolean(p.ipRestrict)};
}

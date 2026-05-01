/**

- BingX AutoTrader Pro v5.0
  */
  'use strict';
  const crypto=require('crypto'),https=require('https'),http=require('http'),fs=require('fs');

const ENV={
BINGX_API_KEY:   process.env.BINGX_API_KEY||'',
BINGX_SECRET:    process.env.BINGX_SECRET_KEY||'',
TG_TOKEN:        process.env.TELEGRAM_TOKEN||'',
TG_CHAT:         process.env.TELEGRAM_CHAT_ID||'',
CLAUDE_KEY:      process.env.CLAUDE_API_KEY||'',
};

let cfg={
strategy:'AUTO',timeframe:'15m',
symbols:['BTC-USDT','ETH-USDT','SOL-USDT','AAPL-USD','TSLA-USD'],
tradeAmount:50,leverage:3,maxRiskPercent:10,
stopLossPercent:2.0,takeProfitPercent:5.0,
atrSLMultiple:1.5,atrTPMultiple:3.0,
allowShort:false,botRunning:false,
strategyWeights:{MA:1.0,RSI:1.0,MACD:1.0,BB:1.0,COMBO:1.0},
params:{fastPeriod:9,slowPeriod:21,rsiPeriod:14,oversold:30,overbought:70,bbPeriod:20,bbStdDev:2}
};

let stats=loadStats();
function loadStats(){if(fs.existsSync('./stats.json'))try{return JSON.parse(fs.readFileSync('./stats.json','utf8'));}catch(e){}return{allTime:{total:0,wins:0,losses:0,pnl:0},daily:{},trades:[],reports:[]};}
function saveStats(){fs.writeFileSync('./stats.json',JSON.stringify(stats,null,2));}
function todayKey(){return new Date().toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});}
function nowTW(){return new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei'});}
function hourTW(){return parseInt(new Date().toLocaleString('en-US',{timeZone:'Asia/Taipei',hour:'numeric',hour12:false}));}
function getDayStat(d){d=d||todayKey();if(!stats.daily[d])stats.daily[d]={total:0,wins:0,losses:0,pnl:0};return stats.daily[d];}
function recordTrade(t){const d=getDayStat();d.total++;t.pnl>0?d.wins++:d.losses++;d.pnl+=t.pnl;stats.allTime.total++;t.pnl>0?stats.allTime.wins++:stats.allTime.losses++;stats.allTime.pnl+=t.pnl;stats.trades.push({…t,date:todayKey()});if(stats.trades.length>500)stats.trades=stats.trades.slice(-500);saveStats();learnFromTrade(t);}

let brain=loadBrain();
function loadBrain(){if(fs.existsSync('./brain.json'))try{return JSON.parse(fs.readFileSync('./brain.json','utf8'));}catch(e){}return{strategyPerf:{MA:{wins:0,losses:0,pnl:0,fakeSig:0},RSI:{wins:0,losses:0,pnl:0,fakeSig:0},MACD:{wins:0,losses:0,pnl:0,fakeSig:0},BB:{wins:0,losses:0,pnl:0,fakeSig:0},COMBO:{wins:0,losses:0,pnl:0,fakeSig:0}},symbolPerf:{},hourPerf:{},errorPatterns:[],adjustHistory:[],marketRegime:'unknown',learnCount:0};}
function saveBrain(){fs.writeFileSync('./brain.json',JSON.stringify(brain,null,2));}

function learnFromTrade(t){
const{symbol,pnl,strategy,holdMin,reason,regime}=t;
brain.learnCount++;
const strat=strategy||'COMBO';
if(!brain.strategyPerf[strat])brain.strategyPerf[strat]={wins:0,losses:0,pnl:0,fakeSig:0};
const sp=brain.strategyPerf[strat];pnl>0?sp.wins++:sp.losses++;sp.pnl+=pnl;
if(!brain.symbolPerf[symbol])brain.symbolPerf[symbol]={wins:0,losses:0,pnl:0};
const syp=brain.symbolPerf[symbol];pnl>0?syp.wins++:syp.losses++;syp.pnl+=pnl;
const hr=String(hourTW());
if(!brain.hourPerf[hr])brain.hourPerf[hr]={wins:0,losses:0,pnl:0};
const hp=brain.hourPerf[hr];pnl>0?hp.wins++:hp.losses++;hp.pnl+=pnl;
if(pnl<0){sp.fakeSig++;brain.errorPatterns.push({symbol,strategy:strat,reason,holdMin,pnl,regime,hour:hourTW(),date:todayKey()});if(brain.errorPatterns.length>100)brain.errorPatterns=brain.errorPatterns.slice(-100);}
if(brain.learnCount%5===0)autoAdjustParams();
if(brain.learnCount%10===0)updateWeights();
saveBrain();
log('AI',pnl>0?'Learn: '+strat+' '+symbol+' profit':'Learn: '+strat+' '+symbol+' loss recorded');
}

function autoAdjustParams(){
const recent=stats.trades.slice(-20);if(recent.length<5)return;
const wins=recent.filter(t=>t.pnl>0),losses=recent.filter(t=>t.pnl<0);
const wr=wins.length/recent.length;
const avgWin=wins.length?wins.reduce((s,t)=>s+t.pnl,0)/wins.length:0;
const avgLoss=losses.length?Math.abs(losses.reduce((s,t)=>s+t.pnl,0)/losses.length):0;
const rr=avgLoss>0?avgWin/avgLoss:1;
const changes=[];
if(wr<0.4&&cfg.stopLossPercent>1.0){const o=cfg.stopLossPercent;cfg.stopLossPercent=+(Math.max(1.0,o-0.3)).toFixed(1);changes.push('SL '+o+'%->'+cfg.stopLossPercent+'% (low WR)');}
if(wr>0.65&&cfg.stopLossPercent<3.5){const o=cfg.stopLossPercent;cfg.stopLossPercent=+(Math.min(3.5,o+0.2)).toFixed(1);changes.push('SL '+o+'%->'+cfg.stopLossPercent+'% (high WR)');}
if(rr<1.5&&cfg.takeProfitPercent<10){const o=cfg.takeProfitPercent;cfg.takeProfitPercent=+(Math.min(10,o+0.5)).toFixed(1);changes.push('TP '+o+'%->'+cfg.takeProfitPercent+'% (low RR)');}
if(changes.length){
brain.adjustHistory.push({date:todayKey(),changes,wr:(wr*100).toFixed(1),rr:rr.toFixed(2)});
if(brain.adjustHistory.length>50)brain.adjustHistory=brain.adjustHistory.slice(-50);
log('AI','Auto adjust: '+changes.join(' | '));
tg('Auto Adjust\n'+changes.map(c=>'* '+c).join('\n')+'\nWR:'+( wr*100).toFixed(1)+'% RR:'+rr.toFixed(2));
}
}

function updateWeights(){
let changed=false;
for(const[s,p]of Object.entries(brain.strategyPerf)){
const t=p.wins+p.losses;if(t<3)continue;
const wr=p.wins/t,old=cfg.strategyWeights[s]||1.0;
let nw=old;
if(wr>0.6)nw=+(Math.min(2.0,old+0.1)).toFixed(2);
if(wr<0.35)nw=+(Math.max(0.2,old-0.15)).toFixed(2);
if(Math.abs(nw-old)>0.05){cfg.strategyWeights[s]=nw;changed=true;log('AI','Weight: '+s+' '+old+'->'+nw);}
}
if(changed)tg('Strategy Weights Updated\n'+Object.entries(cfg.strategyWeights).map(([k,v])=>k+': '+v).join('\n'));
}

function detectRegime(closes){
if(closes.length<30)return 'unknown';
const ma20=closes.slice(-20).reduce((s,v)=>s+v,0)/20,ma5=closes.slice(-5).reduce((s,v)=>s+v,0)/5;
const rets=[];for(let i=1;i<closes.length;i++)rets.push((closes[i]-closes[i-1])/closes[i-1]);
const std=Math.sqrt(rets.slice(-14).reduce((s,r)=>s+r*r,0)/14);
if(std>0.03)return 'volatile';
if(Math.abs(ma5-ma20)/ma20>0.02)return 'trend';
return 'ranging';
}

function selectBestStrategy(regime){
const map={trend:['MACD','MA'],ranging:['BB','RSI'],volatile:['RSI','BB'],unknown:['COMBO']};
const cands=map[regime]||['COMBO'];
let best=cands[0],bestScore=-Infinity;
for(const s of cands){const w=cfg.strategyWeights[s]||1.0,p=brain.strategyPerf[s]||{wins:0,losses:0};const t=p.wins+p.losses,wr=t>0?p.wins/t:0.5,score=w*wr;if(score>bestScore){bestScore=score;best=s;}}
return best;
}

function isBadPattern(symbol,strategy,hour){
const cnt=brain.errorPatterns.filter(p=>p.symbol===symbol&&p.strategy===strategy&&Math.abs(p.hour-hour)<=1).length;
return cnt>=3;
}

function isBadSymbol(symbol){
const p=brain.symbolPerf[symbol];if(!p)return false;
const t=p.wins+p.losses;if(t<5)return false;
return p.wins/t<0.25&&p.pnl<-50;
}

const memLog=[];
function log(lv,msg){console.log('['+nowTW()+']['+lv+'] '+msg);memLog.push({ts:nowTW(),lv,msg});if(memLog.length>300)memLog.shift();}

function sign(qs){return crypto.createHmac('sha256',ENV.BINGX_SECRET).update(qs).digest('hex');}
function buildQ(params){const p={…params,timestamp:Date.now()};const qs=Object.entries(p).filter(([,v])=>v!=null&&v!=='').map(([k,v])=>k+'='+encodeURIComponent(String(v))).join('&');return qs+'&signature='+sign(qs);}
function apiReq(method,path,params,tries){
params=params||{};tries=tries||3;
return new Promise((res,rej)=>{
const q=buildQ(params);
const opt={hostname:'open-api.bingx.com',path:method==='GET'?path+'?'+q:path,method:method,headers:{'X-BX-APIKEY':ENV.BINGX_API_KEY,'Content-Type':'application/x-www-form-urlencoded'}};
const go=function(n){
const r=https.request(opt,function(rsp){let d='';rsp.on('data',function(c){d+=c;});rsp.on('end',function(){try{res(JSON.parse(d));}catch(e){rej(new Error(d.slice(0,80)));}});});
r.on('error',function(e){if(n>1)setTimeout(function(){go(n-1);},2000);else rej(e);});
r.setTimeout(12000,function(){r.destroy();if(n>1)setTimeout(function(){go(n-1);},2000);else rej(new Error('Timeout'));});
if(method==='POST')r.write(q);r.end();
};
go(tries);
});
}

async function getBalance(){
try{const r=await apiReq('GET','/openApi/swap/v2/user/balance');if(r.code===0)return{available:parseFloat(r.data.balance.availableMargin||0),total:parseFloat(r.data.balance.balance||0),unrealPnl:parseFloat(r.data.balance.unrealizedProfit||0)};}catch(e){}
try{const r=await apiReq('GET','/openApi/spot/v1/account/balance');if(r.code===0){const u=r.data.balances.find(function(b){return b.asset==='USDT';})||{};return{available:parseFloat(u.free||0),total:parseFloat(u.free||0)+parseFloat(u.locked||0),unrealPnl:0};}}catch(e){}
throw new Error('Cannot get balance');
}
async function getPositions(sym){sym=sym||'';try{const r=await apiReq('GET','/openApi/swap/v2/user/positions',sym?{symbol:sym}:{});if(r.code===0)return(r.data||[]).filter(function(p){return parseFloat(p.positionAmt||0)!==0;});}catch(e){}return[];}
async function getKlines(sym,iv,lim){lim=lim||150;try{const r=await apiReq('GET','/openApi/swap/v2/quote/klines',{symbol:sym,interval:iv,limit:lim});if(r.code===0&&Array.isArray(r.data))return r.data;}catch(e){log('WARN','Kline fail '+sym);}return[];}
async function getTicker(sym){try{const r=await apiReq('GET','/openApi/swap/v2/quote/ticker',{symbol:sym});if(r.code===0)return r.data;}catch(e){}return null;}
async function setLev(sym,lev){for(const s of['LONG','SHORT'])try{await apiReq('POST','/openApi/swap/v2/trade/leverage',{symbol:sym,side:s,leverage:lev});}catch(e){}}

async function placeOrder(o){
if(cfg.leverage>1)await setLev(o.symbol,cfg.leverage);
const p={symbol:o.symbol,side:o.side,positionSide:o.positionSide||'LONG',type:'MARKET',quantity:String(o.quantity)};
if(o.stopLoss)p.stopLoss=JSON.stringify({type:'STOP_MARKET',stopPrice:String(o.stopLoss),workingType:'MARK_PRICE',closePosition:'true'});
if(o.takeProfit)p.takeProfit=JSON.stringify({type:'TAKE_PROFIT_MARKET',stopPrice:String(o.takeProfit),workingType:'MARK_PRICE',closePosition:'true'});
log('INFO','Order '+o.side+' '+o.symbol+' x'+o.quantity);
const r=await apiReq('POST','/openApi/swap/v2/trade/order',p);
if(r.code===0){log('OK','Order OK '+o.side+' '+o.symbol);tg('Order OK\n'+(o.side==='BUY'?'LONG':'SELL')+' '+o.symbol+'\nQty:'+o.quantity+' SL:'+(o.stopLoss
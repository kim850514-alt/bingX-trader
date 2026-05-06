‘use strict’;
const crypto=require(‘crypto’),https=require(‘https’),http=require(‘http’),fs=require(‘fs’);
const ENV={
BINGX_API_KEY:process.env.BINGX_API_KEY||’’,
BINGX_SECRET:process.env.BINGX_SECRET_KEY||’’,
TG_TOKEN:process.env.TELEGRAM_TOKEN||’’,
TG_CHAT:process.env.TELEGRAM_CHAT_ID||’’
};
let cfg={
timeframe:‘5m’,
symbols:[‘BTC-USDT’,‘ETH-USDT’,‘SOL-USDT’],
tradeAmount:50,leverage:3,maxRiskPercent:10,
stopLossPercent:2.0,takeProfitPercent:5.0,
allowShort:true,botRunning:false,
maxPositions:999,
entryThreshold:2,
maxHoldMin:60,
learnBatchSize:3,
params:{rsiPeriod:7,oversold:35,overbought:65,volMultiple:1.3,bbPeriod:15,bbStdDev:2}
};
let stats=loadStats();
function loadStats(){if(fs.existsSync(’./bingx_stats.json’))try{return JSON.parse(fs.readFileSync(’./bingx_stats.json’,‘utf8’));}catch(e){}return{allTime:{total:0,wins:0,losses:0,pnl:0},daily:{},trades:[]};}
function saveStats(){fs.writeFileSync(’./bingx_stats.json’,JSON.stringify(stats,null,2));}
function todayKey(){return new Date().toLocaleDateString(‘zh-TW’,{timeZone:‘Asia/Taipei’});}
function nowTW(){return new Date().toLocaleString(‘zh-TW’,{timeZone:‘Asia/Taipei’});}
function hourTW(){return parseInt(new Date().toLocaleString(‘en-US’,{timeZone:‘Asia/Taipei’,hour:‘numeric’,hour12:false}));}
function getDayStat(d){d=d||todayKey();if(!stats.daily[d])stats.daily[d]={total:0,wins:0,losses:0,pnl:0};return stats.daily[d];}
function recordTrade(t){
var d=getDayStat();d.total++;if(t.pnl>0)d.wins++;else d.losses++;d.pnl+=t.pnl;
stats.allTime.total++;if(t.pnl>0)stats.allTime.wins++;else stats.allTime.losses++;stats.allTime.pnl+=t.pnl;
stats.trades.push(Object.assign({},t,{date:todayKey()}));
if(stats.trades.length>500)stats.trades=stats.trades.slice(-500);
saveStats();
learnCycleCount++;
learnFromTrade(t);
if(learnCycleCount>=cfg.learnBatchSize){
learnCycleCount=0;learningPause=true;
log(‘AI’,’=== 學習週期觸發！暫停交易，開始分析 ===’);
tg(’[BingX 🧠] 學習週期開始\n已完成 ‘+cfg.learnBatchSize+’ 筆交易\n暫停開新倉，分析中…’);
autoAdjust();
setTimeout(function(){learningPause=false;log(‘AI’,’=== 學習完成！恢復交易 ===’);tg(’[BingX 🧠] 學習完成！恢復交易\n下一批：’+cfg.learnBatchSize+‘筆’);},3000);
}
}
let brain=loadBrain();
var learnCycleCount=0,learningPause=false;
function loadBrain(){if(fs.existsSync(’./bingx_brain.json’))try{return JSON.parse(fs.readFileSync(’./bingx_brain.json’,‘utf8’));}catch(e){}return{symbolPerf:{},hourPerf:{},errorPatterns:[],adjustHistory:[],learnCount:0,bestHours:[],worstHours:[],bestSymbols:[],worstSymbols:[],entryThresholdHistory:[]};}
function saveBrain(){fs.writeFileSync(’./bingx_brain.json’,JSON.stringify(brain,null,2));}

function learnFromTrade(t){
brain.learnCount++;
var symbol=t.symbol,pnl=t.pnl,holdMin=t.holdMin;
if(!brain.symbolPerf[symbol])brain.symbolPerf[symbol]={wins:0,losses:0,pnl:0,avgHold:0,count:0};
var sp=brain.symbolPerf[symbol];
if(pnl>0)sp.wins++;else sp.losses++;sp.pnl+=pnl;sp.count++;
sp.avgHold=((sp.avgHold*(sp.count-1))+holdMin)/sp.count;
var hr=String(hourTW());
if(!brain.hourPerf[hr])brain.hourPerf[hr]={wins:0,losses:0,pnl:0};
var hp=brain.hourPerf[hr];if(pnl>0)hp.wins++;else hp.losses++;hp.pnl+=pnl;
if(pnl<0){brain.errorPatterns.push({symbol:symbol,pnl:pnl,holdMin:holdMin,hour:hourTW(),date:todayKey()});if(brain.errorPatterns.length>100)brain.errorPatterns=brain.errorPatterns.slice(-100);}
updateBestWorst();saveBrain();
log(‘AI’,pnl>0?symbol+’ 獲利 +’+pnl.toFixed(2)+‘U (hold:’+holdMin+‘min)’:symbol+’ 虧損 ’+pnl.toFixed(2)+‘U (hold:’+holdMin+‘min)’);
}

function autoAdjust(){
var recent=stats.trades.slice(-20);if(recent.length<3)return;
var wins=recent.filter(function(t){return t.pnl>0;});
var losses=recent.filter(function(t){return t.pnl<0;});
var wr=wins.length/recent.length;
var avgWin=wins.length?wins.reduce(function(s,t){return s+t.pnl;},0)/wins.length:0;
var avgLoss=losses.length?Math.abs(losses.reduce(function(s,t){return s+t.pnl;},0)/losses.length):0;
var rr=avgLoss>0?avgWin/avgLoss:1;
var avgHold=recent.reduce(function(s,t){return s+(t.holdMin||0);},0)/recent.length;
var changes=[];
if(wr<0.4&&cfg.stopLossPercent>1.0){var o=cfg.stopLossPercent;cfg.stopLossPercent=+(Math.max(1.0,o-0.2)).toFixed(1);changes.push(‘SL 收緊 ‘+o+’->’+cfg.stopLossPercent+’%’);}
if(wr>0.6&&cfg.stopLossPercent<3.5){var o2=cfg.stopLossPercent;cfg.stopLossPercent=+(Math.min(3.5,o2+0.2)).toFixed(1);changes.push(‘SL 放寬 ‘+o2+’->’+cfg.stopLossPercent+’%’);}
if(rr<1.5&&cfg.takeProfitPercent<12){var o3=cfg.takeProfitPercent;cfg.takeProfitPercent=+(Math.min(12,o3+0.5)).toFixed(1);changes.push(‘TP 提高 ‘+o3+’->’+cfg.takeProfitPercent+’%’);}
if(rr>3.0&&cfg.takeProfitPercent>3.0){var o4=cfg.takeProfitPercent;cfg.takeProfitPercent=+(Math.max(3.0,o4-0.3)).toFixed(1);changes.push(‘TP 降低 ‘+o4+’->’+cfg.takeProfitPercent+’%’);}
// ✅ 修復：– 符號（原本是中文破折號 –）
if(wr<0.35&&cfg.entryThreshold<5){cfg.entryThreshold++;changes.push(‘門檻提高 ->’+cfg.entryThreshold);}
if(wr>0.65&&cfg.entryThreshold>1){cfg.entryThreshold–;changes.push(‘門檻降低 ->’+cfg.entryThreshold);}
// 超時調整
var toTrades=recent.filter(function(t){return t.reason===‘超時平倉’;});
if(toTrades.length>=2){var toWr=toTrades.filter(function(t){return t.pnl>0;}).length/toTrades.length;if(toWr<0.3&&cfg.maxHoldMin>15){var ot=cfg.maxHoldMin;cfg.maxHoldMin=Math.max(15,ot-10);changes.push(‘超時 縮短 ‘+ot+’->’+cfg.maxHoldMin+‘min’);}if(toWr>0.6&&cfg.maxHoldMin<180){var ot2=cfg.maxHoldMin;cfg.maxHoldMin=Math.min(180,ot2+10);changes.push(‘超時 延長 ‘+ot2+’->’+cfg.maxHoldMin+‘min’);}}
// RSI 調整
if(wr<0.38&&cfg.params.oversold>20){var rv=cfg.params.oversold;cfg.params.oversold=Math.max(20,rv-3);changes.push(‘RSI超賣 收緊 ‘+rv+’->’+cfg.params.oversold);}
if(wr<0.38&&cfg.params.overbought<80){var rv2=cfg.params.overbought;cfg.params.overbought=Math.min(80,rv2+3);changes.push(‘RSI超買 收緊 ‘+rv2+’->’+cfg.params.overbought);}
if(wr>0.62&&cfg.params.oversold<45){var rv3=cfg.params.oversold;cfg.params.oversold=Math.min(45,rv3+2);changes.push(‘RSI超賣 放寬 ‘+rv3+’->’+cfg.params.oversold);}
if(wr>0.62&&cfg.params.overbought>55){var rv4=cfg.params.overbought;cfg.params.overbought=Math.max(55,rv4-2);changes.push(‘RSI超買 放寬 ‘+rv4+’->’+cfg.params.overbought);}
if(wr<0.4&&avgHold<10&&cfg.params.rsiPeriod>5){var rp=cfg.params.rsiPeriod;cfg.params.rsiPeriod=Math.max(5,rp-1);changes.push(‘RSI週期 縮短 ‘+rp+’->’+cfg.params.rsiPeriod);}
if(wr<0.4&&avgHold>30&&cfg.params.rsiPeriod<21){var rp2=cfg.params.rsiPeriod;cfg.params.rsiPeriod=Math.min(21,rp2+1);changes.push(‘RSI週期 延長 ‘+rp2+’->’+cfg.params.rsiPeriod);}
// BB 調整
if(wr<0.38&&cfg.params.bbStdDev<2.8){var bv=cfg.params.bbStdDev;cfg.params.bbStdDev=+(Math.min(2.8,bv+0.1)).toFixed(1);changes.push(‘BB寬度 加寬 ‘+bv+’->’+cfg.params.bbStdDev);}
if(wr>0.62&&cfg.params.bbStdDev>1.5){var bv2=cfg.params.bbStdDev;cfg.params.bbStdDev=+(Math.max(1.5,bv2-0.1)).toFixed(1);changes.push(‘BB寬度 收窄 ‘+bv2+’->’+cfg.params.bbStdDev);}
// 量能調整
if(wr<0.38&&cfg.params.volMultiple<1.8){var vv=cfg.params.volMultiple;cfg.params.volMultiple=+(Math.min(1.8,vv+0.1)).toFixed(1);changes.push(‘量能 提高 ‘+vv+’->’+cfg.params.volMultiple);}
if(wr>0.62&&cfg.params.volMultiple>1.0){var vv2=cfg.params.volMultiple;cfg.params.volMultiple=+(Math.max(1.0,vv2-0.1)).toFixed(1);changes.push(‘量能 降低 ‘+vv2+’->’+cfg.params.volMultiple);}
if(changes.length){
brain.adjustHistory.push({date:todayKey(),changes:changes,wr:(wr*100).toFixed(1),rr:rr.toFixed(2),avgHold:avgHold.toFixed(0)});
if(brain.adjustHistory.length>100)brain.adjustHistory=brain.adjustHistory.slice(-100);
log(‘AI’,‘自動調整: ‘+changes.join(’ | ‘));
tg(’[BingX 🧠 自動調整]\n’+changes.join(’\n’)+’\nWR:’+(wr*100).toFixed(1)+’% RR:’+rr.toFixed(2)+’\n持倉均時:’+avgHold.toFixed(0)+‘min’);
}
}

function updateBestWorst(){
brain.bestHours=Object.keys(brain.hourPerf).filter(function(h){var p=brain.hourPerf[h];var t=p.wins+p.losses;return t>=3&&p.wins/t>=0.6;});
brain.worstHours=Object.keys(brain.hourPerf).filter(function(h){var p=brain.hourPerf[h];var t=p.wins+p.losses;return t>=3&&p.wins/t<0.35;});
brain.bestSymbols=Object.keys(brain.symbolPerf).filter(function(s){var p=brain.symbolPerf[s];var t=p.wins+p.losses;return t>=3&&p.wins/t>=0.55;});
brain.worstSymbols=Object.keys(brain.symbolPerf).filter(function(s){var p=brain.symbolPerf[s];var t=p.wins+p.losses;return t>=5&&p.wins/t<0.25&&p.pnl<-30;});
}

var memLog=[];
function log(lv,msg){console.log(’[’+nowTW()+’][BX][’+lv+’] ’+msg);memLog.push({ts:nowTW(),lv:lv,msg:msg});if(memLog.length>300)memLog.shift();}

// ══════════════════════════════════
// BingX API
// ══════════════════════════════════
function bxSign(qs){return crypto.createHmac(‘sha256’,ENV.BINGX_SECRET).update(qs).digest(‘hex’);}
function bxBuildQ(params){
var p=Object.assign({},params,{timestamp:Date.now()});
var qs=Object.keys(p).sort().filter(function(k){return p[k]!=null&&p[k]!==’’;}).map(function(k){return k+’=’+p[k];}).join(’&’);
var sig=bxSign(qs);
return qs+’&signature=’+sig;
}
function bxReq(method,path,params,tries){
params=params||{};tries=tries||3;
return new Promise(function(resolve,reject){
var q=bxBuildQ(params);
var opt={hostname:‘open-api.bingx.com’,path:method===‘GET’?path+’?’+q:path,method:method,headers:{‘X-BX-APIKEY’:ENV.BINGX_API_KEY,‘Content-Type’:‘application/x-www-form-urlencoded’}};
var go=function(n){
var req=https.request(opt,function(rsp){var d=’’;rsp.on(‘data’,function(c){d+=c;});rsp.on(‘end’,function(){try{resolve(JSON.parse(d));}catch(e){reject(new Error(d.slice(0,80)));}});});
req.on(‘error’,function(e){if(n>1)setTimeout(function(){go(n-1);},2000);else reject(e);});
req.setTimeout(12000,function(){req.destroy();if(n>1)setTimeout(function(){go(n-1);},2000);else reject(new Error(‘Timeout’));});
if(method===‘POST’)req.write(q);req.end();
};
go(tries);
});
}

async function getBalance(){
try{
var r=await bxReq(‘GET’,’/openApi/swap/v2/user/balance’);
if(r.code===0&&r.data&&r.data.balance){
return{
available:parseFloat(r.data.balance.availableMargin||0),
total:parseFloat(r.data.balance.balance||0),
unrealPnl:parseFloat(r.data.balance.unrealizedProfit||0)
};
}
// ✅ 新增：印出完整錯誤訊息方便排查
log(‘ERROR’,‘getBalance 回應: code=’+r.code+’ msg=’+r.msg);
}catch(

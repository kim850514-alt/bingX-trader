"use strict";
const crypto=require('crypto'),https=require('https'),http=require('http'),fs=require('fs');
const ENV={
  BINGX_API_KEY:process.env.BINGX_API_KEY||'',
  BINGX_SECRET:process.env.BINGX_SECRET_KEY||'',
  TG_TOKEN:process.env.TELEGRAM_TOKEN||'',
  TG_CHAT:process.env.TELEGRAM_CHAT_ID||''
};
let cfg={
  timeframe:'5m',
  symbols:['BTC-USDT','ETH-USDT','SOL-USDT'],
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
function loadStats(){if(fs.existsSync('./bingx_stats.json'))try{return JSON.parse(fs.readFileSync('./bingx_stats.json','utf8'));}catch(e){}return{allTime:{total:0,wins:0,losses:0,pnl:0},daily:{},trades:[]};}
function saveStats(){fs.writeFileSync('./bingx_stats.json',JSON.stringify(stats,null,2));}
function todayKey(){return new Date().toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});}
function nowTW(){return new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei'});}
function hourTW(){return parseInt(new Date().toLocaleString('en-US',{timeZone:'Asia/Taipei',hour:'numeric',hour12:false}));}
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
    log('AI','=== 學習週期觸發！暫停交易，開始分析 ===');
    tg('[BingX 🧠] 學習週期開始\n已完成 '+cfg.learnBatchSize+' 筆交易\n暫停開新倉，分析中...');
    autoAdjust();
    setTimeout(function(){learningPause=false;log('AI','=== 學習完成！恢復交易 ===');tg('[BingX 🧠] 學習完成！恢復交易\n下一批：'+cfg.learnBatchSize+'筆');},3000);
  }
}
let brain=loadBrain();
var learnCycleCount=0,learningPause=false;
function loadBrain(){if(fs.existsSync('./bingx_brain.json'))try{return JSON.parse(fs.readFileSync('./bingx_brain.json','utf8'));}catch(e){}return{symbolPerf:{},hourPerf:{},errorPatterns:[],adjustHistory:[],learnCount:0,bestHours:[],worstHours:[],bestSymbols:[],worstSymbols:[],entryThresholdHistory:[]};}
function saveBrain(){fs.writeFileSync('./bingx_brain.json',JSON.stringify(brain,null,2));}

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
  log('AI',pnl>0?symbol+' 獲利 +'+pnl.toFixed(2)+'U (hold:'+holdMin+'min)':symbol+' 虧損 '+pnl.toFixed(2)+'U (hold:'+holdMin+'min)');
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
  if(wr<0.4&&cfg.stopLossPercent>1.0){var o=cfg.stopLossPercent;cfg.stopLossPercent=+(Math.max(1.0,o-0.2)).toFixed(1);changes.push('SL 收緊 '+o+'->'+cfg.stopLossPercent+'%');}
  if(wr>0.6&&cfg.stopLossPercent<3.5){var o2=cfg.stopLossPercent;cfg.stopLossPercent=+(Math.min(3.5,o2+0.2)).toFixed(1);changes.push('SL 放寬 '+o2+'->'+cfg.stopLossPercent+'%');}
  if(rr<1.5&&cfg.takeProfitPercent<12){var o3=cfg.takeProfitPercent;cfg.takeProfitPercent=+(Math.min(12,o3+0.5)).toFixed(1);changes.push('TP 提高 '+o3+'->'+cfg.takeProfitPercent+'%');}
  if(rr>3.0&&cfg.takeProfitPercent>3.0){var o4=cfg.takeProfitPercent;cfg.takeProfitPercent=+(Math.max(3.0,o4-0.3)).toFixed(1);changes.push('TP 降低 '+o4+'->'+cfg.takeProfitPercent+'%');}
  if(wr<0.35&&cfg.entryThreshold<5){cfg.entryThreshold++;changes.push('門檻提高 ->'+cfg.entryThreshold);}
  if(wr>0.65&&cfg.entryThreshold>1){cfg.entryThreshold--;changes.push('門檻降低 ->'+cfg.entryThreshold);}
  // 超時調整
  var toTrades=recent.filter(function(t){return t.reason==='超時平倉';});
  if(toTrades.length>=2){var toWr=toTrades.filter(function(t){return t.pnl>0;}).length/toTrades.length;if(toWr<0.3&&cfg.maxHoldMin>15){var ot=cfg.maxHoldMin;cfg.maxHoldMin=Math.max(15,ot-10);changes.push('超時 縮短 '+ot+'->'+cfg.maxHoldMin+'min');}if(toWr>0.6&&cfg.maxHoldMin<180){var ot2=cfg.maxHoldMin;cfg.maxHoldMin=Math.min(180,ot2+10);changes.push('超時 延長 '+ot2+'->'+cfg.maxHoldMin+'min');}}
  // RSI 調整
  if(wr<0.38&&cfg.params.oversold>20){var rv=cfg.params.oversold;cfg.params.oversold=Math.max(20,rv-3);changes.push('RSI超賣 收緊 '+rv+'->'+cfg.params.oversold);}
  if(wr<0.38&&cfg.params.overbought<80){var rv2=cfg.params.overbought;cfg.params.overbought=Math.min(80,rv2+3);changes.push('RSI超買 收緊 '+rv2+'->'+cfg.params.overbought);}
  if(wr>0.62&&cfg.params.oversold<45){var rv3=cfg.params.oversold;cfg.params.oversold=Math.min(45,rv3+2);changes.push('RSI超賣 放寬 '+rv3+'->'+cfg.params.oversold);}
  if(wr>0.62&&cfg.params.overbought>55){var rv4=cfg.params.overbought;cfg.params.overbought=Math.max(55,rv4-2);changes.push('RSI超買 放寬 '+rv4+'->'+cfg.params.overbought);}
  if(wr<0.4&&avgHold<10&&cfg.params.rsiPeriod>5){var rp=cfg.params.rsiPeriod;cfg.params.rsiPeriod=Math.max(5,rp-1);changes.push('RSI週期 縮短 '+rp+'->'+cfg.params.rsiPeriod);}
  if(wr<0.4&&avgHold>30&&cfg.params.rsiPeriod<21){var rp2=cfg.params.rsiPeriod;cfg.params.rsiPeriod=Math.min(21,rp2+1);changes.push('RSI週期 延長 '+rp2+'->'+cfg.params.rsiPeriod);}
  // BB 調整
  if(wr<0.38&&cfg.params.bbStdDev<2.8){var bv=cfg.params.bbStdDev;cfg.params.bbStdDev=+(Math.min(2.8,bv+0.1)).toFixed(1);changes.push('BB寬度 加寬 '+bv+'->'+cfg.params.bbStdDev);}
  if(wr>0.62&&cfg.params.bbStdDev>1.5){var bv2=cfg.params.bbStdDev;cfg.params.bbStdDev=+(Math.max(1.5,bv2-0.1)).toFixed(1);changes.push('BB寬度 收窄 '+bv2+'->'+cfg.params.bbStdDev);}
  // 量能調整
  if(wr<0.38&&cfg.params.volMultiple<1.8){var vv=cfg.params.volMultiple;cfg.params.volMultiple=+(Math.min(1.8,vv+0.1)).toFixed(1);changes.push('量能 提高 '+vv+'->'+cfg.params.volMultiple);}
  if(wr>0.62&&cfg.params.volMultiple>1.0){var vv2=cfg.params.volMultiple;cfg.params.volMultiple=+(Math.max(1.0,vv2-0.1)).toFixed(1);changes.push('量能 降低 '+vv2+'->'+cfg.params.volMultiple);}
  if(changes.length){
    brain.adjustHistory.push({date:todayKey(),changes:changes,wr:(wr*100).toFixed(1),rr:rr.toFixed(2),avgHold:avgHold.toFixed(0)});
    if(brain.adjustHistory.length>100)brain.adjustHistory=brain.adjustHistory.slice(-100);
    log('AI','自動調整: '+changes.join(' | '));
    tg('[BingX 🧠 自動調整]\n'+changes.join('\n')+'\nWR:'+(wr*100).toFixed(1)+'% RR:'+rr.toFixed(2)+'\n持倉均時:'+avgHold.toFixed(0)+'min');
  }
}

function updateBestWorst(){
  brain.bestHours=Object.keys(brain.hourPerf).filter(function(h){var p=brain.hourPerf[h];var t=p.wins+p.losses;return t>=3&&p.wins/t>=0.6;});
  brain.worstHours=Object.keys(brain.hourPerf).filter(function(h){var p=brain.hourPerf[h];var t=p.wins+p.losses;return t>=3&&p.wins/t<0.35;});
  brain.bestSymbols=Object.keys(brain.symbolPerf).filter(function(s){var p=brain.symbolPerf[s];var t=p.wins+p.losses;return t>=3&&p.wins/t>=0.55;});
  brain.worstSymbols=Object.keys(brain.symbolPerf).filter(function(s){var p=brain.symbolPerf[s];var t=p.wins+p.losses;return t>=5&&p.wins/t<0.25&&p.pnl<-30;});
}

var memLog=[];
function log(lv,msg){console.log('['+nowTW()+'][BX]['+lv+'] '+msg);memLog.push({ts:nowTW(),lv:lv,msg:msg});if(memLog.length>300)memLog.shift();}

// ══════════════════════════════════
// BingX API
// ══════════════════════════════════
function bxSign(qs){return crypto.createHmac('sha256',ENV.BINGX_SECRET).update(qs).digest('hex');}
function bxBuildQ(params){
  var p=Object.assign({},params,{timestamp:Date.now()});
  // BingX 簽名：不排序，直接組合
  var qs=Object.keys(p).filter(function(k){return p[k]!=null&&p[k]!=='';}).map(function(k){return k+'='+p[k];}).join('&');
  var sig=bxSign(qs);
  return qs+'&signature='+sig;
}
function bxReq(method,path,params,tries){
  params=params||{};tries=tries||3;
  return new Promise(function(resolve,reject){
    var q=bxBuildQ(params);
    var opt={hostname:'open-api.bingx.com',path:method==='GET'?path+'?'+q:path,method:method,headers:{'X-BX-APIKEY':ENV.BINGX_API_KEY,'Content-Type':'application/x-www-form-urlencoded'}};
    var go=function(n){
      var req=https.request(opt,function(rsp){var d='';rsp.on('data',function(c){d+=c;});rsp.on('end',function(){try{resolve(JSON.parse(d));}catch(e){reject(new Error(d.slice(0,80)));}});});
      req.on('error',function(e){if(n>1)setTimeout(function(){go(n-1);},2000);else reject(e);});
      req.setTimeout(12000,function(){req.destroy();if(n>1)setTimeout(function(){go(n-1);},2000);else reject(new Error('Timeout'));});
      if(method==='POST')req.write(q);req.end();
    };
    go(tries);
  });
}

async function getBalance(){
  try{var r=await bxReq('GET','/openApi/swap/v2/user/balance');if(r.code===0)return{available:parseFloat(r.data.balance.availableMargin||0),total:parseFloat(r.data.balance.balance||0),unrealPnl:parseFloat(r.data.balance.unrealizedProfit||0)};}catch(e){}
  throw new Error('Cannot get BingX balance');
}
async function getPositions(sym){sym=sym||'';try{var r=await bxReq('GET','/openApi/swap/v2/user/positions',sym?{symbol:sym}:{});if(r.code===0)return(r.data||[]).filter(function(p){return parseFloat(p.positionAmt||0)!==0;});}catch(e){}return[];}
async function getKlines(sym,iv,lim){
  lim=lim||150;
  // BingX 時間框格式轉換
  var bxIv={'1m':'1m','3m':'3m','5m':'5m','15m':'15m','1h':'1h','4h':'4h'}[iv]||'5m';
  try{var r=await bxReq('GET','/openApi/swap/v2/quote/klines',{symbol:sym,interval:bxIv,limit:lim});if(r.code===0&&Array.isArray(r.data))return r.data;}catch(e){log('WARN','Kline fail '+sym+': '+e.message);}return[];
}
async function getTicker(sym){try{var r=await bxReq('GET','/openApi/swap/v2/quote/ticker',{symbol:sym});if(r.code===0)return r.data;}catch(e){}return null;}
async function setLev(sym,lev){var sides=['LONG','SHORT'];for(var i=0;i<sides.length;i++){try{await bxReq('POST','/openApi/swap/v2/trade/leverage',{symbol:sym,side:sides[i],leverage:lev});}catch(e){}}}

async function placeOrder(o){
  if(cfg.leverage>1)await setLev(o.symbol,cfg.leverage);
  var p={symbol:o.symbol,side:o.side,positionSide:o.positionSide||'LONG',type:'MARKET',quantity:String(o.quantity)};
  log('INFO','下單 '+o.side+' '+o.symbol+' x'+o.quantity+' SL:'+o.stopLoss+' TP:'+o.takeProfit);
  var r=await bxReq('POST','/openApi/swap/v2/trade/order',p);
  if(r.code===0){
    var ps=o.positionSide||'LONG';
    var closeSide=ps==='LONG'?'SELL':'BUY';
    // 獨立止損單
    if(o.stopLoss){try{await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:o.symbol,side:closeSide,positionSide:ps,type:'STOP_MARKET',stopPrice:String(o.stopLoss),quantity:String(o.quantity),workingType:'MARK_PRICE'});log('OK','止損設定 '+o.stopLoss);}catch(e){log('WARN','止損失敗: '+e.message);}}
    // 獨立止盈單
    if(o.takeProfit){try{await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:o.symbol,side:closeSide,positionSide:ps,type:'TAKE_PROFIT_MARKET',stopPrice:String(o.takeProfit),quantity:String(o.quantity),workingType:'MARK_PRICE'});log('OK','止盈設定 '+o.takeProfit);}catch(e){log('WARN','止盈失敗: '+e.message);}}
    log('OK','開單成功 '+o.side+' '+o.symbol);
    tg('[BingX] ✅ 開單成功\n'+(o.side==='BUY'?'🟢 多單':'🔴 空單')+' '+o.symbol+'\n數量:'+o.quantity+'\nSL:'+o.stopLoss+'\nTP:'+o.takeProfit);
    return r.data.order;
  }else{
    log('ERROR','開單失敗 ['+r.code+'] '+r.msg);
    tg('[BingX] ❌ 開單失敗\n'+o.symbol+'\n['+r.code+'] '+r.msg);
    return null;
  }
}
// ✅ 從 BingX API 抓實際盈虧（含手續費）
async function getActualPnlBX(symbol,openTime){
  try{
    var r=await bxReq('GET','/openApi/swap/v2/trade/allOrders',{symbol:symbol,limit:10});
    if(r.code===0&&r.data&&r.data.orders&&r.data.orders.length>0){
      var orders=r.data.orders.filter(function(o){
        return o.status==='FILLED'&&parseInt(o.time||o.updateTime||0)>openTime&&(o.side==='SELL'||o.positionSide==='SHORT');
      });
      if(orders.length>0){
        var latest=orders[0];
        var profit=parseFloat(latest.profit||0);
        var commission=parseFloat(latest.commission||0);
        var pnlNet=profit+commission; // commission 通常是負數
        log('INFO','BingX API實際PnL: profit='+profit+' commission='+commission+' net='+pnlNet.toFixed(4)+'U');
        return{pnl:pnlNet,exitPrice:parseFloat(latest.avgPrice||0),source:'api'};
      }
    }
  }catch(e){log('WARN','getActualPnlBX: '+e.message);}
  return null;
}

// 數量步進
function getQtyStep(price){
  if(price>=10000)return 0.001;
  if(price>=1000)return 0.01;
  if(price>=100)return 0.1;
  if(price>=1)return 1;
  if(price>=0.001)return 10;
  return 100;
}
function roundQty(qty,step){return Math.floor(qty/step)*step;}

// ══════════════════════════════════
// 技術指標（與 Bybit 海馬完全相同）
// ══════════════════════════════════
var I={
  ma:function(a,n){if(a.length<n)return null;return a.slice(-n).reduce(function(s,v){return s+v;},0)/n;},
  ema:function(a,n){if(a.length<n)return null;var k=2/(n+1),ema=a.slice(0,n).reduce(function(s,v){return s+v;},0)/n;for(var i=n;i<a.length;i++)ema=a[i]*k+ema*(1-k);return ema;},
  rsi:function(a,n){n=n||14;if(a.length<n+1)return null;var g=0,l=0;for(var i=a.length-n;i<a.length;i++){var d=a[i]-a[i-1];if(d>0)g+=d;else l-=d;}return 100-100/(1+g/(l||0.0001));},
  boll:function(a,n,d){n=n||20;d=d||2;if(a.length<n)return null;var sl=a.slice(-n),m=sl.reduce(function(s,v){return s+v;},0)/n,std=Math.sqrt(sl.reduce(function(s,v){return s+Math.pow(v-m,2);},0)/n);return{upper:m+d*std,mid:m,lower:m-d*std};},
  atr:function(h,l,c,n){n=n||14;if(c.length<n+1)return null;var tr=[];for(var i=1;i<c.length;i++)tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));return tr.slice(-n).reduce(function(s,v){return s+v;},0)/n;},
  macd:function(a){if(a.length<26)return null;var fast=I.ema(a,12),slow=I.ema(a,26);if(!fast||!slow)return null;return{hist:fast-slow};}
};

async function runSeahorse(sym){
  var hourPenalty=0;
  var hr=String(hourTW());
  if(brain.worstHours.includes(hr)){hourPenalty=1;log('AI','差時段 '+hr+'時，扣1分繼續');}
  if(brain.worstSymbols.includes(sym)){log('AI',sym+' 迴避品種，跳過');return null;}

  log('INFO',sym+' 開始掃描...');
  var kl=await getKlines(sym,cfg.timeframe,150);
  log('INFO',sym+' K線數量:'+kl.length);
  if(kl.length<50){log('WARN',sym+' K線不足');return null;}

  var closes=kl.map(function(k){return parseFloat(k[4]);});
  var highs=kl.map(function(k){return parseFloat(k[2]);});
  var lows=kl.map(function(k){return parseFloat(k[3]);});
  var vols=kl.map(function(k){return parseFloat(k[5]);});
  var last=closes[closes.length-1],p=cfg.params;
  var bs=0,ss=0,rsn=[];

  // RSI
  var rsi=I.rsi(closes,p.rsiPeriod||7),rsiPrev=I.rsi(closes.slice(0,-1),p.rsiPeriod||7);
  if(rsi!==null&&rsiPrev!==null){
    if(rsiPrev<p.oversold&&rsi>p.oversold){bs+=3;rsn.push('RSI回升('+rsi.toFixed(0)+')');}
    if(rsiPrev>p.overbought&&rsi<p.overbought){ss+=3;rsn.push('RSI回落('+rsi.toFixed(0)+')');}
    if(rsi<50){bs+=1;rsn.push('RSI<50('+rsi.toFixed(0)+')');}else{ss+=1;rsn.push('RSI>50('+rsi.toFixed(0)+')');}
  }

  // 成交量
  var avgVol=I.ma(vols.slice(0,-1),20),curVol=vols[vols.length-1];
  if(avgVol&&curVol>avgVol*p.volMultiple){bs+=1;ss+=1;rsn.push('量增('+(curVol/avgVol).toFixed(1)+'x)');}

  // 布林帶
  var bb=I.boll(closes,p.bbPeriod||15,p.bbStdDev||2);
  if(bb){
    if(last<bb.lower){bs+=2;rsn.push('BB下軌');}else if(last<bb.mid){bs+=1;rsn.push('BB下半');}
    if(last>bb.upper){ss+=2;rsn.push('BB上軌');}else if(last>bb.mid){ss+=1;rsn.push('BB上半');}
  }

  // EMA 趨勢
  var ema9=I.ema(closes,9),ema21=I.ema(closes,21);
  if(ema9&&ema21){if(ema9>ema21){bs+=1;rsn.push('EMA多');}else{ss+=1;rsn.push('EMA空');}}

  // MACD
  var macdData=I.macd(closes);
  if(macdData){if(macdData.hist>0){bs+=1;rsn.push('MACD+');}else{ss+=1;rsn.push('MACD-');}}

  bs=Math.max(0,bs-hourPenalty);
  ss=Math.max(0,ss-hourPenalty);

  var threshold=cfg.entryThreshold||2;
  var signal='HOLD';
  if(bs>=threshold||ss>=threshold){signal=bs>=ss?'BUY':'SELL';}

  var atrV=I.atr(highs,lows,closes)||last*0.01;
  log('INFO',sym+' BS:'+bs+' SS:'+ss+' 門檻:'+threshold+' -> '+signal+(rsn.length?' ['+rsn.join('+')+']':''));
  return{signal:signal,reasons:rsn.join('+'),price:last,atrV:atrV};
}

var openTrades={},botTimer=null,startTime=Date.now();

async function tradingLoop(){
  if(!cfg.botRunning)return;
  if(learningPause){log('INFO','學習暫停中');return;}
  log('INFO','=== Loop '+nowTW()+' ===');
  try{
    for(var i=0;i<cfg.symbols.length;i++){
      var sym=cfg.symbols[i];
      try{
        var res=await runSeahorse(sym);
        if(!res||res.signal==='HOLD')continue;
        var signal=res.signal,reasons=res.reasons,atrV=res.atrV;
        var tk=await getTicker(sym);var cur=tk?parseFloat(tk.lastPrice):res.price;
        var bal=await getBalance();
        var amt=Math.min(cfg.tradeAmount,bal.available*(cfg.maxRiskPercent/100));
        if(amt<5){log('WARN',sym+' 餘額不足');continue;}
        var step=getQtyStep(cur);
        var qty=roundQty(amt*cfg.leverage/cur,step);
        if(qty<=0){log('WARN',sym+' 數量為0');continue;}
        var atrVal=atrV||cur*0.01;
        var slD=Math.max(atrVal*1.5,cur*cfg.stopLossPercent/100);
        var tpD=Math.max(atrVal*3.0,cur*cfg.takeProfitPercent/100);
        var slP=+(signal==='BUY'?cur-slD:cur+slD).toFixed(4);
        var tpP=+(signal==='BUY'?cur+tpD:cur-tpD).toFixed(4);
        var pos=await getPositions(sym);
        var hasLong=pos.some(function(p){return p.positionSide==='LONG'&&parseFloat(p.positionAmt||0)!==0;})||openTrades[sym+'_L'];
        var hasShort=pos.some(function(p){return p.positionSide==='SHORT'&&parseFloat(p.positionAmt||0)!==0;})||openTrades[sym+'_S'];
        if(signal==='BUY'&&!hasLong&&!hasShort){
          var o=await placeOrder({symbol:sym,side:'BUY',positionSide:'LONG',quantity:qty,stopLoss:slP,takeProfit:tpP});
          if(o)openTrades[sym+'_L']={symbol:sym,side:'LONG',entry:cur,qty:qty,reason:reasons,openTime:Date.now()};
        }
        if(signal==='SELL'&&cfg.allowShort&&!hasLong&&!hasShort){
          var o2=await placeOrder({symbol:sym,side:'SELL',positionSide:'SHORT',quantity:qty,stopLoss:slP,takeProfit:tpP});
          if(o2)openTrades[sym+'_S']={symbol:sym,side:'SHORT',entry:cur,qty:qty,reason:reasons,openTime:Date.now()};
        }
      }catch(e){log('ERROR',sym+': '+e.message);}
    }
    await checkPositions();
  }catch(e){log('ERROR','Loop: '+e.message);}
}

async function checkPositions(){
  for(var key in openTrades){
    try{
      var t=openTrades[key];
      var tk=await getTicker(t.symbol).catch(function(){return null;});if(!tk)continue;
      var cur=parseFloat(tk.lastPrice);
      var holdMin=Math.round((Date.now()-t.openTime)/60000);
      var ps=t.side;

      // 檢查是否已被 TP/SL 平倉
      var pos=await getPositions(t.symbol);
      var stillOpen=pos.some(function(p){return p.positionSide===ps&&parseFloat(p.positionAmt||0)!==0;});
      if(!stillOpen&&holdMin>2){
        var actual=await getActualPnlBX(t.symbol,t.openTime);
        var pnl=actual?actual.pnl:(ps==='LONG'?(cur-t.entry)*t.qty*cfg.leverage:(t.entry-cur)*t.qty*cfg.leverage);
        var exitPrice=actual?actual.exitPrice:cur;
        var source=actual?'API實際':'估算';
        recordTrade({symbol:t.symbol,side:t.side,entry:t.entry,exit:exitPrice,qty:t.qty,pnl:pnl,holdMin:holdMin,reason:'TP/SL觸發'});
        delete openTrades[key];
        tg('[BingX] '+(pnl>=0?'✅ 獲利':'❌ 虧損')+'\n'+t.symbol+'\n進場:'+t.entry.toFixed(4)+' 出場:'+exitPrice.toFixed(4)+'\nPnL('+source+'):'+(pnl>=0?'+':'')+pnl.toFixed(4)+'U Hold:'+holdMin+'min');
        continue;
      }

      var estPnl=ps==='LONG'?(cur-t.entry)*t.qty*cfg.leverage:(t.entry-cur)*t.qty*cfg.leverage;
      log('INFO','持倉 '+t.symbol+' 估算:'+(estPnl>=0?'+':'')+estPnl.toFixed(2)+'U Hold:'+holdMin+'min');

      // ✅ K線動態平倉：持倉超過5分鐘後，偵測反向訊號
      if(holdMin>=5&&stillOpen){
        var kl=await getKlines(t.symbol,cfg.timeframe,60).catch(function(){return[];});
        if(kl.length>=30){
          var closes=kl.map(function(k){return parseFloat(k[4]);});
          var highs=kl.map(function(k){return parseFloat(k[2]);});
          var lows=kl.map(function(k){return parseFloat(k[3]);});

          var rsi=I.rsi(closes,cfg.params.rsiPeriod||7);
          var ema9=I.ema(closes,9),ema21=I.ema(closes,21);
          var macdData=I.macd(closes);
          var bb=I.boll(closes,cfg.params.bbPeriod||15,cfg.params.bbStdDev||2);
          var last=closes[closes.length-1];

          var exitSignal=false;
          var exitReason='';

          if(ps==='LONG'){
            // 多單反向訊號
            var reverseScore=0;
            if(rsi&&rsi>cfg.params.overbought){reverseScore+=2;exitReason+='RSI超買('+rsi.toFixed(0)+') ';}
            if(ema9&&ema21&&ema9<ema21){reverseScore+=1;exitReason+='EMA空 ';}
            if(macdData&&macdData.hist<0){reverseScore+=1;exitReason+='MACD- ';}
            if(bb&&last>bb.upper){reverseScore+=2;exitReason+='BB上軌 ';}
            if(reverseScore>=3){exitSignal=true;}
          }else{
            // 空單反向訊號
            var reverseScore2=0;
            if(rsi&&rsi<cfg.params.oversold){reverseScore2+=2;exitReason+='RSI超賣('+rsi.toFixed(0)+') ';}
            if(ema9&&ema21&&ema9>ema21){reverseScore2+=1;exitReason+='EMA多 ';}
            if(macdData&&macdData.hist>0){reverseScore2+=1;exitReason+='MACD+ ';}
            if(bb&&last<bb.lower){reverseScore2+=2;exitReason+='BB下軌 ';}
            if(reverseScore2>=3){exitSignal=true;}
          }

          if(exitSignal){
            log('AI',t.symbol+' 偵測到反向訊號，提前平倉: '+exitReason);
            var o3=await closePos(t.symbol,ps,t.qty).catch(function(){return null;});
            if(o3){
              await new Promise(function(res){setTimeout(res,1500);});
              var actual3=await getActualPnlBX(t.symbol,t.openTime);
              var pnl3=actual3?actual3.pnl:estPnl-(t.entry+cur)*t.qty*0.0005;
              var exit3=actual3?actual3.exitPrice:cur;
              var source3=actual3?'API實際':'估算';
              recordTrade({symbol:t.symbol,side:t.side,entry:t.entry,exit:exit3,qty:t.qty,pnl:pnl3,holdMin:holdMin,reason:'反向平倉'});
              delete openTrades[key];
              tg('[BingX] 🔄 反向訊號平倉\n'+t.symbol+'\n原因:'+exitReason+'\nPnL('+source3+'):'+(pnl3>=0?'✅ +':'❌ ')+pnl3.toFixed(4)+'U Hold:'+holdMin+'min');
              continue;
            }
          }
        }
      }

      // 超時平倉
      if(holdMin>=cfg.maxHoldMin){
        var o=await closePos(t.symbol,ps,t.qty).catch(function(){return null;});
        if(o){
          await new Promise(function(res){setTimeout(res,1500);});
          var actual2=await getActualPnlBX(t.symbol,t.openTime);
          var pnl2=actual2?actual2.pnl:estPnl-(t.entry+cur)*t.qty*0.0005;
          var exit2=actual2?actual2.exitPrice:cur;
          var source2=actual2?'API實際':'估算';
          recordTrade({symbol:t.symbol,side:t.side,entry:t.entry,exit:exit2,qty:t.qty,pnl:pnl2,holdMin:holdMin,reason:'超時平倉'});
          delete openTrades[key];
          tg('[BingX] ⏰ 超時平倉\n'+t.symbol+'\nPnL('+source2+'):'+(pnl2>=0?'✅ +':'❌ ')+pnl2.toFixed(4)+'U Hold:'+holdMin+'min');
        }
      }
    }catch(e){log('ERROR','checkPos: '+e.message);}
  }
}

function tg(text,chatId){
  var id=chatId||ENV.TG_CHAT;if(!ENV.TG_TOKEN||!id)return;
  var body=JSON.stringify({chat_id:id,text:text,parse_mode:'HTML'});
  var req=https.request({hostname:'api.telegram.org',path:'/bot'+ENV.TG_TOKEN+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(r){var d='';r.on('data',function(c){d+=c;});});
  req.on('error',function(){});req.write(body);req.end();
}

var lastUpdateId=0;
function tgPoll(){
  if(!ENV.TG_TOKEN)return;
  var req=https.request({hostname:'api.telegram.org',path:'/bot'+ENV.TG_TOKEN+'/getUpdates?offset='+(lastUpdateId+1)+'&timeout=30&limit=10',method:'GET'},function(res){
    var d='';res.on('data',function(c){d+=c;});
    res.on('end',function(){
      try{var json=JSON.parse(d);if(json.ok&&json.result&&json.result.length>0){json.result.forEach(function(u){if(u.update_id>lastUpdateId)lastUpdateId=u.update_id;handleUpdate(u);});}}catch(e){}
      setTimeout(tgPoll,1000);
    });
  });
  req.on('error',function(){setTimeout(tgPoll,5000);});
  req.setTimeout(35000,function(){req.destroy();setTimeout(tgPoll,1000);});
  req.end();
}

function handleUpdate(update){
  var msg=update.message||update.edited_message;if(!msg)return;
  var chatId=String(msg.chat.id),text=(msg.text||'').trim();
  if(ENV.TG_CHAT&&chatId!==ENV.TG_CHAT){tg('Unauthorized',chatId);return;}
  var parts=text.split(' '),cmd=parts[0].toLowerCase(),args=parts.slice(1);
  log('INFO','CMD: '+cmd+' from '+chatId);

  if(cmd==='/start'||cmd==='/help'){
    tg('🐎 BingX 海馬策略 v1.0\nSelf-Learning ON\n\n▶ 基本\n/go - 啟動\n/stop - 停止\n/status - 狀態\n/positions - 持倉\n/brain - 學習狀態\n/stats - 績效\n/history - 近10筆\n/log - 日誌\n/params - 指標參數\n\n⚙ 設定\n/set amount 50\n/set leverage 3\n/set sl 2\n/set tp 5\n/set tf 5m\n/set threshold 2\n\n📊 幣種\n/addsym BTC-USDT\n/delsym BTC-USDT',chatId);return;
  }

  if(cmd==='/go'){
    if(cfg.botRunning){tg('⚠️ 已在運行',chatId);return;}
    cfg.botRunning=true;
    botTimer=setInterval(function(){tradingLoop().catch(function(e){log('ERROR','Timer: '+e.message);});},60000);
    tradingLoop().catch(function(e){log('ERROR','Go: '+e.message);});
    tg('🚀 BingX 海馬啟動!\nTF:'+cfg.timeframe+' Lev:'+cfg.leverage+'x\nAmt:'+cfg.tradeAmount+'U SL:'+cfg.stopLossPercent+'% TP:'+cfg.takeProfitPercent+'%\n門檻:'+cfg.entryThreshold+'分\n掃描:每1分鐘\nSymbols:'+cfg.symbols.join(',')+'\nSelf-Learning: ON ✅',chatId);return;
  }

  if(cmd==='/stop'){cfg.botRunning=false;clearInterval(botTimer);botTimer=null;tg('⏹ 已停止',chatId);return;}

  if(cmd==='/status'){
    getBalance().then(function(bal){
      var d=getDayStat(),all=stats.allTime;
      tg('[BingX] 狀態\n'+(cfg.botRunning?'🟢 運行中':'🔴 已停止')+' Uptime:'+Math.round((Date.now()-startTime)/60000)+'min\n餘額:'+bal.available.toFixed(2)+'U\n今日:'+d.total+'筆 WR:'+(d.total>0?(d.wins/d.total*100).toFixed(0):0)+'% PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U\n全部:'+all.total+'筆 PnL:'+(all.pnl>=0?'+':'')+all.pnl.toFixed(2)+'U\n已學習:'+brain.learnCount+'次\n持倉:'+Object.keys(openTrades).length+'\n門檻:'+cfg.entryThreshold,chatId);
    }).catch(function(e){tg('Error: '+e.message,chatId);});return;
  }

  if(cmd==='/brain'){
    var lastAdj=brain.adjustHistory.length?brain.adjustHistory[brain.adjustHistory.length-1]:{changes:['尚未調整']};
    tg('[BingX] 🧠 學習狀態\n已學習:'+brain.learnCount+'次\n最佳時段:'+(brain.bestHours.join(',')+'時'||'學習中')+'\n迴避時段:'+(brain.worstHours.join(',')+'時'||'無')+'\n最佳品種:'+(brain.bestSymbols.join(',')||'學習中')+'\n迴避品種:'+(brain.worstSymbols.join(',')||'無')+'\n調參:'+brain.adjustHistory.length+'次\n最近:'+lastAdj.changes.join(', '),chatId);return;
  }

  if(cmd==='/log'){tg('[BingX] 日誌\n'+memLog.slice(-15).map(function(l){return '['+l.lv+'] '+l.msg;}).join('\n'),chatId);return;}

  if(cmd==='/params'){
    var p=cfg.params;
    var lastAdj2=brain.adjustHistory.length?brain.adjustHistory[brain.adjustHistory.length-1]:null;
    var pmsg='[BingX] 📐 指標參數\n\nRSI週期:'+p.rsiPeriod+'\nRSI超賣:'+p.oversold+'\nRSI超買:'+p.overbought+'\nBB週期:'+p.bbPeriod+'\nBB標準差:'+p.bbStdDev+'\n量能倍數:'+p.volMultiple+'x\n開單門檻:'+cfg.entryThreshold+'分\n止損:'+cfg.stopLossPercent+'% 止盈:'+cfg.takeProfitPercent+'%\n超時:'+cfg.maxHoldMin+'min\n\n';
    if(lastAdj2)pmsg+='上次調整: '+lastAdj2.date+'\nWR:'+lastAdj2.wr+'%\n'+lastAdj2.changes.join('\n');
    else pmsg+='⏳ 尚未調整';
    tg(pmsg,chatId);return;
  }

  if(cmd==='/positions'){
    var keys=Object.keys(openTrades);if(!keys.length){tg('[BingX] 無持倉',chatId);return;}
    Promise.all(keys.map(function(k){return getTicker(openTrades[k].symbol).catch(function(){return null;});})).then(function(tks){
      var m='[BingX] 持倉\n\n';
      keys.forEach(function(k,i){var t=openTrades[k],cur=tks[i]?parseFloat(tks[i].lastPrice):t.entry;var pnl=t.side==='LONG'?(cur-t.entry)*t.qty*cfg.leverage:(t.entry-cur)*t.qty*cfg.leverage;m+=(t.side==='LONG'?'🟢':'🔴')+' '+t.symbol+'\nEntry:'+t.entry.toFixed(4)+' Now:'+cur.toFixed(4)+'\nPnL:'+(pnl>=0?'+':'')+pnl.toFixed(2)+'U Hold:'+Math.round((Date.now()-t.openTime)/60000)+'min\n\n';});
      tg(m,chatId);
    });return;
  }

  if(cmd==='/stats'){
    var al=stats.allTime,dds=getDayStat();var w7='';
    for(var i=6;i>=0;i--){var dd=new Date();dd.setDate(dd.getDate()-i);var dk=dd.toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});var ds=getDayStat(dk);w7+=dk.slice(5)+':'+ds.total+'筆 '+(ds.pnl>=0?'+':'')+ds.pnl.toFixed(0)+'U\n';}
    tg('[BingX] 📊 績效\n今日:'+dds.total+'筆 WR:'+(dds.total>0?(dds.wins/dds.total*100).toFixed(0):0)+'% PnL:'+(dds.pnl>=0?'+':'')+dds.pnl.toFixed(2)+'U\n\n7天:\n'+w7+'\n累計:'+al.total+'筆 WR:'+(al.total>0?(al.wins/al.total*100).toFixed(1):0)+'% PnL:'+(al.pnl>=0?'+':'')+al.pnl.toFixed(2)+'U',chatId);return;
  }

  if(cmd==='/history'){
    var tr=stats.trades.slice(-10).reverse();if(!tr.length){tg('尚無交易',chatId);return;}
    tg('[BingX] 近10筆\n'+tr.map(function(t){return (t.pnl>=0?'✅':'❌')+' '+t.symbol+' '+(t.pnl>=0?'+':'')+t.pnl.toFixed(2)+'U hold:'+(t.holdMin||0)+'min\n原因:'+t.reason;}).join('\n\n'),chatId);return;
  }

  if(cmd==='/set'){
    if(args.length<2){tg('用法: /set KEY VALUE',chatId);return;}
    var sk=args[0].toLowerCase(),sv=args[1],nv=parseFloat(sv);
    if(sk==='amount'&&nv>0){cfg.tradeAmount=nv;tg('✅ 金額 -> '+nv+'U',chatId);}
    else if(sk==='leverage'&&nv>=1&&nv<=20){cfg.leverage=nv;tg('✅ 槓桿 -> '+nv+'x',chatId);}
    else if(sk==='sl'&&nv>0){cfg.stopLossPercent=nv;tg('✅ 止損 -> '+nv+'%',chatId);}
    else if(sk==='tp'&&nv>0){cfg.takeProfitPercent=nv;tg('✅ 止盈 -> '+nv+'%',chatId);}
    else if(sk==='tf'){if(['1m','3m','5m','15m','1h'].includes(sv)){cfg.timeframe=sv;tg('✅ 時框 -> '+sv,chatId);}else tg('無效',chatId);}
    else if(sk==='threshold'&&nv>=1&&nv<=6){cfg.entryThreshold=Math.round(nv);tg('✅ 門檻 -> '+cfg.entryThreshold,chatId);}
    else if(sk==='short'){cfg.allowShort=(sv==='on'||sv==='true');tg('✅ 空單 -> '+(cfg.allowShort?'開啟':'關閉'),chatId);}
    else tg('未知: '+sk,chatId);return;
  }

  if(cmd==='/addsym'){if(!args[0]){tg('用法: /addsym BTC-USDT',chatId);return;}var as=args[0].toUpperCase();if(cfg.symbols.includes(as)){tg(as+' 已存在',chatId);return;}cfg.symbols.push(as);tg('✅ 新增 '+as,chatId);return;}
  if(cmd==='/delsym'){if(!args[0]){tg('用法: /delsym BTC-USDT',chatId);return;}cfg.symbols=cfg.symbols.filter(function(s){return s!==args[0].toUpperCase();});tg('✅ 移除 '+args[0].toUpperCase(),chatId);return;}
  if(text.startsWith('/'))tg('未知指令，輸入 /help',chatId);
}

function startServer(){
  var PORT=process.env.BINGX_PORT||3002;
  http.createServer(function(req,res){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',running:cfg.botRunning,learnCount:brain.learnCount,uptime:Math.round((Date.now()-startTime)/60000)+'min'}));}).listen(PORT,function(){log('OK','Server Port:'+PORT);});
}

function scheduleReport(){
  function ms10(){var now=new Date(),tw=new Date(now.toLocaleString('en-US',{timeZone:'Asia/Taipei'}));var n=new Date(tw);n.setHours(10,0,0,0);if(tw.getHours()>=10)n.setDate(n.getDate()+1);return n-tw;}
  setTimeout(function(){
    var d=getDayStat(),all=stats.allTime;
    tg('[BingX 海馬] 📊 每日報告\n今日:'+d.total+'筆 WR:'+(d.total>0?(d.wins/d.total*100).toFixed(1):0)+'% PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U\n累計:'+all.total+'筆 PnL:'+(all.pnl>=0?'+':'')+all.pnl.toFixed(2)+'U');
    setInterval(function(){var d2=getDayStat(),all2=stats.allTime;tg('[BingX 海馬] 📊 每日報告\n今日:'+d2.total+'筆 PnL:'+(d2.pnl>=0?'+':'')+d2.pnl.toFixed(2)+'U\n累計:'+all2.total+'筆 PnL:'+(all2.pnl>=0?'+':'')+all2.pnl.toFixed(2)+'U');},24*60*60*1000);
  },ms10());
}

async function main(){
  console.log('\nBingX Seahorse AutoTrader v1.0\n');
  log('INFO','Starting...');
  startServer();
  try{
    var bal=await getBalance();
    log('OK','BingX API OK! Available:'+bal.available.toFixed(2)+'U');
    tg('[BingX 海馬] 🟢 上線!\n餘額:'+bal.available.toFixed(2)+'U\nSelf-Learning: ON ✅\n/help 查看指令');
  }catch(e){log('ERROR','API fail: '+e.message);tg('[BingX] ⚠️ Warning: '+e.message);}
  log('INFO','Starting Telegram polling...');
  tgPoll();scheduleReport();
  log('OK','Ready. /help');
}

process.on('uncaughtException',function(e){log('ERROR','Uncaught: '+e.message);tg('🚨 BingX 海馬 程式異常!\n錯誤: '+e.message);});
process.on('unhandledRejection',function(e){log('ERROR','Unhandled: '+(e&&e.message?e.message:String(e)));});
process.on('SIGINT',function(){tg('⛔ BingX 海馬 已關閉!\n持倉:'+Object.keys(openTrades).length+'個未平倉');setTimeout(function(){process.exit(0);},2000);});
setInterval(function(){if(!cfg.botRunning)return;var hr=new Date().getMinutes();if(hr===0){var d=getDayStat();tg('💓 BingX 心跳\n🟢 運行中\n今日:'+d.total+'筆 PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U');}},60000);
main().catch(function(e){log('ERROR','Start fail: '+e.message);process.exit(1);});

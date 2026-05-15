'use strict';
const crypto=require('crypto'),https=require('https'),http=require('http'),fs=require('fs');
const ENV={
  BYBIT_API_KEY:process.env.BYBIT_API_KEY||'',
  BYBIT_SECRET:process.env.BYBIT_SECRET_KEY||'',
  TG_TOKEN:process.env.TELEGRAM_TOKEN||'',
  TG_CHAT:process.env.TELEGRAM_CHAT_ID||''
};

// ══════════════════════════════════
// 三層策略設定
// ══════════════════════════════════
const LAYERS={
  scalp:{name:'短期',tf:'3m',lev:5,amt:1,threshold:4,maxHold:60,
    atrMult:{sl:1.5,tp:2.5},   // ATR 倍數（止損/止盈）
    limitOffset:0.002},         // 限價低於現價 0.2%
  swing:{name:'中期',tf:'5m',lev:5,amt:1,threshold:5,maxHold:360,
    atrMult:{sl:2.0,tp:3.5},
    limitOffset:0.003},
  long: {name:'長期',tf:'1h',lev:5,amt:1,threshold:5,maxHold:2880,
    atrMult:{sl:2.5,tp:5.0},
    limitOffset:0.005}
};

// 固定限制（AI 不可超出）
const MIN_SL=1.0,MIN_RR=1.5;
const MAX_SAME_DIR=5;
const PARAM_LIMITS={
  oversold:   {min:25,max:35},
  overbought: {min:65,max:75},
  rsiPeriod:  {min:5, max:14},
  bbPeriod:   {min:10,max:25},
  bbStdDev:   {min:1.5,max:2.5},
  volMultiple:{min:1.0,max:2.0},
  atrMultSl:  {min:1.5,max:3.0},
  atrMultTp:  {min:2.0,max:5.0},
  limitOffset:{min:0.001,max:0.005}
};
function clamp(val,key){var l=PARAM_LIMITS[key];if(!l)return val;return Math.min(l.max,Math.max(l.min,val));}

var openTrades={},pendingOrders={},usedOrderIds=new Set(),learnCycleCount=0,learningPause=false;

let cfg={
  symbols:['SIRENUSDT','DOGEUSDT','XRPUSDT'],
  botRunning:false,
  allowShort:true,
  params:{
    rsiPeriod:7,oversold:30,overbought:70,
    volMultiple:1.3,bbPeriod:15,bbStdDev:2.0
  }
};

// ══════════════════════════════════
// 統計與學習
// ══════════════════════════════════
var stats=loadStats();
function loadStats(){if(fs.existsSync('./bybit_3tier_stats.json'))try{return JSON.parse(fs.readFileSync('./bybit_3tier_stats.json','utf8'));}catch(e){}return{allTime:{total:0,wins:0,losses:0,pnl:0},daily:{},trades:[]};}
function saveStats(){fs.writeFileSync('./bybit_3tier_stats.json',JSON.stringify(stats,null,2));}
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
  learnFromTrade(t);
  learnCycleCount++;
  if(learnCycleCount>=3){
    learnCycleCount=0;learningPause=true;
    log('AI','=== 學習週期觸發！暫停交易 ===');
    tg('[Bybit 🧠] 學習週期開始\n已完成3筆，分析中...');
    autoAdjust();
    setTimeout(function(){learningPause=false;log('AI','=== 學習完成！恢復交易 ===');tg('[Bybit 🧠] 學習完成！恢復交易');},3000);
  }
}

var brain=loadBrain();
function loadBrain(){
  var paths=['./shared_brain.json','./bybit_brain.json'];
  for(var i=0;i<paths.length;i++){if(fs.existsSync(paths[i]))try{return JSON.parse(fs.readFileSync(paths[i],'utf8'));}catch(e){}}
  return{symbolPerf:{},hourPerf:{},adjustHistory:[],learnCount:0};
}
function saveBrain(){fs.writeFileSync('./shared_brain.json',JSON.stringify(brain,null,2));fs.writeFileSync('./bybit_brain.json',JSON.stringify(brain,null,2));}

function learnFromTrade(t){
  brain.learnCount=(brain.learnCount||0)+1;
  if(!brain.symbolPerf[t.symbol])brain.symbolPerf[t.symbol]={wins:0,losses:0,pnl:0,count:0};
  var sp=brain.symbolPerf[t.symbol];
  if(t.pnl>0)sp.wins++;else sp.losses++;sp.pnl+=t.pnl;sp.count++;
  var hr=String(hourTW());
  if(!brain.hourPerf[hr])brain.hourPerf[hr]={wins:0,losses:0,pnl:0};
  if(t.pnl>0)brain.hourPerf[hr].wins++;else brain.hourPerf[hr].losses++;brain.hourPerf[hr].pnl+=t.pnl;
  saveBrain();
}

function autoAdjust(){
  var recent=stats.trades.slice(-20);if(recent.length<3)return;
  var wins=recent.filter(function(t){return t.pnl>0;});
  var wr=wins.length/recent.length;
  var changes=[];
  var p=cfg.params;
  // RSI 調整（限定範圍）
  if(wr<0.4&&p.oversold>PARAM_LIMITS.oversold.min){p.oversold=Math.max(PARAM_LIMITS.oversold.min,p.oversold-2);changes.push('RSI超賣->'+p.oversold);}
  if(wr<0.4&&p.overbought<PARAM_LIMITS.overbought.max){p.overbought=Math.min(PARAM_LIMITS.overbought.max,p.overbought+2);changes.push('RSI超買->'+p.overbought);}
  if(wr>0.6&&p.oversold<PARAM_LIMITS.oversold.max){p.oversold=Math.min(PARAM_LIMITS.oversold.max,p.oversold+2);changes.push('RSI超賣放寬->'+p.oversold);}
  if(wr>0.6&&p.overbought>PARAM_LIMITS.overbought.min){p.overbought=Math.max(PARAM_LIMITS.overbought.min,p.overbought-2);changes.push('RSI超買放寬->'+p.overbought);}
  // BB 調整
  if(wr<0.4&&p.bbStdDev<PARAM_LIMITS.bbStdDev.max){p.bbStdDev=+(Math.min(PARAM_LIMITS.bbStdDev.max,p.bbStdDev+0.1)).toFixed(1);changes.push('BB寬度->'+p.bbStdDev);}
  if(wr>0.6&&p.bbStdDev>PARAM_LIMITS.bbStdDev.min){p.bbStdDev=+(Math.max(PARAM_LIMITS.bbStdDev.min,p.bbStdDev-0.1)).toFixed(1);changes.push('BB收窄->'+p.bbStdDev);}
  if(changes.length){
    brain.adjustHistory=brain.adjustHistory||[];
    brain.adjustHistory.push({date:todayKey(),changes:changes,wr:(wr*100).toFixed(1)});
    if(brain.adjustHistory.length>100)brain.adjustHistory=brain.adjustHistory.slice(-100);
    log('AI','自動調整: '+changes.join(' | '));
    tg('[Bybit 🧠 自動調整]\n'+changes.join('\n')+'\nWR:'+(wr*100).toFixed(1)+'%');
    saveBrain();
  }
}

var memLog=[];
function log(lv,msg){console.log('['+nowTW()+'][BY]['+lv+'] '+msg);memLog.push({ts:nowTW(),lv:lv,msg:msg});if(memLog.length>300)memLog.shift();}

// ══════════════════════════════════
// Bybit API
// ══════════════════════════════════
function bybitSign(data,ts){
  var msg=ts+''+ENV.BYBIT_API_KEY+'5000'+data;
  return crypto.createHmac('sha256',ENV.BYBIT_SECRET).update(msg).digest('hex');
}
function bybitReq(method,path,params,tries){
  params=params||{};tries=tries||3;
  return new Promise(function(resolve,reject){
    var ts=String(Date.now());
    var body=method==='POST'?JSON.stringify(params):'';
    var qs=method==='GET'?Object.keys(params).map(function(k){return k+'='+params[k];}).join('&'):'';
    var data=method==='GET'?qs:body;
    var sig=bybitSign(data,ts);
    var fullPath=method==='GET'&&qs?path+'?'+qs:path;
    var opt={hostname:'api.bybit.com',path:fullPath,method:method,headers:{'X-BAPI-API-KEY':ENV.BYBIT_API_KEY,'X-BAPI-TIMESTAMP':ts,'X-BAPI-SIGN':sig,'X-BAPI-RECV-WINDOW':'5000','Content-Type':'application/json'}};
    var go=function(n){
      var req=https.request(opt,function(rsp){var d='';rsp.on('data',function(c){d+=c;});rsp.on('end',function(){try{resolve(JSON.parse(d));}catch(e){reject(new Error(d.slice(0,80)));}});});
      req.on('error',function(e){if(n>1)setTimeout(function(){go(n-1);},2000);else reject(e);});
      req.setTimeout(12000,function(){req.destroy();if(n>1)setTimeout(function(){go(n-1);},2000);else reject(new Error('Timeout'));});
      if(method==='POST')req.write(body);req.end();
    };
    go(tries);
  });
}

async function getBalance(){
  var r=await bybitReq('GET','/v5/account/wallet-balance',{accountType:'UNIFIED'});
  if(r.retCode===0){
    var coins=r.result.list[0].coin;
    var usdt=coins.find(function(c){return c.coin==='USDT';})||{};
    return{available:parseFloat(usdt.availableToWithdraw||usdt.walletBalance||0),total:parseFloat(usdt.walletBalance||0)};
  }
  throw new Error('Cannot get balance');
}

async function getKlines(symbol,interval,limit){
  limit=limit||200;
  var ivMap={'1m':'1','3m':'3','5m':'5','15m':'15','1h':'60','4h':'240'};
  var iv=ivMap[interval]||'5';
  try{
    var r=await bybitReq('GET','/v5/market/kline',{category:'linear',symbol:symbol,interval:iv,limit:limit});
    if(r.retCode===0)return r.result.list.reverse();
  }catch(e){log('WARN','Kline '+symbol+': '+e.message);}
  return[];
}

async function getTicker(symbol){
  try{var r=await bybitReq('GET','/v5/market/tickers',{category:'linear',symbol:symbol});if(r.retCode===0&&r.result.list.length>0)return r.result.list[0];}catch(e){}return null;
}

async function getPositions(symbol){
  var p=symbol?{category:'linear',symbol:symbol}:{category:'linear',settleCoin:'USDT'};
  try{var r=await bybitReq('GET','/v5/position/list',p);if(r.retCode===0)return r.result.list.filter(function(p){return parseFloat(p.size||0)>0;});}catch(e){}return[];
}

function getQtyStep(price){
  if(price>=10000)return 0.001;
  if(price>=1000)return 0.01;
  if(price>=100)return 0.1;
  if(price>=1)return 1;
  return 1;
}
function roundQty(qty,step){return Math.floor(qty/step)*step;}

async function setLeverage(symbol,lev){
  try{await bybitReq('POST','/v5/position/set-leverage',{category:'linear',symbol:symbol,buyLeverage:String(lev),sellLeverage:String(lev)});}catch(e){}
}

// ✅ 限價掛單
async function placeLimitOrder(o){
  try{await setLeverage(o.symbol,o.lev);}catch(e){}
  var step=getQtyStep(o.price);
  var notional=o.amt*o.lev;
  var qty=roundQty(notional/o.price,step);
  if(qty*o.price<5)qty=roundQty(5/o.price+step,step);
  if(qty<=0)throw new Error('數量為0');
  var posIdx=o.positionSide==='LONG'?1:2;
  var side=o.side==='BUY'?'Buy':'Sell';
  var p={category:'linear',symbol:o.symbol,side:side,orderType:'Limit',qty:String(qty),price:String(o.limitPrice),timeInForce:'GTC',positionIdx:posIdx};
  var r=await bybitReq('POST','/v5/order/create',p);
  if(r.retCode===0){
    log('OK',o.symbol+' 限價掛單 '+side+' @'+o.limitPrice+' qty='+qty+' orderId='+r.result.orderId);
    tg('[Bybit] 📋 限價掛單\n'+(o.side==='BUY'?'🟢 多':'🔴 空')+' '+o.symbol+' ['+o.layer+']\n掛單價: '+o.limitPrice+'\nSL: '+o.stopLoss+' TP: '+o.takeProfit);
    return{orderId:r.result.orderId,qty:qty,price:o.limitPrice};
  }
  log('ERROR','限價掛單失敗 '+o.symbol+' '+r.retMsg);
  return null;
}

// ✅ 確認限價單是否已成交
async function checkLimitOrderFilled(symbol,orderId){
  try{
    var r=await bybitReq('GET','/v5/order/realtime',{category:'linear',symbol:symbol,orderId:orderId});
    if(r.retCode===0&&r.result.list.length>0){
      var o=r.result.list[0];
      return o.orderStatus==='Filled';
    }
  }catch(e){}
  return false;
}

async function cancelOrder(symbol,orderId){
  if(!orderId)return;
  try{await bybitReq('POST','/v5/order/cancel',{category:'linear',symbol:symbol,orderId:orderId});}catch(e){}
}

async function setSLTP(symbol,posIdx,sl,tp){
  try{
    var p={category:'linear',symbol:symbol,positionIdx:posIdx};
    if(sl)p.stopLoss=String(sl);
    if(tp){p.takeProfit=String(tp);p.tpslMode='Partial';p.tpSize=String(1);}
    await bybitReq('POST','/v5/position/trading-stop',p);
  }catch(e){log('WARN',symbol+' SL/TP設定失敗: '+e.message);}
}

async function closePos(sym,side,qty,posIdx){
  var closeSide=side==='LONG'?'Sell':'Buy';
  var r=await bybitReq('POST','/v5/order/create',{category:'linear',symbol:sym,side:closeSide,orderType:'Market',qty:String(qty),timeInForce:'IOC',positionIdx:posIdx});
  return r.retCode===0?r.result:null;
}

async function getActualPnl(symbol,openTime){
  try{
    var r=await bybitReq('GET','/v5/position/closed-pnl',{category:'linear',symbol:symbol,limit:10});
    if(r.retCode===0&&r.result.list&&r.result.list.length>0){
      var trades=r.result.list.filter(function(t){return parseInt(t.updatedTime||0)>openTime;});
      if(trades.length>0){
        var pnl=parseFloat(trades[0].closedPnl||0);
        log('INFO',symbol+' API實際PnL: '+pnl.toFixed(4)+'U');
        return{pnl:pnl,exitPrice:parseFloat(trades[0].avgExitPrice||0)};
      }
    }
  }catch(e){log('WARN','getActualPnl: '+e.message);}
  return null;
}

// ══════════════════════════════════
// 技術指標
// ══════════════════════════════════
var I={
  ma:function(a,n){if(a.length<n)return null;return a.slice(-n).reduce(function(s,v){return s+v;},0)/n;},
  ema:function(a,n){if(a.length<n)return null;var k=2/(n+1),ema=a.slice(0,n).reduce(function(s,v){return s+v;},0)/n;for(var i=n;i<a.length;i++)ema=a[i]*k+ema*(1-k);return ema;},
  rsi:function(a,n){n=n||14;if(a.length<n+1)return null;var g=0,l=0;for(var i=a.length-n;i<a.length;i++){var d=a[i]-a[i-1];if(d>0)g+=d;else l-=d;}return 100-100/(1+g/(l||0.0001));},
  boll:function(a,n,d){n=n||20;d=d||2;if(a.length<n)return null;var sl=a.slice(-n),m=sl.reduce(function(s,v){return s+v;},0)/n,std=Math.sqrt(sl.reduce(function(s,v){return s+Math.pow(v-m,2);},0)/n);return{upper:m+d*std,mid:m,lower:m-d*std};},
  macd:function(a){if(a.length<26)return null;var fast=I.ema(a,12),slow=I.ema(a,26);if(!fast||!slow)return null;return{hist:fast-slow};},
  // ✅ ATR（平均真實波幅）
  atr:function(highs,lows,closes,n){
    n=n||14;
    if(highs.length<n+1)return null;
    var trs=[];
    for(var i=1;i<highs.length;i++){
      var tr=Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1]));
      trs.push(tr);
    }
    if(trs.length<n)return null;
    var atr=trs.slice(0,n).reduce(function(s,v){return s+v;},0)/n;
    for(var j=n;j<trs.length;j++)atr=(atr*(n-1)+trs[j])/n;
    return atr;
  }
};

// ══════════════════════════════════
// 信號計算（加強版）
// ══════════════════════════════════
async function calcSignal(sym,layer){
  var cfg2=LAYERS[layer];
  var kl=await getKlines(sym,cfg2.tf,210); // 多取一些K線給 EMA200
  if(kl.length<60)return null;
  var closes=kl.map(function(k){return parseFloat(k[4]);});
  var highs=kl.map(function(k){return parseFloat(k[2]);});
  var lows=kl.map(function(k){return parseFloat(k[3]);});
  var vols=kl.map(function(k){return parseFloat(k[5]);});
  var last=closes[closes.length-1];
  var p=cfg.params;
  var bs=0,ss=0,rsn=[];

  // ✅ RSI
  var rsi=I.rsi(closes,clamp(p.rsiPeriod,'rsiPeriod'));
  var rsiPrev=I.rsi(closes.slice(0,-1),clamp(p.rsiPeriod,'rsiPeriod'));
  var oversold=clamp(p.oversold,'oversold'),overbought=clamp(p.overbought,'overbought');
  if(rsi!==null&&rsiPrev!==null){
    if(rsiPrev<oversold&&rsi>oversold){bs+=3;rsn.push('RSI回升('+rsi.toFixed(0)+')');}
    if(rsiPrev>overbought&&rsi<overbought){ss+=3;rsn.push('RSI回落('+rsi.toFixed(0)+')');}
    if(rsi<50){bs+=1;}else{ss+=1;}
  }

  // ✅ BB
  var bb=I.boll(closes,clamp(p.bbPeriod,'bbPeriod'),clamp(p.bbStdDev,'bbStdDev'));
  if(bb){
    if(last<bb.lower){bs+=2;rsn.push('BB下軌');}else if(last<bb.mid){bs+=1;rsn.push('BB下半');}
    if(last>bb.upper){ss+=2;rsn.push('BB上軌');}else if(last>bb.mid){ss+=1;rsn.push('BB上半');}
  }

  // ✅ EMA9/21（短期動能）
  var ema9=I.ema(closes,9),ema21=I.ema(closes,21);
  if(ema9&&ema21){
    if(ema9>ema21){bs+=1;rsn.push('EMA多');}else{ss+=1;rsn.push('EMA空');}
  }

  // ✅ EMA50/200（趨勢過濾，所有層都加入）
  var ema50=I.ema(closes,50);
  var ema200=I.ema(closes,Math.min(200,closes.length-1));
  if(ema50&&ema200){
    if(ema50>ema200){bs+=2;rsn.push('趨勢多');}else{ss+=2;rsn.push('趨勢空');}
    // 趨勢反向扣分（逆勢交易要更嚴格）
    if(ema50>ema200&&ss>bs){ss-=1;} // 趨勢多，空單扣1分
    if(ema50<ema200&&bs>ss){bs-=1;} // 趨勢空，多單扣1分
  }

  // ✅ MACD
  var macdData=I.macd(closes);
  if(macdData){if(macdData.hist>0){bs+=1;rsn.push('MACD+');}else{ss+=1;rsn.push('MACD-');}}

  // ✅ 成交量
  var avgVol=I.ma(vols.slice(0,-1),20);
  if(avgVol&&vols[vols.length-1]>avgVol*clamp(p.volMultiple,'volMultiple')){bs+=1;ss+=1;rsn.push('量增');}

  // ✅ ATR 計算（用於止損，不給分）
  var atrVal=I.atr(highs,lows,closes,14);

  var threshold=cfg2.threshold;
  var signal='HOLD';
  if(bs>=threshold&&bs>ss)signal='BUY';
  else if(ss>=threshold&&ss>bs)signal='SELL';

  log('INFO',sym+' ['+layer+'] BS:'+bs+' SS:'+ss+' 門檻:'+threshold+' -> '+signal+(rsn.length?' ['+rsn.join('+')+']':''));
  return{signal:signal,bs:bs,ss:ss,reasons:rsn.join('+'),price:last,atr:atrVal,highs:highs,lows:lows,closes:closes};
}

// ══════════════════════════════════
// 持倉監控
// ══════════════════════════════════
async function checkPendingOrders(){
  for(var key in pendingOrders){
    try{
      var po=pendingOrders[key];
      var holdMin=Math.round((Date.now()-po.openTime)/60000);
      // 限價單超過 30 分鐘未成交則取消
      if(holdMin>30){
        await cancelOrder(po.symbol,po.orderId);
        delete pendingOrders[key];
        log('INFO',po.symbol+' ['+po.layer+'] 限價單超時取消');
        tg('[Bybit] ⏰ 限價單取消\n'+po.symbol+' ['+po.layerName+']\n掛了 '+holdMin+' 分鐘未成交');
        continue;
      }
      // 檢查是否已成交
      var filled=await checkLimitOrderFilled(po.symbol,po.orderId);
      if(filled){
        log('OK',po.symbol+' ['+po.layer+'] 限價單已成交！');
        // 設定 SL/TP
        var posIdx=po.positionSide==='LONG'?1:2;
        await setSLTP(po.symbol,posIdx,po.stopLoss,po.takeProfit);
        // 移到 openTrades
        openTrades[key]={
          symbol:po.symbol,side:po.positionSide,
          entry:po.limitPrice,qty:po.qty,
          layer:po.layer,openTime:Date.now(),
          stopLoss:po.stopLoss,takeProfit:po.takeProfit,
          halfExited:false,slMoved:false
        };
        delete pendingOrders[key];
        tg('[Bybit] ✅ 限價單成交！\n'+(po.positionSide==='LONG'?'🟢':'🔴')+' '+po.symbol+' ['+po.layerName+']\n成交價: '+po.limitPrice+'\nSL: '+po.stopLoss+' TP: '+po.takeProfit);
      }
    }catch(e){log('ERROR','checkPending: '+e.message);}
  }
}

async function checkPositions(){
  for(var key in openTrades){
    try{
      var t=openTrades[key];
      var layer=t.layer,layerCfg=LAYERS[layer];
      var tk=await getTicker(t.symbol).catch(function(){return null;});if(!tk)continue;
      var cur=parseFloat(tk.lastPrice);
      var holdMin=Math.round((Date.now()-t.openTime)/60000);
      var ps=t.side;
      var posIdx=ps==='LONG'?1:2;

      // 檢查是否已平倉
      var pos=await getPositions(t.symbol);
      var stillOpen=pos.some(function(p){return parseFloat(p.size||0)>0&&(ps==='LONG'?p.side==='Buy':p.side==='Sell');});

      if(!stillOpen&&holdMin>1){
        await new Promise(function(res){setTimeout(res,1500);});
        var actual=await getActualPnl(t.symbol,t.openTime);
        var pnl=actual?actual.pnl:0;
        var source=actual?'API':'估算';
        recordTrade({symbol:t.symbol,side:t.side,entry:t.entry,exit:cur,qty:t.qty,pnl:pnl,holdMin:holdMin,reason:'TP/SL',layer:layer});
        delete openTrades[key];
        tg('[Bybit] '+(pnl>=0?'✅':'❌')+' '+t.symbol+' ['+layerCfg.name+']\nPnL('+source+'):'+(pnl>=0?'+':'')+pnl.toFixed(4)+'U Hold:'+holdMin+'min');
        continue;
      }

      var estPnl=ps==='LONG'?(cur-t.entry)*t.qty*layerCfg.lev:(t.entry-cur)*t.qty*layerCfg.lev;
      var estPct=ps==='LONG'?(cur-t.entry)/t.entry*100:(t.entry-cur)/t.entry*100;
      log('INFO','持倉 '+t.symbol+' ['+layer+'] '+(estPct>=0?'+':'')+estPct.toFixed(2)+'% Hold:'+holdMin+'min');

      // ✅ 移動止損：達到 TP1 時 SL 移到開倉價和 TP1 中間
      var tpPct=layerCfg.atrMult.tp;
      var tp1Pct=tpPct*0.5;
      if(estPct>=tp1Pct&&!t.slMoved){
        t.slMoved=true;
        var tp1Price=ps==='LONG'?t.entry*(1+tp1Pct/100):t.entry*(1-tp1Pct/100);
        var newSl=+((t.entry+tp1Price)/2).toFixed(4);
        try{
          await bybitReq('POST','/v5/position/trading-stop',{category:'linear',symbol:t.symbol,stopLoss:String(newSl),slTriggerBy:'MarkPrice',positionIdx:posIdx});
          log('AI',t.symbol+' 止損移動至 '+newSl);
          tg('[Bybit] 🔒 止損上移\n'+t.symbol+' ['+layerCfg.name+']\n新止損: '+newSl+'\n鎖定約 '+(tp1Pct*0.5).toFixed(2)+'% 獲利');
        }catch(e){log('WARN',t.symbol+' 止損移動失敗: '+e.message);}
      }

      // ✅ 分倉出場：達到 TP1 平一半
      if(estPct>=tp1Pct&&!t.halfExited&&stillOpen){
        t.halfExited=true;
        var halfQty=Math.floor(t.qty/2*100)/100;
        if(halfQty>0){
          try{
            await bybitReq('POST','/v5/order/create',{category:'linear',symbol:t.symbol,side:ps==='LONG'?'Sell':'Buy',orderType:'Market',qty:String(halfQty),timeInForce:'IOC',positionIdx:posIdx});
            log('AI',t.symbol+' 半倉出場 qty='+halfQty);
            tg('[Bybit] 🏁 半倉出場\n'+t.symbol+' ['+layerCfg.name+']\n數量: '+halfQty+'\n獲利: +'+estPct.toFixed(2)+'%');
          }catch(e){log('WARN',t.symbol+' 半倉失敗: '+e.message);}
        }
      }

      // ✅ K線反向訊號平倉
      if(holdMin>=5&&stillOpen){
        var res=await calcSignal(t.symbol,layer).catch(function(){return null;});
        if(res){
          var rev=(ps==='LONG'&&res.signal==='SELL')||(ps==='SHORT'&&res.signal==='BUY');
          if(rev){
            var o=await closePos(t.symbol,ps,t.qty,posIdx).catch(function(){return null;});
            if(o){
              await new Promise(function(r2){setTimeout(r2,1500);});
              var a2=await getActualPnl(t.symbol,t.openTime);
              var p2=a2?a2.pnl:estPnl;
              recordTrade({symbol:t.symbol,side:t.side,entry:t.entry,exit:cur,qty:t.qty,pnl:p2,holdMin:holdMin,reason:'反向平倉',layer:layer});
              delete openTrades[key];
              tg('[Bybit] 🔄 反向平倉\n'+t.symbol+' ['+layerCfg.name+']\nPnL:'+(p2>=0?'✅ +':'❌ ')+p2.toFixed(4)+'U Hold:'+holdMin+'min');
              continue;
            }
          }
        }
      }

      // ✅ 超時平倉
      if(holdMin>=layerCfg.maxHold){
        var o2=await closePos(t.symbol,ps,t.qty,posIdx).catch(function(){return null;});
        if(o2){
          await new Promise(function(r3){setTimeout(r3,1500);});
          var a3=await getActualPnl(t.symbol,t.openTime);
          var p3=a3?a3.pnl:estPnl;
          recordTrade({symbol:t.symbol,side:t.side,entry:t.entry,exit:cur,qty:t.qty,pnl:p3,holdMin:holdMin,reason:'超時平倉',layer:layer});
          delete openTrades[key];
          tg('[Bybit] ⏰ 超時\n'+t.symbol+' ['+layerCfg.name+']\nPnL:'+(p3>=0?'✅ +':'❌ ')+p3.toFixed(4)+'U Hold:'+holdMin+'min');
        }
      }
    }catch(e){log('ERROR','checkPos: '+e.message);}
  }
}

// ══════════════════════════════════
// 主循環
// ══════════════════════════════════
var botTimer=null,lastSignalTs={};

async function tradingLoop(){
  if(!cfg.botRunning)return;
  if(learningPause){log('INFO','學習暫停中');await checkPendingOrders();await checkPositions();return;}
  log('INFO','=== Loop '+nowTW()+' ===');
  try{
    var bal=await getBalance().catch(function(){return null;});
    if(!bal){log('WARN','無法取得餘額');return;}

    // 先檢查掛單和持倉
    await checkPendingOrders();

    for(var i=0;i<cfg.symbols.length;i++){
      var sym=cfg.symbols[i];
      for(var layerName in LAYERS){
        try{
          var layerCfg=LAYERS[layerName];
          // ✅ 同層同幣只能一個方向
          var hasL=openTrades[sym+'_'+layerName+'_L']||pendingOrders[sym+'_'+layerName+'_L'];
          var hasS=openTrades[sym+'_'+layerName+'_S']||pendingOrders[sym+'_'+layerName+'_S'];
          if(hasL||hasS)continue;

          // 冷卻時間 300 秒
          var coolKey=sym+'_'+layerName+'_cool';
          if(lastSignalTs[coolKey]&&(Date.now()-lastSignalTs[coolKey])<300000)continue;

          // 同方向最多 5 張
          var dirKey=null;
          var res=await calcSignal(sym,layerName);
          if(!res||res.signal==='HOLD')continue;

          dirKey=res.signal==='BUY'?'_L':'_S';
          var sameDir=Object.keys(openTrades).filter(function(k){return k.endsWith(dirKey);}).length+
                      Object.keys(pendingOrders).filter(function(k){return k.endsWith(dirKey);}).length;
          if(sameDir>=MAX_SAME_DIR){log('INFO',sym+' ['+layerName+'] 同方向達上限');continue;}

          if(bal.available<layerCfg.amt){log('WARN',sym+' ['+layerName+'] 餘額不足');continue;}

          var cur=res.price;
          if(!cur||isNaN(cur))continue;

          // ✅ ATR 動態止損止盈
          var atrVal=res.atr||cur*0.01;
          var slDist=Math.max(atrVal*layerCfg.atrMult.sl,cur*MIN_SL/100);
          var tpDist=Math.max(atrVal*layerCfg.atrMult.tp,slDist*MIN_RR);
          var slP,tpP,limitPrice;

          if(res.signal==='BUY'){
            slP=+(cur-slDist).toFixed(4);
            tpP=+(cur+tpDist).toFixed(4);
            // ✅ 限價掛在現價下方（等回調）
            limitPrice=+(cur*(1-layerCfg.limitOffset)).toFixed(4);
          }else{
            slP=+(cur+slDist).toFixed(4);
            tpP=+(cur-tpDist).toFixed(4);
            // 空單限價掛在現價上方（等反彈）
            limitPrice=+(cur*(1+layerCfg.limitOffset)).toFixed(4);
          }

          var tradeKey=sym+'_'+layerName+(res.signal==='BUY'?'_L':'_S');
          var positionSide=res.signal==='BUY'?'LONG':'SHORT';

          if(res.signal==='BUY'||cfg.allowShort){
            var lo=await placeLimitOrder({
              symbol:sym,side:res.signal==='BUY'?'BUY':'SELL',
              positionSide:positionSide,
              amt:layerCfg.amt,lev:layerCfg.lev,
              price:cur,limitPrice:limitPrice,
              stopLoss:slP,takeProfit:tpP,
              layer:layerName,layerName:layerCfg.name
            });
            if(lo){
              lastSignalTs[coolKey]=Date.now();
              pendingOrders[tradeKey]={
                symbol:sym,positionSide:positionSide,
                layer:layerName,layerName:layerCfg.name,
                orderId:lo.orderId,qty:lo.qty,
                limitPrice:limitPrice,
                stopLoss:slP,takeProfit:tpP,
                openTime:Date.now()
              };
            }
          }
        }catch(e){log('ERROR',sym+' ['+layerName+']: '+e.message);}
      }
    }
    await checkPositions();
  }catch(e){log('ERROR','Loop: '+e.message);}
}

// ══════════════════════════════════
// Telegram
// ══════════════════════════════════
function tg(text,chatId){
  var id=chatId||ENV.TG_CHAT;if(!ENV.TG_TOKEN||!id)return;
  var body=JSON.stringify({chat_id:id,text:text,parse_mode:'HTML'});
  var req=https.request({hostname:'api.telegram.org',path:'/bot'+ENV.TG_TOKEN+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(r){var d='';r.on('data',function(c){d+=c;});});
  req.on('error',function(){});req.write(body);req.end();
}

var lastUpdateId=0;
function tgPoll(){
  if(!ENV.TG_TOKEN)return;
  var req=https.request({hostname:'api.telegram.org',path:'/bot'+ENV.TG_TOKEN+'/getUpdates?offset='+(lastUpdateId+1)+'&timeout=10&limit=5',method:'GET'},function(res){
    var d='';res.on('data',function(c){d+=c;});
    res.on('end',function(){
      try{var json=JSON.parse(d);if(json.ok&&json.result&&json.result.length>0){json.result.forEach(function(u){if(u.update_id>lastUpdateId)lastUpdateId=u.update_id;setImmediate(function(){handleUpdate(u);});});}}catch(e){}
      setTimeout(tgPoll,500);
    });
  });
  req.on('error',function(){setTimeout(tgPoll,5000);});
  req.setTimeout(15000,function(){req.destroy();setTimeout(tgPoll,1000);});
  req.end();
}

function handleUpdate(update){
  var msg=update.message||update.edited_message;if(!msg)return;
  var chatId=String(msg.chat.id),text=(msg.text||'').trim();
  if(ENV.TG_CHAT&&chatId!==ENV.TG_CHAT){tg('Unauthorized',chatId);return;}
  var parts=text.split(' '),cmd=parts[0].toLowerCase();
  log('INFO','CMD: '+cmd+' from '+chatId);

  if(cmd==='/help'||cmd==='/start'){
    tg('🐴 Bybit 海馬 v2.0\n\n短期(3m): ATR×1.5/2.5 門檻4\n中期(5m): ATR×2.0/3.5 門檻5\n長期(1h): ATR×2.5/5.0 門檻5\n\n限價掛單 + 分倉出場\nEMA50/200趨勢過濾\n\n/go - 啟動\n/stop - 停止\n/status - 狀態\n/positions - 持倉\n/pending - 掛單\n/stats - 績效\n/history - 近10筆\n/log - 日誌\n/brain - 學習狀態\n/scalp N - 短期門檻\n/swing N - 中期門檻\n/long N - 長期門檻\n/short - 切換空單\n/addsym SYMBOL\n/delsym SYMBOL',chatId);return;
  }

  if(cmd==='/go'){
    if(cfg.botRunning){tg('⚠️ 已在運行',chatId);return;}
    cfg.botRunning=true;
    botTimer=setInterval(function(){tradingLoop().catch(function(e){log('ERROR','Timer: '+e.message);});},60000);
    tradingLoop().catch(function(e){log('ERROR','Go: '+e.message);});
    tg('🚀 海馬 v2.0 啟動!\n幣種: '+cfg.symbols.join(',')+'\n限價掛單模式\nATR動態止損\nEMA50/200趨勢過濾\nSelf-Learning: ON ✅',chatId);return;
  }

  if(cmd==='/stop'){cfg.botRunning=false;clearInterval(botTimer);botTimer=null;tg('⏹ 已停止',chatId);return;}

  if(cmd==='/status'){
    getBalance().then(function(bal){
      var d=getDayStat(),all=stats.allTime;
      var posCount=Object.keys(openTrades).length;
      var pendCount=Object.keys(pendingOrders).length;
      tg('[Bybit] 狀態\n'+(cfg.botRunning?'🟢 運行中':'🔴 已停止')+'\n餘額:'+bal.available.toFixed(2)+'U\n今日:'+d.total+'筆 WR:'+(d.total>0?(d.wins/d.total*100).toFixed(0):0)+'% PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U\n累計:'+all.total+'筆 PnL:'+(all.pnl>=0?'+':'')+all.pnl.toFixed(2)+'U\n持倉:'+posCount+' 掛單:'+pendCount+'\n幣種:'+cfg.symbols.join(','),chatId);
    }).catch(function(e){tg('Error: '+e.message,chatId);});return;
  }

  if(cmd==='/positions'){
    var keys=Object.keys(openTrades);
    if(!keys.length){tg('[Bybit] 無持倉',chatId);return;}
    var m='[Bybit] 持倉\n\n';
    keys.forEach(function(k){var t=openTrades[k];var layer=LAYERS[t.layer];m+=(t.side==='LONG'?'🟢':'🔴')+' '+t.symbol+' ['+layer.name+']\nHold:'+Math.round((Date.now()-t.openTime)/60000)+'min '+(t.halfExited?'半倉已出':'')+'\n\n';});
    tg(m,chatId);return;
  }

  if(cmd==='/pending'){
    var pkeys=Object.keys(pendingOrders);
    if(!pkeys.length){tg('[Bybit] 無掛單',chatId);return;}
    var pm='[Bybit] 掛單\n\n';
    pkeys.forEach(function(k){var po=pendingOrders[k];pm+='📋 '+po.symbol+' ['+po.layerName+']\n掛單價:'+po.limitPrice+'\n等待:'+Math.round((Date.now()-po.openTime)/60000)+'min\n\n';});
    tg(pm,chatId);return;
  }

  if(cmd==='/stats'){
    var al=stats.allTime,dds=getDayStat();
    tg('[Bybit] 📊 績效\n今日:'+dds.total+'筆 WR:'+(dds.total>0?(dds.wins/dds.total*100).toFixed(0):0)+'% PnL:'+(dds.pnl>=0?'+':'')+dds.pnl.toFixed(2)+'U\n累計:'+al.total+'筆 WR:'+(al.total>0?(al.wins/al.total*100).toFixed(1):0)+'% PnL:'+(al.pnl>=0?'+':'')+al.pnl.toFixed(2)+'U',chatId);return;
  }

  if(cmd==='/history'){
    var tr=stats.trades.slice(-10).reverse();if(!tr.length){tg('尚無交易',chatId);return;}
    tg('[Bybit] 近10筆\n'+tr.map(function(t){return (t.pnl>=0?'✅':'❌')+' '+t.symbol+'['+(t.layer||'?')+'] '+(t.pnl>=0?'+':'')+t.pnl.toFixed(4)+'U '+t.reason;}).join('\n'),chatId);return;
  }

  if(cmd==='/log'){
    var logs=memLog.slice(-15).map(function(l){return '['+l.lv+'] '+l.msg.slice(0,80);}).join('\n');
    tg('[Bybit] 日誌\n'+(logs||'無'),chatId);return;
  }

  if(cmd==='/brain'){
    var lastAdj=brain.adjustHistory&&brain.adjustHistory.length?brain.adjustHistory[brain.adjustHistory.length-1]:{changes:['尚未調整']};
    tg('[Bybit] 🧠 學習狀態\n已學習:'+(brain.learnCount||0)+'次\n最近調整:'+lastAdj.changes.join(', ')+'\nRSI超賣:'+cfg.params.oversold+' 超買:'+cfg.params.overbought+'\nBB標準差:'+cfg.params.bbStdDev,chatId);return;
  }

  if(cmd==='/scalp'&&parts[1]){var nv=parseFloat(parts[1]);if(nv>=1&&nv<=6){LAYERS.scalp.threshold=Math.round(nv);tg('✅ 短期門檻 -> '+LAYERS.scalp.threshold,chatId);}return;}
  if(cmd==='/swing'&&parts[1]){var nv2=parseFloat(parts[1]);if(nv2>=1&&nv2<=6){LAYERS.swing.threshold=Math.round(nv2);tg('✅ 中期門檻 -> '+LAYERS.swing.threshold,chatId);}return;}
  if(cmd==='/long'&&parts[1]){var nv3=parseFloat(parts[1]);if(nv3>=1&&nv3<=6){LAYERS.long.threshold=Math.round(nv3);tg('✅ 長期門檻 -> '+LAYERS.long.threshold,chatId);}return;}
  if(cmd==='/short'){cfg.allowShort=!cfg.allowShort;tg('✅ 空單 -> '+(cfg.allowShort?'開啟':'關閉'),chatId);return;}
  if(cmd==='/addsym'&&parts[1]){var ns=parts[1].toUpperCase();if(!cfg.symbols.includes(ns)){cfg.symbols.push(ns);tg('✅ 新增 '+ns,chatId);}else tg(ns+' 已存在',chatId);return;}
  if(cmd==='/delsym'&&parts[1]){cfg.symbols=cfg.symbols.filter(function(s){return s!==parts[1].toUpperCase();});tg('✅ 移除 '+parts[1].toUpperCase(),chatId);return;}
  if(text.startsWith('/'))tg('未知指令，輸入 /help',chatId);
}

async function recoverPositions(){
  try{
    var pos=await getPositions();
    if(!pos||pos.length===0){log('INFO','無需恢復持倉');return;}
    var recovered=0;
    for(var i=0;i<pos.length;i++){
      var p=pos[i];
      var size=parseFloat(p.size||0);
      if(size===0)continue;
      var sym=p.symbol;
      var side=p.side==='Buy'?'LONG':'SHORT';
      var key=sym+'_swing_'+(side==='LONG'?'L':'S');
      if(openTrades[key])continue;
      openTrades[key]={symbol:sym,side:side,entry:parseFloat(p.avgPrice||0),qty:size,layer:'swing',openTime:Date.now()-30*60000,halfExited:false,slMoved:false};
      recovered++;
      log('INFO','恢復持倉: '+sym+' '+side);
    }
    if(recovered>0)tg('[Bybit] 🔄 恢復 '+recovered+' 個持倉');
  }catch(e){log('WARN','recoverPositions: '+e.message);}
}

function startServer(){
  http.createServer(function(req,res){res.writeHead(200);res.end(JSON.stringify({status:'ok',running:cfg.botRunning}));}).listen(3001,function(){log('OK','Server Port:3001');});
}

function scheduleReport(){
  function ms10(){var now=new Date(),tw=new Date(now.toLocaleString('en-US',{timeZone:'Asia/Taipei'}));var n=new Date(tw);n.setHours(10,0,0,0);if(tw.getHours()>=10)n.setDate(n.getDate()+1);return n-tw;}
  setTimeout(function(){
    var d=getDayStat(),all=stats.allTime;
    tg('[Bybit] 📊 每日報告\n今日:'+d.total+'筆 PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U\n累計:'+all.total+'筆 PnL:'+(all.pnl>=0?'+':'')+all.pnl.toFixed(2)+'U');
    setInterval(function(){var d2=getDayStat(),all2=stats.allTime;tg('[Bybit] 📊 每日報告\n今日:'+d2.total+'筆 PnL:'+(d2.pnl>=0?'+':'')+d2.pnl.toFixed(2)+'U\n累計:'+all2.total+'筆 PnL:'+(all2.pnl>=0?'+':'')+all2.pnl.toFixed(2)+'U');},24*60*60*1000);
  },ms10());
}

async function main(){
  console.log('\nBybit 海馬 v2.0 - ATR+限價+趨勢過濾\n');
  log('INFO','Starting...');
  startServer();
  try{
    var bal=await getBalance();
    log('OK','Bybit API OK! Available:'+bal.available.toFixed(2)+'U');
    tg('[Bybit 海馬 v2.0] 🟢 上線!\n餘額:'+bal.available.toFixed(2)+'U\n\n新功能:\n✅ ATR動態止損\n✅ EMA50/200趨勢過濾\n✅ 限價掛單\n✅ 分倉出場\n✅ 移動止損\n\n/go 啟動交易');
    await recoverPositions();
  }catch(e){log('ERROR','API fail: '+e.message);tg('[Bybit] ⚠️ '+e.message);}
  log('INFO','Starting Telegram polling...');
  tgPoll();scheduleReport();
  log('OK','Ready. /help');
}

process.on('uncaughtException',function(e){log('ERROR','Uncaught: '+e.message);tg('🚨 海馬異常!\n'+e.message);});
process.on('unhandledRejection',function(e){log('ERROR','Unhandled: '+(e&&e.message?e.message:String(e)));});
process.on('SIGINT',function(){var cnt=0;try{cnt=Object.keys(openTrades).length;}catch(e){}tg('⛔ 海馬已關閉!\n持倉:'+cnt+'個');setTimeout(function(){process.exit(0);},2000);});
setInterval(function(){if(!cfg.botRunning)return;var hr=new Date().getMinutes();if(hr===0){var d=getDayStat();tg('💓 海馬心跳\n今日:'+d.total+'筆 PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U');}},60000);
main().catch(function(e){log('ERROR','Start fail: '+e.message);process.exit(1);});

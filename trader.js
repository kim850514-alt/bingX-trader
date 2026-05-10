'use strict';
const crypto=require('crypto'),https=require('https'),http=require('http'),fs=require('fs');
const ENV={
  BINGX_API_KEY:process.env.BINGX_API_KEY||'',
  BINGX_SECRET:process.env.BINGX_SECRET_KEY||'',
  TG_TOKEN:process.env.TELEGRAM_TOKEN||'',
  TG_CHAT:process.env.TELEGRAM_CHAT_ID||''
};

// ══════════════════════════════════
// 三層策略設定
// ══════════════════════════════════
const LAYERS={
  scalp:{name:'短期',tf:'1m',sl:1.0,tp:1.5,lev:5,amt:1,threshold:2,maxHold:15},
  swing:{name:'中期',tf:'5m',sl:2.0,tp:3.0,lev:5,amt:1,threshold:3,maxHold:120},
  long: {name:'長期',tf:'1h',sl:3.0,tp:6.0,lev:5,amt:1,threshold:3,maxHold:1440}
};

// ✅ SL/TP 最小值限制（不可調動）
const MIN_SL=1.0;  // 最小止損 1%
const MIN_RR=1.5;  // 最小風報比 1:1.5

let cfg={
  symbols:['SIREN-USDT','DOGE-USDT','XRP-USDT'],
  botRunning:false,
  allowShort:true,
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
  learnFromTrade(t);
  learnCycleCount++;
  if(learnCycleCount>=3){
    learnCycleCount=0;learningPause=true;
    log('AI','=== 學習週期觸發！暫停交易 ===');
    tg('[BingX 🧠] 學習週期開始\n已完成3筆，分析中...');
    autoAdjust();
    setTimeout(function(){learningPause=false;log('AI','=== 學習完成！恢復交易 ===');tg('[BingX 🧠] 學習完成！恢復交易');},3000);
  }
}

let brain=loadBrain();
function loadBrain(){
  var paths=['./shared_brain.json','./bingx_brain.json'];
  for(var i=0;i<paths.length;i++){if(fs.existsSync(paths[i]))try{return JSON.parse(fs.readFileSync(paths[i],'utf8'));}catch(e){}}
  return{symbolPerf:{},hourPerf:{},adjustHistory:[],learnCount:0,bestHours:[],worstHours:[],bestSymbols:[],worstSymbols:[]};
}
function saveBrain(){fs.writeFileSync('./shared_brain.json',JSON.stringify(brain,null,2));fs.writeFileSync('./bingx_brain.json',JSON.stringify(brain,null,2));}

var memLog=[];
function log(lv,msg){console.log('['+nowTW()+'][BX]['+lv+'] '+msg);memLog.push({ts:nowTW(),lv:lv,msg:msg});if(memLog.length>300)memLog.shift();}

// ══════════════════════════════════
// BingX API
// ══════════════════════════════════
function bxSign(qs){return crypto.createHmac('sha256',ENV.BINGX_SECRET).update(qs).digest('hex');}
function bxBuildQ(params){
  var p=Object.assign({},params,{timestamp:Date.now()});
  var qs=Object.keys(p).filter(function(k){return p[k]!=null&&p[k]!=='';}).map(function(k){return k+'='+p[k];}).join('&');
  return qs+'&signature='+bxSign(qs);
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
  try{var r=await bxReq('GET','/openApi/swap/v2/user/balance');if(r.code===0)return{available:parseFloat(r.data.balance.availableMargin||0),total:parseFloat(r.data.balance.balance||0)};}catch(e){}
  throw new Error('Cannot get BingX balance');
}
async function getPositions(sym){sym=sym||'';try{var r=await bxReq('GET','/openApi/swap/v2/user/positions',sym?{symbol:sym}:{});if(r.code===0)return(r.data||[]).filter(function(p){return parseFloat(p.positionAmt||0)!==0;});}catch(e){}return[];}
async function getKlines(sym,tf,lim){
  lim=lim||150;
  var bxTf={'1m':'1m','3m':'3m','5m':'5m','15m':'15m','1h':'1h','4h':'4h'}[tf]||'5m';
  try{var r=await bxReq('GET','/openApi/swap/v2/quote/klines',{symbol:sym,interval:bxTf,limit:lim});if(r.code===0&&Array.isArray(r.data))return r.data;}catch(e){log('WARN','Kline fail '+sym+': '+e.message);}return[];
}
async function getTicker(sym){try{var r=await bxReq('GET','/openApi/swap/v2/quote/ticker',{symbol:sym});if(r.code===0)return r.data;}catch(e){}return null;}
async function setLev(sym,lev){var sides=['LONG','SHORT'];for(var i=0;i<sides.length;i++){try{await bxReq('POST','/openApi/swap/v2/trade/leverage',{symbol:sym,side:sides[i],leverage:lev});}catch(e){}}}

async function placeOrder(o){
  if(o.lev>1)await setLev(o.symbol,o.lev);
  var notional=o.amt*o.lev;
  var p={symbol:o.symbol,side:o.side,positionSide:o.positionSide,type:'MARKET',quoteOrderQty:String(notional)};
  var r=await bxReq('POST','/openApi/swap/v2/trade/order',p);
  if(r.code===0){
    var ps=o.positionSide;
    var closeSide=ps==='LONG'?'SELL':'BUY';
    if(o.stopLoss){try{await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:o.symbol,side:closeSide,positionSide:ps,type:'STOP_MARKET',stopPrice:String(o.stopLoss),quantity:String(notional/o.price||1),workingType:'MARK_PRICE'});}catch(e){log('WARN','SL設定失敗');}}
    if(o.takeProfit){try{await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:o.symbol,side:closeSide,positionSide:ps,type:'TAKE_PROFIT_MARKET',stopPrice:String(o.takeProfit),quantity:String(notional/o.price||1),workingType:'MARK_PRICE'});}catch(e){log('WARN','TP設定失敗');}}
    tg('[BingX] ✅ 開單\n'+(o.side==='BUY'?'🟢':'🔴')+' '+o.symbol+' ['+o.layer+']\n保證金:'+o.amt+'U × '+o.lev+'x\nSL:'+o.stopLoss+' TP:'+o.takeProfit);
    return r.data.order;
  }else{
    log('ERROR','開單失敗 '+o.symbol+' '+r.msg);
    tg('[BingX] ❌ 開單失敗\n'+o.symbol+' ['+o.layer+']\n'+r.msg);
    return null;
  }
}
async function closePos(sym,ps,qty){
  var r=await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:sym,side:ps==='LONG'?'SELL':'BUY',positionSide:ps,type:'MARKET',quantity:String(qty)});
  return r.code===0?r.data.order:null;
}

// ══════════════════════════════════
// 技術指標
// ══════════════════════════════════
var I={
  ma:function(a,n){if(a.length<n)return null;return a.slice(-n).reduce(function(s,v){return s+v;},0)/n;},
  ema:function(a,n){if(a.length<n)return null;var k=2/(n+1),ema=a.slice(0,n).reduce(function(s,v){return s+v;},0)/n;for(var i=n;i<a.length;i++)ema=a[i]*k+ema*(1-k);return ema;},
  rsi:function(a,n){n=n||14;if(a.length<n+1)return null;var g=0,l=0;for(var i=a.length-n;i<a.length;i++){var d=a[i]-a[i-1];if(d>0)g+=d;else l-=d;}return 100-100/(1+g/(l||0.0001));},
  boll:function(a,n,d){n=n||20;d=d||2;if(a.length<n)return null;var sl=a.slice(-n),m=sl.reduce(function(s,v){return s+v;},0)/n,std=Math.sqrt(sl.reduce(function(s,v){return s+Math.pow(v-m,2);},0)/n);return{upper:m+d*std,mid:m,lower:m-d*std};},
  macd:function(a){if(a.length<26)return null;var fast=I.ema(a,12),slow=I.ema(a,26);if(!fast||!slow)return null;return{hist:fast-slow};}
};

// ══════════════════════════════════
// 信號計算（按層）
// ══════════════════════════════════
async function calcSignal(sym,layer){
  var cfg2=LAYERS[layer];
  var kl=await getKlines(sym,cfg2.tf,150);
  if(kl.length<50)return null;
  var closes=kl.map(function(k){return parseFloat(k[4]);});
  var vols=kl.map(function(k){return parseFloat(k[5]);});
  var last=closes[closes.length-1];
  var p=cfg.params;
  var bs=0,ss=0,rsn=[];

  // RSI
  var rsi=I.rsi(closes,p.rsiPeriod||7),rsiPrev=I.rsi(closes.slice(0,-1),p.rsiPeriod||7);
  if(rsi!==null&&rsiPrev!==null){
    if(rsiPrev<p.oversold&&rsi>p.oversold){bs+=3;rsn.push('RSI回升('+rsi.toFixed(0)+')');}
    if(rsiPrev>p.overbought&&rsi<p.overbought){ss+=3;rsn.push('RSI回落('+rsi.toFixed(0)+')');}
    if(rsi<50){bs+=1;}else{ss+=1;}
  }

  // BB
  var bb=I.boll(closes,p.bbPeriod||15,p.bbStdDev||2);
  if(bb){
    if(last<bb.lower){bs+=2;rsn.push('BB下軌');}else if(last<bb.mid){bs+=1;rsn.push('BB下半');}
    if(last>bb.upper){ss+=2;rsn.push('BB上軌');}else if(last>bb.mid){ss+=1;rsn.push('BB上半');}
  }

  // EMA
  var ema9=I.ema(closes,9),ema21=I.ema(closes,21);
  if(ema9&&ema21){
    if(ema9>ema21){bs+=1;rsn.push('EMA多');}else{ss+=1;rsn.push('EMA空');}
    // 長期額外用 50/200 EMA
    if(layer==='long'){
      var ema50=I.ema(closes,50),ema200=I.ema(closes,Math.min(200,closes.length-1));
      if(ema50&&ema200){if(ema50>ema200){bs+=2;rsn.push('黃金交叉');}else{ss+=2;rsn.push('死亡交叉');}}
    }
  }

  // MACD
  var macdData=I.macd(closes);
  if(macdData){if(macdData.hist>0){bs+=1;rsn.push('MACD+');}else{ss+=1;rsn.push('MACD-');}}

  // 成交量
  var avgVol=I.ma(vols.slice(0,-1),20);
  if(avgVol&&vols[vols.length-1]>avgVol*p.volMultiple){bs+=1;ss+=1;rsn.push('量增');}

  var threshold=cfg2.threshold;
  var signal='HOLD';
  if(bs>=threshold&&bs>ss)signal='BUY';
  else if(ss>=threshold&&ss>bs)signal='SELL';

  log('INFO',sym+' ['+layer+'] BS:'+bs+' SS:'+ss+' -> '+signal+(rsn.length?' ['+rsn.join('+')+']':''));
  return{signal:signal,bs:bs,ss:ss,reasons:rsn.join('+'),price:last};
}

// ══════════════════════════════════
// 持倉記錄（三層獨立）
// key 格式: sym_layer_L 或 sym_layer_S
// ══════════════════════════════════
var learnCycleCount=0,learningPause=false;

function learnFromTrade(t){
  brain.learnCount=(brain.learnCount||0)+1;
  var symbol=t.symbol,pnl=t.pnl,holdMin=t.holdMin;
  if(!brain.symbolPerf[symbol])brain.symbolPerf[symbol]={wins:0,losses:0,pnl:0,avgHold:0,count:0};
  var sp=brain.symbolPerf[symbol];
  if(pnl>0)sp.wins++;else sp.losses++;sp.pnl+=pnl;sp.count++;
  sp.avgHold=((sp.avgHold*(sp.count-1))+holdMin)/sp.count;
  var hr=String(hourTW());
  if(!brain.hourPerf[hr])brain.hourPerf[hr]={wins:0,losses:0,pnl:0};
  var hp=brain.hourPerf[hr];if(pnl>0)hp.wins++;else hp.losses++;hp.pnl+=pnl;
  updateBestWorst();saveBrain();
}

function updateBestWorst(){
  brain.bestHours=Object.keys(brain.hourPerf).filter(function(h){var p=brain.hourPerf[h];var t=p.wins+p.losses;return t>=3&&p.wins/t>=0.6;});
  brain.worstHours=Object.keys(brain.hourPerf).filter(function(h){var p=brain.hourPerf[h];var t=p.wins+p.losses;return t>=3&&p.wins/t<0.35;});
  brain.bestSymbols=Object.keys(brain.symbolPerf).filter(function(s){var p=brain.symbolPerf[s];var t=p.wins+p.losses;return t>=3&&p.wins/t>=0.55;});
  brain.worstSymbols=Object.keys(brain.symbolPerf).filter(function(s){var p=brain.symbolPerf[s];var t=p.wins+p.losses;return t>=5&&p.wins/t<0.25&&p.pnl<-10;});
}

function autoAdjust(){
  var recent=stats.trades.slice(-20);if(recent.length<3)return;
  var wins=recent.filter(function(t){return t.pnl>0;});
  var losses=recent.filter(function(t){return t.pnl<0;});
  var wr=wins.length/recent.length;
  var avgWin=wins.length?wins.reduce(function(s,t){return s+t.pnl;},0)/wins.length:0;
  var avgLoss=losses.length?Math.abs(losses.reduce(function(s,t){return s+t.pnl;},0)/losses.length):0;
  var rr=avgLoss>0?avgWin/avgLoss:1;
  var changes=[];
  var p=cfg.params;

  // RSI 調整
  if(wr<0.38&&p.oversold>20){var rv=p.oversold;p.oversold=Math.max(20,rv-3);changes.push('RSI超賣 '+rv+'->'+p.oversold);}
  if(wr<0.38&&p.overbought<80){var rv2=p.overbought;p.overbought=Math.min(80,rv2+3);changes.push('RSI超買 '+rv2+'->'+p.overbought);}
  if(wr>0.62&&p.oversold<45){var rv3=p.oversold;p.oversold=Math.min(45,rv3+2);changes.push('RSI超賣放寬 '+rv3+'->'+p.oversold);}
  if(wr>0.62&&p.overbought>55){var rv4=p.overbought;p.overbought=Math.max(55,rv4-2);changes.push('RSI超買放寬 '+rv4+'->'+p.overbought);}

  // BB 調整
  if(wr<0.38&&p.bbStdDev<2.8){var bv=p.bbStdDev;p.bbStdDev=+(Math.min(2.8,bv+0.1)).toFixed(1);changes.push('BB寬度 '+bv+'->'+p.bbStdDev);}
  if(wr>0.62&&p.bbStdDev>1.5){var bv2=p.bbStdDev;p.bbStdDev=+(Math.max(1.5,bv2-0.1)).toFixed(1);changes.push('BB收窄 '+bv2+'->'+p.bbStdDev);}

  // 量能調整
  if(wr<0.38&&p.volMultiple<1.8){var vv=p.volMultiple;p.volMultiple=+(Math.min(1.8,vv+0.1)).toFixed(1);changes.push('量能 '+vv+'->'+p.volMultiple);}
  if(wr>0.62&&p.volMultiple>1.0){var vv2=p.volMultiple;p.volMultiple=+(Math.max(1.0,vv2-0.1)).toFixed(1);changes.push('量能降低 '+vv2+'->'+p.volMultiple);}

  // 各層門檻調整
  Object.keys(LAYERS).forEach(function(ln){
    var lc=LAYERST[ln];
    var layerTrades=recent.filter(function(t){return t.layer===ln;});
    if(layerTrades.length>=3){
      var lwr=layerTrades.filter(function(t){return t.pnl>0;}).length/layerTrades.length;
      if(lwr<0.35&&lc.threshold<5){lc.threshold++;changes.push(lc.name+'門檻 ->'+lc.threshold);}
      if(lwr>0.65&&lc.threshold>1){lc.threshold--;changes.push(lc.name+'門檻降 ->'+lc.threshold);}
    }
  });

  if(changes.length){
    brain.adjustHistory=brain.adjustHistory||[];
    brain.adjustHistory.push({date:todayKey(),changes:changes,wr:(wr*100).toFixed(1),rr:rr.toFixed(2)});
    if(brain.adjustHistory.length>100)brain.adjustHistory=brain.adjustHistory.slice(-100);
    log('AI','自動調整: '+changes.join(' | '));
    tg('[BingX 🧠 自動調整]\n'+changes.join('\n')+'\nWR:'+(wr*100).toFixed(1)+'% RR:'+rr.toFixed(2));
    saveBrain();
  }
}

var LAYERST=LAYERS; // 讓 autoAdjust 可以修改門檻

async function getActualPnlBX(symbol,openTime){
  try{
    var r=await bxReq('GET','/openApi/swap/v2/trade/allOrders',{symbol:symbol,limit:20});
    if(r.code===0&&r.data&&r.data.orders){
      var orders=r.data.orders.filter(function(o){
        var oTime=parseInt(o.time||o.updateTime||0);
        var orderId=String(o.orderId||'');
        var isClose=(o.side==='SELL'&&o.positionSide==='LONG')||(o.side==='BUY'&&o.positionSide==='SHORT');
        return o.status==='FILLED'&&isClose&&oTime>openTime&&!usedOrderIds.has(orderId);
      });
      if(orders.length>0){
        var latest=orders[0];
        usedOrderIds.add(String(latest.orderId||''));
        var pnl=parseFloat(latest.profit||0)+parseFloat(latest.commission||0);
        return{pnl:pnl,exitPrice:parseFloat(latest.avgPrice||0)};
      }
    }
  }catch(e){log('WARN','getActualPnlBX: '+e.message);}
  return null;
}

async function checkPositions(){
  for(var key in openTrades){
    try{
      var t=openTrades[key];
      var layer=t.layer;
      var layerCfg=LAYERS[layer];
      var tk=await getTicker(t.symbol).catch(function(){return null;});if(!tk)continue;
      var cur=parseFloat(tk.lastPrice);
      var holdMin=Math.round((Date.now()-t.openTime)/60000);
      var ps=t.side;

      // 檢查是否已平倉
      var pos=await getPositions(t.symbol);
      var stillOpen=pos.some(function(p){return p.positionSide===ps&&parseFloat(p.positionAmt||0)!==0;});

      if(!stillOpen&&holdMin>1){
        var actual=await getActualPnlBX(t.symbol,t.openTime);
        var pnl=actual?actual.pnl:(ps==='LONG'?(cur-t.entry)*t.qty*layerCfg.lev:(t.entry-cur)*t.qty*layerCfg.lev);
        var exitPrice=actual?actual.exitPrice:cur;
        var source=actual?'API':'估算';
        recordTrade({symbol:t.symbol,side:t.side,entry:t.entry,exit:exitPrice,qty:t.qty,pnl:pnl,holdMin:holdMin,reason:'TP/SL',layer:layer});
        delete openTrades[key];
        tg('[BingX] '+(pnl>=0?'✅':'❌')+' '+t.symbol+' ['+layerCfg.name+']\nPnL('+source+'):'+(pnl>=0?'+':'')+pnl.toFixed(4)+'U Hold:'+holdMin+'min');
        continue;
      }

      var estPnl=ps==='LONG'?(cur-t.entry)*t.qty*layerCfg.lev:(t.entry-cur)*t.qty*layerCfg.lev;
      var estPnlPct=ps==='LONG'?(cur-t.entry)/t.entry*100:(t.entry-cur)/t.entry*100;
      log('INFO','持倉 '+t.symbol+' ['+layer+'] 估算:'+(estPnl>=0?'+':'')+estPnl.toFixed(2)+'U ('+estPnlPct.toFixed(2)+'%) Hold:'+holdMin+'min');

      // ✅ 移動止盈（Trailing Stop）
      // 獲利達到 TP 的 50% 後啟動
      var tpPct=Math.max(MIN_SL*MIN_RR,layerCfg.tp);
      var trailActivatePct=tpPct*0.5; // 達到 TP 50% 啟動
      var trailStopPct=0.5; // 回落 0.5% 觸發平倉

      if(estPnlPct>=trailActivatePct){
        // 更新最高獲利點
        if(!t.maxProfitPct||estPnlPct>t.maxProfitPct){
          t.maxProfitPct=estPnlPct;
          t.trailActive=true;
          if(!t.trailNotified){
            t.trailNotified=true;
            log('AI',t.symbol+' ['+layer+'] 移動止盈啟動！最高:'+estPnlPct.toFixed(2)+'%');
            tg('[BingX] 🔒 移動止盈啟動\n'+t.symbol+' ['+layerCfg.name+']\n獲利:+'+estPnlPct.toFixed(2)+'%\n跟蹤中...');
          }
        }
        // 從最高點回落超過 trailStopPct 觸發平倉
        if(t.trailActive&&t.maxProfitPct-estPnlPct>=trailStopPct){
          log('AI',t.symbol+' ['+layer+'] 移動止盈觸發！最高:'+t.maxProfitPct.toFixed(2)+'% 現在:'+estPnlPct.toFixed(2)+'%');
          var ot=await closePos(t.symbol,ps,t.qty).catch(function(){return null;});
          if(ot){
            await new Promise(function(res2){setTimeout(res2,1500);});
            var actual2=await getActualPnlBX(t.symbol,t.openTime);
            var pnl2=actual2?actual2.pnl:estPnl;
            var source2=actual2?'API':'估算';
            recordTrade({symbol:t.symbol,side:t.side,entry:t.entry,exit:cur,qty:t.qty,pnl:pnl2,holdMin:holdMin,reason:'移動止盈',layer:layer});
            delete openTrades[key];
            tg('[BingX] 🔒 移動止盈平倉\n'+t.symbol+' ['+layerCfg.name+']\n最高:+'+t.maxProfitPct.toFixed(2)+'%\nPnL('+source2+'):'+(pnl2>=0?'✅ +':'❌ ')+pnl2.toFixed(4)+'U Hold:'+holdMin+'min');
            continue;
          }
        }
      }

      // K線反向訊號平倉
      if(holdMin>=5&&stillOpen){
        var res=await calcSignal(t.symbol,layer).catch(function(){return null;});
        if(res){
          var reverseSignal=(ps==='LONG'&&res.signal==='SELL')||(ps==='SHORT'&&res.signal==='BUY');
          if(reverseSignal){
            log('AI',t.symbol+' ['+layer+'] 反向訊號，平倉');
            var o=await closePos(t.symbol,ps,t.qty).catch(function(){return null;});
            if(o){
              await new Promise(function(res3){setTimeout(res3,1500);});
              var actual3=await getActualPnlBX(t.symbol,t.openTime);
              var pnl3=actual3?actual3.pnl:estPnl;
              var source3=actual3?'API':'估算';
              recordTrade({symbol:t.symbol,side:t.side,entry:t.entry,exit:cur,qty:t.qty,pnl:pnl3,holdMin:holdMin,reason:'反向平倉',layer:layer});
              delete openTrades[key];
              tg('[BingX] 🔄 反向平倉\n'+t.symbol+' ['+layerCfg.name+']\nPnL('+source3+'):'+(pnl3>=0?'✅ +':'❌ ')+pnl3.toFixed(4)+'U Hold:'+holdMin+'min');
              continue;
            }
          }
        }
      }

      // 超時平倉
      if(holdMin>=layerCfg.maxHold){
        var o2=await closePos(t.symbol,ps,t.qty).catch(function(){return null;});
        if(o2){
          await new Promise(function(res4){setTimeout(res4,1500);});
          var actual4=await getActualPnlBX(t.symbol,t.openTime);
          var pnl4=actual4?actual4.pnl:estPnl;
          var source4=actual4?'API':'估算';
          recordTrade({symbol:t.symbol,side:t.side,entry:t.entry,exit:cur,qty:t.qty,pnl:pnl4,holdMin:holdMin,reason:'超時平倉',layer:layer});
          delete openTrades[key];
          tg('[BingX] ⏰ 超時\n'+t.symbol+' ['+layerCfg.name+']\nPnL('+source4+'):'+(pnl4>=0?'✅ +':'❌ ')+pnl4.toFixed(4)+'U Hold:'+holdMin+'min');
        }
      }
    }catch(e){log('ERROR','checkPos: '+e.message);}
  }
}

var botTimer=null,startTime=Date.now();

async function tradingLoop(){
  if(!cfg.botRunning)return;
  if(learningPause){log('INFO','學習暫停中');await checkPositions();return;}
  log('INFO','=== Loop '+nowTW()+' ===');
  try{
    var bal=await getBalance().catch(function(){return null;});
    if(!bal){log('WARN','無法取得餘額');return;}

    for(var i=0;i<cfg.symbols.length;i++){
      var sym=cfg.symbols[i];
      for(var layerName in LAYERS){
        try{
          var layerCfg=LAYERS[layerName];
          // 檢查這個幣種+層是否已有持倉
          var hasLong=openTrades[sym+'_'+layerName+'_L'];
          var hasShort=openTrades[sym+'_'+layerName+'_S'];
          if(hasLong||hasShort)continue;

          var res=await calcSignal(sym,layerName);
          if(!res||res.signal==='HOLD')continue;

          if(bal.available<layerCfg.amt){log('WARN',sym+' ['+layerName+'] 餘額不足');continue;}

          var cur=res.price;
          // ✅ 強制最小 SL 1%，最小 RR 1:1.5
          var slPct=Math.max(MIN_SL,layerCfg.sl);
          var tpPct=Math.max(slPct*MIN_RR,layerCfg.tp);
          var slD=cur*slPct/100;
          var tpD=cur*tpPct/100;
          var slP=+(res.signal==='BUY'?cur-slD:cur+slD).toFixed(4);
          var tpP=+(res.signal==='BUY'?cur+tpD:cur-tpD).toFixed(4);

          if(res.signal==='BUY'){
            var o=await placeOrder({symbol:sym,side:'BUY',positionSide:'LONG',amt:layerCfg.amt,lev:layerCfg.lev,price:cur,stopLoss:slP,takeProfit:tpP,layer:layerCfg.name});
            if(o){
              openTrades[sym+'_'+layerName+'_L']={symbol:sym,side:'LONG',entry:cur,qty:layerCfg.amt*layerCfg.lev/cur,layer:layerName,openTime:Date.now()};
            }
          }else if(res.signal==='SELL'&&cfg.allowShort){
            var o2=await placeOrder({symbol:sym,side:'SELL',positionSide:'SHORT',amt:layerCfg.amt,lev:layerCfg.lev,price:cur,stopLoss:slP,takeProfit:tpP,layer:layerCfg.name});
            if(o2){
              openTrades[sym+'_'+layerName+'_S']={symbol:sym,side:'SHORT',entry:cur,qty:layerCfg.amt*layerCfg.lev/cur,layer:layerName,openTime:Date.now()};
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
      try{
        var json=JSON.parse(d);
        if(json.ok&&json.result&&json.result.length>0){
          json.result.forEach(function(u){
            if(u.update_id>lastUpdateId)lastUpdateId=u.update_id;
            setImmediate(function(){handleUpdate(u);});
          });
        }
      }catch(e){}
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
    tg('🐎 BingX 三層策略\n\n短期: 1m SL0.5% TP0.8%\n中期: 5m SL1% TP1.5%\n長期: 1h SL2% TP5%\n每層 1U×5x=5U 倉位\n幣種: '+cfg.symbols.join(',')+'\n\n/go - 啟動\n/stop - 停止\n/status - 狀態\n/positions - 持倉\n/stats - 績效\n/history - 近10筆\n/log - 日誌',chatId);return;
  }

  if(cmd==='/go'){
    if(cfg.botRunning){tg('⚠️ 已在運行',chatId);return;}
    cfg.botRunning=true;
    botTimer=setInterval(function(){tradingLoop().catch(function(e){log('ERROR','Timer: '+e.message);});},60000);
    tradingLoop().catch(function(e){log('ERROR','Go: '+e.message);});
    tg('🚀 BingX 三層策略啟動!\n\n短期(1m): SL0.5% TP0.8%\n中期(5m): SL1% TP1.5%\n長期(1h): SL2% TP5%\n\n幣種: '+cfg.symbols.join(',')+'\n每層保證金: 1U × 5x\nSelf-Learning: ON ✅',chatId);return;
  }

  if(cmd==='/stop'){cfg.botRunning=false;clearInterval(botTimer);botTimer=null;tg('⏹ 已停止',chatId);return;}

  if(cmd==='/status'){
    getBalance().then(function(bal){
      var d=getDayStat(),all=stats.allTime;
      var posCount=Object.keys(openTrades).length;
      tg('[BingX] 狀態\n'+(cfg.botRunning?'🟢 運行中':'🔴 已停止')+'\n餘額:'+bal.available.toFixed(2)+'U\n今日:'+d.total+'筆 WR:'+(d.total>0?(d.wins/d.total*100).toFixed(0):0)+'% PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U\n累計:'+all.total+'筆 PnL:'+(all.pnl>=0?'+':'')+all.pnl.toFixed(2)+'U\n持倉:'+posCount+'\n幣種:'+cfg.symbols.join(','),chatId);
    }).catch(function(e){tg('Error: '+e.message,chatId);});return;
  }

  if(cmd==='/positions'){
    var keys=Object.keys(openTrades);
    if(!keys.length){tg('[BingX] 無持倉',chatId);return;}
    var m='[BingX] 持倉\n\n';
    keys.forEach(function(k){
      var t=openTrades[k];
      var layer=LAYERS[t.layer];
      m+=(t.side==='LONG'?'🟢':'🔴')+' '+t.symbol+' ['+layer.name+']\nHold:'+Math.round((Date.now()-t.openTime)/60000)+'min\n\n';
    });
    tg(m,chatId);return;
  }

  if(cmd==='/stats'){
    var al=stats.allTime,dds=getDayStat();
    tg('[BingX] 📊 績效\n今日:'+dds.total+'筆 WR:'+(dds.total>0?(dds.wins/dds.total*100).toFixed(0):0)+'% PnL:'+(dds.pnl>=0?'+':'')+dds.pnl.toFixed(2)+'U\n累計:'+al.total+'筆 WR:'+(al.total>0?(al.wins/al.total*100).toFixed(1):0)+'% PnL:'+(al.pnl>=0?'+':'')+al.pnl.toFixed(2)+'U',chatId);return;
  }

  if(cmd==='/history'){
    var tr=stats.trades.slice(-10).reverse();if(!tr.length){tg('尚無交易',chatId);return;}
    tg('[BingX] 近10筆\n'+tr.map(function(t){return (t.pnl>=0?'✅':'❌')+' '+t.symbol+'['+(t.layer||'?')+'] '+(t.pnl>=0?'+':'')+t.pnl.toFixed(4)+'U '+t.reason;}).join('\n'),chatId);return;
  }

  if(cmd==='/log'){
    var logs=memLog.slice(-15).map(function(l){return '['+l.lv+'] '+l.msg.slice(0,80);}).join('\n');
    tg('[BingX] 日誌\n'+(logs||'無'),chatId);return;
  }

  if(cmd==='/brain'){
    var lastAdj=brain.adjustHistory&&brain.adjustHistory.length?brain.adjustHistory[brain.adjustHistory.length-1]:{changes:['尚未調整']};
    tg('[BingX] 🧠 學習狀態\n已學習:'+(brain.learnCount||0)+'次\n最佳時段:'+(brain.bestHours&&brain.bestHours.length?brain.bestHours.join(',')+'時':'學習中')+'\n最佳幣種:'+(brain.bestSymbols&&brain.bestSymbols.length?brain.bestSymbols.join(','):'學習中')+'\n調參次數:'+(brain.adjustHistory?brain.adjustHistory.length:0)+'\n最近:'+lastAdj.changes.join(', '),chatId);return;
  }

  if(cmd==='/short'){
    cfg.allowShort=!cfg.allowShort;
    tg('✅ 空單 -> '+(cfg.allowShort?'開啟':'關閉'),chatId);return;
  }

  if(text.startsWith('/'))tg('未知指令，輸入 /help',chatId);
}

function startServer(){
  http.createServer(function(req,res){res.writeHead(200);res.end(JSON.stringify({status:'ok',running:cfg.botRunning}));}).listen(3002,function(){log('OK','Server Port:3002');});
}

async function recoverPositions(){
  try{
    var pos=await getPositions();
    if(!pos||pos.length===0)return;
    var recovered=0;
    for(var i=0;i<pos.length;i++){
      var p=pos[i];
      var amt=parseFloat(p.positionAmt||0);
      if(amt===0)continue;
      var sym=p.symbol;
      var side=p.positionSide||'LONG';
      // 恢復到中期層
      var key=sym+'_swing_'+(side==='LONG'?'L':'S');
      if(openTrades[key])continue;
      openTrades[key]={symbol:sym,side:side,entry:parseFloat(p.avgPrice||0),qty:Math.abs(amt),layer:'swing',openTime:Date.now()-30*60000};
      recovered++;
      log('INFO','恢復持倉: '+sym+' '+side);
    }
    if(recovered>0)tg('[BingX] 🔄 恢復 '+recovered+' 個持倉');
  }catch(e){log('WARN','recoverPositions: '+e.message);}
}

function scheduleReport(){
  function ms10(){var now=new Date(),tw=new Date(now.toLocaleString('en-US',{timeZone:'Asia/Taipei'}));var n=new Date(tw);n.setHours(10,0,0,0);if(tw.getHours()>=10)n.setDate(n.getDate()+1);return n-tw;}
  setTimeout(function(){
    var d=getDayStat(),all=stats.allTime;
    tg('[BingX] 📊 每日報告\n今日:'+d.total+'筆 PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U\n累計:'+all.total+'筆 PnL:'+(all.pnl>=0?'+':'')+all.pnl.toFixed(2)+'U');
    setInterval(function(){var d2=getDayStat(),all2=stats.allTime;tg('[BingX] 📊 每日報告\n今日:'+d2.total+'筆 PnL:'+(d2.pnl>=0?'+':'')+d2.pnl.toFixed(2)+'U\n累計:'+all2.total+'筆 PnL:'+(all2.pnl>=0?'+':'')+all2.pnl.toFixed(2)+'U');},24*60*60*1000);
  },ms10());
}

async function main(){
  console.log('\nBingX 三層策略 AutoTrader v2.0\n');
  log('INFO','Starting...');
  startServer();
  try{
    var bal=await getBalance();
    log('OK','BingX API OK! Available:'+bal.available.toFixed(2)+'U');
    tg('[BingX 三層策略] 🟢 上線!\n餘額:'+bal.available.toFixed(2)+'U\n\n短期(1m): SL0.5% TP0.8%\n中期(5m): SL1% TP1.5%\n長期(1h): SL2% TP5%\n\n/go 啟動交易');
    await recoverPositions();
  }catch(e){log('ERROR','API fail: '+e.message);tg('[BingX] ⚠️ '+e.message);}
  log('INFO','Starting Telegram polling...');
  tgPoll();scheduleReport();
  log('OK','Ready. /help');
}

process.on('uncaughtException',function(e){log('ERROR','Uncaught: '+e.message);tg('🚨 BingX 異常!\n'+e.message);});
process.on('unhandledRejection',function(e){log('ERROR','Unhandled: '+(e&&e.message?e.message:String(e)));});
process.on('SIGINT',function(){tg('⛔ BingX 三層策略 已關閉!\n持倉:'+Object.keys(openTrades).length+'個');setTimeout(function(){process.exit(0);},2000);});
setInterval(function(){if(!cfg.botRunning)return;var hr=new Date().getMinutes();if(hr===0){var d=getDayStat();tg('💓 BingX 心跳\n今日:'+d.total+'筆 PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U');}},60000);
main().catch(function(e){log('ERROR','Start fail: '+e.message);process.exit(1);});

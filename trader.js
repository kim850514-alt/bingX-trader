'use strict';
const crypto=require('crypto'),https=require('https'),http=require('http'),fs=require('fs');

// ══════════════════════════════════
// 系統設定
// ══════════════════════════════════
const ADMIN_CHAT=process.env.TELEGRAM_CHAT_ID||'';
const ADMIN_TOKEN=process.env.BYBIT_TG_TOKEN||''; // 海馬Bot Token（管理員）

// 共用策略設定（管理員修改，全部用戶同步）
const LAYERS={
  scalp:{name:'短期',tf:'3m',lev:5,amt:1,threshold:4,maxHold:60,
    atrMult:{sl:1.5,tp:2.5},limitOffset:0.002},
  swing:{name:'中期',tf:'5m',lev:5,amt:1,threshold:5,maxHold:360,
    atrMult:{sl:2.0,tp:3.5},limitOffset:0.003},
  long: {name:'長期',tf:'1h',lev:5,amt:1,threshold:5,maxHold:2880,
    atrMult:{sl:2.5,tp:5.0},limitOffset:0.005}
};
const MIN_SL=1.0,MIN_RR=1.5;
const MAX_SAME_DIR=5;
const PARAM_LIMITS={
  oversold:    {min:25, max:35},
  overbought:  {min:65, max:75},
  rsiPeriod:   {min:5,  max:14},
  bbPeriod:    {min:10, max:25},
  bbStdDev:    {min:1.5,max:2.5},
  volMultiple: {min:1.0,max:2.0},
  atrMultSl:   {min:1.5,max:3.0},
  atrMultTp:   {min:2.0,max:5.0},
  limitOffset: {min:0.001,max:0.005}
};
function clamp(val,key){var l=PARAM_LIMITS[key];if(!l)return val;return Math.min(l.max,Math.max(l.min,val));}

// ══════════════════════════════════
// 用戶管理
// ══════════════════════════════════
var bots=loadBots(); // 所有子Bot資料
function loadBots(){
  if(fs.existsSync('./bots.json'))try{return JSON.parse(fs.readFileSync('./bots.json','utf8'));}catch(e){}
  return{};
}
function saveBots(){fs.writeFileSync('./bots.json',JSON.stringify(bots,null,2));}

// bots 格式：
// {
//   "botToken": {
//     token: "xxx",
//     chatId: "xxx",       // 用戶的 chat id
//     name: "朋友A",
//     apiKey: "xxx",
//     secret: "xxx",
//     cfg: { symbols, botRunning, allowShort, params, amount },
//     openTrades: {},
//     stats: {},
//     lastSignalTs: {},
//     learnCycleCount: 0,
//     learningPause: false,
//     memLog: [],
//     usedOrderIds: []
//   }
// }

function getBot(token){return bots[token]||null;}
function getBotByChatId(chatId){
  return Object.values(bots).find(function(b){return b.chatId===chatId;})||null;
}

function createBot(token,chatId,name,apiKey,secret){
  bots[token]={
    token:token,
    chatId:chatId,
    name:name||'用戶',
    apiKey:apiKey,
    secret:secret,
    role:'user', // ✅ 角色：user / leader
    cfg:{
      symbols:['DOGE-USDT','XRP-USDT','SIREN-USDT'],
      botRunning:false,
      allowShort:true,
      amount:1,
      copyFrom:null // 跟單哪個leader的token
    },
    openTrades:{},
    stats:{allTime:{total:0,wins:0,losses:0,pnl:0},daily:{},trades:[]},
    lastSignalTs:{},
    learnCycleCount:0,
    learningPause:false,
    memLog:[],
    usedOrderIds:[]
  };
  saveBots();
  return bots[token];
}

// ══════════════════════════════════
// 共用 Brain（所有用戶共享學習）
// ══════════════════════════════════
var brain=loadBrain();
function loadBrain(){
  if(fs.existsSync('./shared_brain.json'))try{return JSON.parse(fs.readFileSync('./shared_brain.json','utf8'));}catch(e){}
  return{symbolPerf:{},hourPerf:{},adjustHistory:[],learnCount:0,bestHours:[],worstHours:[],bestSymbols:[],worstSymbols:[]};
}
function saveBrain(){fs.writeFileSync('./shared_brain.json',JSON.stringify(brain,null,2));}

function todayKey(){return new Date().toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});}
function nowTW(){return new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei'});}
function hourTW(){return parseInt(new Date().toLocaleString('en-US',{timeZone:'Asia/Taipei',hour:'numeric',hour12:false}));}

var sysLog=[];
function log(lv,msg,b){
  var line='['+nowTW()+'][BX]['+lv+'] '+(b?'['+b.name+'] ':'')+msg;
  console.log(line);
  sysLog.push({ts:nowTW(),lv:lv,msg:msg});
  if(sysLog.length>300)sysLog.shift();
  if(b&&b.memLog){b.memLog.push({ts:nowTW(),lv:lv,msg:msg});if(b.memLog.length>100)b.memLog.shift();}
}

// ══════════════════════════════════
// BingX API
// ══════════════════════════════════
function bxReq(method,path,params,apiKey,secret,tries){
  params=params||{};tries=tries||3;
  return new Promise(function(resolve,reject){
    var p=Object.assign({},params,{timestamp:Date.now()});
    var qs=Object.keys(p).filter(function(k){return p[k]!=null&&p[k]!=='';}).map(function(k){return k+'='+p[k];}).join('&');
    var sig=crypto.createHmac('sha256',secret).update(qs).digest('hex');
    var q=qs+'&signature='+sig;
    var opt={hostname:'open-api.bingx.com',path:method==='GET'?path+'?'+q:path,method:method,headers:{'X-BX-APIKEY':apiKey,'Content-Type':'application/x-www-form-urlencoded'}};
    var go=function(n){
      var req=https.request(opt,function(rsp){var d='';rsp.on('data',function(c){d+=c;});rsp.on('end',function(){try{resolve(JSON.parse(d));}catch(e){reject(new Error(d.slice(0,80)));}});});
      req.on('error',function(e){if(n>1)setTimeout(function(){go(n-1);},2000);else reject(e);});
      req.setTimeout(12000,function(){req.destroy();if(n>1)setTimeout(function(){go(n-1);},2000);else reject(new Error('Timeout'));});
      if(method==='POST')req.write(q);req.end();
    };
    go(tries);
  });
}

function api(b){
  var ak=b.apiKey,sk=b.secret;
  return{
    getBalance:async function(){
      var r=await bxReq('GET','/openApi/swap/v2/user/balance',{},ak,sk);
      if(r.code===0)return{available:parseFloat(r.data.balance.availableMargin||0),total:parseFloat(r.data.balance.balance||0)};
      throw new Error('Cannot get balance');
    },
    getPositions:async function(sym){
      sym=sym||'';
      try{var r=await bxReq('GET','/openApi/swap/v2/user/positions',sym?{symbol:sym}:{},ak,sk);if(r.code===0)return(r.data||[]).filter(function(p){return parseFloat(p.positionAmt||0)!==0;});}catch(e){}return[];
    },
    getKlines:async function(sym,tf,lim){
      lim=lim||150;
      var bxTf={'1m':'1m','3m':'3m','5m':'5m','15m':'15m','1h':'1h','4h':'4h'}[tf]||'5m';
      try{var r=await bxReq('GET','/openApi/swap/v2/quote/klines',{symbol:sym,interval:bxTf,limit:lim},ak,sk);if(r.code===0&&Array.isArray(r.data))return r.data;}catch(e){}return[];
    },
    getTicker:async function(sym){
      try{var r=await bxReq('GET','/openApi/swap/v2/quote/ticker',{symbol:sym},ak,sk);if(r.code===0)return r.data;}catch(e){}return null;
    },
    setLev:async function(sym,lev){
      for(var s of['LONG','SHORT']){try{await bxReq('POST','/openApi/swap/v2/trade/leverage',{symbol:sym,side:s,leverage:lev},ak,sk);}catch(e){}}
    },
    placeOrder:async function(o){
      await this.setLev(o.symbol,o.lev);
      var notional=o.amt*o.lev;
      var p={symbol:o.symbol,side:o.side,positionSide:o.positionSide,type:'MARKET',quoteOrderQty:String(notional)};
      var r=await bxReq('POST','/openApi/swap/v2/trade/order',p,ak,sk);
      if(r.code===0){
        var ps=o.positionSide,cs=ps==='LONG'?'SELL':'BUY';
        if(o.stopLoss){try{await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:o.symbol,side:cs,positionSide:ps,type:'STOP_MARKET',stopPrice:String(o.stopLoss),quantity:String(notional/o.price||1),workingType:'MARK_PRICE'},ak,sk);}catch(e){}}
        if(o.takeProfit){try{await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:o.symbol,side:cs,positionSide:ps,type:'TAKE_PROFIT_MARKET',stopPrice:String(o.takeProfit),quantity:String(notional/o.price||1),workingType:'MARK_PRICE'},ak,sk);}catch(e){}}
        tgBot(b,'[BingX] ✅ 開單\n'+(o.side==='BUY'?'🟢':'🔴')+' '+o.symbol+' ['+o.layer+']\n保證金:'+o.amt+'U × '+o.lev+'x\nSL:'+o.stopLoss+' TP:'+o.takeProfit);
        return r.data.order;
      }else{
        tgBot(b,'[BingX] ❌ 開單失敗\n'+o.symbol+'\n'+r.msg);
        return null;
      }
    },
    closePos:async function(sym,ps,qty){
      var r=await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:sym,side:ps==='LONG'?'SELL':'BUY',positionSide:ps,type:'MARKET',quantity:String(qty)},ak,sk);
      return r.code===0?r.data.order:null;
    },
    getActualPnl:async function(symbol,openTime){
      try{
        var r=await bxReq('GET','/openApi/swap/v2/trade/allOrders',{symbol:symbol,limit:20},ak,sk);
        if(r.code===0&&r.data&&r.data.orders){
          var orders=r.data.orders.filter(function(o){
            var oTime=parseInt(o.time||o.updateTime||0);
            var orderId=String(o.orderId||'');
            var isClose=(o.side==='SELL'&&o.positionSide==='LONG')||(o.side==='BUY'&&o.positionSide==='SHORT');
            return o.status==='FILLED'&&isClose&&oTime>openTime&&b.usedOrderIds.indexOf(orderId)===-1;
          });
          if(orders.length>0){
            b.usedOrderIds.push(String(orders[0].orderId||''));
            var pnl=parseFloat(orders[0].profit||0)+parseFloat(orders[0].commission||0);
            return{pnl:pnl,exitPrice:parseFloat(orders[0].avgPrice||0)};
          }
        }
      }catch(e){}
      return null;
    }
  };
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

async function calcSignal(b,ax,sym,layer){
  var cfg2=LAYERS[layer];
  var kl=await ax.getKlines(sym,cfg2.tf,210); // 多取K線給EMA200
  if(kl.length<60)return null;
  var closes=kl.map(function(k){return parseFloat(k.close||k[4]||0);});
  var highs=kl.map(function(k){return parseFloat(k.high||k[2]||0);});
  var lows=kl.map(function(k){return parseFloat(k.low||k[3]||0);});
  var vols=kl.map(function(k){return parseFloat(k.volume||k[5]||0);});
  var last=closes[closes.length-1];
  var p={
    rsiPeriod:clamp(7,'rsiPeriod'),
    oversold:clamp(30,'oversold'),
    overbought:clamp(70,'overbought'),
    volMultiple:clamp(1.3,'volMultiple'),
    bbPeriod:clamp(15,'bbPeriod'),
    bbStdDev:clamp(2,'bbStdDev')
  };
  var bs=0,ss=0,rsn=[];

  // RSI
  var rsi=I.rsi(closes,p.rsiPeriod),rsiPrev=I.rsi(closes.slice(0,-1),p.rsiPeriod);
  if(rsi!==null&&rsiPrev!==null){
    if(rsiPrev<p.oversold&&rsi>p.oversold){bs+=3;rsn.push('RSI回升('+rsi.toFixed(0)+')');}
    if(rsiPrev>p.overbought&&rsi<p.overbought){ss+=3;rsn.push('RSI回落('+rsi.toFixed(0)+')');}
    if(rsi<50){bs+=1;}else{ss+=1;}
  }

  // BB
  var bb=I.boll(closes,p.bbPeriod,p.bbStdDev);
  if(bb){
    if(last<bb.lower){bs+=2;rsn.push('BB下軌');}else if(last<bb.mid){bs+=1;rsn.push('BB下半');}
    if(last>bb.upper){ss+=2;rsn.push('BB上軌');}else if(last>bb.mid){ss+=1;rsn.push('BB上半');}
  }

  // EMA9/21 短期動能
  var ema9=I.ema(closes,9),ema21=I.ema(closes,21);
  if(ema9&&ema21){
    if(ema9>ema21){bs+=1;rsn.push('EMA多');}else{ss+=1;rsn.push('EMA空');}
  }

  // ✅ EMA50/200 趨勢過濾（所有層都加入）
  var ema50=I.ema(closes,50);
  var ema200=I.ema(closes,Math.min(200,closes.length-1));
  if(ema50&&ema200){
    if(ema50>ema200){bs+=2;rsn.push('趨勢多');}else{ss+=2;rsn.push('趨勢空');}
    // 逆勢扣分
    if(ema50>ema200&&ss>bs){ss=Math.max(0,ss-1);}
    if(ema50<ema200&&bs>ss){bs=Math.max(0,bs-1);}
  }

  // MACD
  var macdData=I.macd(closes);
  if(macdData){if(macdData.hist>0){bs+=1;rsn.push('MACD+');}else{ss+=1;rsn.push('MACD-');}}

  // 成交量
  var avgVol=I.ma(vols.slice(0,-1),20);
  if(avgVol&&vols[vols.length-1]>avgVol*p.volMultiple){bs+=1;ss+=1;rsn.push('量增');}

  // ✅ ATR 計算
  var atrVal=I.atr(highs,lows,closes,14);

  var threshold=cfg2.threshold;
  var signal='HOLD';
  if(bs>=threshold&&bs>ss)signal='BUY';
  else if(ss>=threshold&&ss>bs)signal='SELL';

  log('INFO',sym+' ['+layer+'] BS:'+bs+' SS:'+ss+' 門檻:'+threshold+' -> '+signal+(rsn.length?' ['+rsn.join('+')+']':''),b);
  return{signal:signal,bs:bs,ss:ss,reasons:rsn.join('+'),price:last,atr:atrVal,highs:highs,lows:lows,closes:closes};
}
// 統計
// ══════════════════════════════════
function recordTrade(b,t){
  var today=todayKey();
  if(!b.stats.daily[today])b.stats.daily[today]={total:0,wins:0,losses:0,pnl:0};
  var d=b.stats.daily[today];
  d.total++;if(t.pnl>0)d.wins++;else d.losses++;d.pnl+=t.pnl;
  b.stats.allTime.total++;if(t.pnl>0)b.stats.allTime.wins++;else b.stats.allTime.losses++;b.stats.allTime.pnl+=t.pnl;
  b.stats.trades.push(Object.assign({},t,{date:today}));
  if(b.stats.trades.length>500)b.stats.trades=b.stats.trades.slice(-500);
  // 共享學習
  brain.learnCount=(brain.learnCount||0)+1;
  if(!brain.symbolPerf[t.symbol])brain.symbolPerf[t.symbol]={wins:0,losses:0,pnl:0,count:0};
  var sp=brain.symbolPerf[t.symbol];
  if(t.pnl>0)sp.wins++;else sp.losses++;sp.pnl+=t.pnl;sp.count++;
  var hr=String(hourTW());
  if(!brain.hourPerf[hr])brain.hourPerf[hr]={wins:0,losses:0,pnl:0};
  if(t.pnl>0)brain.hourPerf[hr].wins++;else brain.hourPerf[hr].losses++;brain.hourPerf[hr].pnl+=t.pnl;
  saveBrain();
  // 學習週期
  b.learnCycleCount++;
  if(b.learnCycleCount>=3){
    b.learnCycleCount=0;
    tgBot(b,'[BingX 🧠] 已完成3筆交易，學習中...');
  }
  saveBots();
}

// ══════════════════════════════════
// 持倉監控
// ══════════════════════════════════
async function checkPendingOrders(b){
  var ax=api(b);
  if(!b.pendingOrders)b.pendingOrders={};
  for(var key in b.pendingOrders){
    try{
      var po=b.pendingOrders[key];
      var holdMin=Math.round((Date.now()-po.openTime)/60000);
      // 超過 30 分鐘未成交取消
      if(holdMin>30){
        try{await bxReq('POST','/openApi/swap/v2/trade/cancel',{symbol:po.symbol,orderId:po.orderId},b.apiKey,b.secret);}catch(e){}
        delete b.pendingOrders[key];
        saveBots();
        log('INFO',po.symbol+' ['+po.layer+'] 限價單超時取消',b);
        tgBot(b,'[BingX] ⏰ 限價單取消\n'+po.symbol+' ['+po.layerName+']\n掛了 '+holdMin+' 分鐘未成交');
        continue;
      }
      // 檢查訂單狀態
      try{
        var r=await bxReq('GET','/openApi/swap/v2/trade/orderDetail',{symbol:po.symbol,orderId:po.orderId},b.apiKey,b.secret);
        if(r.code===0&&r.data&&r.data.order&&r.data.order.status==='FILLED'){
          log('OK',po.symbol+' ['+po.layer+'] 限價單已成交！',b);
          var tradeKey=po.symbol+'_'+po.layer+'_'+(po.positionSide==='LONG'?'L':'S');
          b.openTrades[tradeKey]={
            symbol:po.symbol,side:po.positionSide,
            entry:po.limitPrice,qty:po.qty,
            layer:po.layer,openTime:Date.now(),
            halfExited:false,slMoved:false
          };
          delete b.pendingOrders[key];
          saveBots();
          tgBot(b,'[BingX] ✅ 限價單成交！\n'+(po.positionSide==='LONG'?'🟢':'🔴')+' '+po.symbol+' ['+po.layerName+']\n成交價: '+po.limitPrice+'\nSL: '+po.stopLoss+' TP: '+po.takeProfit);
        }
      }catch(e){}
    }catch(e){log('ERROR','checkPending: '+e.message,b);}
  }
}

async function checkPositions(b){
  var ax=api(b);
  for(var key in b.openTrades){
    try{
      var t=b.openTrades[key];
      var layer=t.layer,layerCfg=LAYERS[layer];
      var tk=await ax.getTicker(t.symbol).catch(function(){return null;});if(!tk)continue;
      var cur=parseFloat(tk.lastPrice);
      var holdMin=Math.round((Date.now()-t.openTime)/60000);
      var ps=t.side;
      var pos=await ax.getPositions(t.symbol);
      var stillOpen=pos.some(function(p){return p.positionSide===ps&&parseFloat(p.positionAmt||0)!==0;});
      if(!stillOpen&&holdMin>1){
        await new Promise(function(r){setTimeout(r,1500);});
        var actual=await ax.getActualPnl(t.symbol,t.openTime);
        var pnl=actual?actual.pnl:0;
        var source=actual?'API':'估算';
        recordTrade(b,{symbol:t.symbol,side:t.side,entry:t.entry,exit:cur,qty:t.qty,pnl:pnl,holdMin:holdMin,reason:'TP/SL',layer:layer});
        delete b.openTrades[key];
        saveBots();
        tgBot(b,'[BingX] '+(pnl>=0?'✅':'❌')+' '+t.symbol+' ['+layerCfg.name+']\nPnL('+source+'):'+(pnl>=0?'+':'')+pnl.toFixed(4)+'U Hold:'+holdMin+'min');
        continue;
      }
      var estPnl=ps==='LONG'?(cur-t.entry)*t.qty*layerCfg.lev:(t.entry-cur)*t.qty*layerCfg.lev;
      var estPct=ps==='LONG'?(cur-t.entry)/t.entry*100:(t.entry-cur)/t.entry*100;
      log('INFO','持倉 '+t.symbol+' ['+layer+'] '+(estPct>=0?'+':'')+estPct.toFixed(2)+'% Hold:'+holdMin+'min',b);

      // ✅ 移動止損：達到 TP1 時 SL 移到開倉價和 TP1 中間
      var tpPct=layerCfg.atrMult?layerCfg.atrMult.tp:Math.max(MIN_SL*MIN_RR,3);
      var tp1Pct=tpPct*0.5;
      if(estPct>=tp1Pct&&!t.slMoved){
        t.slMoved=true;
        var tp1Price=ps==='LONG'?t.entry*(1+tp1Pct/100):t.entry*(1-tp1Pct/100);
        var newSl=+((t.entry+tp1Price)/2).toFixed(4);
        try{
          await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:t.symbol,side:ps==='LONG'?'SELL':'BUY',positionSide:ps,type:'STOP_MARKET',stopPrice:String(newSl),quantity:String(t.qty),workingType:'MARK_PRICE'},b.apiKey,b.secret);
          tgBot(b,'[BingX] 🔒 止損上移\n'+t.symbol+' ['+layerCfg.name+']\n新止損: '+newSl+'\n鎖定約 '+(tp1Pct*0.5).toFixed(2)+'% 獲利');
        }catch(e){}
      }

      // ✅ 分倉出場：達到 TP1 平一半
      if(estPct>=tp1Pct&&!t.halfExited&&stillOpen){
        t.halfExited=true;
        var halfQty=Math.floor(t.qty/2*100)/100;
        if(halfQty>0){
          try{
            await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:t.symbol,side:ps==='LONG'?'SELL':'BUY',positionSide:ps,type:'MARKET',quantity:String(halfQty)},b.apiKey,b.secret);
            log('AI',t.symbol+' 半倉出場 qty='+halfQty,b);
            tgBot(b,'[BingX] 🏁 半倉出場\n'+t.symbol+' ['+layerCfg.name+']\n數量: '+halfQty+'\n獲利: +'+estPct.toFixed(2)+'%');
          }catch(e){log('WARN',t.symbol+' 半倉失敗: '+e.message,b);}
        }
      }

      // 反向訊號
      if(holdMin>=5&&stillOpen){
        var res=await calcSignal(b,ax,t.symbol,layer).catch(function(){return null;});
        if(res){
          var rev=(ps==='LONG'&&res.signal==='SELL')||(ps==='SHORT'&&res.signal==='BUY');
          if(rev){
            var o=await ax.closePos(t.symbol,ps,t.qty).catch(function(){return null;});
            if(o){
              await new Promise(function(r3){setTimeout(r3,1500);});
              var a3=await ax.getActualPnl(t.symbol,t.openTime);
              var p3=a3?a3.pnl:estPnl;
              recordTrade(b,{symbol:t.symbol,side:t.side,entry:t.entry,exit:cur,qty:t.qty,pnl:p3,holdMin:holdMin,reason:'反向平倉',layer:layer});
              delete b.openTrades[key];
              saveBots();
              tgBot(b,'[BingX] 🔄 反向平倉\n'+t.symbol+' ['+layerCfg.name+']\nPnL:'+(p3>=0?'✅ +':'❌ ')+p3.toFixed(4)+'U Hold:'+holdMin+'min');
              continue;
            }
          }
        }
      }
      // 超時
      if(holdMin>=layerCfg.maxHold){
        var o2=await ax.closePos(t.symbol,ps,t.qty).catch(function(){return null;});
        if(o2){
          await new Promise(function(r4){setTimeout(r4,1500);});
          var a4=await ax.getActualPnl(t.symbol,t.openTime);
          var p4=a4?a4.pnl:estPnl;
          recordTrade(b,{symbol:t.symbol,side:t.side,entry:t.entry,exit:cur,qty:t.qty,pnl:p4,holdMin:holdMin,reason:'超時平倉',layer:layer});
          delete b.openTrades[key];
          tgBot(b,'[BingX] ⏰ 超時\n'+t.symbol+' ['+layerCfg.name+']\nPnL:'+(p4>=0?'✅ +':'❌ ')+p4.toFixed(4)+'U Hold:'+holdMin+'min');
        }
      }
    }catch(e){log('ERROR','checkPos: '+e.message,b);}
  }
}

// ══════════════════════════════════
// 交易循環
// ══════════════════════════════════
async function tradingLoop(b){
  if(!b.cfg.botRunning)return;
  if(b.learningPause){await checkPendingOrders(b);await checkPositions(b);return;}
  var ax=api(b);
  if(!b.pendingOrders)b.pendingOrders={};
  try{
    var bal=await ax.getBalance().catch(function(){return null;});
    if(!bal)return;
    var amt=b.cfg.amount||1;

    // 先檢查掛單
    await checkPendingOrders(b);

    for(var i=0;i<b.cfg.symbols.length;i++){
      var sym=b.cfg.symbols[i];
      for(var layerName in LAYERS){
        try{
          var layerCfg=LAYERS[layerName];
          // 同層同幣只能一個方向（包含掛單）
          var hasL=b.openTrades[sym+'_'+layerName+'_L']||b.pendingOrders[sym+'_'+layerName+'_L'];
          var hasS=b.openTrades[sym+'_'+layerName+'_S']||b.pendingOrders[sym+'_'+layerName+'_S'];
          if(hasL||hasS)continue;

          var coolKey=sym+'_'+layerName+'_cool';
          if(b.lastSignalTs[coolKey]&&(Date.now()-b.lastSignalTs[coolKey])<300000)continue;

          var res=await calcSignal(b,ax,sym,layerName);
          if(!res||res.signal==='HOLD')continue;

          // 同方向最多5張
          var dirKey=res.signal==='BUY'?'_L':'_S';
          var sameDir=Object.keys(b.openTrades).filter(function(k){return k.endsWith(dirKey);}).length+
                      Object.keys(b.pendingOrders).filter(function(k){return k.endsWith(dirKey);}).length;
          if(sameDir>=MAX_SAME_DIR){log('INFO',sym+' ['+layerName+'] 同方向達上限',b);continue;}

          if(bal.available<amt)continue;
          var cur=res.price;
          if(!cur||isNaN(cur))continue;

          // ✅ ATR 動態止損止盈
          var atrVal=res.atr||cur*0.01;
          var slDist=Math.max(atrVal*layerCfg.atrMult.sl,cur*MIN_SL/100);
          var tpDist=Math.max(atrVal*layerCfg.atrMult.tp,slDist*MIN_RR);
          var slP,tpP,limitPrice;

          if(res.signal==='BUY'){
            slP=+(cur-slDist).toFixed(6);
            tpP=+(cur+tpDist).toFixed(6);
            limitPrice=+(cur*(1-layerCfg.limitOffset)).toFixed(6);
          }else{
            slP=+(cur+slDist).toFixed(6);
            tpP=+(cur-tpDist).toFixed(6);
            limitPrice=+(cur*(1+layerCfg.limitOffset)).toFixed(6);
          }

          var positionSide=res.signal==='BUY'?'LONG':'SHORT';
          var tradeKey=sym+'_'+layerName+'_'+(res.signal==='BUY'?'L':'S');

          if(res.signal==='BUY'||(res.signal==='SELL'&&b.cfg.allowShort)){
            // ✅ 限價掛單
            var notional=amt*layerCfg.lev;
            var qty=Math.floor(notional/cur*100)/100;
            if(qty*cur<5)qty=Math.ceil(5/cur*100)/100;
            if(qty<=0){log('WARN',sym+' 數量為0',b);continue;}

            try{
              await bxReq('POST','/openApi/swap/v2/trade/leverage',{symbol:sym,side:positionSide,leverage:layerCfg.lev},b.apiKey,b.secret);
            }catch(e){}

            var limitOrder=await bxReq('POST','/openApi/swap/v2/trade/order',{
              symbol:sym,
              side:res.signal==='BUY'?'BUY':'SELL',
              positionSide:positionSide,
              type:'LIMIT',
              price:String(limitPrice),
              quantity:String(qty),
              timeInForce:'GTC'
            },b.apiKey,b.secret);

            if(limitOrder&&limitOrder.code===0){
              b.lastSignalTs[coolKey]=Date.now();
              b.pendingOrders[tradeKey]={
                symbol:sym,positionSide:positionSide,
                layer:layerName,layerName:layerCfg.name,
                orderId:limitOrder.data.order.orderId,
                qty:qty,limitPrice:limitPrice,
                stopLoss:slP,takeProfit:tpP,
                openTime:Date.now()
              };
              saveBots();
              log('OK',sym+' ['+layerName+'] 限價掛單 @'+limitPrice+' SL:'+slP+' TP:'+tpP,b);
              tgBot(b,'[BingX] 📋 限價掛單\n'+(res.signal==='BUY'?'🟢 多':'🔴 空')+' '+sym+' ['+layerCfg.name+']\n掛單價: '+limitPrice+'\nSL: '+slP+'\nTP: '+tpP+'\n(ATR×'+layerCfg.atrMult.sl+'/'+layerCfg.atrMult.tp+')');
              // 觸發帶單
              copyTrade(b,{symbol:sym,side:res.signal==='BUY'?'BUY':'SELL',positionSide:positionSide,price:limitPrice,stopLoss:slP,takeProfit:tpP,layer:layerName}).catch(function(){});
            }else{
              log('ERROR',sym+' 限價掛單失敗: '+(limitOrder?limitOrder.msg:'null'),b);
            }
          }
        }catch(e){log('ERROR',sym+' ['+layerName+']: '+e.message,b);}
      }
    }
    await checkPositions(b);
  }catch(e){log('ERROR','Loop: '+e.message,b);}
}

// ══════════════════════════════════
// 主循環（每分鐘掃描所有Bot）
// ══════════════════════════════════
// ══════════════════════════════════
// 持倉恢復
// ══════════════════════════════════
async function recoverPositions(b){
  try{
    var ax=api(b);
    var pos=await ax.getPositions();
    if(!pos||pos.length===0)return;
    var recovered=0;
    for(var i=0;i<pos.length;i++){
      var p=pos[i];
      var amt=parseFloat(p.positionAmt||0);
      if(amt===0)continue;
      var sym=p.symbol;
      var side=p.positionSide||'LONG';
      var key=sym+'_swing_'+(side==='LONG'?'L':'S');
      if(b.openTrades[key])continue;
      b.openTrades[key]={symbol:sym,side:side,entry:parseFloat(p.avgPrice||0),qty:Math.abs(amt),layer:'swing',openTime:Date.now()-30*60000};
      recovered++;
      log('INFO','恢復持倉: '+sym+' '+side,b);
    }
    if(recovered>0){
      saveBots();
      tgBot(b,'[BingX] 🔄 恢復 '+recovered+' 個持倉');
    }
  }catch(e){log('WARN','recoverPositions: '+e.message,b);}
}

// ══════════════════════════════════
// 帶單跟單
// ══════════════════════════════════
// 跟單設定儲存在 bots[token].copyFrom = '主帳號token'
async function copyTrade(masterBot,tradeInfo){
  // 只有帶單員（leader）開單才觸發跟單
  if(masterBot.role!=='leader')return;
  var followers=Object.values(bots).filter(function(b){
    return b.cfg&&b.cfg.copyFrom===masterBot.token&&b.cfg.botRunning&&b.token!==masterBot.token;
  });
  if(!followers.length)return;
  log('INFO','帶單: '+tradeInfo.symbol+' '+tradeInfo.side+' 跟單人數:'+followers.length);
  for(var i=0;i<followers.length;i++){
    var fb=followers[i];
    try{
      var ax=api(fb);
      var amt=fb.cfg.amount||1;
      var layerCfg=LAYERS[tradeInfo.layer]||LAYERS.swing;
      var o=await ax.placeOrder({
        symbol:tradeInfo.symbol,
        side:tradeInfo.side,
        positionSide:tradeInfo.positionSide,
        amt:amt,
        lev:layerCfg.lev,
        price:tradeInfo.price,
        stopLoss:tradeInfo.stopLoss,
        takeProfit:tradeInfo.takeProfit,
        layer:'跟單'
      });
      if(o){
        var key=tradeInfo.symbol+'_'+tradeInfo.layer+'_'+(tradeInfo.positionSide==='LONG'?'L':'S');
        fb.openTrades[key]={symbol:tradeInfo.symbol,side:tradeInfo.positionSide,entry:tradeInfo.price,qty:1,layer:tradeInfo.layer,openTime:Date.now()};
        saveBots();
        tgBot(fb,'[BingX] 📋 跟單成功\n'+tradeInfo.symbol+' ['+(tradeInfo.side==='BUY'?'🟢 多':'🔴 空')+']\n跟隨: '+masterBot.name);
      }
    }catch(e){log('ERROR','跟單失敗 '+fb.name+': '+e.message,fb);}
  }
}

function startMainLoop(){
  setInterval(function(){
    Object.values(bots).forEach(function(b){
      if(b.cfg&&b.cfg.botRunning){
        tradingLoop(b).catch(function(e){log('ERROR','BotLoop '+b.name+': '+e.message);});
      }
    });
  },60000);
  log('INFO','主循環啟動');
}

// ══════════════════════════════════
// Telegram（每個Bot獨立polling）
// ══════════════════════════════════
function tgBot(b,text){
  if(!b.token||!b.chatId)return;
  var body=JSON.stringify({chat_id:b.chatId,text:text,parse_mode:'HTML'});
  var req=https.request({hostname:'api.telegram.org',path:'/bot'+b.token+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(r){var d='';r.on('data',function(c){d+=c;});});
  req.on('error',function(){});req.write(body);req.end();
}

// 管理員Bot（錢錢）
function tgAdmin(text){
  if(!ADMIN_TOKEN||!ADMIN_CHAT)return;
  var body=JSON.stringify({chat_id:ADMIN_CHAT,text:text,parse_mode:'HTML'});
  var req=https.request({hostname:'api.telegram.org',path:'/bot'+ADMIN_TOKEN+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(r){var d='';r.on('data',function(c){d+=c;});});
  req.on('error',function(){});req.write(body);req.end();
}

// 各Bot的polling lastId
var pollIds={};

function startBotPolling(b){
  if(!b.token)return;
  pollIds[b.token]=pollIds[b.token]||0;
  function poll(){
    var req=https.request({hostname:'api.telegram.org',path:'/bot'+b.token+'/getUpdates?offset='+(pollIds[b.token]+1)+'&timeout=10&limit=5',method:'GET'},function(res){
      var d='';res.on('data',function(c){d+=c;});
      res.on('end',function(){
        try{
          var json=JSON.parse(d);
          if(json.ok&&json.result&&json.result.length>0){
            json.result.forEach(function(u){
              if(u.update_id>pollIds[b.token])pollIds[b.token]=u.update_id;
              setImmediate(function(){handleBotUpdate(b,u);});
            });
          }
        }catch(e){}
        setTimeout(poll,500);
      });
    });
    req.on('error',function(){setTimeout(poll,5000);});
    req.setTimeout(15000,function(){req.destroy();setTimeout(poll,1000);});
    req.end();
  }
  poll();
  log('INFO','Bot polling 啟動: '+b.name);
}

function handleBotUpdate(b,update){
  var msg=update.message||update.edited_message;if(!msg)return;
  var chatId=String(msg.chat.id),text=(msg.text||'').trim();
  // 更新 chatId
  if(b.chatId!==chatId){b.chatId=chatId;saveBots();}
  var parts=text.split(' '),cmd=parts[0].toLowerCase();
  log('INFO','CMD: '+cmd+' from '+b.name,b);

  if(cmd==='/help'||cmd==='/start'){
    tgBot(b,'🐎 BingX 三層策略 v2\n\n短期(3m): ATR×1.5/2.5 門檻4\n中期(5m): ATR×2.0/3.5 門檻5\n長期(1h): ATR×2.5/5.0 門檻5\n限價掛單 + 分倉出場\nEMA50/200趨勢過濾\n\n/go - 啟動\n/stop - 停止\n/status - 狀態\n/positions - 持倉\n/pending - 掛單\n/stats - 績效\n/history - 近10筆\n/set amount N - 開倉金額\n/copy 名稱 - 跟單\n/stopcopy - 取消跟單\n/addsym SYMBOL\n/delsym SYMBOL\n/symbols - 幣種清單');return;
  }
  if(cmd==='/go'){
    if(b.cfg.botRunning){tgBot(b,'⚠️ 已在運行');return;}
    b.cfg.botRunning=true;saveBots();
    tradingLoop(b).catch(function(e){log('ERROR','Go: '+e.message,b);});
    tgBot(b,'🚀 啟動!\n幣種: '+b.cfg.symbols.join(',')+'\n金額: '+b.cfg.amount+'U × 5x\nSelf-Learning: ON ✅');return;
  }
  if(cmd==='/stop'){b.cfg.botRunning=false;saveBots();tgBot(b,'⏹ 已停止');return;}
  if(cmd==='/status'){
    api(b).getBalance().then(function(bal){
      var today=todayKey(),d=b.stats.daily[today]||{total:0,wins:0,losses:0,pnl:0},all=b.stats.allTime;
      tgBot(b,'[BingX] 狀態\n'+(b.cfg.botRunning?'🟢 運行中':'🔴 已停止')+'\n餘額:'+bal.available.toFixed(2)+'U\n今日:'+d.total+'筆 WR:'+(d.total>0?(d.wins/d.total*100).toFixed(0):0)+'% PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U\n累計:'+all.total+'筆 PnL:'+(all.pnl>=0?'+':'')+all.pnl.toFixed(2)+'U\n持倉:'+Object.keys(b.openTrades).length+'\n金額:'+b.cfg.amount+'U');
    }).catch(function(e){tgBot(b,'Error: '+e.message);});return;
  }
  if(cmd==='/stats'){
    var al=b.stats.allTime,today2=todayKey(),dds=b.stats.daily[today2]||{total:0,wins:0,losses:0,pnl:0};
    tgBot(b,'[BingX] 📊 績效\n今日:'+dds.total+'筆 WR:'+(dds.total>0?(dds.wins/dds.total*100).toFixed(0):0)+'% PnL:'+(dds.pnl>=0?'+':'')+dds.pnl.toFixed(2)+'U\n累計:'+al.total+'筆 WR:'+(al.total>0?(al.wins/al.total*100).toFixed(1):0)+'% PnL:'+(al.pnl>=0?'+':'')+al.pnl.toFixed(2)+'U');return;
  }
  if(cmd==='/positions'){
    var keys=Object.keys(b.openTrades);
    if(!keys.length){tgBot(b,'無持倉');return;}
    var m='[BingX] 持倉\n\n';
    keys.forEach(function(k){var t=b.openTrades[k];m+=(t.side==='LONG'?'🟢':'🔴')+' '+t.symbol+' ['+LAYERS[t.layer].name+']\nHold:'+Math.round((Date.now()-t.openTime)/60000)+'min\n\n';});
    tgBot(b,m);return;
  }
  if(cmd==='/history'){
    var tr=b.stats.trades.slice(-10).reverse();if(!tr.length){tgBot(b,'尚無交易');return;}
    tgBot(b,'[BingX] 近10筆\n'+tr.map(function(t){return (t.pnl>=0?'✅':'❌')+' '+t.symbol+'['+(t.layer||'?')+'] '+(t.pnl>=0?'+':'')+t.pnl.toFixed(4)+'U '+t.reason;}).join('\n'));return;
  }
  if(cmd==='/set'&&parts[1]==='amount'&&parts[2]){
    var amt=parseFloat(parts[2]);
    if(amt>=1&&amt<=100){b.cfg.amount=amt;saveBots();tgBot(b,'✅ 開倉金額 -> '+amt+'U × 5x = '+(amt*5)+'U 名義');}
    else tgBot(b,'金額需在 1-100U 之間');return;
  }
  if(cmd==='/pending'){
    if(!b.pendingOrders||!Object.keys(b.pendingOrders).length){tgBot(b,'無掛單');return;}
    var pm='[BingX] 掛單\n\n';
    Object.values(b.pendingOrders).forEach(function(po){pm+='📋 '+po.symbol+' ['+po.layerName+']\n掛單價:'+po.limitPrice+'\n等待:'+Math.round((Date.now()-po.openTime)/60000)+'min\n\n';});
    tgBot(b,pm);return;
  }
  if(cmd==='/copy'){
    if(!parts[1]){
      // 顯示可跟單的帶單員
      var leaders=Object.values(bots).filter(function(lb){return lb.role==='leader';});
      if(!leaders.length){tgBot(b,'目前沒有帶單員');return;}
      tgBot(b,'🌟 可跟單的帶單員:\n'+leaders.map(function(lb){return lb.name;}).join('\n')+'\n\n/copy 名稱 開始跟單');return;
    }
    var masterName=parts[1];
    var masterBot=Object.values(bots).find(function(mb){return mb.name===masterName&&mb.role==='leader';});
    if(masterBot){
      b.cfg.copyFrom=masterBot.token;
      saveBots();
      tgBot(b,'✅ 已設定跟單: '+masterName+'\n每次開單自動跟隨\n\n/stopcopy 取消跟單');
    }else{
      tgBot(b,'❌ 找不到帶單員: '+masterName+'\n\n發 /copy 查看可跟單的帶單員');
    }
    return;
  }
  if(cmd==='/stopcopy'){
    delete b.cfg.copyFrom;
    saveBots();
    tgBot(b,'✅ 已取消跟單');
    return;
  }
  if(text.startsWith('/'))tgBot(b,'未知指令，輸入 /help');
}

// ══════════════════════════════════
// 管理員Bot（錢錢）指令
// ══════════════════════════════════
var adminPollId=0;
function startAdminPolling(){
  var token=ADMIN_TOKEN;
  if(!token)return;
  function poll(){
    var req=https.request({hostname:'api.telegram.org',path:'/bot'+token+'/getUpdates?offset='+(adminPollId+1)+'&timeout=10&limit=5',method:'GET'},function(res){
      var d='';res.on('data',function(c){d+=c;});
      res.on('end',function(){
        try{
          var json=JSON.parse(d);
          if(json.ok&&json.result&&json.result.length>0){
            json.result.forEach(function(u){
              if(u.update_id>adminPollId)adminPollId=u.update_id;
              var msg=u.message||u.edited_message;
              if(msg&&String(msg.chat.id)===ADMIN_CHAT){
                setImmediate(function(){handleAdminUpdate(u);});
              }
            });
          }
        }catch(e){}
        setTimeout(poll,500);
      });
    });
    req.on('error',function(){setTimeout(poll,5000);});
    req.setTimeout(15000,function(){req.destroy();setTimeout(poll,1000);});
    req.end();
  }
  poll();
  log('INFO','管理員Bot polling 啟動');
}

function handleAdminUpdate(update){
  var msg=update.message||update.edited_message;if(!msg)return;
  var text=(msg.text||'').trim(),parts=text.split(' '),cmd=parts[0].toLowerCase();
  log('INFO','ADMIN CMD: '+cmd);

  if(cmd==='/help'){
    tgAdmin('👑 管理員指令\n\n/addbot TOKEN NAME APIKEY SECRET - 新增Bot\n/bots - 所有Bot狀態\n/delbot TOKEN - 刪除Bot\n/setleader 名稱 - 設定帶單員\n/removeleader 名稱 - 移除帶單員\n/leaders - 帶單員列表\n/scalp N - 短期門檻(全部)\n/swing N - 中期門檻(全部)\n/long N - 長期門檻(全部)\n/log - 系統日誌\n/broadcast 訊息 - 廣播');return;
  }

  if(cmd==='/addbot'&&parts.length>=5){
    var token=parts[1],name=parts[2],apiKey=parts[3],secret=parts[4];
    // 驗證 API Key
    bxReq('GET','/openApi/swap/v2/user/balance',{},apiKey,secret).then(function(r){
      if(r.code===0){
        var bal=parseFloat(r.data.balance.availableMargin||0);
        var b=createBot(token,'',name,apiKey,secret);
        startBotPolling(b);
        tgAdmin('✅ 新增Bot成功\n名稱: '+name+'\n餘額: '+bal.toFixed(2)+'U\n\n請讓用戶對Bot發 /start');
      }else{
        tgAdmin('❌ API Key 驗證失敗\n'+r.msg);
      }
    }).catch(function(e){tgAdmin('❌ 連線失敗: '+e.message);});
    return;
  }

  if(cmd==='/bots'){
    var botList=Object.values(bots);
    if(!botList.length){tgAdmin('目前沒有Bot');return;}
    var m='[管理員] Bot 列表\n共 '+botList.length+' 個\n\n';
    botList.forEach(function(b){
      m+=b.name+': '+(b.cfg.botRunning?'🟢':'🔴')+' 持倉:'+Object.keys(b.openTrades).length+' 累計:'+b.stats.allTime.pnl.toFixed(2)+'U\n';
    });
    tgAdmin(m);return;
  }

  if(cmd==='/setleader'&&parts[1]){
    var leaderName=parts[1];
    var leaderBot=Object.values(bots).find(function(b){return b.name===leaderName;});
    if(leaderBot){
      leaderBot.role='leader';saveBots();
      tgAdmin('✅ 已設定帶單員: '+leaderName);
      tgBot(leaderBot,'🌟 您已獲得帶單員權限\n您的開單將會帶動跟單者');
    }else tgAdmin('找不到: '+leaderName);return;
  }

  if(cmd==='/removeleader'&&parts[1]){
    var rName=parts[1];
    var rBot=Object.values(bots).find(function(b){return b.name===rName;});
    if(rBot){
      rBot.role='user';saveBots();
      tgAdmin('✅ 已移除帶單員: '+rName);
      tgBot(rBot,'⚠️ 您的帶單員權限已被移除');
    }else tgAdmin('找不到: '+rName);return;
  }

  if(cmd==='/leaders'){
    var leaders=Object.values(bots).filter(function(b){return b.role==='leader';});
    tgAdmin('🌟 帶單員列表\n'+(leaders.length?leaders.map(function(b){return b.name+' (跟單:'+Object.values(bots).filter(function(f){return f.cfg&&f.cfg.copyFrom===b.token;}).length+'人)';}).join('\n'):'尚無帶單員'));return;
  }

  if(cmd==='/delbot'&&parts[1]){
    var token2=parts[1];
    if(bots[token2]){var name2=bots[token2].name;delete bots[token2];saveBots();tgAdmin('✅ 已刪除Bot: '+name2);}
    else tgAdmin('找不到Bot: '+token2);return;
  }

  if(cmd==='/scalp'&&parts[1]){var nv=parseFloat(parts[1]);if(nv>=1&&nv<=6){LAYERS.scalp.threshold=Math.round(nv);tgAdmin('✅ 短期門檻(全部) -> '+LAYERS.scalp.threshold);}return;}
  if(cmd==='/swing'&&parts[1]){var nv2=parseFloat(parts[1]);if(nv2>=1&&nv2<=6){LAYERS.swing.threshold=Math.round(nv2);tgAdmin('✅ 中期門檻(全部) -> '+LAYERS.swing.threshold);}return;}
  if(cmd==='/long'&&parts[1]){var nv3=parseFloat(parts[1]);if(nv3>=1&&nv3<=6){LAYERS.long.threshold=Math.round(nv3);tgAdmin('✅ 長期門檻(全部) -> '+LAYERS.long.threshold);}return;}

  if(cmd==='/log'){
    var logs=sysLog.slice(-15).map(function(l){return '['+l.lv+'] '+l.msg.slice(0,60);}).join('\n');
    tgAdmin('系統日誌\n'+(logs||'無'));return;
  }

  if(cmd==='/broadcast'&&parts.length>1){
    var broadMsg=parts.slice(1).join(' ');
    Object.values(bots).forEach(function(b){tgBot(b,'📢 系統公告\n'+broadMsg);});
    tgAdmin('✅ 廣播完成，共 '+Object.keys(bots).length+' 個Bot');return;
  }
}

function startServer(){
  http.createServer(function(req,res){res.writeHead(200);res.end(JSON.stringify({status:'ok',bots:Object.keys(bots).length}));}).listen(3002,function(){log('INFO','Server Port:3002');});
}

async function main(){
  console.log('\nBingX 多Bot伺服器 v1.0\n');
  log('INFO','Starting...');
  startServer();
  startMainLoop();
  startAdminPolling();
  // 啟動所有已有Bot的polling並恢復持倉
  Object.values(bots).forEach(function(b){
    startBotPolling(b);
    recoverPositions(b).catch(function(){});
  });
  var activeCount=Object.values(bots).filter(function(b){return b.cfg&&b.cfg.botRunning;}).length;
  tgAdmin('[BingX 伺服器] 🟢 上線!\n共 '+Object.keys(bots).length+' 個Bot\n運行中: '+activeCount+'\n\n新增Bot:\n/addbot TOKEN 名稱 APIKEY SECRET');
  log('OK','Ready. Bots: '+Object.keys(bots).length);
}

process.on('uncaughtException',function(e){log('ERROR','Uncaught: '+e.message);});
process.on('unhandledRejection',function(e){log('ERROR','Unhandled: '+(e&&e.message?e.message:String(e)));});
process.on('SIGINT',function(){tgAdmin('⛔ 伺服器關閉');setTimeout(function(){process.exit(0);},2000);});
main().catch(function(e){log('ERROR','Start fail: '+e.message);process.exit(1);});

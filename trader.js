'use strict';
const crypto=require('crypto'),https=require('https'),http=require('http'),fs=require('fs');

// ══════════════════════════════════
// 系統設定
// ══════════════════════════════════
const ADMIN_CHAT=process.env.TELEGRAM_CHAT_ID||'';
const ADMIN_TOKEN=process.env.BYBIT_TG_TOKEN||'';

// 刺點策略設定
const STRATEGY={name:'刺點',tf:'15m',lev:5,atrSl:3.0};
const WATCH_SYMBOLS=['SIREN-USDT','DOGE-USDT','XRP-USDT','HYPE-USDT','BTC-USDT'];
const MIN_SL=1.0,MIN_RR=1.5,MAX_SAME_DIR=3;

// ══════════════════════════════════
// 用戶管理
// ══════════════════════════════════
var bots=loadBots();
function loadBots(){
  if(fs.existsSync('/home/ubuntu/bots.json'))try{return JSON.parse(fs.readFileSync('/home/ubuntu/bots.json','utf8'));}catch(e){}
  return{};
}
function saveBots(){fs.writeFileSync('/home/ubuntu/bots.json',JSON.stringify(bots,null,2));}

function createBot(token,chatId,name,apiKey,secret){
  bots[token]={
    token,chatId,name,apiKey,secret,
    role:'user',
    cfg:{
      symbols:[].concat(WATCH_SYMBOLS),
      botRunning:false,
      allowShort:true,
      amount:1,
      copyFrom:null
    },
    openTrades:{},
    stats:{allTime:{total:0,wins:0,losses:0,pnl:0},daily:{},trades:[]},
    lastSignalTs:{},
    memLog:[],
    usedOrderIds:[],
    brain:{
      symbolPerf:{},hourPerf:{},dayPerf:{},
      adjustHistory:[],learnCount:0,
      hunterParams:{atrMultSl:3.0},
      bestWR:0,locked:false
    }
  };
  saveBots();
  return bots[token];
}

// ══════════════════════════════════
// 工具函數
// ══════════════════════════════════
function todayKey(){return new Date().toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});}
function nowTW(){return new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei'});}
function hourTW(){return parseInt(new Date().toLocaleString('en-US',{timeZone:'Asia/Taipei',hour:'numeric',hour12:false}));}

var sysLog=[];
function log(lv,msg,b){
  var line='['+nowTW()+'][BX]['+lv+'] '+(b?'['+b.name+'] ':'')+msg;
  console.log(line);
  sysLog.push({ts:nowTW(),lv,msg});
  if(sysLog.length>300)sysLog.shift();
  if(b&&b.memLog){b.memLog.push({ts:nowTW(),lv,msg});if(b.memLog.length>100)b.memLog.shift();}
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
    var opt={hostname:'open-api.bingx.com',path:path+'?'+q,method:method,headers:{'X-BX-APIKEY':apiKey,'Content-Type':'application/x-www-form-urlencoded'}};
    var go=function(n){
      var req=https.request(opt,function(rsp){var d='';rsp.on('data',function(c){d+=c;});rsp.on('end',function(){try{resolve(JSON.parse(d));}catch(e){reject(new Error(d.slice(0,80)));}});});
      req.on('error',function(e){if(n>1)setTimeout(function(){go(n-1);},2000);else reject(e);});
      req.setTimeout(12000,function(){req.destroy();if(n>1)setTimeout(function(){go(n-1);},2000);else reject(new Error('Timeout'));});
      req.end();
    };
    go(tries);
  });
}

function bxPublic(path,params){
  return new Promise(function(resolve,reject){
    var qs=params?Object.keys(params).map(function(k){return k+'='+params[k];}).join('&'):'';
    var fullPath=qs?path+'?'+qs:path;
    var req=https.request({hostname:'open-api.bingx.com',path:fullPath,method:'GET'},function(rsp){
      var d='';rsp.on('data',function(c){d+=c;});
      rsp.on('end',function(){try{resolve(JSON.parse(d));}catch(e){reject(e);}});
    });
    req.on('error',reject);
    req.setTimeout(10000,function(){req.destroy();reject(new Error('Timeout'));});
    req.end();
  });
}

function api(b){
  var ak=b.apiKey,sk=b.secret;
  return{
    getBalance:async function(){
      var r=await bxReq('GET','/openApi/swap/v2/user/balance',{},ak,sk);
      if(r.code===0)return{available:parseFloat(r.data.balance.availableMargin||0),total:parseFloat(r.data.balance.balance||0)};
      throw new Error('無法取得餘額');
    },
    getPositions:async function(sym){
      try{var r=await bxReq('GET','/openApi/swap/v2/user/positions',sym?{symbol:sym}:{},ak,sk);if(r.code===0)return(r.data||[]).filter(function(p){return parseFloat(p.positionAmt||0)!==0;});}catch(e){}return[];
    },
    getKlines:async function(sym,tf,lim){
      lim=lim||60;
      try{var r=await bxReq('GET','/openApi/swap/v2/quote/klines',{symbol:sym,interval:tf,limit:lim},ak,sk);if(r.code===0&&Array.isArray(r.data))return r.data;}catch(e){}return[];
    },
    setLev:async function(sym,lev){
      for(var s of['LONG','SHORT']){try{await bxReq('POST','/openApi/swap/v2/trade/leverage',{symbol:sym,side:s,leverage:lev},ak,sk);}catch(e){}}
    },
    placeMarketOrder:async function(o){
      await this.setLev(o.symbol,o.lev);
      var notional=o.amt*o.lev;
      var r=await bxReq('POST','/openApi/swap/v2/trade/order',{
        symbol:o.symbol,side:o.side,positionSide:o.positionSide,
        type:'MARKET',quoteOrderQty:String(notional)
      },ak,sk);
      if(r.code===0){
        await new Promise(function(res){setTimeout(res,1500);});
        var entryPrice=parseFloat(r.data&&r.data.order&&r.data.order.avgPrice||0);
        var qty=parseFloat(r.data&&r.data.order&&r.data.order.executedQty||0);
        console.log('[開單] '+o.symbol+' 入場:'+entryPrice+' 數量:'+qty);
        var cs=o.positionSide==='LONG'?'SELL':'BUY';
        if(o.stopLoss&&qty>0){
          var slR=await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:o.symbol,side:cs,positionSide:o.positionSide,type:'STOP_MARKET',stopPrice:String(o.stopLoss),quantity:String(qty),workingType:'MARK_PRICE'},ak,sk).catch(function(e){return{code:-1,msg:e.message};});
          console.log('[止損] '+o.symbol+' code:'+slR.code+' sl:'+o.stopLoss);
        }
        if(o.takeProfit&&qty>0){
          var tpR=await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:o.symbol,side:cs,positionSide:o.positionSide,type:'TAKE_PROFIT_MARKET',stopPrice:String(o.takeProfit),quantity:String(qty),workingType:'MARK_PRICE'},ak,sk).catch(function(e){return{code:-1,msg:e.message};});
          console.log('[止盈] '+o.symbol+' code:'+tpR.code+' tp:'+o.takeProfit);
        }
        return{orderId:r.data.order.orderId,qty,price:entryPrice};
      }
      throw new Error('市價單失敗: '+r.msg);
    },
    closePos:async function(sym,ps,qty){
      var r=await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:sym,side:ps==='LONG'?'SELL':'BUY',positionSide:ps,type:'MARKET',quantity:String(qty)},ak,sk);
      return r.code===0?r.data.order:null;
    },
    cancelAllOrders:async function(sym,ps){
      try{
        var r=await bxReq('GET','/openApi/swap/v2/trade/openOrders',{symbol:sym},ak,sk);
        if(r.code===0&&r.data&&r.data.orders){
          var toCancel=r.data.orders.filter(function(o){return o.positionSide===ps;});
          for(var i=0;i<toCancel.length;i++){
            try{await bxReq('POST','/openApi/swap/v2/trade/cancel',{symbol:sym,orderId:toCancel[i].orderId},ak,sk);}catch(e){}
          }
          if(toCancel.length>0)log('OK',sym+' 取消 '+toCancel.length+' 個掛單',b);
        }
      }catch(e){}
    },
    getActualPnl:async function(symbol,openTime){
      try{
        var r=await bxReq('GET','/openApi/swap/v2/user/income',{symbol:symbol,limit:20,startTime:String(openTime)},ak,sk);
        if(r.code===0&&r.data&&r.data.length>0){
          var items=r.data.filter(function(o){
            return parseInt(o.time||0)>openTime&&(o.incomeType==='REALIZED_PNL'||o.incomeType==='TRADING_FEE');
          });
          if(items.length>0){
            var totalPnl=items.reduce(function(sum,o){return sum+parseFloat(o.income||0);},0);
            return{pnl:totalPnl};
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
  atr:function(highs,lows,closes,n){
    n=n||14;if(highs.length<n+1)return null;
    var trs=[];
    for(var i=1;i<highs.length;i++){
      var tr=Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1]));
      trs.push(tr);
    }
    if(trs.length<n)return null;
    var atr=trs.slice(0,n).reduce(function(s,v){return s+v;},0)/n;
    for(var j=n;j<trs.length;j++)atr=(atr*(n-1)+trs[j])/n;
    return atr;
  },
  rsi:function(a,n){n=n||14;if(a.length<n+1)return null;var g=0,l=0;for(var i=a.length-n;i<a.length;i++){var d=a[i]-a[i-1];if(d>0)g+=d;else l-=d;}return 100-100/(1+g/(l||0.0001));},
  ema:function(a,n){if(a.length<n)return null;var k=2/(n+1),ema=a.slice(0,n).reduce(function(s,v){return s+v;},0)/n;for(var i=n;i<a.length;i++)ema=a[i]*k+ema*(1-k);return ema;}
};

// ══════════════════════════════════
// 刺點分析（Pin Bar）
// ══════════════════════════════════
function analyzePinBar(closes,highs,lows,opens){
  var result={signal:'NONE',pattern:'',strength:0,details:[]};
  if(closes.length<20)return result;

  var last=closes.length-1;
  var close=closes[last];
  var open=opens[last];
  var high=highs[last];
  var low=lows[last];

  var body=Math.abs(close-open);
  var upperShadow=high-Math.max(close,open);
  var lowerShadow=Math.min(close,open)-low;
  var totalRange=high-low;
  if(totalRange<=0||body<=0)return result;

  // 支撐阻力位（最近15根）
  var support=Math.min.apply(null,lows.slice(-15,-1));
  var resistance=Math.max.apply(null,highs.slice(-15,-1));

  // RSI
  var rsiVal=I.rsi(closes,14);

  // ✅ 做多刺點（長下影線）
  if(lowerShadow>body*2&&lowerShadow>totalRange*0.4&&close>open){
    var strength=0;
    if(lowerShadow>body*4)strength+=3;
    else if(lowerShadow>body*3)strength+=2;
    else strength+=1;
    if((close-low)/totalRange>0.6)strength+=2;
    if(Math.abs(low-support)/support<0.01)strength+=2;
    if(rsiVal&&rsiVal<45)strength++;
    result.signal='BUY';
    result.pattern='做多刺點(下影線)';
    result.strength=strength;
    result.details.push('下影線: '+(lowerShadow/body).toFixed(1)+'倍實體');
    result.details.push('收盤位置: K線上方'+(((close-low)/totalRange)*100).toFixed(0)+'%');
    if(Math.abs(low-support)/support<0.01)result.details.push('觸碰支撐: '+support.toFixed(4));
    if(rsiVal)result.details.push('RSI: '+rsiVal.toFixed(1));
    return result;
  }

  // ✅ 做空刺點（長上影線）
  if(upperShadow>body*2&&upperShadow>totalRange*0.4&&close<open){
    var strength2=0;
    if(upperShadow>body*4)strength2+=3;
    else if(upperShadow>body*3)strength2+=2;
    else strength2+=1;
    if((high-close)/totalRange>0.6)strength2+=2;
    if(Math.abs(high-resistance)/resistance<0.01)strength2+=2;
    if(rsiVal&&rsiVal>55)strength2++;
    result.signal='SELL';
    result.pattern='做空刺點(上影線)';
    result.strength=strength2;
    result.details.push('上影線: '+(upperShadow/body).toFixed(1)+'倍實體');
    result.details.push('收盤位置: K線下方'+(((high-close)/totalRange)*100).toFixed(0)+'%');
    if(Math.abs(high-resistance)/resistance<0.01)result.details.push('觸碰阻力: '+resistance.toFixed(4));
    if(rsiVal)result.details.push('RSI: '+rsiVal.toFixed(1));
    return result;
  }

  return result;
}

// ══════════════════════════════════
// 持倉監控（每30秒）
// ══════════════════════════════════
async function checkPositions(b){
  var ax=api(b);
  for(var key in b.openTrades){
    try{
      var t=b.openTrades[key];
      var ps=t.side;

      // 確認倉位是否還開著
      var pos=await ax.getPositions(t.symbol);
      var stillOpen=pos.some(function(p){return p.positionSide===ps&&parseFloat(p.positionAmt||0)!==0;});
      var holdMin=Math.round((Date.now()-t.openTime)/60000);

      // 已平倉
      if(!stillOpen&&holdMin>1){
        await new Promise(function(res){setTimeout(res,1500);});
        var actual=await ax.getActualPnl(t.symbol,t.openTime);
        var pnl=actual?actual.pnl:0;
        recordTrade(b,{symbol:t.symbol,side:t.side,entry:t.entry,exit:0,qty:t.qty,pnl:pnl,holdMin:holdMin,reason:'TP/SL',layer:'hunter'});
        delete b.openTrades[key];
        await ax.cancelAllOrders(t.symbol,ps);
        tgBot(b,'[BingX] '+(pnl>=0?'✅':'❌')+' '+t.symbol+'\\nPnL:'+(pnl>=0?'+':'')+pnl.toFixed(4)+'U Hold:'+holdMin+'min');
        saveBots();
        continue;
      }

      if(!stillOpen)continue;

      // 取當前價格
      var tkR=await bxReq('GET','/openApi/swap/v2/quote/ticker',{symbol:t.symbol},b.apiKey,b.secret).catch(function(){return{code:-1};});
      if(tkR.code!==0)continue;
      var cur=parseFloat(tkR.data.lastPrice);
      var estPct=ps==='LONG'?(cur-t.entry)/t.entry*100:(t.entry-cur)/t.entry*100;
      log('INFO','持倉 '+t.symbol+' '+(estPct>=0?'+':'')+estPct.toFixed(2)+'% Hold:'+holdMin+'min',b);

      // ✅ 移動止損：每獲利10%往上移一格
      if(!t.trailLevel)t.trailLevel=0;
      var newTrailLevel=Math.floor(estPct/10);
      if(newTrailLevel>t.trailLevel&&newTrailLevel>=1){
        t.trailLevel=newTrailLevel;
        var lockPct=(newTrailLevel-1)*10;
        var newSl,newTp;
        if(lockPct===0){
          newSl=+t.entry.toFixed(6);
        }else{
          newSl=ps==='LONG'?+(t.entry*(1+lockPct/100)).toFixed(6):+(t.entry*(1-lockPct/100)).toFixed(6);
        }
        // TP 同步上移（維持 RR 1.5）
        var slDist=Math.abs(cur-newSl);
        newTp=ps==='LONG'?+(cur+slDist*MIN_RR).toFixed(6):+(cur-slDist*MIN_RR).toFixed(6);

        try{
          // 取消舊的止損止盈
          await ax.cancelAllOrders(t.symbol,ps);
          await new Promise(function(res){setTimeout(res,500);});
          // 設定新的止損
          await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:t.symbol,side:ps==='LONG'?'SELL':'BUY',positionSide:ps,type:'STOP_MARKET',stopPrice:String(newSl),quantity:String(t.qty),workingType:'MARK_PRICE'},b.apiKey,b.secret);
          // 設定新的止盈
          await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:t.symbol,side:ps==='LONG'?'SELL':'BUY',positionSide:ps,type:'TAKE_PROFIT_MARKET',stopPrice:String(newTp),quantity:String(t.qty),workingType:'MARK_PRICE'},b.apiKey,b.secret);
          t.stopLoss=newSl;
          t.takeProfit=newTp;
          saveBots();
          tgBot(b,'[BingX] 🔒 移動止損\\n'+t.symbol+'\\n獲利: +'+estPct.toFixed(1)+'%\\n新止損: '+newSl+(lockPct===0?' (保本)':' (鎖定+'+lockPct+'%)')+'\\n新止盈: '+newTp);
          log('OK',t.symbol+' 移動止損 -> '+newSl+' TP -> '+newTp,b);
        }catch(e){log('WARN',t.symbol+' 移動止損失敗: '+e.message,b);}
      }
    }catch(e){log('ERROR','checkPos: '+e.message,b);}
  }
}

// ══════════════════════════════════
// 主交易循環（刺點策略）
// ══════════════════════════════════
async function tradingLoopUser(b){
  if(!b.cfg.botRunning)return;
  var ax=api(b);
  try{
    var bal=await ax.getBalance().catch(function(){return null;});
    if(!bal)return;
    var amt=b.cfg.amount||1;

    // 固定監控幣種
    var watchList=b.cfg.symbols&&b.cfg.symbols.length>0?b.cfg.symbols:WATCH_SYMBOLS;
    log('INFO','刺點監控: '+watchList.join(','),b);

    for(var i=0;i<watchList.length;i++){
      var sym=watchList[i];
      try{
        var hasL=b.openTrades[sym+'_L'];
        var hasS=b.openTrades[sym+'_S'];

        // 冷卻時間300秒
        var coolKey=sym+'_cool';
        if(b.lastSignalTs[coolKey]&&(Date.now()-b.lastSignalTs[coolKey])<300000)continue;

        // 同方向最多3張
        var sameL=Object.keys(b.openTrades).filter(function(k){return k.endsWith('_L');}).length;
        var sameS=Object.keys(b.openTrades).filter(function(k){return k.endsWith('_S');}).length;
        if(bal.available<amt)continue;

        // 取K線
        var kl=await ax.getKlines(sym,STRATEGY.tf,60);
        if(!kl||kl.length<20)continue;
        var closes=kl.map(function(k){return parseFloat(k.close||k[4]||0);});
        var highs=kl.map(function(k){return parseFloat(k.high||k[2]||0);});
        var lows=kl.map(function(k){return parseFloat(k.low||k[3]||0);});
        var opens=kl.map(function(k){return parseFloat(k.open||k[1]||0);});
        var cur=closes[closes.length-1];
        if(!cur||isNaN(cur))continue;
        var atrVal=I.atr(highs,lows,closes,14)||cur*0.01;

        // 刺點分析
        var pinBar=analyzePinBar(closes,highs,lows,opens);
        log('INFO',sym+' 刺點:'+pinBar.signal+' 強度:'+pinBar.strength+(pinBar.pattern?' ('+pinBar.pattern+')':''),b);

        if(pinBar.signal==='NONE')continue;
        if(pinBar.signal==='BUY'&&hasL)continue;
        if(pinBar.signal==='SELL'&&hasS)continue;
        if(pinBar.signal==='BUY'&&sameL>=MAX_SAME_DIR)continue;
        if(pinBar.signal==='SELL'&&(!b.cfg.allowShort||sameS>=MAX_SAME_DIR))continue;

        // ATR 止損止盈（RR=1.5）
        var atrSl=(b.brain&&b.brain.hunterParams&&b.brain.hunterParams.atrMultSl)||STRATEGY.atrSl;
        var slDist=Math.max(atrVal*atrSl,cur*MIN_SL/100);
        var tpDist=slDist*MIN_RR;

        var slP,tpP;
        if(pinBar.signal==='BUY'){
          slP=+(cur-slDist).toFixed(6);
          tpP=+(cur+tpDist).toFixed(6);
        }else{
          slP=+(cur+slDist).toFixed(6);
          tpP=+(cur-tpDist).toFixed(6);
        }

        var positionSide=pinBar.signal==='BUY'?'LONG':'SHORT';
        var tradeKey=sym+'_'+(pinBar.signal==='BUY'?'L':'S');

        // 市價開單
        var lo=await ax.placeMarketOrder({
          symbol:sym,
          side:pinBar.signal==='BUY'?'BUY':'SELL',
          positionSide:positionSide,
          amt:amt,lev:STRATEGY.lev,
          stopLoss:slP,takeProfit:tpP
        }).catch(function(e){log('ERROR',sym+' 開單失敗: '+e.message,b);return null;});

        if(lo){
          b.lastSignalTs[coolKey]=Date.now();
          b.openTrades[tradeKey]={
            symbol:sym,side:positionSide,
            entry:lo.price||cur,qty:lo.qty,
            layer:'hunter',openTime:Date.now(),
            isPending:false,halfExited:false,
            stopLoss:slP,takeProfit:tpP,
            trailLevel:0,slDist:slDist
          };
          saveBots();

          var notif='[BingX] ✅ 刺點開單\\n';
          notif+=(pinBar.signal==='BUY'?'🟢 多':'🔴 空')+' '+sym+'\\n';
          notif+='📐 '+pinBar.pattern+'\\n';
          pinBar.details.forEach(function(d){notif+='  '+d+'\\n';});
          notif+='\\n入場: '+cur+'\\n';
          notif+='SL: '+slP+'\\nTP: '+tpP+' (RR1.5)\\n';
          notif+='強度: '+pinBar.strength+'/8';
          tgBot(b,notif);
          log('OK',sym+' 刺點開單 '+pinBar.signal+' @'+cur+' SL:'+slP+' TP:'+tpP,b);
          copyTrade(b,{symbol:sym,side:pinBar.signal==='BUY'?'BUY':'SELL',positionSide:positionSide,price:cur,stopLoss:slP,takeProfit:tpP,layer:'hunter'}).catch(function(){});
        }
      }catch(e){log('ERROR',sym+': '+e.message,b);}
    }
    await checkPositions(b);
  }catch(e){log('ERROR','Loop: '+e.message,b);}
}

// ══════════════════════════════════
// 統計與學習
// ══════════════════════════════════
function recordTrade(b,t){
  var today=todayKey();
  if(!b.stats.daily[today])b.stats.daily[today]={total:0,wins:0,losses:0,pnl:0};
  var d=b.stats.daily[today];
  d.total++;if(t.pnl>0)d.wins++;else d.losses++;d.pnl+=t.pnl;
  b.stats.allTime.total++;if(t.pnl>0)b.stats.allTime.wins++;else b.stats.allTime.losses++;b.stats.allTime.pnl+=t.pnl;
  b.stats.trades.push(Object.assign({},t,{date:today}));
  if(b.stats.trades.length>500)b.stats.trades=b.stats.trades.slice(-500);
  if(!b.brain)b.brain={symbolPerf:{},hourPerf:{},dayPerf:{},adjustHistory:[],learnCount:0,hunterParams:{atrMultSl:3.0}};
  b.brain.learnCount=(b.brain.learnCount||0)+1;
  var hr=String(hourTW());
  if(!b.brain.hourPerf)b.brain.hourPerf={};
  if(!b.brain.hourPerf[hr])b.brain.hourPerf[hr]={wins:0,losses:0,pnl:0};
  if(t.pnl>0)b.brain.hourPerf[hr].wins++;else b.brain.hourPerf[hr].losses++;
  b.brain.hourPerf[hr].pnl+=t.pnl;
  if(!b.brain.symbolPerf)b.brain.symbolPerf={};
  if(!b.brain.symbolPerf[t.symbol])b.brain.symbolPerf[t.symbol]={wins:0,losses:0,pnl:0,count:0};
  var sp=b.brain.symbolPerf[t.symbol];
  if(t.pnl>0)sp.wins++;else sp.losses++;sp.pnl+=t.pnl;sp.count++;
  saveBots();
}

// ══════════════════════════════════
// 帶單跟單
// ══════════════════════════════════
async function copyTrade(masterBot,tradeInfo){
  if(masterBot.role!=='leader')return;
  var followers=Object.values(bots).filter(function(b){return b.cfg&&b.cfg.copyFrom===masterBot.token&&b.cfg.botRunning&&b.token!==masterBot.token;});
  if(!followers.length)return;
  for(var i=0;i<followers.length;i++){
    var fb=followers[i];
    try{
      var fax=api(fb);
      var lo=await fax.placeMarketOrder({
        symbol:tradeInfo.symbol,side:tradeInfo.side,positionSide:tradeInfo.positionSide,
        amt:fb.cfg.amount||1,lev:STRATEGY.lev,
        stopLoss:tradeInfo.stopLoss,takeProfit:tradeInfo.takeProfit
      }).catch(function(){return null;});
      if(lo)tgBot(fb,'[BingX] 📋 跟單\\n'+tradeInfo.symbol+' ['+(tradeInfo.side==='BUY'?'🟢 多':'🔴 空')+']\\n跟隨: '+masterBot.name);
    }catch(e){log('ERROR','跟單失敗 '+fb.name+': '+e.message,fb);}
  }
}

// ══════════════════════════════════
// AI 交易助手（Groq）
// ══════════════════════════════════
async function askAI(b,question){
  tgBot(b,'🤖 AI分析中...');
  var marketContext='';
  // 取監控幣種的最新數據
  var watchList=b.cfg.symbols&&b.cfg.symbols.length>0?b.cfg.symbols:WATCH_SYMBOLS;
  var ax=api(b);
  for(var i=0;i<watchList.length;i++){
    try{
      var sym=watchList[i];
      var kl=await ax.getKlines(sym,STRATEGY.tf,20);
      if(kl&&kl.length>=5){
        var closes=kl.map(function(k){return parseFloat(k.close||k[4]||0);});
        var highs=kl.map(function(k){return parseFloat(k.high||k[2]||0);});
        var lows=kl.map(function(k){return parseFloat(k.low||k[3]||0);});
        var opens=kl.map(function(k){return parseFloat(k.open||k[1]||0);});
        var pinBar=analyzePinBar(closes,highs,lows,opens);
        var rsi=I.rsi(closes,14);
        marketContext+=sym+': 現價'+closes[closes.length-1].toFixed(4);
        if(rsi)marketContext+=' RSI:'+rsi.toFixed(1);
        if(pinBar.signal!=='NONE')marketContext+=' 刺點:'+pinBar.pattern+'(強度'+pinBar.strength+')';
        marketContext+='\n';
      }
    }catch(e){}
  }

  var systemPrompt='你是一個專業的加密貨幣刺點策略交易分析師。'+
    '根據以下即時K線數據，給出交易建議。'+
    '分析是否有刺點形態，建議進場方向和止損止盈位置。'+
    '用繁體中文回答，簡潔清楚，不超過250字。'+
    '\n\n當前監控幣種數據：\n'+marketContext;

  var body=JSON.stringify({
    model:'llama-3.3-70b-versatile',
    max_tokens:500,
    messages:[
      {role:'system',content:systemPrompt},
      {role:'user',content:question}
    ]
  });

  return new Promise(function(resolve,reject){
    var req=https.request({
      hostname:'api.groq.com',
      path:'/openai/v1/chat/completions',
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':'Bearer '+(process.env.GROQ_API_KEY||'')
      }
    },function(res){
      var d='';
      res.on('data',function(c){d+=c;});
      res.on('end',function(){
        try{
          var r=JSON.parse(d);
          if(r.choices&&r.choices[0]&&r.choices[0].message){
            tgBot(b,'🤖 AI交易助手\n\n'+r.choices[0].message.content);
            resolve();
          }else{
            reject(new Error('AI回應格式錯誤: '+d.slice(0,100)));
          }
        }catch(e){reject(e);}
      });
    });
    req.on('error',reject);
    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════
// Telegram
// ══════════════════════════════════
function tgBot(b,text){
  if(!b.token||!b.chatId)return;
  var body=JSON.stringify({chat_id:b.chatId,text,parse_mode:'HTML'});
  var req=https.request({hostname:'api.telegram.org',path:'/bot'+b.token+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(r){var d='';r.on('data',function(c){d+=c;});});
  req.on('error',function(){});req.write(body);req.end();
}

function tgAdmin(text){
  if(!ADMIN_TOKEN||!ADMIN_CHAT)return;
  var body=JSON.stringify({chat_id:ADMIN_CHAT,text,parse_mode:'HTML'});
  var req=https.request({hostname:'api.telegram.org',path:'/bot'+ADMIN_TOKEN+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(r){var d='';r.on('data',function(c){d+=c;});});
  req.on('error',function(){});req.write(body);req.end();
}

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
  log('INFO','Bot監聽: '+b.name);
}

function handleBotUpdate(b,update){
  var msg=update.message||update.edited_message;if(!msg)return;
  var chatId=String(msg.chat.id),text=(msg.text||'').trim();
  if(b.chatId!==chatId){b.chatId=chatId;saveBots();}
  var parts=text.split(' '),cmd=parts[0].toLowerCase();
  log('INFO','指令: '+cmd+' from '+b.name,b);

  if(cmd==='/help'||cmd==='/start'){
    tgBot(b,'🎯 BingX 刺點策略系統\n\n【交易控制】\n/go - 啟動交易\n/stop - 停止交易\n/status - 狀態與餘額\n/short - 切換空單開關\n\n【查詢】\n/positions - 目前持倉\n/stats - 績效統計\n/history - 近10筆交易\n/log - 系統日誌\n/brain - 學習狀態\n\n【幣種管理】\n/symbols - 監控幣種清單\n/addsym SYMBOL - 新增幣種\n/delsym SYMBOL - 移除幣種\n\n【設定】\n/set amount N - 開倉金額(U)\n\n【AI助手】\n直接輸入問題即可\n例：DOGE現在有刺點嗎？\n\n【跟單】\n/copy - 查看帶單員\n/stopcopy - 取消跟單');return;
  }

  if(cmd==='/go'){
    if(b.cfg.botRunning){tgBot(b,'⚠️ 已在運行');return;}
    b.cfg.botRunning=true;saveBots();
    tgBot(b,'🚀 刺點策略啟動！\n\n監控幣種:\n'+b.cfg.symbols.join('\n')+'\n\n每1分鐘掃描刺點形態\nRR=1.5 移動止損\n\n等待刺點訊號...');return;
  }

  if(cmd==='/stop'){b.cfg.botRunning=false;saveBots();tgBot(b,'⏹ 已停止');return;}

  if(cmd==='/status'){
    api(b).getBalance().then(function(bal){
      var today=todayKey(),d=b.stats.daily[today]||{total:0,wins:0,losses:0,pnl:0},all=b.stats.allTime;
      var posCount=Object.keys(b.openTrades).length;
      tgBot(b,'[BingX] 狀態\n'+(b.cfg.botRunning?'🟢 運行中':'🔴 已停止')+'\n餘額:'+bal.available.toFixed(2)+'U\n今日:'+d.total+'筆 WR:'+(d.total>0?(d.wins/d.total*100).toFixed(0):0)+'% PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U\n累計:'+all.total+'筆 PnL:'+(all.pnl>=0?'+':'')+all.pnl.toFixed(2)+'U\n持倉:'+posCount+'\n金額:'+b.cfg.amount+'U\n空單:'+(b.cfg.allowShort?'開啟':'關閉'));
    }).catch(function(e){tgBot(b,'Error: '+e.message);});return;
  }

  if(cmd==='/short'){b.cfg.allowShort=!b.cfg.allowShort;saveBots();tgBot(b,'✅ 空單 -> '+(b.cfg.allowShort?'開啟':'關閉'));return;}

  if(cmd==='/positions'){
    var keys=Object.keys(b.openTrades);
    if(!keys.length){tgBot(b,'無持倉');return;}
    var m='[BingX] 持倉\n\n';
    keys.forEach(function(k){
      var t=b.openTrades[k];
      m+=(t.side==='LONG'?'🟢':'🔴')+' '+t.symbol+'\n';
      m+='Hold:'+Math.round((Date.now()-t.openTime)/60000)+'min\n';
      m+='SL:'+t.stopLoss+' TP:'+t.takeProfit+'\n\n';
    });
    tgBot(b,m);return;
  }

  if(cmd==='/stats'){
    var al=b.stats.allTime,today2=todayKey(),dds=b.stats.daily[today2]||{total:0,wins:0,losses:0,pnl:0};
    tgBot(b,'[BingX] 📊 績效\n今日:'+dds.total+'筆 WR:'+(dds.total>0?(dds.wins/dds.total*100).toFixed(0):0)+'% PnL:'+(dds.pnl>=0?'+':'')+dds.pnl.toFixed(2)+'U\n累計:'+al.total+'筆 WR:'+(al.total>0?(al.wins/al.total*100).toFixed(1):0)+'% PnL:'+(al.pnl>=0?'+':'')+al.pnl.toFixed(2)+'U');return;
  }

  if(cmd==='/history'){
    var tr=b.stats.trades.slice(-10).reverse();if(!tr.length){tgBot(b,'尚無交易');return;}
    tgBot(b,'[BingX] 近10筆\n'+tr.map(function(t){return (t.pnl>=0?'✅':'❌')+' '+t.symbol+' '+(t.pnl>=0?'+':'')+t.pnl.toFixed(4)+'U '+t.reason;}).join('\n'));return;
  }

  if(cmd==='/log'){
    var logs=b.memLog&&b.memLog.slice(-10)||[];
    if(!logs.length){tgBot(b,'📋 目前沒有日誌');return;}
    var m2='📋 最近日誌\n\n';
    logs.forEach(function(l){
      var icon=l.lv==='OK'?'✅':l.lv==='ERROR'?'❌':l.lv==='WARN'?'⚠️':'ℹ️';
      m2+=icon+' '+l.msg.slice(0,60)+'\n';
    });
    tgBot(b,m2);return;
  }

  if(cmd==='/brain'){
    var br=b.brain||{};
    var msg='[BingX] 🧠 學習狀態\n';
    msg+='已學習:'+(br.learnCount||0)+'次\n';
    msg+='ATR止損倍數:'+(br.hunterParams&&br.hunterParams.atrMultSl||STRATEGY.atrSl)+'x\n\n';
    var sp=br.symbolPerf||{};
    msg+='【幣種表現】\n';
    Object.keys(sp).forEach(function(s){
      var p=sp[s];var t=p.wins+p.losses;
      if(t>0)msg+=s+': WR:'+(p.wins/t*100).toFixed(0)+'% PnL:'+(p.pnl>=0?'+':'')+p.pnl.toFixed(2)+'U ('+t+'筆)\n';
    });
    tgBot(b,msg);return;
  }

  if(cmd==='/symbols'){tgBot(b,'監控幣種:\n'+b.cfg.symbols.join('\n'));return;}

  if(cmd==='/addsym'&&parts[1]){
    var ns=parts[1].toUpperCase();
    if(!b.cfg.symbols.includes(ns)){b.cfg.symbols.push(ns);saveBots();tgBot(b,'✅ 新增: '+ns);}
    else tgBot(b,ns+' 已存在');return;
  }

  if(cmd==='/delsym'&&parts[1]){
    b.cfg.symbols=b.cfg.symbols.filter(function(s){return s!==parts[1].toUpperCase();});
    saveBots();tgBot(b,'✅ 移除: '+parts[1].toUpperCase());return;
  }

  if(cmd==='/set'&&parts[1]==='amount'&&parts[2]){
    var amt=parseFloat(parts[2]);
    if(amt>=1&&amt<=100){b.cfg.amount=amt;saveBots();tgBot(b,'✅ 開倉金額 -> '+amt+'U');}
    else tgBot(b,'金額需在 1-100U');return;
  }

  if(cmd==='/copy'){
    if(!parts[1]){
      var leaders=Object.values(bots).filter(function(lb){return lb.role==='leader';});
      if(!leaders.length){tgBot(b,'目前沒有帶單員');return;}
      tgBot(b,'🌟 可跟單:\n'+leaders.map(function(lb){return lb.name;}).join('\n')+'\n\n/copy 名稱 開始跟單');return;
    }
    var masterBot=Object.values(bots).find(function(mb){return mb.name===parts[1]&&mb.role==='leader';});
    if(masterBot){b.cfg.copyFrom=masterBot.token;saveBots();tgBot(b,'✅ 跟單: '+parts[1]);}
    else tgBot(b,'找不到帶單員: '+parts[1]);return;
  }

  if(cmd==='/stopcopy'){delete b.cfg.copyFrom;saveBots();tgBot(b,'✅ 已取消跟單');return;}

  // AI 助手 - 非指令文字直接問
  if(!text.startsWith('/')&&text.length>3){
    askAI(b,text).catch(function(e){tgBot(b,'❌ AI失敗: '+e.message);});
    return;
  }

  if(text.startsWith('/'))tgBot(b,'未知指令，輸入 /help');
}

// 管理員 polling
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
              if(msg&&String(msg.chat.id)===ADMIN_CHAT)setImmediate(function(){handleAdminUpdate(u);});
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
  log('INFO','管理員監聽啟動');
}

function handleAdminUpdate(update){
  var msg=update.message||update.edited_message;if(!msg)return;
  var text=(msg.text||'').trim(),parts=text.split(' '),cmd=parts[0].toLowerCase();
  log('INFO','管理員指令: '+cmd);

  if(cmd==='/help'){
    tgAdmin('👑 管理員指令\n\n/addbot TOKEN NAME APIKEY SECRET\n/bots - Bot列表\n/delbot TOKEN\n/setleader 名稱\n/removeleader 名稱\n/leaders - 帶單員列表\n/log - 系統日誌\n/broadcast 訊息');return;
  }

  if(cmd==='/addbot'&&parts.length>=5){
    var token=parts[1],name=parts[2],apiKey=parts[3],secret=parts[4];
    bxReq('GET','/openApi/swap/v2/user/balance',{},apiKey,secret).then(function(r){
      if(r.code===0){
        var bal=parseFloat(r.data.balance.availableMargin||0);
        var b=createBot(token,'',name,apiKey,secret);
        startBotPolling(b);
        tgAdmin('✅ 新增Bot: '+name+'\n餘額: '+bal.toFixed(2)+'U');
      }else tgAdmin('❌ API驗證失敗: '+r.msg);
    }).catch(function(e){tgAdmin('❌ 連線失敗: '+e.message);});return;
  }

  if(cmd==='/bots'){
    var botList=Object.values(bots);
    if(!botList.length){tgAdmin('目前沒有Bot');return;}
    var m='Bot列表 共'+botList.length+'個\n\n';
    botList.forEach(function(b){m+=b.name+': '+(b.cfg.botRunning?'🟢':'🔴')+' 持倉:'+Object.keys(b.openTrades).length+' PnL:'+b.stats.allTime.pnl.toFixed(2)+'U\n';});
    tgAdmin(m);return;
  }

  if(cmd==='/delbot'&&parts[1]){
    if(bots[parts[1]]){var n=bots[parts[1]].name;delete bots[parts[1]];saveBots();tgAdmin('✅ 已刪除: '+n);}
    else tgAdmin('找不到Bot');return;
  }

  if(cmd==='/setleader'&&parts[1]){
    var lb=Object.values(bots).find(function(b){return b.name===parts[1];});
    if(lb){lb.role='leader';saveBots();tgAdmin('✅ 帶單員: '+parts[1]);tgBot(lb,'🌟 您已獲得帶單員權限');}
    else tgAdmin('找不到: '+parts[1]);return;
  }

  if(cmd==='/removeleader'&&parts[1]){
    var rb=Object.values(bots).find(function(b){return b.name===parts[1];});
    if(rb){rb.role='user';saveBots();tgAdmin('✅ 移除帶單員: '+parts[1]);}
    else tgAdmin('找不到: '+parts[1]);return;
  }

  if(cmd==='/leaders'){
    var leaders=Object.values(bots).filter(function(b){return b.role==='leader';});
    tgAdmin('帶單員:\n'+(leaders.length?leaders.map(function(b){return b.name;}).join('\n'):'無'));return;
  }

  if(cmd==='/log'){
    var logs=sysLog.slice(-15).map(function(l){return '['+l.lv+'] '+l.msg.slice(0,60);}).join('\n');
    tgAdmin('系統日誌\n'+(logs||'無'));return;
  }

  if(cmd==='/broadcast'&&parts.length>1){
    var broadMsg=parts.slice(1).join(' ');
    Object.values(bots).forEach(function(b){tgBot(b,'📢 系統公告\n'+broadMsg);});
    tgAdmin('✅ 廣播完成');return;
  }
}

// ══════════════════════════════════
// 主循環
// ══════════════════════════════════
var mainTimer=null;

function startMainLoop(){
  if(mainTimer)return;
  // 每1分鐘掃描刺點
  mainTimer=setInterval(function(){
    Object.values(bots).forEach(function(b){
      if(b.cfg&&b.cfg.botRunning){
        tradingLoopUser(b).catch(function(e){log('ERROR','BotLoop '+b.name+': '+e.message);});
      }
    });
  },60000);
  // 每30秒監控持倉
  setInterval(function(){
    Object.values(bots).forEach(function(b){
      if(b.cfg&&b.cfg.botRunning&&Object.keys(b.openTrades).length>0){
        checkPositions(b).catch(function(e){log('ERROR','checkPos '+b.name+': '+e.message);});
      }
    });
  },30000);
  log('INFO','主循環啟動 ✅');
}

function startServer(){
  http.createServer(function(req,res){res.writeHead(200);res.end(JSON.stringify({status:'ok',bots:Object.keys(bots).length}));}).listen(3002,function(){log('INFO','Server Port:3002');});
}

async function main(){
  console.log('\nBingX 刺點策略系統 v1.0\n');
  log('INFO','系統啟動中...');
  startServer();
  startMainLoop();
  startAdminPolling();
  Object.values(bots).forEach(function(b){startBotPolling(b);});
  var activeCount=Object.values(bots).filter(function(b){return b.cfg&&b.cfg.botRunning;}).length;
  tgAdmin('[刺點策略 v1.0] 🟢 上線!\nBot數: '+Object.keys(bots).length+'\n運行中: '+activeCount+'\n\n刺點策略（Pin Bar）\n固定監控5個幣種\n每1分鐘掃描\n移動止損 RR=1.5\n\n/addbot 新增Bot');
  log('OK','系統就緒！Bot數量: '+Object.keys(bots).length);
}

process.on('uncaughtException',function(e){log('ERROR','未捕獲錯誤: '+e.message);tgAdmin('🚨 系統異常: '+e.message);});
process.on('unhandledRejection',function(e){log('ERROR','未處理Promise: '+(e&&e.message?e.message:String(e)));});
process.on('SIGINT',function(){tgAdmin('⛔ 系統關閉');setTimeout(function(){process.exit(0);},2000);});
main().catch(function(e){log('ERROR','啟動失敗: '+e.message);process.exit(1);});

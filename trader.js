'use strict';
const crypto=require('crypto'),https=require('https'),http=require('http'),fs=require('fs');

// ══════════════════════════════════
// 系統設定
// ══════════════════════════════════
const ADMIN_CHAT='8308748755';
const ADMIN_TOKEN=process.env.BYBIT_TG_TOKEN||'';
const GROQ_KEY=process.env.GROQ_API_KEY||'';
const BX_KEY=process.env.BX_APIKEY||'IDrcq954PuXoImAK1U4MEC9sI9HLK2B9PSuctuib9u7maCsZdAMRp7u99uHrPfeErNxDBA4SoOYC54DLfKHQ';
const BX_SECRET=process.env.BX_SECRET||'NqpQkRZMwqhzKVcxiC5gECYSGgrZoVhyRKisWBxkQEVsIBxu4iEdtMjCEX174eHFcAfzHT3x9biX8XtcjeJIQ';

const WATCH_SYMBOLS=['ADA-USDT','DOGE-USDT','SOL-USDT','XRP-USDT','SIREN-USDT','GOLD-USDT','HYPE-USDT','APE-USDT','SUI-USDT','UNI-USDT'];
const MAX_SAME_DIR=3;
const MIN_SL=1.0;
const MIN_RR=1.5;

// ══════════════════════════════════
// 策略定義
// ══════════════════════════════════
const STRATEGIES={
  pinbar:{
    name:'刺點策略',emoji:'🎯',tf:'1h',lev:5,
    desc:'長影線反轉，在支撐阻力位捕捉主力反向操作',
    token:'8556121528:AAH03kAeFz9fn9zobHsK16sQqiiw3rPtMy0'
  },
  shortwave:{
    name:'短波策略',emoji:'⚡',tf:'5m',lev:5,
    desc:'5分鐘K線快進快出，捕捉短期波動',
    token:'8725981993:AAE8S_s47BBnEhS6RlNZglwueq0X7sohQiM'
  },
  longwave:{
    name:'長波策略',emoji:'🌊',tf:'4h',lev:5,
    desc:'4小時K線大趨勢操作，耐心等待強訊號',
    token:'8860540887:AAGXQASgMvaITFV4c8qFG1Td6DGDVRsLpL8'
  },
  boll:{
    name:'布林帶',emoji:'🎸',tf:'1h',lev:5,
    desc:'價格觸碰布林帶上下軌，均值回歸策略',
    token:'8503488493:AAH9CESN8hP3crAJFW7Ygi_fd1mPoLL0UQw'
  },
  breakout:{
    name:'突破策略',emoji:'🚀',tf:'1h',lev:5,
    desc:'突破近期高低點，追蹤動能',
    token:'8760052481:AAHo8XWWwgkBJ9a2KuIOCcJJpUGBFQPTwwk'
  }
};

// ══════════════════════════════════
// Bot 資料管理
// ══════════════════════════════════
var bots={};
var sharedMsg=[]; // 交流平台訊息池

function loadBots(){
  if(fs.existsSync('/home/ubuntu/bots.json'))try{
    var data=JSON.parse(fs.readFileSync('/home/ubuntu/bots.json','utf8'));
    // 更新策略Bot
    Object.keys(STRATEGIES).forEach(function(sk){
      var st=STRATEGIES[sk];
      if(!data[st.token]){
        data[st.token]=createBotData(st.token,sk);
      }else{
        data[st.token].strategyKey=sk;
        data[st.token].strategy=st.name;
      }
    });
    return data;
  }catch(e){}
  return initBots();
}

function initBots(){
  var data={};
  Object.keys(STRATEGIES).forEach(function(sk){
    var st=STRATEGIES[sk];
    data[st.token]=createBotData(st.token,sk);
  });
  return data;
}

function createBotData(token,strategyKey){
  var st=STRATEGIES[strategyKey];
  return{
    token:token,
    chatId:ADMIN_CHAT,
    name:st.name,
    strategyKey:strategyKey,
    strategy:st.name,
    emoji:st.emoji,
    apiKey:BX_KEY,
    secret:BX_SECRET,
    cfg:{
      symbols:[].concat(WATCH_SYMBOLS),
      botRunning:false,
      allowShort:true,
      amount:1,
      lev:st.lev
    },
    openTrades:{},
    stats:{
      allTime:{total:0,wins:0,losses:0,pnl:0},
      daily:{},
      weekly:{},
      trades:[],
      capital:20 // 初始本金20U
    },
    lastSignalTs:{},
    memLog:[],
    brain:{
      learnCount:0,
      symbolPerf:{},
      hourPerf:{},
      improvements:[], // 改進方案
      lastWeekRank:0
    }
  };
}

function saveBots(){
  fs.writeFileSync('/home/ubuntu/bots.json',JSON.stringify(bots,null,2));
}

// ══════════════════════════════════
// 工具函數
// ══════════════════════════════════
function todayKey(){return new Date().toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});}
function weekKey(){
  var d=new Date();
  var day=d.getDay();
  var diff=d.getDate()-day+(day===0?-6:1);
  var mon=new Date(d.setDate(diff));
  return mon.toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});
}
function nowTW(){return new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei'});}
function hourTW(){return parseInt(new Date().toLocaleString('en-US',{timeZone:'Asia/Taipei',hour:'numeric',hour12:false}));}
function minTW(){return new Date().getMinutes();}

var sysLog=[];
function log(lv,msg,b){
  var line='['+nowTW()+'][BX]['+lv+'] '+(b?'['+b.name+'] ':'')+msg;
  console.log(line);
  sysLog.push({ts:nowTW(),lv,msg:(b?'['+b.name+'] ':'')+msg});
  if(sysLog.length>500)sysLog.shift();
  if(b&&b.memLog){b.memLog.push({ts:nowTW(),lv,msg});if(b.memLog.length>200)b.memLog.shift();}
}

// ══════════════════════════════════
// BingX API
// ══════════════════════════════════
function bxReq(method,path,params,apiKey,secret){
  params=params||{};
  return new Promise(function(resolve,reject){
    var p=Object.assign({},params,{timestamp:Date.now()});
    var qs=Object.keys(p).filter(function(k){return p[k]!=null&&p[k]!=='';}).map(function(k){return k+'='+p[k];}).join('&');
    var sig=crypto.createHmac('sha256',secret).update(qs).digest('hex');
    var q=qs+'&signature='+sig;
    var opt={hostname:'open-api.bingx.com',path:path+'?'+q,method:method,headers:{'X-BX-APIKEY':apiKey,'Content-Type':'application/x-www-form-urlencoded'}};
    var req=https.request(opt,function(rsp){
      var d='';rsp.on('data',function(c){d+=c;});
      rsp.on('end',function(){try{resolve(JSON.parse(d));}catch(e){reject(new Error(d.slice(0,80)));}});
    });
    req.on('error',function(e){setTimeout(function(){reject(e);},1000);});
    req.setTimeout(12000,function(){req.destroy();reject(new Error('Timeout'));});
    req.end();
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
      try{
        var r=await bxReq('GET','/openApi/swap/v2/quote/klines',{symbol:sym,interval:tf,limit:lim},ak,sk);
        if(r.code===0&&Array.isArray(r.data))return r.data;
      }catch(e){}return[];
    },
    setLev:async function(sym,lev){
      for(var s of['LONG','SHORT']){try{await bxReq('POST','/openApi/swap/v2/trade/leverage',{symbol:sym,side:s,leverage:lev},ak,sk);}catch(e){}}
    },
    placeMarketOrder:async function(o){
      await this.setLev(o.symbol,o.lev||5);
      var notional=o.amt*o.lev;
      var r=await bxReq('POST','/openApi/swap/v2/trade/order',{
        symbol:o.symbol,side:o.side,positionSide:o.positionSide,
        type:'MARKET',quoteOrderQty:String(notional)
      },ak,sk);
      if(r.code===0){
        await new Promise(function(res){setTimeout(res,1500);});
        var entryPrice=parseFloat(r.data&&r.data.order&&r.data.order.avgPrice||0);
        var qty=parseFloat(r.data&&r.data.order&&r.data.order.executedQty||0);
        var cs=o.positionSide==='LONG'?'SELL':'BUY';
        if(o.stopLoss&&qty>0){
          await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:o.symbol,side:cs,positionSide:o.positionSide,type:'STOP_MARKET',stopPrice:String(o.stopLoss),quantity:String(qty),workingType:'MARK_PRICE'},ak,sk).catch(function(e){log('ERROR','SL失敗: '+e.message);});
        }
        if(o.takeProfit&&qty>0){
          await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:o.symbol,side:cs,positionSide:o.positionSide,type:'TAKE_PROFIT_MARKET',stopPrice:String(o.takeProfit),quantity:String(qty),workingType:'MARK_PRICE'},ak,sk).catch(function(e){log('ERROR','TP失敗: '+e.message);});
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
        }
      }catch(e){}
    },
    getActualPnl:async function(symbol,openTime){
      try{
        var r=await bxReq('GET','/openApi/swap/v2/user/income',{symbol:symbol,limit:20,startTime:String(openTime)},ak,sk);
        if(r.code===0&&r.data&&r.data.length>0){
          var items=r.data.filter(function(o){return parseInt(o.time||0)>openTime&&(o.incomeType==='REALIZED_PNL'||o.incomeType==='TRADING_FEE');});
          if(items.length>0)return{pnl:items.reduce(function(s,o){return s+parseFloat(o.income||0);},0)};
        }
      }catch(e){}return null;
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
  ema:function(a,n){if(a.length<n)return null;var k=2/(n+1),ema=a.slice(0,n).reduce(function(s,v){return s+v;},0)/n;for(var i=n;i<a.length;i++)ema=a[i]*k+ema*(1-k);return ema;},
  boll:function(a,n,d){n=n||20;d=d||2;if(a.length<n)return null;var sl=a.slice(-n),m=sl.reduce(function(s,v){return s+v;},0)/n,std=Math.sqrt(sl.reduce(function(s,v){return s+Math.pow(v-m,2);},0)/n);return{upper:m+d*std,mid:m,lower:m-d*std};},
  ma:function(a,n){if(a.length<n)return null;return a.slice(-n).reduce(function(s,v){return s+v;},0)/n;}
};

// ══════════════════════════════════
// 各策略分析函數
// ══════════════════════════════════

// 1. 刺點策略
function analyzePinBar(closes,highs,lows,opens){
  var result={signal:'NONE',pattern:'',strength:0,details:[]};
  if(closes.length<20)return result;
  var last=closes.length-1;
  var close=closes[last],open=opens[last],high=highs[last],low=lows[last];
  var body=Math.abs(close-open),upperShadow=high-Math.max(close,open),lowerShadow=Math.min(close,open)-low,totalRange=high-low;
  if(totalRange<=0||body<=0)return result;
  if(upperShadow>body*1.5&&lowerShadow>body*1.5)return result; // 雙影線過濾
  var support=Math.min.apply(null,lows.slice(-15,-1));
  var resistance=Math.max.apply(null,highs.slice(-15,-1));
  var rsiVal=I.rsi(closes,14);
  var ema20=I.ema(closes,20),ema50=I.ema(closes,50);
  var trendUp=ema20&&ema50&&ema20>ema50;
  var trendDown=ema20&&ema50&&ema20<ema50;
  var prevBearish=closes[last-1]<opens[last-1];
  var prevBullish=closes[last-1]>opens[last-1];

  // 做多刺點
  if(lowerShadow>body*3&&lowerShadow>totalRange*0.45&&close>open&&(close-low)/totalRange>0.65&&trendUp){
    var s=0;
    if(lowerShadow>body*5)s+=3;else if(lowerShadow>body*4)s+=2;else s+=1;
    if((close-low)/totalRange>0.65)s+=2;
    if(Math.abs(low-support)/support<0.015)s+=2;
    if(rsiVal&&rsiVal<40)s+=2;else if(rsiVal&&rsiVal<45)s++;
    if(prevBearish)s++;
    if(s<4)return result;
    result.signal='BUY';result.pattern='做多刺點';result.strength=s;
    result.details.push('下影線:'+(lowerShadow/body).toFixed(1)+'倍');
    result.details.push('觸支撐:'+(Math.abs(low-support)/support*100).toFixed(2)+'%');
    if(rsiVal)result.details.push('RSI:'+rsiVal.toFixed(1));
    return result;
  }
  // 做空刺點
  if(upperShadow>body*3&&upperShadow>totalRange*0.45&&close<open&&(high-close)/totalRange>0.65&&trendDown){
    var s2=0;
    if(upperShadow>body*5)s2+=3;else if(upperShadow>body*4)s2+=2;else s2+=1;
    if((high-close)/totalRange>0.65)s2+=2;
    if(Math.abs(high-resistance)/resistance<0.015)s2+=2;
    if(rsiVal&&rsiVal>60)s2+=2;else if(rsiVal&&rsiVal>55)s2++;
    if(prevBullish)s2++;
    if(s2<4)return result;
    result.signal='SELL';result.pattern='做空刺點';result.strength=s2;
    result.details.push('上影線:'+(upperShadow/body).toFixed(1)+'倍');
    result.details.push('觸阻力:'+(Math.abs(high-resistance)/resistance*100).toFixed(2)+'%');
    if(rsiVal)result.details.push('RSI:'+rsiVal.toFixed(1));
    return result;
  }
  return result;
}

// 2. 短波策略（5分鐘快進快出）
function analyzeShortWave(closes,highs,lows,opens,vols){
  var result={signal:'NONE',pattern:'',strength:0,details:[]};
  if(closes.length<20)return result;
  var cur=closes[closes.length-1];
  var rsi=I.rsi(closes,14);
  var ema9=I.ema(closes,9),ema21=I.ema(closes,21);
  var boll=I.boll(closes,20,2);
  var avgVol=vols.slice(-10,-1).reduce(function(s,v){return s+v;},0)/9;
  var lastVol=vols[vols.length-1];
  var volSpike=lastVol>avgVol*1.8;
  var prev9=I.ema(closes.slice(0,-1),9);
  var prev21=I.ema(closes.slice(0,-1),21);
  if(!ema9||!ema21||!prev9||!prev21)return result;

  // 快速金叉 + 成交量放大 + RSI動能
  if(prev9<prev21&&ema9>ema21&&volSpike&&rsi&&rsi>50&&rsi<75){
    var s=3;
    if(volSpike)s++;
    if(rsi>55)s++;
    if(boll&&cur>boll.mid)s++;
    result.signal='BUY';result.pattern='短波金叉';result.strength=s;
    result.details.push('EMA快速金叉');
    result.details.push('量能放大 '+(lastVol/avgVol).toFixed(1)+'倍');
    result.details.push('RSI:'+rsi.toFixed(1));
    return result;
  }
  // 快速死叉 + 成交量放大 + RSI動能
  if(prev9>prev21&&ema9<ema21&&volSpike&&rsi&&rsi<50&&rsi>25){
    var s2=3;
    if(volSpike)s2++;
    if(rsi<45)s2++;
    if(boll&&cur<boll.mid)s2++;
    result.signal='SELL';result.pattern='短波死叉';result.strength=s2;
    result.details.push('EMA快速死叉');
    result.details.push('量能放大 '+(lastVol/avgVol).toFixed(1)+'倍');
    result.details.push('RSI:'+rsi.toFixed(1));
    return result;
  }
  // 超短RSI極端反轉
  if(rsi&&rsi<20&&closes[closes.length-1]>closes[closes.length-2]){
    result.signal='BUY';result.pattern='短波超賣';result.strength=4;
    result.details.push('RSI極度超賣:'+rsi.toFixed(1));
    return result;
  }
  if(rsi&&rsi>80&&closes[closes.length-1]<closes[closes.length-2]){
    result.signal='SELL';result.pattern='短波超買';result.strength=4;
    result.details.push('RSI極度超買:'+rsi.toFixed(1));
    return result;
  }
  return result;
}

// 3. 長波策略（4小時大趨勢）
function analyzeLongWave(closes,highs,lows,opens,vols){
  var result={signal:'NONE',pattern:'',strength:0,details:[]};
  if(closes.length<55)return result;
  var cur=closes[closes.length-1];
  var ema21=I.ema(closes,21),ema55=I.ema(closes,55);
  var prevEma21=I.ema(closes.slice(0,-1),21);
  var prevEma55=I.ema(closes.slice(0,-1),55);
  if(!ema21||!ema55||!prevEma21||!prevEma55)return result;
  var rsi=I.rsi(closes,14);
  var boll=I.boll(closes,20,2);
  // 支撐阻力
  var support=Math.min.apply(null,lows.slice(-30,-1));
  var resistance=Math.max.apply(null,highs.slice(-30,-1));

  // 大趨勢翻多：EMA21上穿EMA55 + 收盤確認
  if(prevEma21<prevEma55&&ema21>ema55&&cur>ema21){
    var s=4;
    if(rsi&&rsi>50&&rsi<70)s++;
    if(cur>ema55*1.01)s++;
    if(boll&&cur>boll.mid)s++;
    result.signal='BUY';result.pattern='長波趨勢翻多';result.strength=s;
    result.details.push('EMA21('+ema21.toFixed(4)+') 上穿 EMA55('+ema55.toFixed(4)+')');
    result.details.push('大趨勢確認轉多');
    if(rsi)result.details.push('RSI:'+rsi.toFixed(1));
    return result;
  }
  // 大趨勢翻空：EMA21下穿EMA55
  if(prevEma21>prevEma55&&ema21<ema55&&cur<ema21){
    var s2=4;
    if(rsi&&rsi<50&&rsi>30)s2++;
    if(cur<ema55*0.99)s2++;
    if(boll&&cur<boll.mid)s2++;
    result.signal='SELL';result.pattern='長波趨勢翻空';result.strength=s2;
    result.details.push('EMA21('+ema21.toFixed(4)+') 下穿 EMA55('+ema55.toFixed(4)+')');
    result.details.push('大趨勢確認轉空');
    if(rsi)result.details.push('RSI:'+rsi.toFixed(1));
    return result;
  }
  // 長波回調做多：大趨勢多頭中回調到支撐
  if(ema21>ema55&&cur<ema21&&Math.abs(cur-support)/support<0.02){
    var s3=3;
    if(rsi&&rsi<45)s3++;
    if(boll&&cur<boll.lower)s3++;
    result.signal='BUY';result.pattern='長波回調支撐';result.strength=s3;
    result.details.push('多頭趨勢回調至支撐 '+support.toFixed(4));
    if(rsi)result.details.push('RSI:'+rsi.toFixed(1));
    return result;
  }
  // 長波反彈做空：大趨勢空頭中反彈到阻力
  if(ema21<ema55&&cur>ema21&&Math.abs(cur-resistance)/resistance<0.02){
    var s4=3;
    if(rsi&&rsi>55)s4++;
    if(boll&&cur>boll.upper)s4++;
    result.signal='SELL';result.pattern='長波反彈阻力';result.strength=s4;
    result.details.push('空頭趨勢反彈至阻力 '+resistance.toFixed(4));
    if(rsi)result.details.push('RSI:'+rsi.toFixed(1));
    return result;
  }
  return result;
}

// 4. 布林帶策略
function analyzeBoll(closes,highs,lows){
  var result={signal:'NONE',pattern:'',strength:0,details:[]};
  if(closes.length<25)return result;
  var boll=I.boll(closes,20,2);
  if(!boll)return result;
  var cur=closes[closes.length-1],prev=closes[closes.length-2];
  var rsi=I.rsi(closes,14);
  var ema50=I.ema(closes,50);
  // 跌破下軌後反彈（做多）
  if(prev<boll.lower&&cur>boll.lower&&ema50&&cur>ema50*0.98){
    var s=3;
    if(cur>prev)s++;
    if(rsi&&rsi<45)s++;
    if(cur>boll.mid*0.99)s++;
    result.signal='BUY';result.pattern='布林下軌反彈';result.strength=s;
    result.details.push('突破布林下軌 '+boll.lower.toFixed(4));
    result.details.push('中軌:'+boll.mid.toFixed(4));
    if(rsi)result.details.push('RSI:'+rsi.toFixed(1));
    return result;
  }
  // 突破上軌後回落（做空）
  if(prev>boll.upper&&cur<boll.upper&&ema50&&cur<ema50*1.02){
    var s2=3;
    if(cur<prev)s2++;
    if(rsi&&rsi>55)s2++;
    if(cur<boll.mid*1.01)s2++;
    result.signal='SELL';result.pattern='布林上軌回落';result.strength=s2;
    result.details.push('突破布林上軌 '+boll.upper.toFixed(4));
    result.details.push('中軌:'+boll.mid.toFixed(4));
    if(rsi)result.details.push('RSI:'+rsi.toFixed(1));
    return result;
  }
  return result;
}

// 5. 突破策略
function analyzeBreakout(closes,highs,lows,vols){
  var result={signal:'NONE',pattern:'',strength:0,details:[]};
  if(closes.length<25)return result;
  var cur=closes[closes.length-1];
  var recentHighs=highs.slice(-20,-1),recentLows=lows.slice(-20,-1);
  var highBreak=Math.max.apply(null,recentHighs);
  var lowBreak=Math.min.apply(null,recentLows);
  var avgVol=vols.slice(-20,-1).reduce(function(s,v){return s+v;},0)/19;
  var lastVol=vols[vols.length-1];
  var volConfirm=lastVol>avgVol*1.5;
  var rsi=I.rsi(closes,14);
  // 向上突破
  if(cur>highBreak*1.002&&volConfirm){
    var s=3;
    if(cur>highBreak*1.005)s++;
    if(lastVol>avgVol*2)s++;
    if(rsi&&rsi>50&&rsi<75)s++;
    result.signal='BUY';result.pattern='向上突破';result.strength=s;
    result.details.push('突破'+highBreak.toFixed(4)+' (+'+((cur/highBreak-1)*100).toFixed(2)+'%)');
    result.details.push('成交量放大 '+(lastVol/avgVol).toFixed(1)+'倍');
    if(rsi)result.details.push('RSI:'+rsi.toFixed(1));
    return result;
  }
  // 向下突破
  if(cur<lowBreak*0.998&&volConfirm){
    var s2=3;
    if(cur<lowBreak*0.995)s2++;
    if(lastVol>avgVol*2)s2++;
    if(rsi&&rsi<50&&rsi>25)s2++;
    result.signal='SELL';result.pattern='向下突破';result.strength=s2;
    result.details.push('跌破'+lowBreak.toFixed(4)+' (-'+((1-cur/lowBreak)*100).toFixed(2)+'%)');
    result.details.push('成交量放大 '+(lastVol/avgVol).toFixed(1)+'倍');
    if(rsi)result.details.push('RSI:'+rsi.toFixed(1));
    return result;
  }
  return result;
}

// 選擇策略函數
function runStrategy(b,closes,highs,lows,opens,vols){
  switch(b.strategyKey){
    case 'pinbar':return analyzePinBar(closes,highs,lows,opens);
    case 'shortwave':return analyzeShortWave(closes,highs,lows,opens,vols);
    case 'longwave':return analyzeLongWave(closes,highs,lows,opens,vols);
    case 'boll':return analyzeBoll(closes,highs,lows);
    case 'breakout':return analyzeBreakout(closes,highs,lows,vols);
    default:return{signal:'NONE',pattern:'',strength:0,details:[]};
  }
}

// ══════════════════════════════════
// 本金與開倉金額管理
// ══════════════════════════════════
function getTradeAmount(b){
  var capital=b.stats.capital||20;
  var amount=b.cfg.amount||1;
  // 本金>200U 最多可開10U
  if(capital>200)amount=Math.min(amount,10);
  else amount=Math.min(amount,5);
  return amount;
}

function getLeverage(b){
  var capital=b.stats.capital||20;
  // 本金>500U 可調整槓桿
  if(capital>500)return b.cfg.lev||5;
  return 5; // 固定5倍
}

function updateCapital(b,pnl){
  b.stats.capital=(b.stats.capital||20)+pnl;
  saveBots();
}

// ══════════════════════════════════
// 持倉監控
// ══════════════════════════════════
async function checkPositions(b){
  var ax=api(b);
  for(var key in b.openTrades){
    try{
      var t=b.openTrades[key];
      var ps=t.side;
      var pos=await ax.getPositions(t.symbol);
      var stillOpen=pos.some(function(p){return p.positionSide===ps&&parseFloat(p.positionAmt||0)!==0;});
      var holdMin=Math.round((Date.now()-t.openTime)/60000);

      if(!stillOpen&&holdMin>1){
        await new Promise(function(res){setTimeout(res,1500);});
        var actual=await ax.getActualPnl(t.symbol,t.openTime);
        var pnl=actual?actual.pnl:0;
        recordTrade(b,{symbol:t.symbol,side:t.side,entry:t.entry,exit:0,qty:t.qty,pnl:pnl,holdMin:holdMin,reason:'TP/SL',layer:b.strategyKey});
        updateCapital(b,pnl);
        delete b.openTrades[key];
        await ax.cancelAllOrders(t.symbol,ps);
        tgBot(b,'['+b.emoji+b.name+'] '+(pnl>=0?'✅':'❌')+' '+t.symbol+'\nPnL:'+(pnl>=0?'+':'')+pnl.toFixed(4)+'U Hold:'+holdMin+'min');
        // 交流平台廣播
        broadcastToAdmin(b.emoji+b.name+(pnl>=0?' ✅ 獲利 ':' ❌ 虧損 ')+t.symbol+' PnL:'+(pnl>=0?'+':'')+pnl.toFixed(4)+'U Hold:'+holdMin+'min');
        saveBots();
        continue;
      }
      if(!stillOpen)continue;

      var tkR=await bxReq('GET','/openApi/swap/v2/quote/ticker',{symbol:t.symbol},b.apiKey,b.secret).catch(function(){return{code:-1};});
      if(tkR.code!==0)continue;
      var cur=parseFloat(tkR.data.lastPrice);
      var estPct=ps==='LONG'?(cur-t.entry)/t.entry*100:(t.entry-cur)/t.entry*100;
      log('INFO','持倉 '+t.symbol+' '+(estPct>=0?'+':'')+estPct.toFixed(2)+'% Hold:'+holdMin+'min',b);

      // 移動止損：每5%往上移，鎖定(獲利-3%)
      if(!t.trailLevel)t.trailLevel=0;
      var newTrailLevel=Math.floor(estPct/5);
      if(newTrailLevel>t.trailLevel&&newTrailLevel>=1){
        t.trailLevel=newTrailLevel;
        var lockPct=Math.max(0,(newTrailLevel-1)*5+2);
        var newSl=lockPct===0?+t.entry.toFixed(6):(ps==='LONG'?+(t.entry*(1+lockPct/100)).toFixed(6):+(t.entry*(1-lockPct/100)).toFixed(6));
        var slDist=Math.abs(cur-newSl);
        var newTp=ps==='LONG'?+(cur+slDist*MIN_RR).toFixed(6):+(cur-slDist*MIN_RR).toFixed(6);
        try{
          await ax.cancelAllOrders(t.symbol,ps);
          await new Promise(function(res){setTimeout(res,500);});
          await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:t.symbol,side:ps==='LONG'?'SELL':'BUY',positionSide:ps,type:'STOP_MARKET',stopPrice:String(newSl),quantity:String(t.qty),workingType:'MARK_PRICE'},b.apiKey,b.secret);
          await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:t.symbol,side:ps==='LONG'?'SELL':'BUY',positionSide:ps,type:'TAKE_PROFIT_MARKET',stopPrice:String(newTp),quantity:String(t.qty),workingType:'MARK_PRICE'},b.apiKey,b.secret);
          t.stopLoss=newSl;t.takeProfit=newTp;
          saveBots();
          tgBot(b,'['+b.emoji+b.name+'] 🔒 移動止損\n'+t.symbol+'\n獲利: +'+estPct.toFixed(1)+'%\n新止損: '+newSl+(lockPct===0?' (保本)':' (鎖定+'+lockPct+'%)')+'\n新止盈: '+newTp);
        }catch(e){log('WARN',t.symbol+' 移動止損失敗: '+e.message,b);}
      }
    }catch(e){log('ERROR','checkPos: '+e.message,b);}
  }
}

// ══════════════════════════════════
// 主交易循環
// ══════════════════════════════════
async function tradingLoopUser(b){
  if(!b.cfg.botRunning)return;
  var ax=api(b);
  try{
    var bal=await ax.getBalance().catch(function(){return null;});
    if(!bal)return;
    var amt=getTradeAmount(b);
    var lev=getLeverage(b);
    var watchList=b.cfg.symbols&&b.cfg.symbols.length>0?b.cfg.symbols:WATCH_SYMBOLS;

    for(var i=0;i<watchList.length;i++){
      var sym=watchList[i];
      try{
        var hasL=b.openTrades[sym+'_L'];
        var hasS=b.openTrades[sym+'_S'];
        var coolKey=sym+'_cool';
        if(b.lastSignalTs[coolKey]&&(Date.now()-b.lastSignalTs[coolKey])<1800000)continue; // 30分鐘冷卻
        var sameL=Object.keys(b.openTrades).filter(function(k){return k.endsWith('_L');}).length;
        var sameS=Object.keys(b.openTrades).filter(function(k){return k.endsWith('_S');}).length;
        if(bal.available<amt)continue;

        var tf=STRATEGIES[b.strategyKey].tf;
        var kl=await ax.getKlines(sym,tf,100);
        if(!kl||kl.length<55)continue;
        var closes=kl.map(function(k){return parseFloat(k.close||k[4]||0);});
        var highs=kl.map(function(k){return parseFloat(k.high||k[2]||0);});
        var lows=kl.map(function(k){return parseFloat(k.low||k[3]||0);});
        var opens=kl.map(function(k){return parseFloat(k.open||k[1]||0);});
        var vols=kl.map(function(k){return parseFloat(k.volume||k[5]||0);});
        var cur=closes[closes.length-1];
        if(!cur||isNaN(cur))continue;
        var atrVal=I.atr(highs,lows,closes,14)||cur*0.01;

        var sig=runStrategy(b,closes,highs,lows,opens,vols);
        if(sig.signal!=='NONE'){
          log('INFO',sym+' '+b.name+' '+sig.signal+' 強度:'+sig.strength+' ('+sig.pattern+')',b);
        }

        if(sig.signal==='NONE')continue;
        if(sig.signal==='BUY'&&hasL)continue;
        if(sig.signal==='SELL'&&hasS)continue;
        if(sig.signal==='BUY'&&sameL>=MAX_SAME_DIR)continue;
        if(sig.signal==='SELL'&&(!b.cfg.allowShort||sameS>=MAX_SAME_DIR))continue;

        // 止損放在支撐/阻力位
        var recentH=highs.slice(-20),recentL=lows.slice(-20);
        var resistance=Math.max.apply(null,recentH.slice(0,-3));
        var support=Math.min.apply(null,recentL.slice(0,-3));
        var slDist,tpP;
        if(sig.signal==='BUY'){
          slDist=Math.max(cur-support,cur*MIN_SL/100);
          slDist=Math.min(slDist,cur*5/100);
          var tpAtRes=+(resistance*0.998).toFixed(6);
          tpP=tpAtRes>cur+slDist*MIN_RR?tpAtRes:+(cur+slDist*MIN_RR).toFixed(6);
        }else{
          slDist=Math.max(resistance-cur,cur*MIN_SL/100);
          slDist=Math.min(slDist,cur*5/100);
          var tpAtSup=+(support*1.002).toFixed(6);
          tpP=tpAtSup<cur-slDist*MIN_RR?tpAtSup:+(cur-slDist*MIN_RR).toFixed(6);
        }
        var slP=sig.signal==='BUY'?+(cur-slDist).toFixed(6):+(cur+slDist).toFixed(6);
        var positionSide=sig.signal==='BUY'?'LONG':'SHORT';
        var tradeKey=sym+'_'+(sig.signal==='BUY'?'L':'S');

        var lo=await ax.placeMarketOrder({
          symbol:sym,side:sig.signal==='BUY'?'BUY':'SELL',
          positionSide:positionSide,amt:amt,lev:lev,
          stopLoss:slP,takeProfit:tpP
        }).catch(function(e){log('ERROR',sym+' 開單失敗: '+e.message,b);return null;});

        if(lo){
          b.lastSignalTs[coolKey]=Date.now();
          b.openTrades[tradeKey]={
            symbol:sym,side:positionSide,
            entry:lo.price||cur,qty:lo.qty,
            layer:b.strategyKey,openTime:Date.now(),
            isPending:false,stopLoss:slP,takeProfit:tpP,
            trailLevel:0,slDist:slDist
          };
          saveBots();

          var notif='['+b.emoji+b.name+'] ✅ 開單\n';
          notif+=(sig.signal==='BUY'?'🟢 多':'🔴 空')+' '+sym+'\n';
          notif+='📐 '+sig.pattern+' (強度:'+sig.strength+')\n';
          sig.details.forEach(function(d){notif+='  '+d+'\n';});
          notif+='\n入場: '+cur+'\nSL: '+slP+'\nTP: '+tpP;
          tgBot(b,notif);
          log('OK',sym+' 開單 '+sig.signal+' @'+cur,b);

          // 交流平台廣播開單訊息
          var openMsg=b.emoji+b.name+' 開倉 '+(sig.signal==='BUY'?'🟢 多':'🔴 空')+' '+sym+'\n理由: '+sig.pattern+'\n強度: '+sig.strength+'/8';
          broadcastToAdmin(openMsg);
          // 自動發起討論（不阻塞主流程）
          setTimeout(function(){botDiscuss(b,'我剛開了'+sym+(sig.signal==='BUY'?'多單':'空單')+'，你們怎麼看？',sym).catch(function(){});},3000);
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
  var today=todayKey(),wk=weekKey();
  if(!b.stats.daily[today])b.stats.daily[today]={total:0,wins:0,losses:0,pnl:0};
  if(!b.stats.weekly[wk])b.stats.weekly[wk]={total:0,wins:0,losses:0,pnl:0};
  var d=b.stats.daily[today],w=b.stats.weekly[wk];
  d.total++;w.total++;
  if(t.pnl>0){d.wins++;w.wins++;}else{d.losses++;w.losses++;}
  d.pnl+=t.pnl;w.pnl+=t.pnl;
  b.stats.allTime.total++;
  if(t.pnl>0)b.stats.allTime.wins++;else b.stats.allTime.losses++;
  b.stats.allTime.pnl+=t.pnl;
  b.stats.trades.push(Object.assign({},t,{date:today}));
  if(b.stats.trades.length>500)b.stats.trades=b.stats.trades.slice(-500);
  if(!b.brain.symbolPerf[t.symbol])b.brain.symbolPerf[t.symbol]={wins:0,losses:0,pnl:0,count:0};
  var sp=b.brain.symbolPerf[t.symbol];
  if(t.pnl>0)sp.wins++;else sp.losses++;sp.pnl+=t.pnl;sp.count++;
  b.brain.learnCount++;
  saveBots();
}

// ══════════════════════════════════
// 交流平台
// ══════════════════════════════════
function broadcastToAdmin(msg,silent){
  sharedMsg.push({ts:nowTW(),msg:msg});
  if(sharedMsg.length>200)sharedMsg.shift();
  // silent=true 只存不發通知，避免洗版
  if(!silent&&ADMIN_TOKEN&&ADMIN_CHAT){
    var body=JSON.stringify({chat_id:ADMIN_CHAT,text:'💬 '+msg});
    var req=https.request({hostname:'api.telegram.org',path:'/bot'+ADMIN_TOKEN+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(){});
    req.on('error',function(){});req.write(body);req.end();
  }
}

// ✅ AI Bot 互相討論
async function botDiscuss(triggerBot,topic,sym){
  // 每個Bot用AI生成觀點，發到聊天窗
  var allBots=Object.values(bots).filter(function(b){return b.cfg&&b.cfg.botRunning;});
  if(!allBots.length)return;
  broadcastToAdmin('━━━━━━━━━━━━━━━\n📢 '+triggerBot.emoji+triggerBot.name+' 發起討論\n主題: '+topic+(sym?' ['+sym+']':'')+' \n━━━━━━━━━━━━━━━');
  await new Promise(function(r){setTimeout(r,1000);});
  for(var i=0;i<allBots.length;i++){
    var b=allBots[i];
    try{
      var ax=api(b);
      var marketCtx='';
      if(sym){
        var tf=STRATEGIES[b.strategyKey]&&STRATEGIES[b.strategyKey].tf||'1h';
        var kl=await ax.getKlines(sym,tf,30).catch(function(){return[];});
        if(kl&&kl.length>=10){
          var closes=kl.map(function(k){return parseFloat(k.close||k[4]||0);});
          var highs=kl.map(function(k){return parseFloat(k.high||k[2]||0);});
          var lows=kl.map(function(k){return parseFloat(k.low||k[3]||0);});
          var opens=kl.map(function(k){return parseFloat(k.open||k[1]||0);});
          var vols=kl.map(function(k){return parseFloat(k.volume||k[5]||0);});
          var rsi=I.rsi(closes,14);
          var ema20=I.ema(closes,20);
          var sig=runStrategy(b,closes,highs,lows,opens,vols);
          marketCtx=sym+'現價:'+closes[closes.length-1].toFixed(4);
          if(rsi)marketCtx+=' RSI:'+rsi.toFixed(1);
          if(ema20)marketCtx+=' EMA20:'+ema20.toFixed(4);
          if(sig.signal!=='NONE')marketCtx+=' 我的訊號:'+sig.signal+'('+sig.pattern+')';
        }
      }
      var prompt='你是'+b.name+'，專業的'+b.strategy+'交易員。'+
        '用你的策略視角，針對討論主題給出簡短專業的看法（50字以內）。'+
        '語氣要有個性，可以同意或反對其他人的看法。'+
        '只說重點，不用客套話。'+
        (marketCtx?'\n當前數據: '+marketCtx:'');
      var body=JSON.stringify({
        model:'llama-3.3-70b-versatile',max_tokens:150,
        messages:[{role:'system',content:prompt},{role:'user',content:topic}]
      });
      var response=await new Promise(function(resolve,reject){
        var req=https.request({hostname:'api.groq.com',path:'/openai/v1/chat/completions',method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_KEY}},function(res){
          var d='';res.on('data',function(c){d+=c;});
          res.on('end',function(){try{var r=JSON.parse(d);resolve(r.choices&&r.choices[0]?r.choices[0].message.content:'...');}catch(e){resolve('...');}});
        });
        req.on('error',function(){resolve('...');});req.write(body);req.end();
      });
      broadcastToAdmin(b.emoji+' '+b.name+':\n'+response);
      await new Promise(function(r){setTimeout(r,1500);});
    }catch(e){log('ERROR','討論失敗 '+b.name+': '+e.message);}
  }
  broadcastToAdmin('━━━━━━━━━━━━━━━\n討論結束');
}

// ══════════════════════════════════
// 每日績效報告（早上9點）
// ══════════════════════════════════
function sendDailyReport(){
  var today=todayKey();
  var msg='📊 每日績效報告 '+today+'\n\n';
  var botList=Object.values(bots).sort(function(a,b){
    var ap=(a.stats.daily[today]||{pnl:0}).pnl;
    var bp=(b.stats.daily[today]||{pnl:0}).pnl;
    return bp-ap;
  });
  botList.forEach(function(b,idx){
    var d=b.stats.daily[today]||{total:0,wins:0,losses:0,pnl:0};
    var wr=d.total>0?(d.wins/d.total*100).toFixed(0):0;
    msg+=idx+1+'. '+b.emoji+b.name+'\n';
    msg+='  今日: '+d.total+'筆 WR:'+wr+'% PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(4)+'U\n';
    msg+='  本金: '+b.stats.capital.toFixed(2)+'U\n\n';
  });
  if(ADMIN_TOKEN&&ADMIN_CHAT){
    var body=JSON.stringify({chat_id:ADMIN_CHAT,text:msg});
    var req=https.request({hostname:'api.telegram.org',path:'/bot'+ADMIN_TOKEN+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(){});
    req.on('error',function(){});req.write(body);req.end();
  }
}

// ══════════════════════════════════
// 每週排名（週日）
// ══════════════════════════════════
function sendWeeklyRanking(){
  var wk=weekKey();
  var msg='🏆 每週排名 週次:'+wk+'\n\n';
  var botList=Object.values(bots).sort(function(a,b){
    var ap=(a.stats.weekly[wk]||{pnl:0}).pnl;
    var bp=(b.stats.weekly[wk]||{pnl:0}).pnl;
    return bp-ap;
  });
  botList.forEach(function(b,idx){
    var w=b.stats.weekly[wk]||{total:0,wins:0,losses:0,pnl:0};
    var wr=w.total>0?(w.wins/w.total*100).toFixed(0):0;
    var medal=idx===0?'🥇':idx===1?'🥈':idx===2?'🥉':'  ';
    msg+=medal+' '+b.emoji+b.name+'\n';
    msg+='  週績效: WR:'+wr+'% PnL:'+(w.pnl>=0?'+':'')+w.pnl.toFixed(4)+'U ('+w.total+'筆)\n';
    msg+='  本金: '+b.stats.capital.toFixed(2)+'U\n\n';
  });
  // 最後一名需要寫改進方案
  var lastBot=botList[botList.length-1];
  if(lastBot){
    msg+='⚠️ 最後一名: '+lastBot.emoji+lastBot.name+'\n請提交改進方案！\n';
    msg+='指令: /improve [策略改進內容]';
    tgBot(lastBot,'⚠️ 本週排名最後！\n\n請提交改進方案給海馬審核\n指令: /improve [改進內容]\n\n例: /improve 調整RSI門檻為25/75，增加成交量確認條件');
  }
  if(ADMIN_TOKEN&&ADMIN_CHAT){
    var body=JSON.stringify({chat_id:ADMIN_CHAT,text:msg});
    var req=https.request({hostname:'api.telegram.org',path:'/bot'+ADMIN_TOKEN+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(){});
    req.on('error',function(){});req.write(body);req.end();
  }
}

// ══════════════════════════════════
// Telegram Bot 處理
// ══════════════════════════════════
function tgBot(b,text){
  if(!b.token||!b.chatId)return;
  var body=JSON.stringify({chat_id:b.chatId,text,parse_mode:'HTML'});
  var req=https.request({hostname:'api.telegram.org',path:'/bot'+b.token+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(){});
  req.on('error',function(){});req.write(body);req.end();
}

function tgAdmin(text){
  if(!ADMIN_TOKEN||!ADMIN_CHAT)return;
  var body=JSON.stringify({chat_id:ADMIN_CHAT,text,parse_mode:'HTML'});
  var req=https.request({hostname:'api.telegram.org',path:'/bot'+ADMIN_TOKEN+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(){});
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
  log('INFO','['+b.name+'] CMD: '+cmd,b);

  if(cmd==='/help'||cmd==='/start'){
    tgBot(b,b.emoji+' '+b.name+'\n策略: '+b.strategy+'\n\n/go - 啟動\n/stop - 停止\n/status - 狀態\n/positions - 持倉\n/stats - 績效\n/history - 交易記錄\n/log - 日誌\n/symbols - 監控幣種\n/addsym - 新增幣種\n/delsym - 移除幣種\n/set amount N - 開倉金額\n/short - 切換空單\n/capital - 本金狀態\n/improve [內容] - 提交改進方案\n\n直接輸入問題 → AI助手');return;
  }

  if(cmd==='/go'){
    if(b.cfg.botRunning){tgBot(b,'⚠️ 已在運行');return;}
    b.cfg.botRunning=true;saveBots();
    tgBot(b,b.emoji+' '+b.name+' 啟動！\n策略: '+b.strategy+'\n監控: '+b.cfg.symbols.join(',')+'\n開倉: '+b.cfg.amount+'U × '+b.cfg.lev+'倍\n本金: '+b.stats.capital.toFixed(2)+'U\n\n準備就緒，等待訊號...');
    broadcastToAdmin(b.emoji+b.name+' 上線！準備交易');return;
  }

  if(cmd==='/stop'){b.cfg.botRunning=false;saveBots();tgBot(b,'⏹ '+b.name+' 已停止');broadcastToAdmin(b.emoji+b.name+' 下線');return;}

  if(cmd==='/status'){
    api(b).getBalance().then(function(bal){
      var today=todayKey(),d=b.stats.daily[today]||{total:0,wins:0,losses:0,pnl:0},all=b.stats.allTime;
      var capital=b.stats.capital||20;
      tgBot(b,b.emoji+' '+b.name+'\n'+(b.cfg.botRunning?'🟢 運行中':'🔴 停止')+
        '\n餘額:'+bal.available.toFixed(2)+'U'+
        '\n本金:'+capital.toFixed(2)+'U'+
        '\n今日:'+d.total+'筆 WR:'+(d.total>0?(d.wins/d.total*100).toFixed(0):0)+'% PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U'+
        '\n累計:'+all.total+'筆 PnL:'+(all.pnl>=0?'+':'')+all.pnl.toFixed(2)+'U'+
        '\n開倉:'+b.cfg.amount+'U 槓桿:'+b.cfg.lev+'x'+
        '\n空單:'+(b.cfg.allowShort?'開':'關'));
    }).catch(function(e){tgBot(b,'Error: '+e.message);});return;
  }

  if(cmd==='/capital'){
    var capital=b.stats.capital||20;
    var maxAmt=capital>200?10:5;
    var canAdjLev=capital>500;
    tgBot(b,'💰 '+b.name+' 本金狀態\n本金:'+capital.toFixed(2)+'U\n最大開倉:'+maxAmt+'U\n調整槓桿:'+(canAdjLev?'✅ 可調整':'❌ 需>500U\n目前固定5倍')+'\n\n開倉金額>200U後可調到10U\n槓桿>500U後可調整');return;
  }

  if(cmd==='/short'){b.cfg.allowShort=!b.cfg.allowShort;saveBots();tgBot(b,'✅ 空單 → '+(b.cfg.allowShort?'開啟':'關閉'));return;}

  if(cmd==='/positions'){
    var keys=Object.keys(b.openTrades);
    if(!keys.length){tgBot(b,'無持倉');return;}
    var m=b.emoji+' 持倉\n\n';
    keys.forEach(function(k){
      var t=b.openTrades[k];
      m+=(t.side==='LONG'?'🟢':'🔴')+' '+t.symbol+'\n';
      m+='Hold:'+Math.round((Date.now()-t.openTime)/60000)+'min\n';
      m+='SL:'+t.stopLoss+' TP:'+t.takeProfit+'\n\n';
    });
    tgBot(b,m);return;
  }

  if(cmd==='/stats'){
    var al=b.stats.allTime,today2=todayKey(),d2=b.stats.daily[today2]||{total:0,wins:0,losses:0,pnl:0};
    var wk2=weekKey(),w2=b.stats.weekly[wk2]||{total:0,wins:0,losses:0,pnl:0};
    tgBot(b,b.emoji+' '+b.name+' 績效\n今日:'+d2.total+'筆 WR:'+(d2.total>0?(d2.wins/d2.total*100).toFixed(0):0)+'% PnL:'+(d2.pnl>=0?'+':'')+d2.pnl.toFixed(2)+'U\n本週:'+w2.total+'筆 WR:'+(w2.total>0?(w2.wins/w2.total*100).toFixed(0):0)+'% PnL:'+(w2.pnl>=0?'+':'')+w2.pnl.toFixed(2)+'U\n累計:'+al.total+'筆 WR:'+(al.total>0?(al.wins/al.total*100).toFixed(1):0)+'% PnL:'+(al.pnl>=0?'+':'')+al.pnl.toFixed(2)+'U\n本金:'+b.stats.capital.toFixed(2)+'U');return;
  }

  if(cmd==='/history'){
    var tr=b.stats.trades.slice(-10).reverse();if(!tr.length){tgBot(b,'尚無交易');return;}
    tgBot(b,b.emoji+' 近10筆\n'+tr.map(function(t){return (t.pnl>=0?'✅':'❌')+' '+t.symbol+' '+(t.pnl>=0?'+':'')+t.pnl.toFixed(4)+'U '+t.reason;}).join('\n'));return;
  }

  if(cmd==='/log'){
    var logs=b.memLog&&b.memLog.slice(-10)||[];
    if(!logs.length){tgBot(b,'目前沒有日誌');return;}
    var m2=b.emoji+' 最近日誌\n\n';
    logs.forEach(function(l){m2+=(l.lv==='OK'?'✅':l.lv==='ERROR'?'❌':l.lv==='WARN'?'⚠️':'ℹ️')+' '+l.msg.slice(0,60)+'\n';});
    tgBot(b,m2);return;
  }

  if(cmd==='/symbols'){tgBot(b,'監控幣種:\n'+b.cfg.symbols.join('\n'));return;}

  if(cmd==='/addsym'&&parts[1]){
    var ns=parts[1].toUpperCase().trim();
    if(!ns.endsWith('-USDT'))ns+='-USDT';
    if(!b.cfg.symbols.includes(ns)){b.cfg.symbols.push(ns);saveBots();tgBot(b,'✅ 新增: '+ns);}
    else tgBot(b,ns+' 已存在');return;
  }

  if(cmd==='/delsym'&&parts[1]){
    var ds=parts[1].toUpperCase().trim();
    if(!ds.endsWith('-USDT'))ds+='-USDT';
    b.cfg.symbols=b.cfg.symbols.filter(function(s){return s!==ds;});
    saveBots();tgBot(b,'✅ 移除: '+ds);return;
  }

  if(cmd==='/set'&&parts[1]==='amount'&&parts[2]){
    var amt2=parseFloat(parts[2]);
    var capital2=b.stats.capital||20;
    var maxAmt2=capital2>200?10:5;
    if(amt2>=1&&amt2<=maxAmt2){b.cfg.amount=amt2;saveBots();tgBot(b,'✅ 開倉金額 → '+amt2+'U');}
    else tgBot(b,'金額需在 1-'+maxAmt2+'U\n(本金需>200U才能開到10U)');return;
  }

  if(cmd==='/set'&&parts[1]==='lev'&&parts[2]){
    var capital3=b.stats.capital||20;
    if(capital3<500){tgBot(b,'❌ 本金需>500U才能調整槓桿\n目前本金:'+capital3.toFixed(2)+'U');return;}
    var lev2=parseInt(parts[2]);
    if(lev2>=1&&lev2<=20){b.cfg.lev=lev2;saveBots();tgBot(b,'✅ 槓桿 → '+lev2+'x');}
    else tgBot(b,'槓桿需在 1-20x');return;
  }

  if(cmd==='/improve'&&parts.length>1){
    var content=parts.slice(1).join(' ');
    if(!b.brain.improvements)b.brain.improvements=[];
    b.brain.improvements.push({ts:nowTW(),content:content,status:'待審核'});
    saveBots();
    tgBot(b,'✅ 改進方案已提交！等待海馬審核');
    // 通知管理員
    tgAdmin('📋 改進方案\n來自: '+b.emoji+b.name+'\n\n'+content+'\n\n/approve '+b.strategyKey+' 批准\n/reject '+b.strategyKey+' 拒絕');return;
  }

  // AI 助手
  if(!text.startsWith('/')&&text.length>3){
    askAI(b,text).catch(function(e){tgBot(b,'❌ AI失敗: '+e.message);});return;
  }

  if(text.startsWith('/'))tgBot(b,'未知指令，輸入 /help');
}

// ══════════════════════════════════
// 管理員（海馬）指令
// ══════════════════════════════════
var adminPollId=0;
function startAdminPolling(){
  if(!ADMIN_TOKEN)return;
  function poll(){
    var req=https.request({hostname:'api.telegram.org',path:'/bot'+ADMIN_TOKEN+'/getUpdates?offset='+(adminPollId+1)+'&timeout=10&limit=5',method:'GET'},function(res){
      var d='';res.on('data',function(c){d+=c;});
      res.on('end',function(){
        try{
          var json=JSON.parse(d);
          if(json.ok&&json.result&&json.result.length>0){
            json.result.forEach(function(u){
              if(u.update_id>adminPollId)adminPollId=u.update_id;
              var msg=u.message||u.edited_message;
              if(msg&&String(msg.chat.id)===ADMIN_CHAT)setImmediate(function(){handleAdminCmd(u);});
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

function handleAdminCmd(update){
  var msg=update.message||update.edited_message;if(!msg)return;
  var text=(msg.text||'').trim(),parts=text.split(' '),cmd=parts[0].toLowerCase();
  log('INFO','管理員: '+cmd);

  if(cmd==='/help'){
    tgAdmin('👑 海馬管理指令\n\n【查看】\n/bots - 所有Bot狀態\n/ranking - 即時排名\n/report - 即時績效報告\n/chat - 交易室訊息\n/log - 系統日誌\n\n【討論】\n/discuss DOGE - 召開幣種分析會議\n/meeting - 每日市場會議\n\n【控制】\n/startall - 啟動所有Bot\n/stopall - 停止所有Bot\n/broadcast [訊息] - 廣播\n\n【改進方案】\n/improvements - 查看所有方案\n/approve [策略名] - 批准\n/reject [策略名] [原因] - 拒絕');return;
  }

  if(cmd==='/bots'){
    var m='🤖 Bot狀態\n\n';
    Object.values(bots).forEach(function(b){
      var today=todayKey(),d=b.stats.daily[today]||{total:0,wins:0,pnl:0};
      m+=b.emoji+' '+b.name+': '+(b.cfg.botRunning?'🟢':'🔴')+'\n';
      m+='  今日:'+d.total+'筆 PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U 本金:'+b.stats.capital.toFixed(2)+'U\n\n';
    });
    tgAdmin(m);return;
  }

  if(cmd==='/ranking'||cmd==='/report'){
    var today2=todayKey();
    var m2='📊 即時排名 '+today2+'\n\n';
    var sorted=Object.values(bots).sort(function(a,b){
      var ap=(a.stats.daily[today2]||{pnl:0}).pnl;
      var bp=(b.stats.daily[today2]||{pnl:0}).pnl;
      return bp-ap;
    });
    sorted.forEach(function(b,idx){
      var d=b.stats.daily[today2]||{total:0,wins:0,losses:0,pnl:0};
      var wr=d.total>0?(d.wins/d.total*100).toFixed(0):0;
      var medal=idx===0?'🥇':idx===1?'🥈':idx===2?'🥉':'  ';
      m2+=medal+' '+b.emoji+b.name+'\n';
      m2+='  今日:'+d.total+'筆 WR:'+wr+'% PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U\n';
      m2+='  本金:'+b.stats.capital.toFixed(2)+'U 持倉:'+Object.keys(b.openTrades).length+'\n\n';
    });
    tgAdmin(m2);return;
  }

  if(cmd==='/chat'){
    var msgs=sharedMsg.slice(-20);
    if(!msgs.length){tgAdmin('交易室目前沒有訊息');return;}
    tgAdmin('💬 交易室\n\n'+msgs.map(function(m){return m.msg;}).join('\n'));return;
  }

  if(cmd==='/discuss'&&parts[1]){
    var sym2=parts[1].toUpperCase();
    if(!sym2.endsWith('-USDT'))sym2+='-USDT';
    tgAdmin('💬 召開 '+sym2+' 分析會議...');
    var trigBot=Object.values(bots)[0];
    botDiscuss(trigBot,'請分析 '+sym2+' 目前的走勢和機會',sym2).catch(function(e){tgAdmin('錯誤: '+e.message);});return;
  }

  if(cmd==='/meeting'){
    tgAdmin('💬 召開每日市場分析會議...');
    var trigBot2=Object.values(bots)[0];
    botDiscuss(trigBot2,'今天市場整體走勢如何？各自分享最看好的幣種',null).catch(function(e){tgAdmin('錯誤: '+e.message);});return;
  }

  if(cmd==='/log'){
    var logs=sysLog.slice(-15).map(function(l){return '['+l.lv+'] '+l.msg.slice(0,60);}).join('\n');
    tgAdmin('系統日誌\n'+(logs||'無'));return;
  }

  if(cmd==='/startall'){
    Object.values(bots).forEach(function(b){b.cfg.botRunning=true;});
    saveBots();
    tgAdmin('✅ 所有Bot已啟動');
    Object.values(bots).forEach(function(b){tgBot(b,b.emoji+' '+b.name+' 已由海馬啟動！');});return;
  }

  if(cmd==='/stopall'){
    Object.values(bots).forEach(function(b){b.cfg.botRunning=false;});
    saveBots();
    tgAdmin('⏹ 所有Bot已停止');return;
  }

  if(cmd==='/broadcast'&&parts.length>1){
    var broadMsg=parts.slice(1).join(' ');
    Object.values(bots).forEach(function(b){tgBot(b,'📢 海馬廣播\n'+broadMsg);});
    tgAdmin('✅ 廣播完成');return;
  }

  if(cmd==='/improvements'){
    var m3='📋 改進方案\n\n';
    Object.values(bots).forEach(function(b){
      if(b.brain.improvements&&b.brain.improvements.length>0){
        var latest=b.brain.improvements[b.brain.improvements.length-1];
        m3+=b.emoji+b.name+' ('+latest.status+')\n'+latest.content+'\n\n';
      }
    });
    tgAdmin(m3||'目前沒有改進方案');return;
  }

  if(cmd==='/approve'&&parts[1]){
    var stratKey=parts[1].toLowerCase();
    var targetBot=Object.values(bots).find(function(b){return b.strategyKey===stratKey;});
    if(targetBot&&targetBot.brain.improvements&&targetBot.brain.improvements.length>0){
      var imp=targetBot.brain.improvements[targetBot.brain.improvements.length-1];
      imp.status='已批准';saveBots();
      tgAdmin('✅ 批准 '+targetBot.name+' 的改進方案');
      tgBot(targetBot,'✅ 改進方案已獲批准！\n\n'+imp.content+'\n\n請開始執行改進！');
    }else tgAdmin('找不到: '+stratKey);return;
  }

  if(cmd==='/reject'&&parts[1]){
    var stratKey2=parts[1].toLowerCase();
    var reason=parts.slice(2).join(' ')||'請重新擬定';
    var targetBot2=Object.values(bots).find(function(b){return b.strategyKey===stratKey2;});
    if(targetBot2&&targetBot2.brain.improvements&&targetBot2.brain.improvements.length>0){
      var imp2=targetBot2.brain.improvements[targetBot2.brain.improvements.length-1];
      imp2.status='已拒絕';saveBots();
      tgAdmin('❌ 拒絕 '+targetBot2.name+' 的改進方案');
      tgBot(targetBot2,'❌ 改進方案被拒絕\n原因: '+reason+'\n\n請重新提交！\n/improve [新方案]');
    }else tgAdmin('找不到: '+stratKey2);return;
  }
}

// ══════════════════════════════════
// AI 助手
// ══════════════════════════════════
async function askAI(b,question){
  tgBot(b,'🤖 分析中...');
  var ax=api(b);
  var marketContext='【'+b.name+'分析師視角】\n策略: '+b.strategy+'\n\n監控幣種即時數據:\n';
  for(var i=0;i<Math.min(3,b.cfg.symbols.length);i++){
    try{
      var sym=b.cfg.symbols[i];
      var tf=STRATEGIES[b.strategyKey].tf;
      var kl=await ax.getKlines(sym,tf,20);
      if(kl&&kl.length>=5){
        var closes=kl.map(function(k){return parseFloat(k.close||k[4]||0);});
        var highs=kl.map(function(k){return parseFloat(k.high||k[2]||0);});
        var lows=kl.map(function(k){return parseFloat(k.low||k[3]||0);});
        var rsi=I.rsi(closes,14);
        var ema20=I.ema(closes,20);
        marketContext+=sym+': 現價'+closes[closes.length-1].toFixed(4);
        if(rsi)marketContext+=' RSI:'+rsi.toFixed(1);
        if(ema20)marketContext+=' EMA20:'+ema20.toFixed(4);
        marketContext+='\n';
      }
    }catch(e){}
  }
  // 其他Bot的近期動向
  marketContext+='\n其他策略近期動向:\n';
  Object.values(bots).forEach(function(ob){
    if(ob.token!==b.token&&Object.keys(ob.openTrades).length>0){
      var tradeList=Object.values(ob.openTrades);
      tradeList.forEach(function(t){
        marketContext+=ob.emoji+ob.name+' 持倉 '+(t.side==='LONG'?'🟢':'🔴')+t.symbol+'\n';
      });
    }
  });

  var systemPrompt='你是'+b.name+'，一個專業的加密貨幣'+b.strategy+'交易分析師。'+
    '你個性鮮明，有自己的交易觀點和風格。'+
    '你可以看到其他策略Bot的動向，並給出你的專業意見。'+
    '用繁體中文回答，簡潔專業，不超過200字。\n\n'+marketContext;

  var body=JSON.stringify({
    model:'llama-3.3-70b-versatile',
    max_tokens:400,
    messages:[{role:'system',content:systemPrompt},{role:'user',content:question}]
  });

  return new Promise(function(resolve,reject){
    var req=https.request({
      hostname:'api.groq.com',path:'/openai/v1/chat/completions',method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_KEY}
    },function(res){
      var d='';res.on('data',function(c){d+=c;});
      res.on('end',function(){
        try{
          var r=JSON.parse(d);
          if(r.choices&&r.choices[0])tgBot(b,'🤖 '+b.name+'\n\n'+r.choices[0].message.content);
          else reject(new Error('AI錯誤'));
          resolve();
        }catch(e){reject(e);}
      });
    });
    req.on('error',reject);req.write(body);req.end();
  });
}

// ══════════════════════════════════
// 主循環
// ══════════════════════════════════
function startMainLoop(){
  // 每1小時掃描（配合1h K線）
  setInterval(function(){
    Object.values(bots).forEach(function(b){
      if(b.cfg&&b.cfg.botRunning){
        tradingLoopUser(b).catch(function(e){log('ERROR','BotLoop '+b.name+': '+e.message);});
      }
    });
  },60000); // 每1分鐘檢查，但K線週期是1小時

  // 每30秒監控持倉
  setInterval(function(){
    Object.values(bots).forEach(function(b){
      if(b.cfg&&b.cfg.botRunning&&Object.keys(b.openTrades).length>0){
        checkPositions(b).catch(function(e){log('ERROR','checkPos: '+e.message);});
      }
    });
  },30000);

  // 每日早上9點發報告
  setInterval(function(){
    if(hourTW()===9&&minTW()===0)sendDailyReport();
    // 每週日早上9點發週排名
    var now=new Date();
    if(now.getDay()===0&&hourTW()===9&&minTW()===5)sendWeeklyRanking();
  },60000);

  log('INFO','主循環啟動 ✅');
}

function startServer(){
  http.createServer(function(req,res){
    res.writeHead(200);
    res.end(JSON.stringify({status:'ok',bots:Object.keys(bots).length,strategies:Object.keys(STRATEGIES)}));
  }).listen(3002,function(){log('INFO','Server Port:3002');});
}

async function main(){
  console.log('\nBingX 多策略競爭系統 v1.0\n');
  log('INFO','系統啟動中...');
  bots=loadBots();
  saveBots();
  startServer();
  startMainLoop();
  startAdminPolling();
  Object.values(bots).forEach(function(b){startBotPolling(b);});
  var msg='🎯 多策略競爭系統上線！\n\n';
  msg+='已啟動策略:\n';
  Object.keys(STRATEGIES).forEach(function(sk){
    var st=STRATEGIES[sk];
    msg+=st.emoji+' '+st.name+'\n';
  });
  msg+='\n監控幣種:\n'+WATCH_SYMBOLS.join(', ')+'\n\n';
  msg+='指令: /help 查看所有指令\n/startall 啟動所有Bot\n/ranking 查看排名';
  tgAdmin(msg);
  log('OK','系統就緒！策略數: '+Object.keys(STRATEGIES).length);
}

process.on('uncaughtException',function(e){log('ERROR','未捕獲: '+e.message);tgAdmin('🚨 系統異常: '+e.message);});
process.on('unhandledRejection',function(e){log('ERROR','未處理: '+(e&&e.message?e.message:String(e)));});
process.on('SIGINT',function(){tgAdmin('⛔ 系統關閉');setTimeout(function(){process.exit(0);},2000);});
main().catch(function(e){log('ERROR','啟動失敗: '+e.message);process.exit(1);});

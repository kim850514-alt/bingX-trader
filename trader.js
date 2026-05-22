'use strict';
const crypto=require('crypto'),https=require('https'),http=require('http'),fs=require('fs');

// ══════════════════════════════════
// 系統設定
// ══════════════════════════════════
const ADMIN_CHAT=process.env.TELEGRAM_CHAT_ID||'';
const ADMIN_TOKEN=process.env.BYBIT_TG_TOKEN||'';

// 三層設定（只保留基本參數）
// 獵手策略（單一策略，無層）
const STRATEGY={name:'獵手',tf:'15m',lev:5,atrSl:2.0};
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
      symbols:[],         // 動態更新，由掃描系統決定
      botRunning:false,
      allowShort:true,
      amount:1,
      copyFrom:null,

    },
    openTrades:{},
    stats:{allTime:{total:0,wins:0,losses:0,pnl:0},daily:{},trades:[]},
    lastSignalTs:{},
    memLog:[],
    usedOrderIds:[],
    brain:{
      symbolPerf:{},hourPerf:{},dayPerf:{},
      hunterParams:{atrMultSl:2.0},
      adjustHistory:[],learnCount:0,
      bestParamsList:[],locked:false,
      explorationHistory:[],exploredIdx:0,
      bestHours:[],worstHours:[]
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
    var opt={hostname:'open-api.bingx.com',path:path+'?'+q,method,headers:{'X-BX-APIKEY':apiKey,'Content-Type':'application/x-www-form-urlencoded'}};
    var go=function(n){
      var req=https.request(opt,function(rsp){var d='';rsp.on('data',function(c){d+=c;});rsp.on('end',function(){try{resolve(JSON.parse(d));}catch(e){reject(new Error(d.slice(0,80)));}});});
      req.on('error',function(e){if(n>1)setTimeout(function(){go(n-1);},2000);else reject(e);});
      req.setTimeout(12000,function(){req.destroy();if(n>1)setTimeout(function(){go(n-1);},2000);else reject(new Error('Timeout'));});
      req.end();
    };
    go(tries);
  });
}

// 公開 API（不需要簽名）
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
      throw new Error('Cannot get balance');
    },
    getPositions:async function(sym){
      try{var r=await bxReq('GET','/openApi/swap/v2/user/positions',sym?{symbol:sym}:{},ak,sk);if(r.code===0)return(r.data||[]).filter(function(p){return parseFloat(p.positionAmt||0)!==0;});}catch(e){}return[];
    },
    getKlines:async function(sym,tf,lim){
      lim=lim||200;
      var bxTf={'1m':'1m','3m':'3m','5m':'5m','15m':'15m','1h':'1h','4h':'4h'}[tf]||'5m';
      try{var r=await bxReq('GET','/openApi/swap/v2/quote/klines',{symbol:sym,interval:bxTf,limit:lim},ak,sk);if(r.code===0&&Array.isArray(r.data))return r.data;}catch(e){}return[];
    },
    getTicker:async function(sym){
      try{var r=await bxReq('GET','/openApi/swap/v2/quote/ticker',{symbol:sym},ak,sk);if(r.code===0)return r.data;}catch(e){}return null;
    },
    getFundingRate:async function(sym){
      try{var r=await bxPublic('/openApi/swap/v2/quote/premiumIndex',{symbol:sym});if(r.code===0&&r.data)return parseFloat(r.data.lastFundingRate||0);}catch(e){}return null;
    },
    getOI:async function(sym){
      try{var r=await bxPublic('/openApi/swap/v2/quote/openInterest',{symbol:sym});if(r.code===0&&r.data)return parseFloat(r.data.openInterest||0);}catch(e){}return null;
    },
    setLev:async function(sym,lev){
      for(var s of['LONG','SHORT']){try{await bxReq('POST','/openApi/swap/v2/trade/leverage',{symbol:sym,side:s,leverage:lev},ak,sk);}catch(e){}}
    },
    placeLimitOrder:async function(o){
      await this.setLev(o.symbol,o.lev);
      var notional=o.amt*o.lev;
      var qty=Math.floor(notional/o.limitPrice*100)/100;
      if(qty*o.limitPrice<5)qty=Math.ceil(5/o.limitPrice*100)/100;
      if(qty<=0)throw new Error('數量為0');
      var r=await bxReq('POST','/openApi/swap/v2/trade/order',{
        symbol:o.symbol,side:o.side,positionSide:o.positionSide,
        type:'LIMIT',price:String(o.limitPrice),quantity:String(qty),timeInForce:'GTC'
      },ak,sk);
      if(r.code===0){
        // 設定 SL/TP
        await new Promise(function(res){setTimeout(res,500);});
        var cs=o.positionSide==='LONG'?'SELL':'BUY';
        if(o.stopLoss){
          var slR=await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:o.symbol,side:cs,positionSide:o.positionSide,type:'STOP_MARKET',stopPrice:String(o.stopLoss),quantity:String(qty),workingType:'MARK_PRICE'},ak,sk).catch(function(e){return{code:-1,msg:e.message};});
          console.log('[SL] '+o.symbol+' code:'+slR.code+' sl:'+o.stopLoss);
        }
        if(o.takeProfit){
          var tpR=await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:o.symbol,side:cs,positionSide:o.positionSide,type:'TAKE_PROFIT_MARKET',stopPrice:String(o.takeProfit),quantity:String(qty),workingType:'MARK_PRICE'},ak,sk).catch(function(e){return{code:-1,msg:e.message};});
          console.log('[TP] '+o.symbol+' code:'+tpR.code+' tp:'+o.takeProfit);
        }
        return{orderId:r.data.order.orderId,qty,price:o.limitPrice};
      }
      throw new Error('限價單失敗: '+r.msg);
    },
    closePos:async function(sym,ps,qty){
      var r=await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:sym,side:ps==='LONG'?'SELL':'BUY',positionSide:ps,type:'MARKET',quantity:String(qty)},ak,sk);
      return r.code===0?r.data.order:null;
    },
    cancelOrder:async function(sym,orderId){
      try{await bxReq('POST','/openApi/swap/v2/trade/cancel',{symbol:sym,orderId},ak,sk);}catch(e){}
    },
    cancelAllOrders:async function(sym,ps){
      try{
        var r=await bxReq('GET','/openApi/swap/v2/trade/openOrders',{symbol:sym},ak,sk);
        if(r.code===0&&r.data&&r.data.orders){
          var toCancel=r.data.orders.filter(function(o){
            return o.positionSide===ps&&(o.type==='STOP_MARKET'||o.type==='TAKE_PROFIT_MARKET'||o.type==='LIMIT');
          });
          for(var i=0;i<toCancel.length;i++){
            try{await bxReq('POST','/openApi/swap/v2/trade/cancel',{symbol:sym,orderId:toCancel[i].orderId},ak,sk);}catch(e){}
          }
          if(toCancel.length>0)log('OK',sym+' 取消 '+toCancel.length+' 個掛單',b);
        }
      }catch(e){}
    },
    getActualPnl:async function(symbol,openTime){
      try{
        var r=await bxReq('GET','/openApi/swap/v2/user/income',{symbol,limit:20,startTime:String(openTime)},ak,sk);
        if(r.code===0&&r.data&&r.data.length>0){
          var items=r.data.filter(function(o){
            return parseInt(o.time||0)>openTime&&(o.incomeType==='REALIZED_PNL'||o.incomeType==='TRADING_FEE');
          });
          if(items.length>0){
            var totalPnl=items.reduce(function(sum,o){return sum+parseFloat(o.income||0);},0);
            return{pnl:totalPnl,exitPrice:0};
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
  atr:function(highs,lows,closes,n){
    n=n||14;if(highs.length<

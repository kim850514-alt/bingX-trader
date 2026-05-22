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
  }
};

// ══════════════════════════════════
// Wyckoff 分析
// ══════════════════════════════════
function analyzeWyckoff(closes,highs,lows,vols){
  var result={signal:'NONE',pattern:'',strength:0,supportLevel:0,resistanceLevel:0,details:[]};
  if(closes.length<50)return result;

  var last=closes[closes.length-1];
  var recentCloses=closes.slice(-20);
  var recentHighs=highs.slice(-20);
  var recentLows=lows.slice(-20);
  var recentVols=vols.slice(-20);

  // 支撐/阻力位
  var support=Math.min.apply(null,recentLows.slice(0,15));
  var resistance=Math.max.apply(null,recentHighs.slice(0,15));
  result.supportLevel=+support.toFixed(6);
  result.resistanceLevel=+resistance.toFixed(6);

  var range=resistance-support;
  if(range<=0)return result;

  var avgVol=I.ma(recentVols.slice(0,-1),10)||1;
  var lastVol=recentVols[recentVols.length-1];
  var volSpike=lastVol>avgVol*1.5;

  // ✅ 彈簧（Spring）— 假跌破支撐後反彈，做多
  var prevLow=Math.min.apply(null,recentLows.slice(-5,-1));
  var currLow=lows[lows.length-1];
  var currClose=closes[closes.length-1];
  var prevClose=closes[closes.length-2];

  if(currLow<support&&currClose>support&&currClose>prevClose){
    var springStrength=0;
    springStrength+=volSpike?2:1;
    springStrength+=(currClose-currLow)/(highs[highs.length-1]-currLow)>0.7?2:1;
    var rsi=I.rsi(closes,14);
    if(rsi&&rsi<40)springStrength++;
    result.signal='BUY';
    result.pattern='彈簧(Spring)';
    result.strength=springStrength;
    result.details.push('假跌破支撐'+support.toFixed(4)+'後反彈');
    if(volSpike)result.details.push('成交量放大確認');
    return result;
  }

  // ✅ 向上推力（Upthrust）— 假突破阻力後回落，做空
  var currHigh=highs[highs.length-1];
  if(currHigh>resistance&&currClose<resistance&&currClose<prevClose){
    var utStrength=0;
    utStrength+=volSpike?2:1;
    utStrength+=(currHigh-currClose)/(currHigh-lows[lows.length-1])>0.7?2:1;
    var rsi2=I.rsi(closes,14);
    if(rsi2&&rsi2>60)utStrength++;
    result.signal='SELL';
    result.pattern='向上推力(Upthrust)';
    result.strength=utStrength;
    result.details.push('假突破阻力'+resistance.toFixed(4)+'後回落');
    if(volSpike)result.details.push('成交量放大確認');
    return result;
  }

  // ✅ 吸籌確認（Accumulation）— 低位橫盤後放量上漲
  var priceRange=Math.max.apply(null,recentCloses)-Math.min.apply(null,recentCloses);
  var isConsolidating=priceRange/last<0.05; // 5% 以內橫盤
  if(isConsolidating&&last<(support+range*0.3)&&volSpike&&currClose>prevClose){
    result.signal='BUY';
    result.pattern='吸籌突破(Accumulation)';
    result.strength=3;
    result.details.push('低位橫盤後放量突破');
    return result;
  }

  // ✅ 派發確認（Distribution）— 高位橫盤後放量下跌
  if(isConsolidating&&last>(support+range*0.7)&&volSpike&&currClose<prevClose){
    result.signal='SELL';
    result.pattern='派發下跌(Distribution)';
    result.strength=3;
    result.details.push('高位橫盤後放量下跌');
    return result;
  }

  return result;
}

// ══════════════════════════════════
// 數據獵手分析（OI + 資金費率）
// ══════════════════════════════════
var oiHistory={}; // 記錄各幣的 OI 歷史

async function analyzeHunter(sym,ax){
  var result={signal:'NONE',oiTrend:'',fundingBias:'',strength:0,details:[]};
  try{
    // 取得當前 OI
    var currentOI=await ax.getOI(sym);
    if(!currentOI)return result;

    // 取得資金費率
    var fr=await ax.getFundingRate(sym);

    // OI 趨勢（與上次比較）
    var prevOI=oiHistory[sym]||currentOI;
    var oiChange=(currentOI-prevOI)/prevOI;
    oiHistory[sym]=currentOI;

    var oiRising=oiChange>0.02;   // OI 上升 >2%
    var oiFalling=oiChange<-0.02; // OI 下降 >2%

    // 判斷主力方向
    if(oiRising&&fr!==null){
      if(fr<0){
        // OI 上升 + 負資金費率 → 主力開多
        result.signal='BUY';
        result.oiTrend='OI↑+'+(oiChange*100).toFixed(1)+'%';
        result.fundingBias='資金費負('+( fr*100).toFixed(4)+'%)';
        result.strength+=3;
        result.details.push('主力開多！OI增加'+(oiChange*100).toFixed(1)+'%');
        result.details.push('資金費率負值，空方付費給多方');
      }else if(fr>0){
        // OI 上升 + 正資金費率 → 主力開空
        result.signal='SELL';
        result.oiTrend='OI↑+'+(oiChange*100).toFixed(1)+'%';
        result.fundingBias='資金費正('+( fr*100).toFixed(4)+'%)';
        result.strength+=3;
        result.details.push('主力開空！OI增加'+(oiChange*100).toFixed(1)+'%');
        result.details.push('資金費率正值，多方付費給空方');
      }
    }else if(oiFalling){
      // OI 下降 → 主力撤資，不開單
      result.signal='NONE';
      result.oiTrend='OI↓'+(oiChange*100).toFixed(1)+'%';
      result.strength=0;
      result.details.push('主力撤資！OI減少'+(Math.abs(oiChange)*100).toFixed(1)+'%');
    }else{
      result.details.push('OI變化:'+(oiChange*100).toFixed(2)+'% 主力觀望');
    }
  }catch(e){log('WARN',sym+' Hunter分析失敗: '+e.message);}
  return result;
}

// ══════════════════════════════════
// 全市場掃描（每15分鐘）
// ══════════════════════════════════
var marketScanResult={topBuy:[],topSell:[],lastScan:0};

async function scanMarket(){
  log('INFO','=== 開始全市場情緒掃描 ===');
  try{
    // 取得所有合約的 ticker（用成交量篩出活躍幣種）
    var r=await bxPublic('/openApi/swap/v2/quote/ticker');
    if(r.code!==0||!r.data)return;

    var tickers=r.data.filter(function(t){
      return t.symbol&&t.symbol.endsWith('-USDT')&&parseFloat(t.quoteVolume||0)>500000;
    });

    // 按成交量排序，取前100名活躍幣種
    var active=tickers.sort(function(a,b){
      return parseFloat(b.quoteVolume||0)-parseFloat(a.quoteVolume||0);
    }).slice(0,100);

    log('INFO','活躍幣種: '+active.length+'個，開始取OI和資金費率...');

    // 對每個幣取 OI 和資金費率，計算情緒分數
    var scored=[];
    for(var i=0;i<active.length;i++){
      var t=active[i];
      try{
        var sym=t.symbol;
        var prevOI=oiHistory[sym]||0;
        var oiR=await bxPublic('/openApi/swap/v2/quote/openInterest',{symbol:sym});
        var curOI=oiR.code===0?parseFloat(oiR.data.openInterest||0):0;
        var oiChange=prevOI>0?(curOI-prevOI)/prevOI:0;
        oiHistory[sym]=curOI;

        var frR=await bxPublic('/openApi/swap/v2/quote/premiumIndex',{symbol:sym});
        var fr=frR.code===0?parseFloat(frR.data.lastFundingRate||0):0;

        // 做多情緒分數：OI上升 + 資金費率越負越強
        var longScore=0,shortScore=0;
        if(oiChange>0.01){
          longScore=oiChange*100+(fr<0?Math.abs(fr)*1000:0);
          shortScore=oiChange*100+(fr>0?fr*1000:0);
        }

        scored.push({
          symbol:sym,
          oiChange,fr,
          longScore,shortScore,
          price:parseFloat(t.lastPrice),
          changePercent:parseFloat(t.priceChangePercent||0)
        });
      }catch(e){}
      // 避免API限流
      if(i%10===0)await new Promise(function(res){setTimeout(res,200);});
    }

    // 按做多情緒排序，取前3
    var topBuy=scored.filter(function(s){return s.longScore>0;})
      .sort(function(a,b){return b.longScore-a.longScore;}).slice(0,3);

    // 按做空情緒排序，取前3
    var topSell=scored.filter(function(s){return s.shortScore>0;})
      .sort(function(a,b){return b.shortScore-a.shortScore;}).slice(0,3);

    log('INFO','做多情緒前3: '+topBuy.map(function(t){return t.symbol+'(OI:'+( t.oiChange*100).toFixed(1)+'% FR:'+(t.fr*100).toFixed(4)+'%)';}).join(', '));
    log('INFO','做空情緒前3: '+topSell.map(function(t){return t.symbol+'(OI:'+( t.oiChange*100).toFixed(1)+'% FR:'+(t.fr*100).toFixed(4)+'%)';}).join(', '));

    marketScanResult={
      topGainers:topBuy.map(function(s,i){return{symbol:s.symbol,direction:'BUY',rank:i+1,changePercent:s.changePercent,oiChange:s.oiChange,fr:s.fr};}),
      topLosers:topSell.map(function(s,i){return{symbol:s.symbol,direction:'SELL',rank:i+1,changePercent:s.changePercent,oiChange:s.oiChange,fr:s.fr};}),
      lastScan:Date.now(),
      allTickers:tickers
    };

    // 廣播掃描結果
    var msg='📊 全市場情緒掃描完成\n\n';
    msg+='🟢 做多情緒前3:\n';
    topBuy.forEach(function(t,i){
      msg+=(i+1)+'名 '+t.symbol+'\n';
      msg+='  OI: '+(t.oiChange*100).toFixed(2)+'% FR: '+(t.fr*100).toFixed(4)+'%\n';
    });
    msg+='\n🔴 做空情緒前3:\n';
    topSell.forEach(function(t,i){
      msg+=(i+1)+'名 '+t.symbol+'\n';
      msg+='  OI: '+(t.oiChange*100).toFixed(2)+'% FR: '+(t.fr*100).toFixed(4)+'%\n';
    });
    msg+='\n每1分鐘持續監控，等待Wyckoff確認...';

    Object.values(bots).forEach(function(b){
      if(b.cfg&&b.cfg.botRunning)tgBot(b,msg);
    });

  }catch(e){log('ERROR','市場掃描失敗: '+e.message);}
}

// ══════════════════════════════════
// 雙重確認信號（Wyckoff + Hunter）
// ══════════════════════════════════
async function analyzeSignal(b,ax,sym,layer,rankInfo){
  var kl=await ax.getKlines(sym,STRATEGY.tf,200);
  if(kl.length<60)return null;

  var closes=kl.map(function(k){return parseFloat(k.close||k[4]||0);});
  var highs=kl.map(function(k){return parseFloat(k.high||k[2]||0);});
  var lows=kl.map(function(k){return parseFloat(k.low||k[3]||0);});
  var vols=kl.map(function(k){return parseFloat(k.volume||k[5]||0);});
  var last=closes[closes.length-1];

  // Wyckoff 分析
  var wyckoff=analyzeWyckoff(closes,highs,lows,vols);

  // 數據獵手分析
  var hunter=await analyzeHunter(sym,ax);

  // ATR 計算
  var atrVal=I.atr(highs,lows,closes,14)||last*0.01;

  // 各層獨立參數
  var lp=(b.brain&&b.brain.layerParams&&b.brain.layerParams[layer])||LAYERS[layer];

  // ✅ 雙重確認：Wyckoff 和 Hunter 方向一致才開單
  var signal='HOLD';
  var signalDetails=[];

  if(wyckoff.signal!=='NONE'&&hunter.signal!=='NONE'&&wyckoff.signal===hunter.signal){
    signal=wyckoff.signal;
    signalDetails.push('✅ 雙重確認一致！');
    signalDetails.push('📐 Wyckoff: '+wyckoff.pattern+' (強度:'+wyckoff.strength+')');
    signalDetails.push(wyckoff.details.join(' | '));
    signalDetails.push('🐋 數據獵手: '+hunter.details.join(' | '));
    if(rankInfo)signalDetails.push('📊 '+rankInfo);
  }else if(wyckoff.signal!=='NONE'&&hunter.signal==='NONE'){
    // Hunter 觀望，只有 Wyckoff 訊號，不開單
    log('INFO',sym+' ['+layer+'] Wyckoff:'+wyckoff.signal+' Hunter:觀望 → HOLD',b);
  }else if(wyckoff.signal==='NONE'&&hunter.signal!=='NONE'){
    // 只有 Hunter 訊號，不開單
    log('INFO',sym+' ['+layer+'] Wyckoff:無訊號 Hunter:'+hunter.signal+' → HOLD',b);
  }else if(wyckoff.signal!=='NONE'&&hunter.signal!=='NONE'&&wyckoff.signal!==hunter.signal){
    // 訊號相反，不開單
    log('INFO',sym+' ['+layer+'] 訊號矛盾 Wyckoff:'+wyckoff.signal+' Hunter:'+hunter.signal+' → HOLD',b);
  }

  log('INFO',sym+' ['+layer+'] Wyckoff:'+wyckoff.signal+'('+wyckoff.pattern+') Hunter:'+hunter.signal+' → '+signal,b);

  return{
    signal,
    wyckoff,
    hunter,
    atr:atrVal,
    price:last,
    support:wyckoff.supportLevel,
    resistance:wyckoff.resistanceLevel,
    signalDetails,
    lp
  };
}

// ══════════════════════════════════
// 持倉監控
// ══════════════════════════════════
async function checkPositions(b){
  var ax=api(b);
  for(var key in b.openTrades){
    try{
      var t=b.openTrades[key];
      var layer=t.layer||'hunter';
      var tk=await ax.getTicker(t.symbol).catch(function(){return null;});if(!tk)continue;
      var cur=parseFloat(tk.lastPrice);
      var holdMin=Math.round((Date.now()-t.openTime)/60000);
      var ps=t.side;

      // 檢查是否已平倉
      var pos=await ax.getPositions(t.symbol);
      var stillOpen=pos.some(function(p){return p.positionSide===ps&&parseFloat(p.positionAmt||0)!==0;});

      if(!stillOpen&&holdMin>1){
        await new Promise(function(res){setTimeout(res,1500);});
        var actual=await ax.getActualPnl(t.symbol,t.openTime);
        var pnl=actual?actual.pnl:0;
        recordTrade(b,{symbol:t.symbol,side:t.side,entry:t.entry,exit:cur,qty:t.qty,pnl,holdMin,reason:'TP/SL',layer});
        delete b.openTrades[key];
        await ax.cancelAllOrders(t.symbol,ps);
        tgBot(b,'[BingX] '+(pnl>=0?'✅':'❌')+' '+t.symbol+' ['+STRATEGY.name+']\nPnL:'+(pnl>=0?'+':'')+pnl.toFixed(4)+'U Hold:'+holdMin+'min');
        continue;
      }

      var estPnl=ps==='LONG'?(cur-t.entry)*t.qty:(t.entry-cur)*t.qty;
      var estPct=ps==='LONG'?(cur-t.entry)/t.entry*100:(t.entry-cur)/t.entry*100;
      log('INFO','持倉 '+t.symbol+' ['+layer+'] '+(estPct>=0?'+':'')+estPct.toFixed(2)+'% Hold:'+holdMin+'min',b);

      // ✅ 動態移動止損：每獲利10%往上移一格
      if(!t.trailLevel)t.trailLevel=0;
      var newTrailLevel=Math.floor(estPct/10); // 0=未啟動, 1=10%, 2=20%...
      if(newTrailLevel>t.trailLevel&&newTrailLevel>=1){
        t.trailLevel=newTrailLevel;
        var lockPct=(newTrailLevel-1)*10; // 鎖定上一格
        var newSl;
        if(lockPct===0){
          // 獲利10% → SL移到開倉價（保本）
          newSl=+t.entry.toFixed(6);
        }else{
          // 獲利20%+ → SL移到上一個10%位置
          newSl=ps==='LONG'?+(t.entry*(1+lockPct/100)).toFixed(6):+(t.entry*(1-lockPct/100)).toFixed(6);
        }
        try{
          await bxReq('POST','/openApi/swap/v2/trade/order',{symbol:t.symbol,side:ps==='LONG'?'SELL':'BUY',positionSide:ps,type:'STOP_MARKET',stopPrice:String(newSl),quantity:String(t.qty),workingType:'MARK_PRICE'},b.apiKey,b.secret);
          tgBot(b,'[BingX] 🔒 移動止損\n'+t.symbol+' ['+STRATEGY.name+']\n獲利: +'+estPct.toFixed(1)+'%\n止損移至: '+newSl+(lockPct===0?' (保本)':' (鎖定+'+lockPct+'%)'));
          log('OK',t.symbol+' 移動止損 -> '+newSl+' (獲利'+estPct.toFixed(1)+'%)',b);
        }catch(e){log('WARN',t.symbol+' 移動止損失敗: '+e.message,b);}
      }

      // 無超時，讓移動止損決定出場

      // 掛單超時取消（限價單超30分鐘未成交）
      if(t.isPending&&holdMin>30){
        await ax.cancelOrder(t.symbol,t.orderId);
        delete b.openTrades[key];
        log('INFO',t.symbol+' 限價掛單超時取消',b);
        tgBot(b,'[BingX] ⏰ 限價單取消\n'+t.symbol+'\n掛了'+holdMin+'分鐘未成交');
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
    var amt=b.cfg.amount||1;

    // 從掃描結果取候選幣種
    var candidates=[];
    if(marketScanResult.topGainers){
      // 漲幅前3（做多候選）
      marketScanResult.topGainers.slice(0,3).forEach(function(t,i){
        candidates.push({symbol:t.symbol,direction:'BUY',rank:i+1,changePercent:parseFloat(t.priceChangePercent)});
      });
      // 跌幅前3（做空候選）
      if(b.cfg.allowShort){
        marketScanResult.topLosers.slice(0,3).forEach(function(t,i){
          candidates.push({symbol:t.symbol,direction:'SELL',rank:i+1,changePercent:parseFloat(t.priceChangePercent)});
        });
      }
    }

    log('INFO','候選幣種: '+candidates.map(function(x){return x.symbol;}).join(','),b);
    for(var i=0;i<candidates.length;i++){
      var cand=candidates[i];
      var sym=cand.symbol;
      try{
        var hasL=b.openTrades[sym+'_L'];
        var hasS=b.openTrades[sym+'_S'];
        if(hasL||hasS)continue;
        if(cand.direction==='BUY'&&hasS)continue;
        if(cand.direction==='SELL'&&hasL)continue;
        var coolKey=sym+'_cool';
        if(b.lastSignalTs[coolKey]&&(Date.now()-b.lastSignalTs[coolKey])<300000)continue;
        var dirKey=cand.direction==='BUY'?'_L':'_S';
        var sameDir=Object.keys(b.openTrades).filter(function(k){return k.endsWith(dirKey);}).length;
        if(sameDir>=MAX_SAME_DIR)continue;
        if(bal.available<amt)continue;
        var rankInfo=(cand.direction==='BUY'?'漲幅':'跌幅')+'第'+cand.rank+'名 '+cand.changePercent.toFixed(2)+'%';
        var res=await analyzeSignal(b,ax,sym,'hunter',rankInfo);
        log('INFO',sym+' → '+(res?res.signal:'null'),b);
        if(!res||res.signal==='HOLD')continue;
        if(res.signal!==cand.direction)continue;
        var cur=res.price;
        if(!cur||isNaN(cur))continue;
        var atrSl=(b.brain&&b.brain.hunterParams&&b.brain.hunterParams.atrMultSl)||STRATEGY.atrSl;
        var slDist=Math.max(res.atr*atrSl,cur*MIN_SL/100);
        var tpDist=slDist*MIN_RR;
        var slP,tpP,limitPrice;
        if(res.signal==='BUY'){
          slP=+(cur-slDist).toFixed(6);
          tpP=+(cur+tpDist).toFixed(6);
          limitPrice=res.support>0&&res.support>cur*0.98?+(res.support*1.001).toFixed(6):+(cur*0.998).toFixed(6);
        }else{
          slP=+(cur+slDist).toFixed(6);
          tpP=+(cur-tpDist).toFixed(6);
          limitPrice=res.resistance>0&&res.resistance<cur*1.02?+(res.resistance*0.999).toFixed(6):+(cur*1.002).toFixed(6);
        }
        var positionSide=res.signal==='BUY'?'LONG':'SHORT';
        var tradeKey=sym+'_'+(res.signal==='BUY'?'L':'S');
        var lo=await ax.placeLimitOrder({
          symbol:sym,side:res.signal==='BUY'?'BUY':'SELL',
          positionSide,amt,lev:STRATEGY.lev,
          limitPrice,stopLoss:slP,takeProfit:tpP
        }).catch(function(e){log('ERROR',sym+' 掛單失敗: '+e.message,b);return null;});
        if(lo){
          b.lastSignalTs[coolKey]=Date.now();
          b.openTrades[tradeKey]={symbol:sym,side:positionSide,entry:limitPrice,qty:lo.qty,layer:'hunter',openTime:Date.now(),orderId:lo.orderId,isPending:true,halfExited:false,slMoved:false,stopLoss:slP,takeProfit:tpP,trailLevel:0,slDist:slDist};
          saveBots();
          var notif='[BingX] 📋 限價掛單\n';
          notif+=(res.signal==='BUY'?'🟢 多':'🔴 空')+' '+sym+'\n';
          notif+='📊 '+rankInfo+'\n';
          notif+='限價: '+limitPrice+'\nSL: '+slP+'\nTP: '+tpP+' (RR1.5)\n\n';
          notif+='📐 Wyckoff: '+res.wyckoff.pattern+'\n';
          res.wyckoff.details.forEach(function(d){notif+='  '+d+'\n';});
          notif+='\n🐋 數據獵手:\n';
          res.hunter.details.forEach(function(d){notif+='  '+d+'\n';});
          if(res.hunter.oiTrend)notif+='OI: '+res.hunter.oiTrend+'\n';
          if(res.hunter.fundingBias)notif+=res.hunter.fundingBias+'\n';
          tgBot(b,notif);
          log('OK',sym+' 限價掛單 @'+limitPrice+' SL:'+slP+' TP:'+tpP,b);
          copyTrade(b,{symbol:sym,side:res.signal==='BUY'?'BUY':'SELL',positionSide,price:limitPrice,stopLoss:slP,takeProfit:tpP,layer:'hunter'}).catch(function(){});
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
  if(!b.brain)b.brain={symbolPerf:{},hourPerf:{},dayPerf:{},adjustHistory:[],learnCount:0,layerStats:{scalp:{learnCount:0,trades:[]},swing:{learnCount:0,trades:[]},long:{learnCount:0,trades:[]}},layerParams:{scalp:{oversold:30,overbought:70,bbStdDev:2.0,volMultiple:1.3,atrMultSl:1.5,atrMultTp:2.5},swing:{oversold:30,overbought:70,bbStdDev:2.0,volMultiple:1.3,atrMultSl:2.0,atrMultTp:3.5},long:{oversold:30,overbought:70,bbStdDev:2.5,volMultiple:1.3,atrMultSl:2.5,atrMultTp:5.0}},bestParamsList:[],locked:false,explorationHistory:[],exploredIdx:0};
  b.brain.learnCount=(b.brain.learnCount||0)+1;
  if(b.brain.learnCount%25===0)autoAdjust(b);
  var tLayer=t.layer||'swing';
  if(!b.brain.layerStats[tLayer])b.brain.layerStats[tLayer]={learnCount:0,trades:[]};
  b.brain.layerStats[tLayer].trades.push({pnl:t.pnl,date:today});
  if(b.brain.layerStats[tLayer].trades.length>100)b.brain.layerStats[tLayer].trades=b.brain.layerStats[tLayer].trades.slice(-100);
  b.brain.layerStats[tLayer].learnCount++;
  if(b.brain.layerStats[tLayer].learnCount%25===0)autoAdjustLayer(b,tLayer);
  var hr=String(hourTW());
  if(!b.brain.hourPerf)b.brain.hourPerf={};
  if(!b.brain.hourPerf[hr])b.brain.hourPerf[hr]={wins:0,losses:0,pnl:0};
  if(t.pnl>0)b.brain.hourPerf[hr].wins++;else b.brain.hourPerf[hr].losses++;
  b.brain.hourPerf[hr].pnl+=t.pnl;
  var curDay=new Date().toLocaleString('en-US',{timeZone:'Asia/Taipei',weekday:'short'});
  if(!b.brain.dayPerf)b.brain.dayPerf={};
  if(!b.brain.dayPerf[curDay])b.brain.dayPerf[curDay]={wins:0,losses:0,pnl:0};
  if(t.pnl>0)b.brain.dayPerf[curDay].wins++;else b.brain.dayPerf[curDay].losses++;
  b.brain.dayPerf[curDay].pnl+=t.pnl;
  if(!b.brain.symbolPerf[t.symbol])b.brain.symbolPerf[t.symbol]={wins:0,losses:0,pnl:0,count:0};
  var sp=b.brain.symbolPerf[t.symbol];
  if(t.pnl>0)sp.wins++;else sp.losses++;sp.pnl+=t.pnl;sp.count++;
  saveBots();
}

function autoAdjustLayer(b,layer){
  if(!b.brain.layerStats||!b.brain.layerStats[layer])return;
  var trades=b.brain.layerStats[layer].trades;
  if(trades.length<10)return;
  var wins=trades.filter(function(t){return t.pnl>0;});
  var wr=wins.length/trades.length;
  var layerCfg=LAYERS[layer];
  var changes=[];
  if(!b.cfg.layers)b.cfg.layers={};
  if(!b.cfg.layerParams)b.cfg.layerParams={};
  if(!b.cfg.layerParams[layer])b.cfg.layerParams[layer]={atrMultSl:layerCfg.atrSl,atrMultTp:layerCfg.atrTp};
  var lp=b.cfg.layerParams[layer];
  if(wr<0.40&&lp.atrMultSl<3.0){lp.atrMultSl=+(Math.min(3.0,lp.atrMultSl+0.1)).toFixed(1);changes.push(STRATEGY.name+'ATR止損->'+lp.atrMultSl);}
  if(wr>=0.55&&lp.atrMultTp>2.0){lp.atrMultTp=+(Math.max(2.0,lp.atrMultTp-0.1)).toFixed(1);changes.push(STRATEGY.name+'ATR止盈->'+lp.atrMultTp);}
  b.cfg.layerParams[layer]=lp;
  if(changes.length){
    log('AI','['+layer+'] 層調整: '+changes.join(' | '),b);
    tgBot(b,'[BingX 🧠] '+STRATEGY.name+'層調整\n'+changes.join('\n')+'\nWR:'+(wr*100).toFixed(1)+'%');
    saveBots();
  }
}

function autoAdjust(b){
  if(!b.brain)return;
  if(!b.cfg.layerParams)b.cfg.layerParams={scalp:{atrMultSl:1.5,atrMultTp:2.5},swing:{atrMultSl:2.0,atrMultTp:3.5},long:{atrMultSl:2.5,atrMultTp:5.0}};
  var recent=b.stats.trades.slice(-25);if(recent.length<5)return;
  var wins=recent.filter(function(t){return t.pnl>0;});
  var wr=wins.length/recent.length;
  var changes=[];
  if(!b.brain.bestParamsList)b.brain.bestParamsList=[];
  if(!b.brain.explorationHistory)b.brain.explorationHistory=[];
  b.brain.explorationHistory.push({params:Object.assign({},b.cfg.layerParams),wr,date:todayKey()});
  if(b.brain.explorationHistory.length>50)b.brain.explorationHistory=b.brain.explorationHistory.slice(-50);
  var isLocked=b.brain.locked&&b.brain.bestParams;
  if(isLocked&&wr<0.3){b.brain.locked=false;changes.push('⚠️ 勝率過低解鎖');tgBot(b,'[BingX 🧠] ⚠️ 勝率過低('+( wr*100).toFixed(1)+'%)解鎖重新探索');}
  if(wr>=0.50&&!isLocked){
    b.brain.bestParams=Object.assign({},b.cfg.layerParams);
    b.brain.bestWR=wr;
    b.brain.locked=true;
    changes.push('🏆 最佳參數鎖定 WR:'+(wr*100).toFixed(1)+'%');
    tgBot(b,'[BingX 🧠] 🏆 最佳參數鎖定！\nWR:'+(wr*100).toFixed(1)+'%');
  }
  // 更新最佳最差時段
  var hp=b.brain.hourPerf||{};
  b.brain.bestHours=Object.keys(hp).filter(function(h){var p=hp[h];var t=p.wins+p.losses;return t>=5&&p.wins/t>=0.55;});
  b.brain.worstHours=Object.keys(hp).filter(function(h){var p=hp[h];var t=p.wins+p.losses;return t>=5&&p.wins/t<0.35;});
  if(changes.length){
    b.brain.adjustHistory=b.brain.adjustHistory||[];
    b.brain.adjustHistory.push({date:todayKey(),changes,wr:(wr*100).toFixed(1)});
    if(b.brain.adjustHistory.length>100)b.brain.adjustHistory=b.brain.adjustHistory.slice(-100);
    tgBot(b,'[BingX 🧠] 自動調整\n'+changes.join('\n')+'\nWR:'+(wr*100).toFixed(1)+'%');
    b.brain.learnCount=0;
    saveBots();
  }
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
      var lo=await fax.placeLimitOrder({
        symbol:tradeInfo.symbol,side:tradeInfo.side,positionSide:tradeInfo.positionSide,
        amt:fb.cfg.amount||1,lev:LAYERS[tradeInfo.layer].lev,
        limitPrice:tradeInfo.price,stopLoss:tradeInfo.stopLoss,takeProfit:tradeInfo.takeProfit
      }).catch(function(){return null;});
      if(lo)tgBot(fb,'[BingX] 📋 跟單\n'+tradeInfo.symbol+' ['+(tradeInfo.side==='BUY'?'🟢 多':'🔴 空')+']\n跟隨: '+masterBot.name);
    }catch(e){log('ERROR','跟單失敗 '+fb.name+': '+e.message,fb);}
  }
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
  log('INFO','Bot polling: '+b.name);
}

function handleBotUpdate(b,update){
  var msg=update.message||update.edited_message;if(!msg)return;
  var chatId=String(msg.chat.id),text=(msg.text||'').trim();
  if(b.chatId!==chatId){b.chatId=chatId;saveBots();}
  var parts=text.split(' '),cmd=parts[0].toLowerCase();
  log('INFO','CMD: '+cmd+' from '+b.name,b);

  if(cmd==='/help'||cmd==='/start'){
    tgBot(b,'🎯 BingX 智能獵手系統\n\n【交易控制】\n/go - 啟動\n/stop - 停止\n/status - 狀態\n\n【查詢】\n/positions - 持倉\n/stats - 績效\n/history - 近10筆\n/brain - 學習狀態\n/market - 最新掃描結果\n\n【設定】\n/set amount N - 開倉金額\n/set scalp on/off - 短期開關\n/set swing on/off - 中期開關\n/set long on/off - 長期開關\n/short - 切換空單\n\n【跟單】\n/copy 名稱 - 跟單\n/stopcopy - 取消跟單');return;
  }

  if(cmd==='/go'){
    if(b.cfg.botRunning){tgBot(b,'⚠️ 已在運行');return;}
    b.cfg.botRunning=true;saveBots();
    tgBot(b,'🚀 智能獵手啟動！\n\n系統每15分鐘掃描全市場\n找出漲跌幅前3名\nWyckoff + 數據獵手雙重確認\n限價掛單模式\n\n等待掃描結果...');return;
  }

  if(cmd==='/stop'){b.cfg.botRunning=false;saveBots();tgBot(b,'⏹ 已停止');return;}

  if(cmd==='/status'){
    api(b).getBalance().then(function(bal){
      var today=todayKey(),d=b.stats.daily[today]||{total:0,wins:0,losses:0,pnl:0},all=b.stats.allTime;
      var posCount=Object.keys(b.openTrades).length;
      var lastScan=marketScanResult.lastScan?new Date(marketScanResult.lastScan).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'}):'尚未掃描';
      tgBot(b,'[BingX] 狀態\n'+(b.cfg.botRunning?'🟢 運行中':'🔴 已停止')+'\n餘額:'+bal.available.toFixed(2)+'U\n今日:'+d.total+'筆 WR:'+(d.total>0?(d.wins/d.total*100).toFixed(0):0)+'% PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U\n累計:'+all.total+'筆 PnL:'+(all.pnl>=0?'+':'')+all.pnl.toFixed(2)+'U\n持倉:'+posCount+'\n金額:'+b.cfg.amount+'U\n上次掃描:'+lastScan);
    }).catch(function(e){tgBot(b,'Error: '+e.message);});return;
  }

  if(cmd==='/positions'){
    var keys=Object.keys(b.openTrades);
    if(!keys.length){tgBot(b,'無持倉');return;}
    var m='[BingX] 持倉\n\n';
    keys.forEach(function(k){
      var t=b.openTrades[k];
      m+=(t.side==='LONG'?'🟢':'🔴')+' '+t.symbol+' ['+LAYERS[t.layer].name+']\n';
      m+=(t.isPending?'📋掛單中':'持倉中')+' Hold:'+Math.round((Date.now()-t.openTime)/60000)+'min\n\n';
    });
    tgBot(b,m);return;
  }

  if(cmd==='/stats'){
    var al=b.stats.allTime,today2=todayKey(),dds=b.stats.daily[today2]||{total:0,wins:0,losses:0,pnl:0};
    tgBot(b,'[BingX] 📊 績效\n今日:'+dds.total+'筆 WR:'+(dds.total>0?(dds.wins/dds.total*100).toFixed(0):0)+'% PnL:'+(dds.pnl>=0?'+':'')+dds.pnl.toFixed(2)+'U\n累計:'+al.total+'筆 WR:'+(al.total>0?(al.wins/al.total*100).toFixed(1):0)+'% PnL:'+(al.pnl>=0?'+':'')+al.pnl.toFixed(2)+'U');return;
  }

  if(cmd==='/history'){
    var tr=b.stats.trades.slice(-10).reverse();if(!tr.length){tgBot(b,'尚無交易');return;}
    tgBot(b,'[BingX] 近10筆\n'+tr.map(function(t){return (t.pnl>=0?'✅':'❌')+' '+t.symbol+'['+(t.layer||'?')+'] '+(t.pnl>=0?'+':'')+t.pnl.toFixed(4)+'U '+t.reason;}).join('\n'));return;
  }

  if(cmd==='/brain'){
    var br=b.brain||{};
    var lastAdj=br.adjustHistory&&br.adjustHistory.length?br.adjustHistory[br.adjustHistory.length-1]:{changes:['尚未調整'],wr:'N/A'};
    var msg='[BingX] 🧠 學習狀態\n';
    msg+='已學習:'+(br.learnCount||0)+'次\n';
    msg+='鎖定狀態:'+(br.locked?'🔒已鎖定':'🔓探索中')+'\n';
    msg+='最佳WR:'+((br.bestWR)?(br.bestWR*100).toFixed(1):'N/A')+'%\n\n';
    msg+='【最近調整】\n'+lastAdj.changes.join('\n')+'\nWR:'+lastAdj.wr+'%\n\n';
    var ls=br.layerStats||{};
    ['scalp','swing','long'].forEach(function(ln){
      var lName={scalp:'短期',swing:'中期',long:'長期'}[ln];
      var lStat=ls[ln]||{learnCount:0,trades:[]};
      var lTrades=lStat.trades||[];
      var lWins=lTrades.filter(function(t){return t.pnl>0;}).length;
      var lWR=lTrades.length>0?(lWins/lTrades.length*100).toFixed(0):0;
      var lp=(b.cfg.layerParams&&b.cfg.layerParams[ln])||{};
      msg+='【'+lName+'】學習:'+lStat.learnCount+'筆 WR:'+lWR+'%\n';
      msg+='ATR止損:'+(lp.atrMultSl||'-')+'x 止盈:'+(lp.atrMultTp||'-')+'x\n\n';
    });
    tgBot(b,msg);return;
  }

  if(cmd==='/market'){
    if(!marketScanResult.lastScan){tgBot(b,'尚未掃描');return;}
    var m2='📊 最新市場掃描\n\n漲幅前3:\n';
    (marketScanResult.topGainers||[]).slice(0,3).forEach(function(t,i){
      m2+=(i+1)+'名 '+t.symbol+' +'+parseFloat(t.priceChangePercent).toFixed(2)+'%\n';
    });
    m2+='\n跌幅前3:\n';
    (marketScanResult.topLosers||[]).slice(0,3).forEach(function(t,i){
      m2+=(i+1)+'名 '+t.symbol+' '+parseFloat(t.priceChangePercent).toFixed(2)+'%\n';
    });
    m2+='\n上次掃描: '+new Date(marketScanResult.lastScan).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'});
    tgBot(b,m2);return;
  }

  if(cmd==='/set'&&parts[1]==='amount'&&parts[2]){
    var amt=parseFloat(parts[2]);
    if(amt>=1&&amt<=100){b.cfg.amount=amt;saveBots();tgBot(b,'✅ 開倉金額 -> '+amt+'U');}
    else tgBot(b,'金額需在 1-100U');return;
  }

  if(cmd==='/set'&&parts[1]==='scalp'&&parts[2]){b.cfg.layers=b.cfg.layers||{scalp:true,swing:true,long:true};b.cfg.layers.scalp=parts[2]==='on';saveBots();tgBot(b,'✅ 短期 -> '+(b.cfg.layers.scalp?'開啟':'關閉'));return;}
  if(cmd==='/set'&&parts[1]==='swing'&&parts[2]){b.cfg.layers=b.cfg.layers||{scalp:true,swing:true,long:true};b.cfg.layers.swing=parts[2]==='on';saveBots();tgBot(b,'✅ 中期 -> '+(b.cfg.layers.swing?'開啟':'關閉'));return;}
  if(cmd==='/set'&&parts[1]==='long'&&parts[2]){b.cfg.layers=b.cfg.layers||{scalp:true,swing:true,long:true};b.cfg.layers.long=parts[2]==='on';saveBots();tgBot(b,'✅ 長期 -> '+(b.cfg.layers.long?'開啟':'關閉'));return;}
  if(cmd==='/short'){b.cfg.allowShort=!b.cfg.allowShort;saveBots();tgBot(b,'✅ 空單 -> '+(b.cfg.allowShort?'開啟':'關閉'));return;}

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
  log('INFO','管理員polling啟動');
}

function handleAdminUpdate(update){
  var msg=update.message||update.edited_message;if(!msg)return;
  var text=(msg.text||'').trim(),parts=text.split(' '),cmd=parts[0].toLowerCase();
  log('INFO','ADMIN CMD: '+cmd);

  if(cmd==='/help'){
    tgAdmin('👑 管理員指令\n\n/addbot TOKEN NAME APIKEY SECRET\n/bots - Bot列表\n/delbot TOKEN\n/setleader 名稱\n/removeleader 名稱\n/leaders - 帶單員列表\n/scan - 立即掃描市場\n/log - 系統日誌\n/broadcast 訊息');return;
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
    var m='Bot列表\n共 '+botList.length+' 個\n\n';
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
    if(rb){rb.role='user';saveBots();tgAdmin('✅ 移除帶單員: '+parts[1]);tgBot(rb,'⚠️ 帶單員權限已移除');}
    else tgAdmin('找不到: '+parts[1]);return;
  }

  if(cmd==='/leaders'){
    var leaders=Object.values(bots).filter(function(b){return b.role==='leader';});
    tgAdmin('帶單員:\n'+(leaders.length?leaders.map(function(b){return b.name;}).join('\n'):'無'));return;
  }

  if(cmd==='/scan'){
    tgAdmin('🔍 開始掃描...');
    scanMarket().then(function(){tgAdmin('✅ 掃描完成');}).catch(function(e){tgAdmin('❌ 掃描失敗: '+e.message);});return;
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
var mainTimer=null,scanTimer=null;

function startMainLoop(){
  if(mainTimer)return;
  // 每1分鐘掃描新訊號
  mainTimer=setInterval(function(){
    Object.values(bots).forEach(function(b){
      if(b.cfg&&b.cfg.botRunning){
        tradingLoopUser(b).catch(function(e){log('ERROR','BotLoop '+b.name+': '+e.message);});
      }
    });
  },60000);
  // 每30秒實時監控倉位（動態移動止損）
  setInterval(function(){
    Object.values(bots).forEach(function(b){
      if(b.cfg&&b.cfg.botRunning&&Object.keys(b.openTrades).length>0){
        checkPositions(b).catch(function(e){log('ERROR','checkPos '+b.name+': '+e.message);});
      }
    });
  },30000);
  // 每15分鐘掃描市場
  scanTimer=setInterval(function(){
    scanMarket().catch(function(e){log('ERROR','掃描失敗: '+e.message);});
  },15*60*1000);
  log('INFO','主循環啟動');
}

function startServer(){
  http.createServer(function(req,res){res.writeHead(200);res.end(JSON.stringify({status:'ok',bots:Object.keys(bots).length}));}).listen(3002,function(){log('INFO','Server Port:3002');});
}

async function main(){
  console.log('\nBingX 智能獵手系統 v2.0\n');
  log('INFO','Starting...');
  startServer();
  startMainLoop();
  startAdminPolling();
  Object.values(bots).forEach(function(b){startBotPolling(b);});

  // 立即做一次市場掃描
  await scanMarket().catch(function(e){log('WARN','初始掃描失敗: '+e.message);});

  var activeCount=Object.values(bots).filter(function(b){return b.cfg&&b.cfg.botRunning;}).length;
  tgAdmin('[智能獵手 v2.0] 🟢 上線!\nBot數: '+Object.keys(bots).length+'\n運行中: '+activeCount+'\n\n每15分鐘掃描全市場\nWyckoff + 數據獵手雙重確認\n限價掛單模式\n\n/addbot 新增Bot');
  log('OK','Ready. Bots: '+Object.keys(bots).length);
}

process.on('uncaughtException',function(e){log('ERROR','Uncaught: '+e.message);tgAdmin('🚨 系統異常: '+e.message);});
process.on('unhandledRejection',function(e){log('ERROR','Unhandled: '+(e&&e.message?e.message:String(e)));});
process.on('SIGINT',function(){tgAdmin('⛔ 系統關閉');setTimeout(function(){process.exit(0);},2000);});
main().catch(function(e){log('ERROR','Start fail: '+e.message);process.exit(1);});

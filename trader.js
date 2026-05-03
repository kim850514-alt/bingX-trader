
'use strict';
const crypto=require('crypto'),https=require('https'),http=require('http'),fs=require('fs');
const ENV={
  BINGX_API_KEY:process.env.BINGX_API_KEY||'',
  BINGX_SECRET:process.env.BINGX_SECRET_KEY||'',
  TG_TOKEN:process.env.TELEGRAM_TOKEN||'',
  TG_CHAT:process.env.TELEGRAM_CHAT_ID||'',
  CLAUDE_KEY:process.env.CLAUDE_API_KEY||''
};
let cfg={
  strategy:'AUTO',timeframe:'15m',
  symbols:['BTC-USDT','ETH-USDT','SOL-USDT','AAPL-USD','TSLA-USD'],
  tradeAmount:50,leverage:3,maxRiskPercent:10,
  stopLossPercent:2.0,takeProfitPercent:5.0,
  atrSLMultiple:1.5,atrTPMultiple:3.0,
  allowShort:false,botRunning:false,
  // ✅ 開單門檻改為動態，預設 1（非常寬鬆，讓 AI 自己學習調整）
  entryThreshold:1,
  strategyWeights:{MA:1.0,RSI:1.0,MACD:1.0,BB:1.0,COMBO:1.0},
  params:{fastPeriod:9,slowPeriod:21,rsiPeriod:14,
    // ✅ RSI 閾值放寬：oversold 30→40, overbought 70→60
    oversold:40,overbought:60,
    bbPeriod:20,bbStdDev:2,
    // ✅ 成交量倍數放寬：1.5→1.2
    volMultiple:1.2}
};
let stats=loadStats();
function loadStats(){
  if(fs.existsSync('./stats.json'))try{return JSON.parse(fs.readFileSync('./stats.json','utf8'));}catch(e){}
  return{allTime:{total:0,wins:0,losses:0,pnl:0},daily:{},trades:[],reports:[]};
}
function saveStats(){fs.writeFileSync('./stats.json',JSON.stringify(stats,null,2));}
function todayKey(){return new Date().toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});}
function nowTW(){return new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei'});}
function hourTW(){return parseInt(new Date().toLocaleString('en-US',{timeZone:'Asia/Taipei',hour:'numeric',hour12:false}));}
function getDayStat(d){
  d=d||todayKey();
  if(!stats.daily[d])stats.daily[d]={total:0,wins:0,losses:0,pnl:0};
  return stats.daily[d];
}
function recordTrade(t){
  var d=getDayStat();
  d.total++;if(t.pnl>0)d.wins++;else d.losses++;d.pnl+=t.pnl;
  stats.allTime.total++;if(t.pnl>0)stats.allTime.wins++;else stats.allTime.losses++;stats.allTime.pnl+=t.pnl;
  stats.trades.push(Object.assign({},t,{date:todayKey()}));
  if(stats.trades.length>500)stats.trades=stats.trades.slice(-500);
  saveStats();learnFromTrade(t);
}
let brain=loadBrain();
function loadBrain(){
  if(fs.existsSync('./brain.json'))try{return JSON.parse(fs.readFileSync('./brain.json','utf8'));}catch(e){}
  return{
    strategyPerf:{MA:{wins:0,losses:0,pnl:0,fakeSig:0},RSI:{wins:0,losses:0,pnl:0,fakeSig:0},MACD:{wins:0,losses:0,pnl:0,fakeSig:0},BB:{wins:0,losses:0,pnl:0,fakeSig:0},COMBO:{wins:0,losses:0,pnl:0,fakeSig:0}},
    symbolPerf:{},hourPerf:{},errorPatterns:[],adjustHistory:[],
    marketRegime:'unknown',learnCount:0,
    bestHours:[],worstHours:[],bestSymbols:[],worstSymbols:[],
    entryThresholdHistory:[]
  };
}
function saveBrain(){fs.writeFileSync('./brain.json',JSON.stringify(brain,null,2));}

function learnFromTrade(t){
  var symbol=t.symbol,pnl=t.pnl,strategy=t.strategy,holdMin=t.holdMin,reason=t.reason,regime=t.regime;
  brain.learnCount++;
  var strat=strategy||'COMBO';
  if(!brain.strategyPerf[strat])brain.strategyPerf[strat]={wins:0,losses:0,pnl:0,fakeSig:0};
  var sp=brain.strategyPerf[strat];
  if(pnl>0)sp.wins++;else sp.losses++;sp.pnl+=pnl;
  if(!brain.symbolPerf[symbol])brain.symbolPerf[symbol]={wins:0,losses:0,pnl:0,count:0,avgHold:0};
  var syp=brain.symbolPerf[symbol];
  if(pnl>0)syp.wins++;else syp.losses++;syp.pnl+=pnl;
  syp.count=(syp.count||0)+1;
  syp.avgHold=(((syp.avgHold||0)*(syp.count-1))+holdMin)/syp.count;
  var hr=String(hourTW());
  if(!brain.hourPerf[hr])brain.hourPerf[hr]={wins:0,losses:0,pnl:0};
  var hp=brain.hourPerf[hr];if(pnl>0)hp.wins++;else hp.losses++;hp.pnl+=pnl;
  if(pnl<0){
    sp.fakeSig++;
    brain.errorPatterns.push({symbol:symbol,strategy:strat,reason:reason,holdMin:holdMin,pnl:pnl,regime:regime,hour:hourTW(),date:todayKey()});
    if(brain.errorPatterns.length>100)brain.errorPatterns=brain.errorPatterns.slice(-100);
  }
  // ✅ 每 3 筆學習一次（原本 5 筆），更快適應
  if(brain.learnCount%3===0)autoAdjustParams();
  if(brain.learnCount%8===0)updateWeights();
  updateBestWorst();
  saveBrain();
  log('AI',pnl>0?'學習: '+strat+' '+symbol+' 獲利 +'+pnl.toFixed(2)+'U':'學習: '+strat+' '+symbol+' 虧損 '+pnl.toFixed(2)+'U');
}

function autoAdjustParams(){
  // ✅ 只需 3 筆就開始學習（原本 5 筆）
  var recent=stats.trades.slice(-15);if(recent.length<3)return;
  var wins=recent.filter(function(t){return t.pnl>0;});
  var losses=recent.filter(function(t){return t.pnl<0;});
  var wr=wins.length/recent.length;
  var avgWin=wins.length?wins.reduce(function(s,t){return s+t.pnl;},0)/wins.length:0;
  var avgLoss=losses.length?Math.abs(losses.reduce(function(s,t){return s+t.pnl;},0)/losses.length):0;
  var rr=avgLoss>0?avgWin/avgLoss:1;
  var changes=[];

  // 止損動態調整
  if(wr<0.4&&cfg.stopLossPercent>1.0){
    var o=cfg.stopLossPercent;cfg.stopLossPercent=+(Math.max(1.0,o-0.3)).toFixed(1);
    changes.push('SL 收緊 '+o+'->'+cfg.stopLossPercent+'%');
  }
  if(wr>0.65&&cfg.stopLossPercent<3.5){
    var o2=cfg.stopLossPercent;cfg.stopLossPercent=+(Math.min(3.5,o2+0.2)).toFixed(1);
    changes.push('SL 放寬 '+o2+'->'+cfg.stopLossPercent+'%');
  }
  // 止盈動態調整
  if(rr<1.5&&cfg.takeProfitPercent<12){
    var o3=cfg.takeProfitPercent;cfg.takeProfitPercent=+(Math.min(12,o3+0.5)).toFixed(1);
    changes.push('TP 提高 '+o3+'->'+cfg.takeProfitPercent+'%');
  }
  if(rr>3.0&&cfg.takeProfitPercent>3.0){
    var o4=cfg.takeProfitPercent;cfg.takeProfitPercent=+(Math.max(3.0,o4-0.3)).toFixed(1);
    changes.push('TP 降低 '+o4+'->'+cfg.takeProfitPercent+'%');
  }
  // ✅ 門檻動態調整（核心學習）
  if(wr<0.35&&cfg.entryThreshold<5){
    cfg.entryThreshold++;
    changes.push('門檻提高 ->'+cfg.entryThreshold);
    brain.entryThresholdHistory.push({date:todayKey(),val:cfg.entryThreshold,wr:(wr*100).toFixed(1)});
  }
  if(wr>0.65&&cfg.entryThreshold>1){
    cfg.entryThreshold--;
    changes.push('門檻降低 ->'+cfg.entryThreshold);
    brain.entryThresholdHistory.push({date:todayKey(),val:cfg.entryThreshold,wr:(wr*100).toFixed(1)});
  }

  if(changes.length){
    brain.adjustHistory.push({date:todayKey(),changes:changes,wr:(wr*100).toFixed(1),rr:rr.toFixed(2)});
    if(brain.adjustHistory.length>100)brain.adjustHistory=brain.adjustHistory.slice(-100);
    log('AI','自動調整: '+changes.join(' | '));
    tg('🧠 AI 自動調整\n'+changes.join('\n')+'\nWR:'+(wr*100).toFixed(1)+'% RR:'+rr.toFixed(2));
  }
}

function updateWeights(){
  var changed=false;
  Object.keys(brain.strategyPerf).forEach(function(s){
    var p=brain.strategyPerf[s];var t=p.wins+p.losses;
    // ✅ 降低最低樣本數 3→2
    if(t<2)return;
    var wr=p.wins/t,old=cfg.strategyWeights[s]||1.0,nw=old;
    if(wr>0.6)nw=+(Math.min(2.0,old+0.15)).toFixed(2);
    if(wr<0.35)nw=+(Math.max(0.2,old-0.15)).toFixed(2);
    if(Math.abs(nw-old)>0.05){cfg.strategyWeights[s]=nw;changed=true;}
  });
  if(changed){
    tg('📊 策略權重更新\n'+Object.keys(cfg.strategyWeights).map(function(k){
      var v=cfg.strategyWeights[k];var p=brain.strategyPerf[k]||{wins:0,losses:0};
      var t=p.wins+p.losses;return k+': '+v+' WR='+(t>0?(p.wins/t*100).toFixed(0):'-')+'%';
    }).join('\n'));
  }
}

function updateBestWorst(){
  // ✅ 最低樣本數 5→3，更快識別好壞
  brain.bestHours=Object.keys(brain.hourPerf).filter(function(h){var p=brain.hourPerf[h];var t=p.wins+p.losses;return t>=3&&p.wins/t>=0.6;});
  brain.worstHours=Object.keys(brain.hourPerf).filter(function(h){var p=brain.hourPerf[h];var t=p.wins+p.losses;return t>=3&&p.wins/t<0.35;});
  brain.bestSymbols=Object.keys(brain.symbolPerf).filter(function(s){var p=brain.symbolPerf[s];var t=p.wins+p.losses;return t>=3&&p.wins/t>=0.55;});
  brain.worstSymbols=Object.keys(brain.symbolPerf).filter(function(s){var p=brain.symbolPerf[s];var t=p.wins+p.losses;return t>=5&&p.wins/t<0.25&&p.pnl<-50;});
}

function detectRegime(closes){
  if(closes.length<30)return 'unknown';
  var ma20=closes.slice(-20).reduce(function(s,v){return s+v;},0)/20;
  var ma5=closes.slice(-5).reduce(function(s,v){return s+v;},0)/5;
  var rets=[];for(var i=1;i<closes.length;i++)rets.push((closes[i]-closes[i-1])/closes[i-1]);
  var std=Math.sqrt(rets.slice(-14).reduce(function(s,r){return s+r*r;},0)/14);
  if(std>0.03)return 'volatile';
  if(Math.abs(ma5-ma20)/ma20>0.02)return 'trend';
  return 'ranging';
}

function selectBestStrategy(regime){
  var map={trend:['MACD','MA'],ranging:['BB','RSI'],volatile:['RSI','BB'],unknown:['COMBO']};
  var cands=map[regime]||['COMBO'];
  var best=cands[0],bestScore=-Infinity;
  cands.forEach(function(s){
    var w=cfg.strategyWeights[s]||1.0,p=brain.strategyPerf[s]||{wins:0,losses:0};
    var t=p.wins+p.losses,wr=t>0?p.wins/t:0.5,score=w*wr;
    if(score>bestScore){bestScore=score;best=s;}
  });
  return best;
}

function isBadPattern(symbol,strategy,hour){
  // ✅ 需要 5 次才列為壞模式（原本 3 次）
  return brain.errorPatterns.filter(function(p){return p.symbol===symbol&&p.strategy===strategy&&Math.abs(p.hour-hour)<=1;}).length>=5;
}

function isBadSymbol(symbol){
  var p=brain.symbolPerf[symbol];if(!p)return false;
  var t=p.wins+p.losses;if(t<5)return false;
  // ✅ 放寬黑名單條件：勝率<25% 且虧損>50U
  return p.wins/t<0.25&&p.pnl<-50;
}

var memLog=[];
function log(lv,msg){
  console.log('['+nowTW()+']['+lv+'] '+msg);
  memLog.push({ts:nowTW(),lv:lv,msg:msg});
  if(memLog.length>300)memLog.shift();
}

function sign(qs){return crypto.createHmac('sha256',ENV.BINGX_SECRET).update(qs).digest('hex');}
function buildQ(params){
  var p=Object.assign({},params,{timestamp:Date.now()});
  var qs=Object.keys(p).filter(function(k){return p[k]!=null&&p[k]!=='';}).map(function(k){return k+'='+encodeURIComponent(String(p[k]));}).join('&');
  return qs+'&signature='+sign(qs);
}
function apiReq(method,path,params,tries){
  params=params||{};tries=tries||3;
  return new Promise(function(resolve,reject){
    var q=buildQ(params);
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
  try{var r=await apiReq('GET','/openApi/swap/v2/user/balance');if(r.code===0)return{available:parseFloat(r.data.balance.availableMargin||0),total:parseFloat(r.data.balance.balance||0),unrealPnl:parseFloat(r.data.balance.unrealizedProfit||0)};}catch(e){}
  try{var r2=await apiReq('GET','/openApi/spot/v1/account/balance');if(r2.code===0){var u=r2.data.balances.find(function(b){return b.asset==='USDT';})||{};return{available:parseFloat(u.free||0),total:parseFloat(u.free||0)+parseFloat(u.locked||0),unrealPnl:0};}}catch(e2){}
  throw new Error('Cannot get balance');
}
async function getPositions(sym){sym=sym||'';try{var r=await apiReq('GET','/openApi/swap/v2/user/positions',sym?{symbol:sym}:{});if(r.code===0)return(r.data||[]).filter(function(p){return parseFloat(p.positionAmt||0)!==0;});}catch(e){}return[];}
async function getKlines(sym,iv,lim){lim=lim||150;try{var r=await apiReq('GET','/openApi/swap/v2/quote/klines',{symbol:sym,interval:iv,limit:lim});if(r.code===0&&Array.isArray(r.data))return r.data;}catch(e){log('WARN','Kline fail '+sym);}return[];}
async function getTicker(sym){try{var r=await apiReq('GET','/openApi/swap/v2/quote/ticker',{symbol:sym});if(r.code===0)return r.data;}catch(e){}return null;}
async function setLev(sym,lev){var sides=['LONG','SHORT'];for(var i=0;i<sides.length;i++){try{await apiReq('POST','/openApi/swap/v2/trade/leverage',{symbol:sym,side:sides[i],leverage:lev});}catch(e){}}}

async function placeOrder(o){
  if(cfg.leverage>1)await setLev(o.symbol,cfg.leverage);
  var p={symbol:o.symbol,side:o.side,positionSide:o.positionSide||'LONG',type:'MARKET',quantity:String(o.quantity)};
  if(o.stopLoss)p.stopLoss=JSON.stringify({type:'STOP_MARKET',stopPrice:String(o.stopLoss),workingType:'MARK_PRICE',closePosition:'true'});
  if(o.takeProfit)p.takeProfit=JSON.stringify({type:'TAKE_PROFIT_MARKET',stopPrice:String(o.takeProfit),workingType:'MARK_PRICE',closePosition:'true'});
  log('INFO','下單 '+o.side+' '+o.symbol+' x'+o.quantity);
  var r=await apiReq('POST','/openApi/swap/v2/trade/order',p);
  if(r.code===0){
    log('OK','開單成功 '+o.side+' '+o.symbol);
    tg('✅ 開單成功\n'+(o.side==='BUY'?'🟢 多單':'🔴 空單')+' '+o.symbol+'\n數量:'+o.quantity+'\nSL:'+o.stopLoss+' TP:'+o.takeProfit);
    return r.data.order;
  }else{
    log('ERROR','開單失敗 ['+r.code+'] '+r.msg);
    tg('❌ 開單失敗\n'+o.symbol+'\n['+r.code+'] '+r.msg);
    return null;
  }
}
async function closePosAPI(sym,ps,qty){return placeOrder({symbol:sym,side:ps==='LONG'?'SELL':'BUY',positionSide:ps,quantity:qty});}

var I={
  ma:function(a,n){if(a.length<n)return null;return a.slice(-n).reduce(function(s,v){return s+v;},0)/n;},
  ema:function(a,n){
    if(a.length<n)return null;
    var k=2/(n+1);var e=a.slice(0,n).reduce(function(s,v){return s+v;},0)/n;
    for(var i=n;i<a.length;i++)e=a[i]*k+e*(1-k);return e;
  },
  rsi:function(a,n){n=n||14;if(a.length<n+1)return null;var g=0,l=0;for(var i=a.length-n;i<a.length;i++){var d=a[i]-a[i-1];if(d>0)g+=d;else l-=d;}return 100-100/(1+g/(l||0.0001));},
  macd:function(a){
    var self=this;if(a.length<35)return null;
    var f=self.ema(a,12),s=self.ema(a,26);if(!f||!s)return null;
    var ln=f-s;
    var arr=a.map(function(_,i){if(i<25)return 0;var ff=self.ema(a.slice(0,i+1),12),ss=self.ema(a.slice(0,i+1),26);return(ff&&ss)?ff-ss:0;}).slice(25);
    var sig=self.ema(arr,9)||0;return{line:ln,signal:sig,hist:ln-sig};
  },
  boll:function(a,n,d){n=n||20;d=d||2;if(a.length<n)return null;var sl=a.slice(-n),m=sl.reduce(function(s,v){return s+v;},0)/n,std=Math.sqrt(sl.reduce(function(s,v){return s+Math.pow(v-m,2);},0)/n);return{upper:m+d*std,mid:m,lower:m-d*std};},
  atr:function(h,l,c,n){n=n||14;if(c.length<n+1)return null;var tr=[];for(var i=1;i<c.length;i++)tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));return tr.slice(-n).reduce(function(s,v){return s+v;},0)/n;},
  // ✅ 新增 Stochastic RSI
  stochRsi:function(a,n){
    n=n||14;if(a.length<n*2)return null;
    var rsiArr=[];
    for(var i=n;i<a.length;i++){
      var sl=a.slice(i-n,i+1);
      var g=0,l=0;
      for(var j=1;j<sl.length;j++){var d=sl[j]-sl[j-1];if(d>0)g+=d;else l-=d;}
      rsiArr.push(100-100/(1+(g/(l||0.0001))));
    }
    if(rsiArr.length<n)return null;
    var rslice=rsiArr.slice(-n);
    var rmin=Math.min.apply(null,rslice),rmax=Math.max.apply(null,rslice);
    return rmax-rmin>0?(rsiArr[rsiArr.length-1]-rmin)/(rmax-rmin)*100:50;
  }
};

var openTrades={};

async function runStrategy(sym){
  if(isBadSymbol(sym)){log('AI',sym+' 黑名單跳過');return null;}
  var kl=await getKlines(sym,cfg.timeframe,150);if(kl.length<50)return null;
  var closes=kl.map(function(k){return parseFloat(k[4]);});
  var highs=kl.map(function(k){return parseFloat(k[2]);});
  var lows=kl.map(function(k){return parseFloat(k[3]);});
  var vols=kl.map(function(k){return parseFloat(k[5]);});
  var last=closes[closes.length-1],p=cfg.params;
  var regime=detectRegime(closes);brain.marketRegime=regime;
  var strat=cfg.strategy==='AUTO'?selectBestStrategy(regime):cfg.strategy;
  var hr=hourTW();

  // ✅ 差時段改為扣分而非封鎖
  var hourPenalty=0;
  if(brain.worstHours.includes(String(hr))){hourPenalty=1;log('AI',sym+' 差時段扣1分');}

  if(isBadPattern(sym,strat,hr)){log('AI',sym+' 壞模式跳過');return null;}

  var bs=0,ss=0,rsn=[];

  // 信號1: MA 交叉
  if(strat==='MA'||strat==='COMBO'){
    var f=I.ma(closes,p.fastPeriod||9),s=I.ma(closes,p.slowPeriod||21);
    var pf=I.ma(closes.slice(0,-1),p.fastPeriod||9),ps2=I.ma(closes.slice(0,-1),p.slowPeriod||21);
    if(f&&s&&pf&&ps2){
      if(pf<=ps2&&f>s){bs+=2;rsn.push('MA金叉');}
      if(pf>=ps2&&f<s){ss+=2;rsn.push('MA死叉');}
      // ✅ 新增：MA 趨勢方向也給分
      if(f>s){bs+=1;rsn.push('MA趨多');}else{ss+=1;rsn.push('MA趨空');}
    }
  }

  // 信號2: RSI（放寬後 oversold:40, overbought:60）
  if(strat==='RSI'||strat==='COMBO'){
    var r=I.rsi(closes,p.rsiPeriod||14),rp=I.rsi(closes.slice(0,-1),p.rsiPeriod||14);
    if(r&&rp){
      if(rp<p.oversold&&r>p.oversold){bs+=2;rsn.push('RSI回升('+r.toFixed(0)+')');}
      if(rp>p.overbought&&r<p.overbought){ss+=2;rsn.push('RSI回落('+r.toFixed(0)+')');}
      // ✅ 接近閾值也給分
      if(r<50)bs+=1;if(r>50)ss+=1;
      if(rsn.length===0&&r<45)rsn.push('RSI偏低('+r.toFixed(0)+')');
      if(rsn.length===0&&r>55)rsn.push('RSI偏高('+r.toFixed(0)+')');
    }
  }

  // 信號3: MACD
  if(strat==='MACD'||strat==='COMBO'){
    var m=I.macd(closes),pm=I.macd(closes.slice(0,-1));
    if(m&&pm){
      if(pm.hist<=0&&m.hist>0){bs+=2;rsn.push('MACD金叉');}
      if(pm.hist>=0&&m.hist<0){ss+=2;rsn.push('MACD死叉');}
      // ✅ MACD 方向也給分
      if(m.hist>0)bs+=1;else ss+=1;
    }
  }

  // 信號4: 布林帶
  if(strat==='BB'||strat==='COMBO'){
    var bb=I.boll(closes,p.bbPeriod||20,p.bbStdDev||2);
    if(bb){
      if(last<=bb.lower){bs+=2;rsn.push('BB下軌');}
      else if(last<bb.mid){bs+=1;rsn.push('BB下半');}
      if(last>=bb.upper){ss+=2;rsn.push('BB上軌');}
      else if(last>bb.mid){ss+=1;rsn.push('BB上半');}
    }
  }

  // ✅ 信號5: Stochastic RSI（新增）
  var srsi=I.stochRsi(closes,14);
  if(srsi!==null){
    if(srsi<20){bs+=1;rsn.push('StochRSI超賣('+srsi.toFixed(0)+')');}
    if(srsi>80){ss+=1;rsn.push('StochRSI超買('+srsi.toFixed(0)+')');}
  }

  // 成交量確認（放寬倍數）
  var av=I.ma(vols.slice(0,-1),20);
  if(av&&vols[vols.length-1]>av*p.volMultiple){bs+=1;ss+=1;rsn.push('量增('+(vols[vols.length-1]/av).toFixed(1)+'x)');}

  // 時段懲罰
  bs=Math.max(0,bs-hourPenalty);
  ss=Math.max(0,ss-hourPenalty);

  // ✅ 使用動態門檻（由 AI 自動調整）
  var w=cfg.strategyWeights[strat]||1.0;
  var thr=Math.max(cfg.entryThreshold,Math.round(cfg.entryThreshold/w));
  var signal='HOLD';
  if(bs>=thr||ss>=thr)signal=bs>=ss?'BUY':'SELL';

  var atrV=I.atr(highs,lows,closes)||last*0.015;
  log('INFO',sym+' ['+regime+'->'+strat+'] BS:'+bs+' SS:'+ss+' 門檻:'+thr+' -> '+signal+(rsn.length?' ['+rsn.join('+')+']':''));
  return{signal:signal,reasons:rsn.join('+'),price:last,atrV:atrV,strat:strat,regime:regime,bs:bs,ss:ss};
}

var botTimer=null,startTime=Date.now();

async function tradingLoop(){
  if(!cfg.botRunning)return;
  log('INFO','=== Loop '+nowTW()+' ===');
  try{
    for(var i=0;i<cfg.symbols.length;i++){
      var sym=cfg.symbols[i];
      try{
        var res=await runStrategy(sym);if(!res)continue;
        var signal=res.signal,reasons=res.reasons,price=res.price,atrV=res.atrV,strat=res.strat,regime=res.regime;
        var tk=await getTicker(sym);var cur=tk?parseFloat(tk.lastPrice):price;
        if(signal==='HOLD')continue;
        var bal=await getBalance();
        var amt=Math.min(cfg.tradeAmount,bal.available*(cfg.maxRiskPercent/100));
        if(amt<5){log('WARN',sym+' 餘額不足 '+bal.available.toFixed(2)+'U');continue;}
        var qty=parseFloat((amt*cfg.leverage/cur).toFixed(5));if(qty<=0)continue;
        var slD=Math.max(atrV*cfg.atrSLMultiple,cur*cfg.stopLossPercent/100);
        var tpD=Math.max(atrV*cfg.atrTPMultiple,cur*cfg.takeProfitPercent/100);
        var slP=signal==='BUY'?+(cur-slD).toFixed(4):+(cur+slD).toFixed(4);
        var tpP=signal==='BUY'?+(cur+tpD).toFixed(4):+(cur-tpD).toFixed(4);
        var pos=await getPositions(sym);
        if(signal==='BUY'&&!pos.some(function(p){return p.positionSide==='LONG';})&&!openTrades[sym]){
          log('BUY','多單 '+sym+' x'+qty+' reasons:'+reasons);
          var o=await placeOrder({symbol:sym,side:'BUY',positionSide:'LONG',quantity:qty,stopLoss:slP,takeProfit:tpP});
          if(o)openTrades[sym]={symbol:sym,side:'LONG',entry:cur,qty:qty,sl:slP,tp:tpP,reason:reasons,strat:strat,regime:regime,openTime:Date.now()};
        }else if(signal==='SELL'&&openTrades[sym]){
          var t=openTrades[sym];
          log('SELL','平倉 '+sym+' entry:'+t.entry.toFixed(4)+' now:'+cur.toFixed(4));
          var ord=await closePosAPI(sym,'LONG',t.qty);
          if(ord){
            var pnl=(cur-t.entry)*t.qty*cfg.leverage-cur*t.qty*0.001;
            var holdMin=Math.round((Date.now()-t.openTime)/60000);
            recordTrade({symbol:sym,side:'LONG',entry:t.entry,exit:cur,qty:t.qty,pnl:pnl,holdMin:holdMin,reason:t.reason,strategy:t.strat,regime:t.regime,marketRegime:t.regime});
            tg((pnl>0?'✅ 獲利':'❌ 虧損')+' '+sym+'\n'+t.entry.toFixed(4)+'->'+cur.toFixed(4)+'\nPnL:'+(pnl>=0?'+':'')+pnl.toFixed(2)+'U Hold:'+holdMin+'min\n策略:'+t.strat);
            delete openTrades[sym];
          }
        }
      }catch(e){log('ERROR',sym+': '+e.message);}
    }
  }catch(e){log('ERROR','Loop錯誤: '+e.message);}
}

function tg(text,chatId){
  var id=chatId||ENV.TG_CHAT;if(!ENV.TG_TOKEN||!id)return;
  var body=JSON.stringify({chat_id:id,text:text,parse_mode:'HTML'});
  var req=https.request({hostname:'api.telegram.org',path:'/bot'+ENV.TG_TOKEN+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(r){var d='';r.on('data',function(c){d+=c;});});
  req.on('error',function(e){log('WARN','TG fail:'+e.message);});
  req.write(body);req.end();
}

var lastUpdateId=0;
function tgPoll(){
  if(!ENV.TG_TOKEN)return;
  var params='offset='+(lastUpdateId+1)+'&timeout=30&limit=10';
  var req=https.request({hostname:'api.telegram.org',path:'/bot'+ENV.TG_TOKEN+'/getUpdates?'+params,method:'GET',headers:{}},function(res){
    var d='';res.on('data',function(c){d+=c;});
    res.on('end',function(){
      try{
        var json=JSON.parse(d);
        if(json.ok&&json.result&&json.result.length>0){
          json.result.forEach(function(update){
            if(update.update_id>lastUpdateId)lastUpdateId=update.update_id;
            handleUpdate(update);
          });
        }
      }catch(e){}
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
    tg('🤖 BingX AutoTrader v5.1\nSelf-Learning ON\n\n▶ 基本\n/go - 啟動\n/stop - 停止\n/status - 狀態\n/positions - 持倉\n/close SYMBOL - 手動平倉\n/log - 最近日誌\n\n⚙ 設定\n/set strategy AUTO\n/set tf 15m\n/set amount 50\n/set leverage 3\n/set sl 2\n/set tp 5\n/set threshold 1\n\n🧠 學習\n/brain - 學習狀態\n/weights - 策略權重\n/errors - 錯誤模式\n/adjustments - 調參記錄\n\n📊 績效\n/stats - 績效\n/history - 近10筆\n/report - AI 分析報告\n\n📌 幣種\n/addsym SYMBOL\n/delsym SYMBOL',chatId);return;
  }

  if(cmd==='/go'){
    if(cfg.botRunning){tg('⚠️ 已在運行',chatId);return;}
    cfg.botRunning=true;
    var ms={'1m':60000,'5m':300000,'15m':900000,'1h':3600000,'4h':14400000}[cfg.timeframe]||900000;
    botTimer=setInterval(function(){tradingLoop().catch(function(e){log('ERROR','Timer: '+e.message);});},ms);
    tradingLoop().catch(function(e){log('ERROR','Go: '+e.message);});
    tg('🚀 BingX 啟動!\n策略:'+cfg.strategy+'\nTF:'+cfg.timeframe+'\nLev:'+cfg.leverage+'x\nAmt:'+cfg.tradeAmount+'U\nSL:'+cfg.stopLossPercent+'% TP:'+cfg.takeProfitPercent+'%\n門檻:'+cfg.entryThreshold+'\nSymbols:'+cfg.symbols.join(',')+'\nSelf-Learning: ON ✅',chatId);return;
  }

  if(cmd==='/stop'){
    if(!cfg.botRunning){tg('⚠️ 未運行',chatId);return;}
    cfg.botRunning=false;clearInterval(botTimer);botTimer=null;tg('⏹ 已停止',chatId);return;
  }

  if(cmd==='/status'){
    getBalance().then(function(bal){
      var d=getDayStat(),all=stats.allTime;
      tg('[BingX] 狀態\n'+(cfg.botRunning?'🟢 運行中':'🔴 已停止')+' Uptime:'+Math.round((Date.now()-startTime)/60000)+'min\n餘額:'+bal.available.toFixed(2)+'U / 總計:'+bal.total.toFixed(2)+'U\n今日:'+d.total+'筆 WR:'+(d.total>0?(d.wins/d.total*100).toFixed(0):0)+'% PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U\n全部:'+all.total+'筆 WR:'+(all.total>0?(all.wins/all.total*100).toFixed(0):0)+'% PnL:'+(all.pnl>=0?'+':'')+all.pnl.toFixed(2)+'U\n已學習:'+brain.learnCount+'次 市場:'+brain.marketRegime+'\n持倉:'+Object.keys(openTrades).length+'\n門檻:'+cfg.entryThreshold,chatId);
    }).catch(function(e){tg('Error: '+e.message,chatId);});return;
  }

  if(cmd==='/brain'){
    var sp=Object.keys(brain.strategyPerf).map(function(k){var v=brain.strategyPerf[k];var t=v.wins+v.losses;return k+':'+(t>0?(v.wins/t*100).toFixed(0):0)+'%('+t+'筆) W:'+cfg.strategyWeights[k];});
    var sy=Object.keys(brain.symbolPerf).slice(0,5).map(function(k){var v=brain.symbolPerf[k];var t=v.wins+v.losses;return k+':'+(t>0?(v.wins/t*100).toFixed(0):0)+'% '+(v.pnl>=0?'+':'')+v.pnl.toFixed(1)+'U';});
    var lastAdj=brain.adjustHistory.length?brain.adjustHistory[brain.adjustHistory.length-1]:{changes:['尚未調整']};
    tg('[BingX] 🧠 學習狀態\n已學習:'+brain.learnCount+'次\n最佳時段:'+(brain.bestHours.join(',')+'時'||'學習中')+'\n迴避時段:'+(brain.worstHours.join(',')+'時'||'無')+'\n最佳品種:'+(brain.bestSymbols.join(',')||'學習中')+'\n迴避品種:'+(brain.worstSymbols.join(',')||'無')+'\n市場:'+brain.marketRegime+'\n\n策略:\n'+sp.join('\n')+'\n\n品種:\n'+sy.join('\n')+'\n\n最近調整:\n'+lastAdj.changes.join('\n'),chatId);return;
  }

  if(cmd==='/weights'){
    tg('📊 策略權重\n'+Object.keys(cfg.strategyWeights).map(function(k){var v=cfg.strategyWeights[k];var p=brain.strategyPerf[k]||{wins:0,losses:0};var t=p.wins+p.losses;return k+': W='+v+' WR='+(t>0?(p.wins/t*100).toFixed(0):'-')+'% ('+t+'筆)';}).join('\n'),chatId);return;
  }

  if(cmd==='/errors'){
    var ep=brain.errorPatterns.slice(-10).reverse();
    if(!ep.length){tg('無錯誤記錄',chatId);return;}
    tg('❌ 最近錯誤\n'+ep.map(function(e){return e.date+' '+e.symbol+'['+e.strategy+'] '+e.hour+'時 '+e.pnl.toFixed(2)+'U';}).join('\n'),chatId);return;
  }

  if(cmd==='/adjustments'){
    var ah=brain.adjustHistory.slice(-5).reverse();
    if(!ah.length){tg('無調整記錄',chatId);return;}
    tg('🔧 調參記錄\n'+ah.map(function(a){return a.date+' WR:'+a.wr+'%\n'+a.changes.join('\n');}).join('\n\n'),chatId);return;
  }

  if(cmd==='/log'){
    var recent=memLog.slice(-15);
    tg('[BingX] 最近日誌\n'+recent.map(function(l){return '['+l.lv+'] '+l.msg;}).join('\n'),chatId);return;
  }

  if(cmd==='/positions'){
    var keys=Object.keys(openTrades);if(!keys.length){tg('[BingX] 無持倉',chatId);return;}
    Promise.all(keys.map(function(s){return getTicker(s).catch(function(){return null;});})).then(function(tks){
      var m='[BingX] 持倉\n\n';
      keys.forEach(function(sym,i){
        var t=openTrades[sym],cur=tks[i]?parseFloat(tks[i].lastPrice):t.entry;
        var pnl=(cur-t.entry)*t.qty*cfg.leverage;
        m+='🟢 '+sym+' ['+t.strat+']\nEntry:'+t.entry.toFixed(4)+' Now:'+cur.toFixed(4)+'\nPnL:'+(pnl>=0?'✅ +':'❌ ')+pnl.toFixed(2)+'U Hold:'+Math.round((Date.now()-t.openTime)/60000)+'min\n原因:'+t.reason+'\n\n';
      });
      tg(m,chatId);
    });return;
  }

  if(cmd==='/close'){
    if(!args[0]){tg('用法: /close BTC-USDT',chatId);return;}
    var sym2=args[0].toUpperCase();if(!openTrades[sym2]){tg('無持倉: '+sym2,chatId);return;}
    var t2=openTrades[sym2];
    closePosAPI(sym2,'LONG',t2.qty).then(function(o){
      if(o){getTicker(sym2).catch(function(){return null;}).then(function(tk){
        var cur=tk?parseFloat(tk.lastPrice):t2.entry,pnl=(cur-t2.entry)*t2.qty*cfg.leverage;
        recordTrade({symbol:sym2,side:'LONG',entry:t2.entry,exit:cur,qty:t2.qty,pnl:pnl,holdMin:Math.round((Date.now()-t2.openTime)/60000),reason:'手動平倉',strategy:t2.strat,regime:t2.regime,marketRegime:t2.regime});
        delete openTrades[sym2];
        tg('✅ 手動平倉 '+sym2+'\nPnL:'+(pnl>=0?'+':'')+pnl.toFixed(2)+'U',chatId);
      });}
    }).catch(function(e){tg('平倉失敗: '+e.message,chatId);});return;
  }

  if(cmd==='/set'){
    if(args.length<2){tg('用法: /set KEY VALUE',chatId);return;}
    var sk=args[0].toLowerCase(),sv=args[1],nv=parseFloat(sv);
    if(sk==='strategy'){var v=sv.toUpperCase();if(['AUTO','COMBO','MA','RSI','MACD','BB'].includes(v)){cfg.strategy=v;tg('✅ 策略 -> '+v,chatId);}else tg('無效策略',chatId);}
    else if(sk==='tf'){if(['1m','5m','15m','1h','4h'].includes(sv)){cfg.timeframe=sv;tg('✅ 時框 -> '+sv,chatId);}else tg('無效時框',chatId);}
    else if(sk==='amount'&&nv>0){cfg.tradeAmount=nv;tg('✅ 金額 -> '+nv+'U',chatId);}
    else if(sk==='leverage'&&nv>=1&&nv<=20){cfg.leverage=nv;tg('✅ 槓桿 -> '+nv+'x',chatId);}
    else if(sk==='sl'&&nv>0){cfg.stopLossPercent=nv;tg('✅ 止損 -> '+nv+'%',chatId);}
    else if(sk==='tp'&&nv>0){cfg.takeProfitPercent=nv;tg('✅ 止盈 -> '+nv+'%',chatId);}
    else if(sk==='threshold'&&nv>=1&&nv<=6){cfg.entryThreshold=Math.round(nv);tg('✅ 開單門檻 -> '+cfg.entryThreshold,chatId);}
    else if(sk==='oversold'&&nv>0&&nv<50){cfg.params.oversold=nv;tg('✅ 超賣線 -> '+nv,chatId);}
    else if(sk==='overbought'&&nv>50&&nv<100){cfg.params.overbought=nv;tg('✅ 超買線 -> '+nv,chatId);}
    else if(sk==='fastp'&&nv>0){cfg.params.fastPeriod=nv;tg('✅ 快線 -> '+nv,chatId);}
    else if(sk==='slowp'&&nv>0){cfg.params.slowPeriod=nv;tg('✅ 慢線 -> '+nv,chatId);}
    else tg('未知設定: '+sk,chatId);return;
  }

  if(cmd==='/addsym'){if(!args[0]){tg('用法: /addsym ETH-USDT',chatId);return;}var as=args[0].toUpperCase();if(cfg.symbols.includes(as)){tg(as+' 已存在',chatId);return;}cfg.symbols.push(as);tg('✅ 新增 '+as,chatId);return;}
  if(cmd==='/delsym'){if(!args[0]){tg('用法: /delsym ETH-USDT',chatId);return;}cfg.symbols=cfg.symbols.filter(function(s){return s!==args[0].toUpperCase();});tg('✅ 移除 '+args[0].toUpperCase(),chatId);return;}

  if(cmd==='/stats'){
    var al=stats.allTime,dds=getDayStat();var w7='',p7=0;
    // ✅ 修復 i-- bug（原本 i– 導致崩潰）
    for(var i=6;i>=0;i--){
      var dd=new Date();dd.setDate(dd.getDate()-i);
      var dk=dd.toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});
      var ds=getDayStat(dk);p7+=ds.pnl;
      w7+=dk.slice(5)+':'+ds.total+'筆 '+(ds.pnl>=0?'+':'')+ds.pnl.toFixed(0)+'U\n';
    }
    tg('[BingX] 📊 績效\n今日:'+dds.total+'筆 WR:'+(dds.total>0?(dds.wins/dds.total*100).toFixed(0):0)+'% PnL:'+(dds.pnl>=0?'+':'')+dds.pnl.toFixed(2)+'U\n\n7天:\n'+w7+'7天合計:'+(p7>=0?'+':'')+p7.toFixed(2)+'U\n\n全部:'+al.total+'筆 WR:'+(al.total>0?(al.wins/al.total*100).toFixed(1):0)+'% PnL:'+(al.pnl>=0?'+':'')+al.pnl.toFixed(2)+'U',chatId);return;
  }

  if(cmd==='/history'){
    var tr=stats.trades.slice(-10).reverse();if(!tr.length){tg('尚無交易記錄',chatId);return;}
    tg('[BingX] 近10筆\n'+tr.map(function(t){return (t.pnl>=0?'✅ WIN':'❌ LOSS')+' '+t.symbol+'['+(t.strategy||'-')+']\n'+(t.entry||0).toFixed(4)+'->'+(t.exit||0).toFixed(4)+' '+(t.pnl>=0?'+':'')+t.pnl.toFixed(2)+'U hold:'+(t.holdMin||0)+'min';}).join('\n\n'),chatId);return;
  }

  if(cmd==='/report'){tg('🧠 生成 AI 分析中...',chatId);generateReport(chatId).catch(function(e){tg('報告失敗: '+e.message,chatId);});return;}
  if(text.startsWith('/'))tg('未知指令，輸入 /help 查看',chatId);
}

async function callClaude(prompt){
  return new Promise(function(resolve){
    if(!ENV.CLAUDE_KEY){resolve('CLAUDE_API_KEY 未設定');return;}
    var body=JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:2000,messages:[{role:'user',content:prompt}]});
    var opt={hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':ENV.CLAUDE_KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(body)}};
    var req=https.request(opt,function(r){var d='';r.on('data',function(c){d+=c;});r.on('end',function(){try{resolve(JSON.parse(d).content[0].text||'no response');}catch(e){resolve('parse fail');}});});
    req.on('error',function(e){resolve('fail: '+e.message);});
    req.setTimeout(40000,function(){req.destroy();resolve('timeout');});
    req.write(body);req.end();
  });
}

async function generateReport(chatId){
  var date=todayKey(),all=stats.allTime;
  var yd=new Date();yd.setDate(yd.getDate()-1);var yDate=yd.toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});var ydS=getDayStat(yDate);
  var last7=[];
  for(var i=6;i>=0;i--){
    var d=new Date();d.setDate(d.getDate()-i);
    var dk=d.toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});
    var ds=getDayStat(dk);last7.push(dk+':'+ds.total+'筆 '+(ds.pnl>=0?'+':'')+ds.pnl.toFixed(2)+'U');
  }
  var bal=await getBalance().catch(function(){return{available:0,total:0,unrealPnl:0};});
  var rt=stats.trades.slice(-20).map(function(t){return t.date+' '+t.symbol+'['+(t.strategy||'-')+'] '+(t.entry||0).toFixed(4)+'->'+(t.exit||0).toFixed(4)+' '+(t.pnl>=0?'+':'')+t.pnl.toFixed(2)+'U';}).join('\n');
  var prompt='你是量化交易AI教練，分析自學習機器人表現，請用繁體中文回覆。\n系統: '+cfg.strategy+' | '+cfg.timeframe+' | '+cfg.leverage+'x | SL:'+cfg.stopLossPercent+'% TP:'+cfg.takeProfitPercent+'% | 門檻:'+cfg.entryThreshold+'\n餘額: '+bal.available.toFixed(2)+'U\n昨日: '+ydS.total+'筆 WR:'+(ydS.total>0?(ydS.wins/ydS.total*100).toFixed(1):0)+'% PnL:'+(ydS.pnl>=0?'+':'')+ydS.pnl.toFixed(2)+'U\n全部: '+all.total+'筆 WR:'+(all.total>0?(all.wins/all.total*100).toFixed(1):0)+'% PnL:'+(all.pnl>=0?'+':'')+all.pnl.toFixed(2)+'U\n7天:\n'+last7.join('\n')+'\n已學習:'+brain.learnCount+'次 市場:'+brain.marketRegime+'\n近期交易:\n'+(rt||'無')+'\n\n請提供: 1.表現總結 2.學習進度 3.策略評估 4.風險提示 5.優化建議 6.明日展望 7.建議參數: stopLossPercent:X takeProfitPercent:X threshold:X';
  log('AI','呼叫 Claude 分析...');
  var text2=await callClaude(prompt);
  stats.reports=stats.reports||[];stats.reports.push({date:date,text:text2});if(stats.reports.length>30)stats.reports=stats.reports.slice(-30);saveStats();
  var target=chatId||ENV.TG_CHAT;
  var full=date+' 🧠 AI 分析報告\n---\n\n'+text2;
  var idx=0;
  var sendNext=function(){if(idx>=full.length)return;tg(full.slice(idx,idx+4000),target);idx+=4000;setTimeout(sendNext,600);};
  sendNext();
  log('OK','報告已發送');
}

function scheduleReport(){
  var ms10=function(){var now=new Date(),tw=new Date(now.toLocaleString('en-US',{timeZone:'Asia/Taipei'}));var n=new Date(tw);n.setHours(10,0,0,0);if(tw.getHours()>=10)n.setDate(n.getDate()+1);return n-tw;};
  var ms=ms10();log('AI','每日報告將於 10:00 台灣時間發送 ('+( ms/3600000).toFixed(1)+'小時後)');
  setTimeout(function(){generateReport();setInterval(generateReport,24*60*60*1000);},ms);
}

function startServer(){
  var PORT=process.env.PORT||3000;
  http.createServer(function(req,res){
    var body='';req.on('data',function(c){body+=c;});req.on('end',function(){
      if(req.url==='/'||req.url==='/health'){
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({status:'ok',running:cfg.botRunning,strategy:cfg.strategy,learnCount:brain.learnCount,uptime:Math.round((Date.now()-startTime)/60000)+'min',trades:stats.allTime.total,pnl:stats.allTime.pnl.toFixed(2),threshold:cfg.entryThreshold}));return;
      }
      if(req.url==='/webhook'&&req.method==='POST'){try{handleUpdate(JSON.parse(body));}catch(e){}res.writeHead(200);res.end('ok');return;}
      res.writeHead(404);res.end('not found');
    });
  }).listen(PORT,function(){log('OK','Server Port:'+PORT);});
}

async function main(){
  console.log('\nBingX AutoTrader Pro v5.1 - Self Learning\n');
  log('INFO','Starting...');
  if(!ENV.BINGX_API_KEY)log('WARN','BINGX_API_KEY 未設定');
  if(!ENV.TG_TOKEN)log('WARN','TELEGRAM_TOKEN 未設定');
  if(!ENV.CLAUDE_KEY)log('WARN','CLAUDE_API_KEY 未設定（/report 功能需要）');
  startServer();
  try{
    var bal=await getBalance();
    log('OK','API OK! Available:'+bal.available.toFixed(2)+'U');
    tg('🤖 BingX AutoTrader v5.1 上線!\nSelf-Learning: ON ✅\n餘額:'+bal.available.toFixed(2)+'U\n/help 查看指令');
  }catch(e){log('ERROR','API 失敗: '+e.message);tg('⚠️ Warning: '+e.message);}
  log('INFO','Starting Telegram polling...');
  tgPoll();
  scheduleReport();
  log('OK','Ready. Use Telegram /help');
}

process.on('uncaughtException',function(e){log('ERROR','Uncaught: '+e.message);tg('⚠️ 程式異常: '+e.message);});
process.on('unhandledRejection',function(e){log('ERROR','Unhandled: '+(e&&e.message?e.message:String(e)));});
main().catch(function(e){log('ERROR','Start fail: '+e.message);process.exit(1);});

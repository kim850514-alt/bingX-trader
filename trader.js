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
  strategyWeights:{MA:1.0,RSI:1.0,MACD:1.0,BB:1.0,COMBO:1.0},
  params:{fastPeriod:9,slowPeriod:21,rsiPeriod:14,oversold:30,overbought:70,bbPeriod:20,bbStdDev:2}
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
  d.total++;
  if(t.pnl>0)d.wins++;else d.losses++;
  d.pnl+=t.pnl;
  stats.allTime.total++;
  if(t.pnl>0)stats.allTime.wins++;else stats.allTime.losses++;
  stats.allTime.pnl+=t.pnl;
  stats.trades.push(Object.assign({},t,{date:todayKey()}));
  if(stats.trades.length>500)stats.trades=stats.trades.slice(-500);
  saveStats();
  learnFromTrade(t);
}
let brain=loadBrain();
function loadBrain(){
  if(fs.existsSync('./brain.json'))try{return JSON.parse(fs.readFileSync('./brain.json','utf8'));}catch(e){}
  return{
    strategyPerf:{MA:{wins:0,losses:0,pnl:0,fakeSig:0},RSI:{wins:0,losses:0,pnl:0,fakeSig:0},MACD:{wins:0,losses:0,pnl:0,fakeSig:0},BB:{wins:0,losses:0,pnl:0,fakeSig:0},COMBO:{wins:0,losses:0,pnl:0,fakeSig:0}},
    symbolPerf:{},hourPerf:{},errorPatterns:[],adjustHistory:[],marketRegime:'unknown',learnCount:0
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
  if(!brain.symbolPerf[symbol])brain.symbolPerf[symbol]={wins:0,losses:0,pnl:0};
  var syp=brain.symbolPerf[symbol];
  if(pnl>0)syp.wins++;else syp.losses++;syp.pnl+=pnl;
  var hr=String(hourTW());
  if(!brain.hourPerf[hr])brain.hourPerf[hr]={wins:0,losses:0,pnl:0};
  var hp=brain.hourPerf[hr];
  if(pnl>0)hp.wins++;else hp.losses++;hp.pnl+=pnl;
  if(pnl<0){
    sp.fakeSig++;
    brain.errorPatterns.push({symbol:symbol,strategy:strat,reason:reason,holdMin:holdMin,pnl:pnl,regime:regime,hour:hourTW(),date:todayKey()});
    if(brain.errorPatterns.length>100)brain.errorPatterns=brain.errorPatterns.slice(-100);
  }
  if(brain.learnCount%5===0)autoAdjustParams();
  if(brain.learnCount%10===0)updateWeights();
  saveBrain();
  log('AI',pnl>0?'Learn: '+strat+' '+symbol+' profit':'Learn: '+strat+' '+symbol+' loss');
}
function autoAdjustParams(){
  var recent=stats.trades.slice(-20);if(recent.length<5)return;
  var wins=recent.filter(function(t){return t.pnl>0;});
  var losses=recent.filter(function(t){return t.pnl<0;});
  var wr=wins.length/recent.length;
  var avgWin=wins.length?wins.reduce(function(s,t){return s+t.pnl;},0)/wins.length:0;
  var avgLoss=losses.length?Math.abs(losses.reduce(function(s,t){return s+t.pnl;},0)/losses.length):0;
  var rr=avgLoss>0?avgWin/avgLoss:1;
  var changes=[];
  if(wr<0.4&&cfg.stopLossPercent>1.0){var o=cfg.stopLossPercent;cfg.stopLossPercent=+(Math.max(1.0,o-0.3)).toFixed(1);changes.push('SL '+o+'->'+cfg.stopLossPercent+'%');}
  if(wr>0.65&&cfg.stopLossPercent<3.5){var o2=cfg.stopLossPercent;cfg.stopLossPercent=+(Math.min(3.5,o2+0.2)).toFixed(1);changes.push('SL '+o2+'->'+cfg.stopLossPercent+'%');}
  if(rr<1.5&&cfg.takeProfitPercent<10){var o3=cfg.takeProfitPercent;cfg.takeProfitPercent=+(Math.min(10,o3+0.5)).toFixed(1);changes.push('TP '+o3+'->'+cfg.takeProfitPercent+'%');}
  if(changes.length){
    brain.adjustHistory.push({date:todayKey(),changes:changes,wr:(wr*100).toFixed(1),rr:rr.toFixed(2)});
    if(brain.adjustHistory.length>50)brain.adjustHistory=brain.adjustHistory.slice(-50);
    log('AI','Auto adjust: '+changes.join(' | '));
    tg('Auto Adjust\n'+changes.join('\n')+'\nWR:'+(wr*100).toFixed(1)+'% RR:'+rr.toFixed(2));
  }
}
function updateWeights(){
  var changed=false;
  Object.keys(brain.strategyPerf).forEach(function(s){
    var p=brain.strategyPerf[s];var t=p.wins+p.losses;if(t<3)return;
    var wr=p.wins/t,old=cfg.strategyWeights[s]||1.0,nw=old;
    if(wr>0.6)nw=+(Math.min(2.0,old+0.1)).toFixed(2);
    if(wr<0.35)nw=+(Math.max(0.2,old-0.15)).toFixed(2);
    if(Math.abs(nw-old)>0.05){cfg.strategyWeights[s]=nw;changed=true;}
  });
  if(changed)tg('Weights Updated\n'+Object.keys(cfg.strategyWeights).map(function(k){return k+':'+cfg.strategyWeights[k];}).join('\n'));
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
  return brain.errorPatterns.filter(function(p){return p.symbol===symbol&&p.strategy===strategy&&Math.abs(p.hour-hour)<=1;}).length>=3;
}
function isBadSymbol(symbol){
  var p=brain.symbolPerf[symbol];if(!p)return false;
  var t=p.wins+p.losses;if(t<5)return false;
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
  log('INFO','Order '+o.side+' '+o.symbol+' x'+o.quantity);
  var r=await apiReq('POST','/openApi/swap/v2/trade/order',p);
  if(r.code===0){log('OK','Order OK '+o.side+' '+o.symbol);tg('Order OK\n'+(o.side==='BUY'?'LONG':'SELL')+' '+o.symbol+'\nQty:'+o.quantity);return r.data.order;}
  else{log('ERROR','Order FAIL ['+r.code+'] '+r.msg);tg('Order FAIL '+o.symbol+' ['+r.code+'] '+r.msg);return null;}
}
async function closePosAPI(sym,ps,qty){return placeOrder({symbol:sym,side:ps==='LONG'?'SELL':'BUY',positionSide:ps,quantity:qty});}
var I={
  ma:function(a,n){if(a.length<n)return null;return a.slice(-n).reduce(function(s,v){return s+v;},0)/n;},
  ema:function(a,n){if(a.length<n)return null;var k=2/(n+1);var e=a.slice(0,n).reduce(function(s,v){return s+v;},0)/n;for(var i=n;i<a.length;i++)e=a[i]*k+e*(1-k);return e;},
  rsi:function(a,n){n=n||14;if(a.length<n+1)return null;var g=0,l=0;for(var i=a.length-n;i<a.length;i++){var d=a[i]-a[i-1];if(d>0)g+=d;else l-=d;}return 100-100/(1+g/(l||0.0001));},
  macd:function(a){var self=this;if(a.length<35)return null;var f=self.ema(a,12),s=self.ema(a,26);if(!f||!s)return null;var ln=f-s;var arr=a.map(function(_,i){if(i<25)return 0;var ff=self.ema(a.slice(0,i+1),12),ss=self.ema(a.slice(0,i+1),26);return(ff&&ss)?ff-ss:0;}).slice(25);var sig=self.ema(arr,9)||0;return{line:ln,signal:sig,hist:ln-sig};},
  boll:function(a,n,d){n=n||20;d=d||2;if(a.length<n)return null;var sl=a.slice(-n),m=sl.reduce(function(s,v){return s+v;},0)/n,std=Math.sqrt(sl.reduce(function(s,v){return s+Math.pow(v-m,2);},0)/n);return{upper:m+d*std,mid:m,lower:m-d*std};},
  atr:function(h,l,c,n){n=n||14;if(c.length<n+1)return null;var tr=[];for(var i=1;i<c.length;i++)tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));return tr.slice(-n).reduce(function(s,v){return s+v;},0)/n;}
};
var openTrades={};
async function runStrategy(sym){
  if(isBadSymbol(sym)){log('AI',sym+' blacklisted');return null;}
  var kl=await getKlines(sym,cfg.timeframe,150);if(kl.length<50)return null;
  var closes=kl.map(function(k){return parseFloat(k[4]);});
  var highs=kl.map(function(k){return parseFloat(k[2]);});
  var lows=kl.map(function(k){return parseFloat(k[3]);});
  var vols=kl.map(function(k){return parseFloat(k[5]);});
  var last=closes[closes.length-1],p=cfg.params;
  var regime=detectRegime(closes);brain.marketRegime=regime;
  var strat=cfg.strategy==='AUTO'?selectBestStrategy(regime):cfg.strategy;
  var hr=hourTW();
  if(isBadPattern(sym,strat,hr)){log('AI',sym+' bad pattern skip');return null;}
  var bs=0,ss=0,rsn=[];
  if(strat==='MA'||strat==='COMBO'){var f=I.ma(closes,p.fastPeriod||9),s=I.ma(closes,p.slowPeriod||21),pf=I.ma(closes.slice(0,-1),p.fastPeriod||9),ps=I.ma(closes.slice(0,-1),p.slowPeriod||21);if(f&&s&&pf&&ps){if(pf<=ps&&f>s){bs+=2;rsn.push('MA+');}if(pf>=ps&&f<s){ss+=2;rsn.push('MA-');}}}
  if(strat==='RSI'||strat==='COMBO'){var r=I.rsi(closes,p.rsiPeriod||14),rp=I.rsi(closes.slice(0,-1),p.rsiPeriod||14);if(r&&rp){if(rp<(p.oversold||30)&&r>p.oversold){bs+=2;rsn.push('RSI-OS('+r.toFixed(0)+')');}if(rp>(p.overbought||70)&&r<p.overbought){ss+=2;rsn.push('RSI-OB('+r.toFixed(0)+')');}if(r<45)bs++;if(r>55)ss++;}}
  if(strat==='MACD'||strat==='COMBO'){var m=I.macd(closes),pm=I.macd(closes.slice(0,-1));if(m&&pm){if(pm.hist<=0&&m.hist>0){bs+=2;rsn.push('MACD+');}if(pm.hist>=0&&m.hist<0){ss+=2;rsn.push('MACD-');}}}
  if(strat==='BB'||strat==='COMBO'){var bb=I.boll(closes,p.bbPeriod||20,p.bbStdDev||2);if(bb){if(last<=bb.lower){bs+=2;rsn.push('BB-lower');}if(last>=bb.upper){ss+=2;rsn.push('BB-upper');}}}
  var av=I.ma(vols.slice(0,-1),20);if(av&&vols[vols.length-1]>av*1.5){bs++;ss++;rsn.push('VOL+');}
  var w=cfg.strategyWeights[strat]||1.0,thr=Math.max(2,Math.round(2/w));
  var signal='HOLD';if(bs>=thr||ss>=thr)signal=bs>=ss?'BUY':'SELL';
  var atrV=I.atr(highs,lows,closes)||last*0.015;
  return{signal:signal,reasons:rsn.join('+'),price:last,atrV:atrV,strat:strat,regime:regime};
}
var botTimer=null,startTime=Date.now();
async function tradingLoop(){
  if(!cfg.botRunning)return;
  log('INFO','--- Loop '+nowTW()+' ---');
  for(var i=0;i<cfg.symbols.length;i++){
    var sym=cfg.symbols[i];
    try{
      var res=await runStrategy(sym);if(!res)continue;
      var signal=res.signal,reasons=res.reasons,price=res.price,atrV=res.atrV,strat=res.strat,regime=res.regime;
      var tk=await getTicker(sym);var cur=tk?parseFloat(tk.lastPrice):price;
      log('INFO',sym+' '+cur.toFixed(4)+' ['+regime+'->'+strat+'] '+signal+(reasons?' | '+reasons:''));
      if(signal==='HOLD')continue;
      var bal=await getBalance();
      var amt=Math.min(cfg.tradeAmount,bal.available*(cfg.maxRiskPercent/100));
      if(amt<5){log('WARN',sym+' low balance');continue;}
      var qty=parseFloat((amt*cfg.leverage/cur).toFixed(5));if(qty<=0)continue;
      var slD=Math.max(atrV*cfg.atrSLMultiple,cur*cfg.stopLossPercent/100);
      var tpD=Math.max(atrV*cfg.atrTPMultiple,cur*cfg.takeProfitPercent/100);
      var slP=signal==='BUY'?+(cur-slD).toFixed(4):+(cur+slD).toFixed(4);
      var tpP=signal==='BUY'?+(cur+tpD).toFixed(4):+(cur-tpD).toFixed(4);
      var pos=await getPositions(sym);
      if(signal==='BUY'&&!pos.some(function(p){return p.positionSide==='LONG';})&&!openTrades[sym]){
        log('BUY','Long '+sym+' x'+qty);
        var o=await placeOrder({symbol:sym,side:'BUY',positionSide:'LONG',quantity:qty,stopLoss:slP,takeProfit:tpP});
        if(o)openTrades[sym]={symbol:sym,side:'LONG',entry:cur,qty:qty,sl:slP,tp:tpP,reason:reasons,strat:strat,regime:regime,openTime:Date.now()};
      }else if(signal==='SELL'&&openTrades[sym]){
        var t=openTrades[sym];
        log('SELL','Close '+sym+' entry:'+t.entry.toFixed(4)+' now:'+cur.toFixed(4));
        var ord=await closePosAPI(sym,'LONG',t.qty);
        if(ord){
          var pnl=(cur-t.entry)*t.qty*cfg.leverage-cur*t.qty*0.001;
          var holdMin=Math.round((Date.now()-t.openTime)/60000);
          recordTrade({symbol:sym,side:'LONG',entry:t.entry,exit:cur,qty:t.qty,pnl:pnl,holdMin:holdMin,reason:t.reason,strategy:t.strat,regime:t.regime,marketRegime:t.regime});
          tg((pnl>0?'PROFIT':'LOSS')+' '+sym+'\n'+t.entry.toFixed(4)+'->'+cur.toFixed(4)+'\nPnL:'+(pnl>=0?'+':'')+pnl.toFixed(2)+'U Hold:'+holdMin+'min');
          delete openTrades[sym];
        }
      }
    }catch(e){log('ERROR',sym+': '+e.message);}
  }
}
function tg(text,chatId){
  var id=chatId||ENV.TG_CHAT;if(!ENV.TG_TOKEN||!id)return;
  var body=JSON.stringify({chat_id:id,text:text,parse_mode:'HTML'});
  var req=https.request({hostname:'api.telegram.org',path:'/bot'+ENV.TG_TOKEN+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(r){var d='';r.on('data',function(c){d+=c;});});
  req.on('error',function(e){log('WARN','TG fail:'+e.message);});
  req.write(body);req.end();
}

// ═══════════════════════════════════════════════════
// TELEGRAM POLLING - 輪詢接收訊息（不需要 Webhook）
// ═══════════════════════════════════════════════════
var lastUpdateId=0;
function tgPoll(){
  if(!ENV.TG_TOKEN)return;
  var params='offset='+(lastUpdateId+1)+'&timeout=30&limit=10';
  var req=https.request({hostname:'api.telegram.org',path:'/bot'+ENV.TG_TOKEN+'/getUpdates?'+params,method:'GET',headers:{}},function(res){
    var d='';
    res.on('data',function(c){d+=c;});
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
  if(cmd==='/start'||cmd==='/help'){
    tg('BingX AutoTrader v5\nSelf-Learning Bot\n\n/go - 啟動自動交易\n/stop - 停止\n/status - 狀態\n/positions - 持倉\n/close SYMBOL - 平倉\n/set strategy AUTO\n/set tf 15m\n/set amount 50\n/set leverage 3\n/set sl 2\n/set tp 5\n/addsym SYMBOL\n/delsym SYMBOL\n/brain - 學習狀態\n/weights - 策略權重\n/errors - 錯誤模式\n/adjustments - 調參記錄\n/stats - 績效\n/history - 近10筆\n/report - AI報告',chatId);return;
  }
  if(cmd==='/go'){
    if(cfg.botRunning){tg('Already running',chatId);return;}
    cfg.botRunning=true;
    var ms={'1m':60000,'5m':300000,'15m':900000,'1h':3600000,'4h':14400000}[cfg.timeframe]||900000;
    botTimer=setInterval(tradingLoop,ms);tradingLoop();
    tg('Trading Started!\nStrategy:'+cfg.strategy+'\nTF:'+cfg.timeframe+'\nLev:'+cfg.leverage+'x\nAmt:'+cfg.tradeAmount+'U\nSL:'+cfg.stopLossPercent+'% TP:'+cfg.takeProfitPercent+'%\nSymbols:'+cfg.symbols.join(',')+'\nSelf-Learning: ON',chatId);return;
  }
  if(cmd==='/stop'){
    if(!cfg.botRunning){tg('Not running',chatId);return;}
    cfg.botRunning=false;clearInterval(botTimer);botTimer=null;tg('Stopped',chatId);return;
  }
  if(cmd==='/status'){
    getBalance().then(function(bal){
      var d=getDayStat(),all=stats.allTime;
      tg((cfg.botRunning?'RUNNING':'STOPPED')+' Uptime:'+Math.round((Date.now()-startTime)/60000)+'min\nBalance:'+bal.available.toFixed(2)+'U Total:'+bal.total.toFixed(2)+'U\nToday:'+d.total+' WR:'+(d.total>0?(d.wins/d.total*100).toFixed(0):0)+'% PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(2)+'U\nAll:'+all.total+' WR:'+(all.total>0?(all.wins/all.total*100).toFixed(0):0)+'% PnL:'+(all.pnl>=0?'+':'')+all.pnl.toFixed(2)+'U\nLearned:'+brain.learnCount+' Market:'+brain.marketRegime+'\nPositions:'+Object.keys(openTrades).length,chatId);
    }).catch(function(e){tg('Error: '+e.message,chatId);});return;
  }
  if(cmd==='/brain'){
    var sp=Object.keys(brain.strategyPerf).map(function(k){var v=brain.strategyPerf[k];var t=v.wins+v.losses;return k+':'+(t>0?(v.wins/t*100).toFixed(0):0)+'%('+t+')';});
    var sy=Object.keys(brain.symbolPerf).map(function(k){var v=brain.symbolPerf[k];var t=v.wins+v.losses;return k+':'+(t>0?(v.wins/t*100).toFixed(0):0)+'% '+(v.pnl>=0?'+':'')+v.pnl.toFixed(1)+'U';}).slice(0,5);
    tg('Brain\nLearned:'+brain.learnCount+' Errors:'+brain.errorPatterns.length+'\nMarket:'+brain.marketRegime+'\n'+sp.join(' ')+'\nSymbols:\n'+sy.join('\n'),chatId);return;
  }
  if(cmd==='/weights'){tg('Weights\n'+Object.keys(cfg.strategyWeights).map(function(k){var v=cfg.strategyWeights[k];var p=brain.strategyPerf[k]||{wins:0,losses:0};var t=p.wins+p.losses;return k+': W='+v+' WR='+(t>0?(p.wins/t*100).toFixed(0):'-')+'%';}).join('\n'),chatId);return;}
  if(cmd==='/errors'){var ep=brain.errorPatterns.slice(-10).reverse();if(!ep.length){tg('No errors',chatId);return;}tg('Last 10 Errors\n'+ep.map(function(e){return e.date+' '+e.symbol+'['+e.strategy+'] '+e.hour+'h '+e.pnl.toFixed(2)+'U';}).join('\n'),chatId);return;}
  if(cmd==='/adjustments'){var ah=brain.adjustHistory.slice(-5).reverse();if(!ah.length){tg('No history',chatId);return;}tg('Adjustments\n'+ah.map(function(a){return a.date+' WR:'+a.wr+'%\n'+a.changes.join('\n');}).join('\n\n'),chatId);return;}
  if(cmd==='/positions'){
    var keys=Object.keys(openTrades);if(!keys.length){tg('No positions',chatId);return;}
    Promise.all(keys.map(function(s){return getTicker(s).catch(function(){return null;});})).then(function(tks){
      var m='Positions\n\n';keys.forEach(function(sym,i){var t=openTrades[sym],cur=tks[i]?parseFloat(tks[i].lastPrice):t.entry,pnl=(cur-t.entry)*t.qty*cfg.leverage;m+=sym+' ['+t.strat+']\nEntry:'+t.entry.toFixed(4)+' Now:'+cur.toFixed(4)+'\nPnL:'+(pnl>=0?'+':'')+pnl.toFixed(2)+'U\n\n';});tg(m,chatId);});return;
  }
  if(cmd==='/close'){
    if(!args[0]){tg('Usage: /close BTC-USDT',chatId);return;}
    var sym2=args[0].toUpperCase();if(!openTrades[sym2]){tg('No position: '+sym2,chatId);return;}
    var t2=openTrades[sym2];
    closePosAPI(sym2,'LONG',t2.qty).then(function(o){if(o){getTicker(sym2).catch(function(){return null;}).then(function(tk){var cur=tk?parseFloat(tk.lastPrice):t2.entry,pnl=(cur-t2.entry)*t2.qty*cfg.leverage;recordTrade({symbol:sym2,side:'LONG',entry:t2.entry,exit:cur,qty:t2.qty,pnl:pnl,holdMin:Math.round((Date.now()-t2.openTime)/60000),reason:'manual',strategy:t2.strat,regime:t2.regime,marketRegime:t2.regime});delete openTrades[sym2];tg('Closed '+sym2+'\nPnL:'+(pnl>=0?'+':'')+pnl.toFixed(2)+'U',chatId);});}}).catch(function(e){tg('Close fail: '+e.message,chatId);});return;
  }
  if(cmd==='/set'){
    if(args.length<2){tg('Usage: /set KEY VALUE',chatId);return;}
    var sk=args[0].toLowerCase(),sv=args[1],nv=parseFloat(sv);
    if(sk==='strategy'){var v=sv.toUpperCase();if(['AUTO','COMBO','MA','RSI','MACD','BB','GRID'].includes(v)){cfg.strategy=v;tg('Strategy -> '+v,chatId);}else tg('Invalid',chatId);}
    else if(sk==='tf'){if(['1m','5m','15m','1h','4h'].includes(sv)){cfg.timeframe=sv;tg('TF -> '+sv,chatId);}else tg('Invalid',chatId);}
    else if(sk==='amount'&&nv>0){cfg.tradeAmount=nv;tg('Amount -> '+nv+'U',chatId);}
    else if(sk==='leverage'&&nv>=1&&nv<=20){cfg.leverage=nv;tg('Leverage -> '+nv+'x',chatId);}
    else if(sk==='sl'&&nv>0){cfg.stopLossPercent=nv;tg('SL -> '+nv+'%',chatId);}
    else if(sk==='tp'&&nv>0){cfg.takeProfitPercent=nv;tg('TP -> '+nv+'%',chatId);}
    else if(sk==='oversold'&&nv>0&&nv<50){cfg.params.oversold=nv;tg('Oversold -> '+nv,chatId);}
    else if(sk==='overbought'&&nv>50&&nv<100){cfg.params.overbought=nv;tg('Overbought -> '+nv,chatId);}
    else if(sk==='fastp'&&nv>0){cfg.params.fastPeriod=nv;tg('FastPeriod -> '+nv,chatId);}
    else if(sk==='slowp'&&nv>0){cfg.params.slowPeriod=nv;tg('SlowPeriod -> '+nv,chatId);}
    else tg('Unknown: '+sk,chatId);return;
  }
  if(cmd==='/addsym'){if(!args[0]){tg('Usage: /addsym ETH-USDT',chatId);return;}var as=args[0].toUpperCase();if(cfg.symbols.includes(as)){tg(as+' exists',chatId);return;}cfg.symbols.push(as);tg('Added '+as,chatId);return;}
  if(cmd==='/delsym'){if(!args[0]){tg('Usage: /delsym ETH-USDT',chatId);return;}cfg.symbols=cfg.symbols.filter(function(s){return s!==args[0].toUpperCase();});tg('Removed '+args[0].toUpperCase(),chatId);return;}
  if(cmd==='/stats'){
    var al=stats.allTime,dds=getDayStat();var w7='',p7=0;
    for(var i=6;i>=0;i--){var dd=new Date();dd.setDate(dd.getDate()-i);var dk=dd.toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});var ds=getDayStat(dk);p7+=ds.pnl;w7+=dk.slice(5)+':'+ds.total+'x '+(ds.pnl>=0?'+':'')+ds.pnl.toFixed(0)+'U\n';}
    tg('Stats\nToday:'+dds.total+' WR:'+(dds.total>0?(dds.wins/dds.total*100).toFixed(0):0)+'% PnL:'+(dds.pnl>=0?'+':'')+dds.pnl.toFixed(2)+'U\n7days:\n'+w7+'Total:'+p7.toFixed(2)+'U\nAll:'+al.total+' WR:'+(al.total>0?(al.wins/al.total*100).toFixed(1):0)+'% PnL:'+(al.pnl>=0?'+':'')+al.pnl.toFixed(2)+'U',chatId);return;
  }
  if(cmd==='/history'){
    var tr=stats.trades.slice(-10).reverse();if(!tr.length){tg('No trades',chatId);return;}
    tg('Last 10\n'+tr.map(function(t){return (t.pnl>=0?'WIN':'LOSS')+' '+t.symbol+'['+(t.strategy||'-')+']\n'+(t.entry||0).toFixed(4)+'->'+(t.exit||0).toFixed(4)+' '+(t.pnl>=0?'+':'')+t.pnl.toFixed(2)+'U hold:'+(t.holdMin||0)+'m';}).join('\n'),chatId);return;
  }
  if(cmd==='/report'){tg('Generating AI report...',chatId);generateReport(chatId).catch(function(e){tg('Report fail: '+e.message,chatId);});return;}
  if(text.startsWith('/'))tg('Unknown. Use /help',chatId);
}
async function callClaude(prompt){
  return new Promise(function(resolve){
    if(!ENV.CLAUDE_KEY){resolve('CLAUDE_API_KEY not set');return;}
    var body=JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:2000,messages:[{role:'user',content:prompt}]});
    var opt={hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':ENV.CLAUDE_KEY,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(body)}};
    var req=https.request(opt,function(r){var d='';r.on('data',function(c){d+=c;});r.on('end',function(){try{resolve(JSON.parse(d).content[0].text||'no response');}catch(e){resolve('parse fail');}});});
    req.on('error',function(e){resolve('fail: '+e.message);});req.setTimeout(40000,function(){req.destroy();resolve('timeout');});req.write(body);req.end();
  });
}
async function generateReport(chatId){
  var date=todayKey(),all=stats.allTime;
  var yd=new Date();yd.setDate(yd.getDate()-1);var yDate=yd.toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});var ydS=getDayStat(yDate);
  var last7=[];for(var i=6;i>=0;i--){var d=new Date();d.setDate(d.getDate()-i);var dk=d.toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei'});var ds=getDayStat(dk);last7.push(dk+':'+ds.total+'x '+(ds.pnl>=0?'+':'')+ds.pnl.toFixed(2)+'U');}
  var bal=await getBalance().catch(function(){return{available:0,total:0,unrealPnl:0};});
  var rt=stats.trades.slice(-20).map(function(t){return t.date+' '+t.symbol+'['+(t.strategy||'-')+'] '+(t.entry||0).toFixed(4)+'->'+(t.exit||0).toFixed(4)+' '+(t.pnl>=0?'+':'')+t.pnl.toFixed(2)+'U';}).join('\n');
  var prompt='Quant trading AI coach. Analyze self-learning bot. Reply in Traditional Chinese.\nSystem: '+cfg.strategy+' | '+cfg.timeframe+' | '+cfg.leverage+'x | SL:'+cfg.stopLossPercent+'% TP:'+cfg.takeProfitPercent+'%\nBalance: '+bal.available.toFixed(2)+'U\nYesterday: '+ydS.total+' WR:'+(ydS.total>0?(ydS.wins/ydS.total*100).toFixed(1):0)+'% PnL:'+(ydS.pnl>=0?'+':'')+ydS.pnl.toFixed(2)+'U\nAll: '+all.total+' WR:'+(all.total>0?(all.wins/all.total*100).toFixed(1):0)+'% PnL:'+(all.pnl>=0?'+':'')+all.pnl.toFixed(2)+'U\n7days:\n'+last7.join('\n')+'\nLearned:'+brain.learnCount+' Market:'+brain.marketRegime+'\nTrades:\n'+(rt||'none')+'\n\nProvide: 1.Summary 2.Learning 3.Strategy 4.Risk 5.Suggestions 6.Tomorrow 7.Params: stopLossPercent:X takeProfitPercent:X';
  log('AI','Calling Claude...');
  var text=await callClaude(prompt);
  stats.reports=stats.reports||[];stats.reports.push({date:date,text:text});if(stats.reports.length>30)stats.reports=stats.reports.slice(-30);saveStats();
  var target=chatId||ENV.TG_CHAT;
  var full=date+' AI Report\n---\n\n'+text;
  var idx=0;
  var sendNext=function(){if(idx>=full.length)return;tg(full.slice(idx,idx+4000),target);idx+=4000;setTimeout(sendNext,600);};
  sendNext();
  log('OK','Report sent');
}
function scheduleReport(){
  var ms10=function(){var now=new Date(),tw=new Date(now.toLocaleString('en-US',{timeZone:'Asia/Taipei'}));var n=new Date(tw);n.setHours(10,0,0,0);if(tw.getHours()>=10)n.setDate(n.getDate()+1);return n-tw;};
  var ms=ms10();log('AI','Report in '+(ms/3600000).toFixed(1)+'h (10:00 TW)');
  setTimeout(function(){generateReport();setInterval(generateReport,24*60*60*1000);},ms);
}
function startServer(){
  var PORT=process.env.PORT||3000;
  http.createServer(function(req,res){
    var body='';req.on('data',function(c){body+=c;});req.on('end',function(){
      if(req.url==='/'||req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',running:cfg.botRunning,strategy:cfg.strategy,learnCount:brain.learnCount,uptime:Math.round((Date.now()-startTime)/60000)+'min',trades:stats.allTime.total,pnl:stats.allTime.pnl.toFixed(2)}));return;}
      if(req.url==='/webhook'&&req.method==='POST'){try{handleUpdate(JSON.parse(body));}catch(e){}res.writeHead(200);res.end('ok');return;}
      res.writeHead(404);res.end('not found');
    });
  }).listen(PORT,function(){log('OK','Server Port:'+PORT);});
}
async function main(){
  console.log('\nBingX AutoTrader Pro v5.0 - Self Learning\n');
  log('INFO','Starting...');
  if(!ENV.BINGX_API_KEY)log('WARN','BINGX_API_KEY not set');
  if(!ENV.TG_TOKEN)log('WARN','TELEGRAM_TOKEN not set');
  if(!ENV.CLAUDE_KEY)log('WARN','CLAUDE_API_KEY not set');
  startServer();
  try{
    var bal=await getBalance();
    log('OK','API OK! Available:'+bal.available.toFixed(2)+'U');
    tg('BingX AutoTrader v5 Online\nSelf-Learning: ON\nBalance:'+bal.available.toFixed(2)+'U\nType /help');
  }catch(e){log('ERROR','API fail: '+e.message);tg('Warning: '+e.message);}
  log('INFO','Starting Telegram polling...');
  tgPoll();
  scheduleReport();
  log('OK','Ready. Use Telegram /help');
}
process.on('uncaughtException',function(e){log('ERROR','Uncaught: '+e.message);});
process.on('unhandledRejection',function(e){log('ERROR','Unhandled: '+e);});
main().catch(function(e){log('ERROR','Start fail: '+e.message);process.exit(1);});

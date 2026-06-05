'use strict';
const https=require('https');
const crypto=require('node:crypto');
const fs=require('fs');

// ══════════════════════════════
// 設定
// ══════════════════════════════
const OKX_KEY='657f0d79-a11c-4d65-b5b4-f75797571204';
const OKX_SECRET='AA0D51A3E8DB21654645E220C488D2FE';
const OKX_PASS='Kim850514!';
const BOT_TOKEN='8774517216:AAH5zE5UKCVJuAJ-c-Jqh17Mm4rXragTixE';
const ADMIN_TOKEN=process.env.BYBIT_TG_TOKEN||'8762136134:AAHWSUF1nkARofObdQQabkUKVqvmiv9P5uc';
const ADMIN_CHAT=process.env.TELEGRAM_CHAT_ID||'8308748755';
const DATA_FILE='/home/ubuntu/okx_bot.json';
const PORT=3003;

// ══════════════════════════════
// 工具
// ══════════════════════════════
function log(level,msg){
  console.log('['+new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})+'][OKX]['+level+'] '+msg);
}

function hourTW(){return(new Date().getUTCHours()+8)%24;}
function todayKey(){return new Date().toISOString().slice(0,10).replace(/-/g,'');}

function saveData(){
  fs.writeFileSync(DATA_FILE,JSON.stringify(botData,null,2));
}

// ══════════════════════════════
// OKX API
// ══════════════════════════════
function okxSign(timestamp,method,path,body){
  var msg=timestamp+method.toUpperCase()+path+(body||'');
  return crypto.createHmac('sha256',OKX_SECRET).update(msg).digest('base64');
}

function okxReq(method,path,params,body){
  return new Promise(function(resolve,reject){
    var timestamp=new Date().toISOString();
    var qs=params?Object.keys(params).map(function(k){return k+'='+params[k];}).join('&'):'';
    var fullPath=qs?path+'?'+qs:path;
    var bodyStr=body?JSON.stringify(body):'';
    var sig=okxSign(timestamp,method,fullPath,bodyStr);
    var opt={
      hostname:'www.okx.com',
      path:fullPath,
      method:method,
      headers:{
        'OK-ACCESS-KEY':OKX_KEY,
        'OK-ACCESS-SIGN':sig,
        'OK-ACCESS-TIMESTAMP':timestamp,
        'OK-ACCESS-PASSPHRASE':OKX_PASS,
        'Content-Type':'application/json',
        'x-simulated-trading':'0'
      }
    };
    var req=https.request(opt,function(rsp){
      var d='';rsp.on('data',function(c){d+=c;});
      rsp.on('end',function(){
        try{resolve(JSON.parse(d));}
        catch(e){reject(new Error(d.slice(0,100)));}
      });
    });
    req.on('error',function(e){setTimeout(function(){reject(e);},1000);});
    req.setTimeout(12000,function(){req.destroy();reject(new Error('Timeout'));});
    if(bodyStr)req.write(bodyStr);
    req.end();
  });
}

function okxPublic(path,params){
  return new Promise(function(resolve,reject){
    var qs=params?Object.keys(params).map(function(k){return k+'='+params[k];}).join('&'):'';
    var fullPath=qs?path+'?'+qs:path;
    var req=https.request({hostname:'www.okx.com',path:fullPath,method:'GET',headers:{'Content-Type':'application/json'}},function(rsp){
      var d='';rsp.on('data',function(c){d+=c;});
      rsp.on('end',function(){try{resolve(JSON.parse(d));}catch(e){reject(e);}});
    });
    req.on('error',reject);
    req.setTimeout(10000,function(){req.destroy();reject(new Error('Timeout'));});
    req.end();
  });
}

// ══════════════════════════════
// Telegram
// ══════════════════════════════
function tgSend(token,chatId,msg){
  return new Promise(function(resolve){
    var body=JSON.stringify({method:'sendMessage',chat_id:chatId,text:msg});
    var req=https.request({hostname:'api.telegram.org',path:'/bot'+token+'/sendMessage',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},function(res){
      var d='';res.on('data',function(c){d+=c;});res.on('end',function(){resolve();});
    });
    req.on('error',function(){resolve();});
    req.write(body);req.end();
  });
}

function tgBot(msg){return tgSend(BOT_TOKEN,ADMIN_CHAT,msg);}
function tgAdmin(msg){return tgSend(ADMIN_TOKEN,ADMIN_CHAT,msg);}

// ══════════════════════════════
// 技術指標
// ══════════════════════════════
var I={
  ema:function(a,n){
    if(a.length<n)return null;
    var k=2/(n+1),e=a.slice(0,n).reduce(function(s,v){return s+v;},0)/n;
    for(var i=n;i<a.length;i++)e=a[i]*k+e*(1-k);
    return e;
  },
  rsi:function(a,n){
    if(a.length<n+1)return null;
    var g=0,l=0;
    for(var i=a.length-n;i<a.length;i++){var d=a[i]-a[i-1];d>0?g+=d:l-=d;}
    return 100-100/(1+(g/n)/((l/n)||0.001));
  },
  atr:function(H,L,C,n){
    if(!H||!L||!C||C.length<n+1)return null;
    var t=[];
    for(var i=C.length-n;i<C.length;i++)t.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));
    return t.reduce(function(s,v){return s+v;},0)/n;
  }
};

// ══════════════════════════════
// 獵神策略（三合一）
// ══════════════════════════════
function analyzeHunterGod(closes,highs,lows,opens,vols){
  var result={signal:'NONE',score:0,details:[]};
  if(closes.length<100)return result;
  var last=closes.length-1;
  var cur=closes[last],prev=closes[last-1];
  var rsi=I.rsi(closes,14)||50;

  // 1. MACD+MA（獵人）
  var ma20=I.ema(closes,20),ma60=I.ema(closes,60);
  var fast=I.ema(closes,12),pfst=I.ema(closes.slice(0,-1),12);
  var slow=I.ema(closes,26),pslw=I.ema(closes.slice(0,-1),26);
  if(ma20&&ma60&&fast&&slow&&pfst&&pslw){
    var macd=fast-slow,pmacd=pfst-pslw;
    if(ma20>ma60&&pmacd<0&&macd>0&&rsi>48&&rsi<75){result.score+=1;result.details.push('MACD金叉');}
    if(ma20<ma60&&pmacd>0&&macd<0&&rsi<52&&rsi>25){result.score-=1;result.details.push('MACD死叉');}
    if(ma20>ma60&&macd>pmacd&&macd>0&&rsi>52)result.score+=0.5;
    if(ma20<ma60&&macd<pmacd&&macd<0&&rsi<48)result.score-=0.5;
  }

  // 2. Wyckoff（賽克斯）
  var support=Math.min.apply(null,lows.slice(-30,-1));
  var resistance=Math.max.apply(null,highs.slice(-30,-1));
  var avgVol=vols.slice(-20,-1).reduce(function(s,v){return s+v;},0)/19;
  var volSpike=vols[last]>avgVol*1.3;
  var ema50=I.ema(closes,50);
  if(lows[last-1]<support*1.001&&cur>support&&cur>prev&&volSpike&&rsi<50){result.score+=1;result.details.push('Wyckoff彈簧');}
  if(highs[last-1]>resistance*0.999&&cur<resistance&&cur<prev&&volSpike&&rsi>50){result.score-=1;result.details.push('Wyckoff推力');}
  if(cur>resistance&&prev<=resistance&&volSpike&&rsi>55&&ema50&&ema50<cur){result.score+=1;result.details.push('Wyckoff突破');}
  if(cur<support&&prev>=support&&volSpike&&rsi<45&&ema50&&ema50>cur){result.score-=1;result.details.push('Wyckoff跌破');}

  // 3. Hades EMA
  var e9=I.ema(closes,9),e20=I.ema(closes,20);
  var e50=I.ema(closes,50),e200=I.ema(closes,Math.min(200,closes.length-1));
  if(e9&&e20&&e50&&e200){
    var near50=Math.abs(cur-e50)/e50<0.008;
    if(e9>e20&&e20>e50&&cur>e9&&cur>e200&&rsi>30&&rsi<60&&near50){result.score+=1;result.details.push('Hades多頭');}
    if(e9<e20&&e20<e50&&cur<e9&&cur<e200&&rsi>40&&rsi<70&&near50){result.score-=1;result.details.push('Hades空頭');}
  }

  if(result.score>=2)result.signal='BUY';
  else if(result.score<=-2)result.signal='SELL';
  return result;
}

// ══════════════════════════════
// OKX 交易函數
// ══════════════════════════════
async function getOkxBalance(){
  try{
    var r=await okxReq('GET','/api/v5/account/balance',{ccy:'USDT'});
    if(r.code==='0'&&r.data&&r.data[0]){
      var detail=r.data[0].details.find(function(d){return d.ccy==='USDT';});
      return parseFloat(detail&&detail.availEq||0);
    }
  }catch(e){log('WARN','取餘額失敗:'+e.message);}
  return 0;
}

async function getOkxPrice(instId){
  try{
    var r=await okxPublic('/api/v5/market/ticker',{instId:instId});
    if(r.code==='0'&&r.data&&r.data[0])return parseFloat(r.data[0].last||0);
  }catch(e){}
  return 0;
}

async function getOkxKlines(instId,bar,limit){
  try{
    var r=await okxPublic('/api/v5/market/candles',{instId:instId,bar:bar||'1H',limit:limit||300});
    if(r.code==='0'&&r.data)return r.data.reverse(); // OKX返回最新在前，需要反轉
  }catch(e){}
  return[];
}

async function setOkxLeverage(instId,lev){
  try{
    await okxReq('POST','/api/v5/account/set-leverage',null,{instId:instId,lever:String(lev),mgnMode:'cross'});
  }catch(e){}
}

async function placeOkxOrder(instId,side,posSide,sz,sl,tp,lev){
  await setOkxLeverage(instId,lev||5);
  var body={
    instId:instId,
    tdMode:'cross',
    side:side.toLowerCase(), // buy/sell
    posSide:posSide.toLowerCase(), // long/short
    ordType:'market',
    sz:String(sz)
  };
  var r=await okxReq('POST','/api/v5/trade/order',null,body);
  if(r.code!=='0')throw new Error('OKX開單失敗:'+r.msg);
  var ordId=r.data&&r.data[0]&&r.data[0].ordId;
  await new Promise(function(res){setTimeout(res,1000);});

  // 掛止損
  if(sl){
    var slBody={
      instId:instId,tdMode:'cross',
      side:side==='buy'?'sell':'buy',
      posSide:posSide.toLowerCase(),
      ordType:'conditional',
      sz:String(sz),
      slTriggerPx:String(sl),
      slOrdPx:'-1', // 市價止損
      slTriggerPxType:'mark'
    };
    await okxReq('POST','/api/v5/trade/order-algo',null,slBody).catch(function(){});
  }
  // 掛止盈
  if(tp){
    var tpBody={
      instId:instId,tdMode:'cross',
      side:side==='buy'?'sell':'buy',
      posSide:posSide.toLowerCase(),
      ordType:'conditional',
      sz:String(sz),
      tpTriggerPx:String(tp),
      tpOrdPx:'-1',
      tpTriggerPxType:'mark'
    };
    await okxReq('POST','/api/v5/trade/order-algo',null,tpBody).catch(function(){});
  }
  return{ordId:ordId};
}

async function getOkxPositions(instId){
  try{
    var params=instId?{instId:instId,instType:'SWAP'}:{instType:'SWAP'};
    var r=await okxReq('GET','/api/v5/account/positions',params);
    if(r.code==='0'&&r.data)return r.data.filter(function(p){return parseFloat(p.pos||0)!==0;});
  }catch(e){}
  return[];
}

// OKX幣種格式：BTC-USDT-SWAP
function toOkxInstId(sym){
  // BTC-USDT → BTC-USDT-SWAP
  if(sym.endsWith('-SWAP'))return sym;
  return sym.replace('-USDT','')+'-USDT-SWAP';
}

async function getTop200OkxSymbols(){
  try{
    var r=await okxPublic('/api/v5/market/tickers',{instType:'SWAP'});
    if(r.code==='0'&&r.data){
      var blacklist=['NCSK','NCSI','NCCO','BABYSHARK','HOOLI','XAU','GOLD','SPX'];
      var syms=r.data.filter(function(s){
        if(!s.instId||!s.instId.endsWith('-USDT-SWAP'))return false;
        var name=s.instId.replace('-USDT-SWAP','');
        return !blacklist.some(function(b){return name.startsWith(b);});
      });
      syms.sort(function(a,b){return parseFloat(b.volCcy24h||0)-parseFloat(a.volCcy24h||0);});
      return syms.slice(0,200).map(function(s){return s.instId;});
    }
  }catch(e){log('WARN','取OKX前200失敗:'+e.message);}
  return['BTC-USDT-SWAP','ETH-USDT-SWAP','SOL-USDT-SWAP','XRP-USDT-SWAP','DOGE-USDT-SWAP'];
}

// ══════════════════════════════
// Bot資料
// ══════════════════════════════
function initData(){
  if(fs.existsSync(DATA_FILE)){
    try{return JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));}catch(e){}
  }
  return{
    running:true,
    amount:1,lev:5,
    allowShort:true,
    symbols:[],
    openTrades:{},
    slCooldown:{},
    closedTrades:{},
    stats:{capital:50,allTime:{total:0,wins:0,losses:0,pnl:0},daily:{},trades:[]}
  };
}
var botData=initData();

function isFlipMode(){return botData.stats.capital>=100;}
function getLev(){return isFlipMode()?100:5;}

function recordTrade(sym,pnl,holdMin){
  var today=todayKey();
  if(!botData.stats.daily[today])botData.stats.daily[today]={total:0,wins:0,losses:0,pnl:0};
  var d=botData.stats.daily[today];
  d.total++;if(pnl>0)d.wins++;else d.losses++;d.pnl+=pnl;
  botData.stats.allTime.total++;
  if(pnl>0)botData.stats.allTime.wins++;else botData.stats.allTime.losses++;
  botData.stats.allTime.pnl+=pnl;
  botData.stats.capital+=pnl;
  botData.stats.trades.push({sym:sym,pnl:pnl,holdMin:holdMin,date:today});
  if(botData.stats.trades.length>500)botData.stats.trades=botData.stats.trades.slice(-500);
  saveData();
}
// ══════════════════════════════
// 主交易循環
// ══════════════════════════════
async function tradingLoop(){
  while(true){
    try{
      if(!botData.running){await new Promise(function(r){setTimeout(r,30000);});continue;}
      var h=hourTW();
      if(h>=2&&h<6){await new Promise(function(r){setTimeout(r,60000);});continue;}

      var today=todayKey();
      var todayPnl=(botData.stats.daily[today]&&botData.stats.daily[today].pnl)||0;
      if(todayPnl<-botData.stats.capital*0.05){
        log('INFO','今日虧損達上限停止開單');
        await new Promise(function(r){setTimeout(r,300000);});continue;
      }

      if(!botData.symbols||botData.symbols.length===0){
        log('INFO','初始化OKX前200幣種...');
        botData.symbols=await getTop200OkxSymbols();
        saveData();
      }

      var balance=await getOkxBalance();
      var lev=getLev();
      var amt=1;

      for(var si=0;si<botData.symbols.length;si++){
        var instId=botData.symbols[si];
        if(Object.keys(botData.openTrades).length>=5)break;
        if(!botData.running)break;

        var hasPos=Object.keys(botData.openTrades).some(function(k){return k.indexOf(instId)===0;});
        if(hasPos)continue;

        if(botData.slCooldown[instId]&&Date.now()-botData.slCooldown[instId]<3600000)continue;

        var kl=await getOkxKlines(instId,'1H',300);
        if(!kl||kl.length<100)continue;

        // OKX K線格式：[timestamp,open,high,low,close,vol,...]
        var closes=kl.map(function(k){return parseFloat(k[4]||0);});
        var highs=kl.map(function(k){return parseFloat(k[2]||0);});
        var lows_=kl.map(function(k){return parseFloat(k[3]||0);});
        var opens=kl.map(function(k){return parseFloat(k[1]||0);});
        var vols=kl.map(function(k){return parseFloat(k[5]||0);});

        var sig=analyzeHunterGod(closes,highs,lows_,opens,vols);
        if(sig.signal==='NONE')continue;
        if(Math.abs(sig.score)<2)continue;

        var longCount=Object.values(botData.openTrades).filter(function(t){return t.side==='long';}).length;
        var shortCount=Object.values(botData.openTrades).filter(function(t){return t.side==='short';}).length;
        if(sig.signal==='BUY'&&longCount>=3)continue;
        if(sig.signal==='SELL'&&shortCount>=3)continue;
        if(sig.signal==='SELL'&&!botData.allowShort)continue;
        if(balance<amt)continue;

        var cur=closes[closes.length-1];
        var atrV=I.atr(highs,lows_,closes,14)||cur*0.02;
        var posSide=sig.signal==='BUY'?'long':'short';
        var orderSide=sig.signal==='BUY'?'buy':'sell';
        var slDist=isFlipMode()?cur*0.009:Math.max(atrV*3,cur*0.015);
        var slP=sig.signal==='BUY'?+(cur-slDist).toFixed(6):+(cur+slDist).toFixed(6);
        var tp1=sig.signal==='BUY'?+(cur+slDist).toFixed(6):+(cur-slDist).toFixed(6);
        var tp2=sig.signal==='BUY'?+(cur+slDist*2).toFixed(6):+(cur-slDist*2).toFixed(6);
        var tp3=sig.signal==='BUY'?+(cur+slDist*3).toFixed(6):+(cur-slDist*3).toFixed(6);

        // 計算下單數量（OKX用張數）
        var notional=amt*lev;
        var sz=parseFloat((notional/cur).toFixed(1));
        if(sz<=0)sz=parseFloat((notional/cur).toFixed(2));
        if(sz<=0)sz=0.01;
try{
          var lo=await placeOkxOrder(instId,orderSide,posSide,sz,slP,tp1,lev);
          var tradeKey=instId+'_'+(sig.signal==='BUY'?'L':'S');
          botData.openTrades[tradeKey]={
            instId:instId,side:posSide,
            entry:cur,sz:sz,
            openTime:Date.now(),
            stopLoss:slP,takeProfit:tp1,
            tp2:tp2,tp3:tp3,tpPhase:1,
            trailLevel:0,slDist:slDist
          };
          balance-=amt;
          saveData();

          var msg='🏹 獵神(OKX) 開倉\n';
          msg+=(sig.signal==='BUY'?'🟢 多單':'🔴 空單')+' '+instId+'\n';
          msg+='━━━━━━━━━━━━━━━\n';
          msg+='📐 策略: 獵神三合一\n';
          msg+='💪 分數: '+sig.score.toFixed(1)+'/3\n';
          msg+='📊 訊號: '+sig.details.join(' | ')+'\n';
          msg+='━━━━━━━━━━━━━━━\n';
          msg+='💰 入場: '+cur+'\n';
          msg+='🛑 止損: '+slP+'\n';
          msg+='🎯 TP1: '+tp1+'\n';
          msg+='🎯 TP2: '+tp2+'\n';
          msg+='🎯 TP3: '+tp3+'\n';
          msg+='📦 '+amt+'U × '+lev+'x\n';
          msg+='💼 本金: '+botData.stats.capital.toFixed(2)+'U '+(isFlipMode()?'⚡翻倉':'📊正常');
          tgBot(msg);
          log('INFO',instId+' 開倉 '+sig.signal+' score:'+sig.score);
        }catch(e){
          log('ERROR',instId+' 開單失敗: '+e.message);
        }
        await new Promise(function(r){setTimeout(r,2000);});
      }
    }catch(e){log('ERROR','tradingLoop: '+e.message);}
    await new Promise(function(r){setTimeout(r,60000);});
  }
}
// ══════════════════════════════
// 持倉監控
// ══════════════════════════════
async function checkPositions(){
  while(true){
    try{
      var keys=Object.keys(botData.openTrades);
      for(var ki=0;ki<keys.length;ki++){
        var key=keys[ki];
        if(!botData.openTrades[key])continue;
        var t=botData.openTrades[key];
        if(!t||!t.instId)continue;

        try{
          var pos=await getOkxPositions(t.instId);
          var stillOpen=pos.some(function(p){return p.posSide===t.side&&parseFloat(p.pos||0)!==0;});
          var holdMin=Math.round((Date.now()-t.openTime)/60000);
          var cur=await getOkxPrice(t.instId);
          if(!cur)continue;
          var estPct=t.side==='long'?(cur-t.entry)/t.entry*100:(t.entry-cur)/t.entry*100;
          log('INFO',t.instId+' '+(estPct>=0?'+':'')+estPct.toFixed(2)+'% Hold:'+holdMin+'min');

          // 移動止損
          if(estPct>0.2&&!isFlipMode()){
            var newLevel=Math.floor(estPct/5);
            if(!t.trailLevel)t.trailLevel=0;
            if(newLevel>t.trailLevel&&newLevel>=1){
              t.trailLevel=newLevel;
              var lockPct=Math.max(0,(newLevel-1)*5+2);
              var newSl=t.side==='long'?+(t.entry*(1+lockPct/100)).toFixed(6):+(t.entry*(1-lockPct/100)).toFixed(6);
              t.stopLoss=newSl;
              saveData();
              tgBot('🏹 獵神(OKX) 移動止損\n'+t.instId+'\n獲利:+'+estPct.toFixed(1)+'%\n新止損:'+newSl+(lockPct===0?' (保本)':' (+'+lockPct+'%)'));
            }
          }
// 已平倉
          if(!stillOpen&&holdMin>1){
            var closeId=t.instId+'_'+t.openTime;
            if(botData.closedTrades[closeId]){delete botData.openTrades[key];saveData();continue;}
            botData.closedTrades[closeId]=Date.now();
            var cks=Object.keys(botData.closedTrades);
            if(cks.length>200)delete botData.closedTrades[cks[0]];

            // 計算PnL
            var pnl=t.side==='long'?(cur-t.entry)*t.sz:(t.entry-cur)*t.sz;
            pnl=parseFloat(pnl.toFixed(4));

            var sym=t.instId,hold=holdMin;
            delete botData.openTrades[key];
            recordTrade(sym,pnl,hold);

            var pnlStr=(pnl>=0?'+':'')+pnl.toFixed(4)+'U';
            tgBot('🏹 獵神(OKX) '+(pnl>=0?'✅':'❌')+'\n'+sym+' PnL:'+pnlStr+' Hold:'+hold+'min\n本金:'+botData.stats.capital.toFixed(2)+'U');
            if(pnl<0){botData.slCooldown[sym]=Date.now();saveData();}
            log('INFO',sym+' 平倉 PnL:'+pnlStr);
            tgAdmin('🏹 OKX獵神 '+(pnl>=0?'✅':'❌')+' '+sym+' PnL:'+pnlStr);
          }
        }catch(e){log('ERROR','checkPos '+t.instId+': '+e.message);}
      }
    }catch(e){log('ERROR','checkPositions: '+e.message);}
    await new Promise(function(r){setTimeout(r,30000);});
  }
}

// ══════════════════════════════
// Telegram指令
// ══════════════════════════════
async function handleCmd(text){
  var parts=text.trim().split(/\s+/);
  var cmd=parts[0].toLowerCase();
  if(cmd==='/help'||cmd==='/start'){
    tgBot('🏹 獵神(OKX)\n\n/status - 狀態\n/positions - 持倉\n/go - 啟動\n/stop - 停止\n/scan - 掃前200幣種\n/sync - 同步持倉\n/capital - 本金');
    return;
  }
  if(cmd==='/go'){botData.running=true;saveData();tgBot('🏹 OKX獵神啟動！');}
  if(cmd==='/stop'){botData.running=false;saveData();tgBot('🏹 OKX獵神停止');}
  if(cmd==='/capital'){
    tgBot('💰 OKX獵神本金: '+botData.stats.capital.toFixed(2)+'U\n'+(isFlipMode()?'⚡翻倉(100x)':'📊正常(5x)'));
  }
  if(cmd==='/status'){
    var at=botData.stats.allTime;
    var wr=at.total>0?(at.wins/at.total*100).toFixed(1):0;
    var today=todayKey();
    var d=botData.stats.daily[today]||{total:0,wins:0,pnl:0};
    tgBot('🏹 OKX獵神狀態\n本金:'+botData.stats.capital.toFixed(2)+'U '+(isFlipMode()?'⚡翻倉':'📊正常')+'\n今日:'+d.total+'筆 WR:'+(d.total>0?(d.wins/d.total*100).toFixed(0):0)+'% PnL:'+(d.pnl>=0?'+':'')+d.pnl.toFixed(4)+'U\n總計:'+at.total+'筆 WR:'+wr+'%\n持倉:'+Object.keys(botData.openTrades).length+'/5\n幣種:'+botData.symbols.length+'個');
  }
if(cmd==='/positions'){
    var ks=Object.keys(botData.openTrades);
    if(ks.length===0){tgBot('🏹 OKX目前無持倉');return;}
    var msg='🏹 OKX持倉:\n';
    ks.forEach(function(k){var t=botData.openTrades[k];msg+=(t.side==='long'?'🟢':'🔴')+' '+t.instId+' entry:'+t.entry+'\n';});
    tgBot(msg);
  }
  if(cmd==='/scan'){
    tgBot('🔍 掃描OKX前200幣種...');
    botData.symbols=await getTop200OkxSymbols();
    saveData();
    tgBot('✅ 已更新'+botData.symbols.length+'個幣種');
  }
  if(cmd==='/sync'){
    var pos=await getOkxPositions();
    botData.openTrades={};
    pos.forEach(function(p){
      var instId=p.instId;
      var side=p.posSide;
      var sz=Math.abs(parseFloat(p.pos||0));
      var entry=parseFloat(p.avgPx||0);
      var key=instId+'_'+(side==='long'?'L':'S');
      botData.openTrades[key]={instId:instId,side:side,entry:entry,sz:sz,openTime:Date.now()-3600000,stopLoss:0,takeProfit:0,trailLevel:0,tpPhase:1};
    });
    saveData();
    tgBot('✅ OKX持倉同步完成！'+pos.length+'個持倉');
  }
}
// ══════════════════════════════
// Telegram Polling
// ══════════════════════════════
var tgOffset=0;
async function tgPoll(){
  while(true){
    try{
      var r=await new Promise(function(resolve){
        var req=https.request({hostname:'api.telegram.org',path:'/bot'+BOT_TOKEN+'/getUpdates?offset='+tgOffset+'&timeout=30',method:'GET'},function(res){
          var d='';res.on('data',function(c){d+=c;});
          res.on('end',function(){try{resolve(JSON.parse(d));}catch(e){resolve({ok:false});}});
        });
        req.on('error',function(){resolve({ok:false});});
        req.setTimeout(35000,function(){req.destroy();resolve({ok:false});});
        req.end();
      });
      if(r.ok&&r.result&&r.result.length>0){
        for(var update of r.result){
          tgOffset=update.update_id+1;
          if(update.message&&update.message.text&&update.message.text.startsWith('/')){
            await handleCmd(update.message.text).catch(function(){});
          }
        }
      }
    }catch(e){}
    await new Promise(function(r){setTimeout(r,1000);});
  }
}

// ══════════════════════════════
// HTTP Server
// ══════════════════════════════
const http=require('http');
http.createServer(function(req,res){res.end('OKX Hunter OK');}).listen(PORT);

// ══════════════════════════════
// 啟動
// ══════════════════════════════
async function main(){
  log('INFO','OKX獵神啟動');
  if(!botData.symbols||botData.symbols.length===0){
    botData.symbols=await getTop200OkxSymbols().catch(function(){return[];});
    saveData();
    log('INFO','載入'+botData.symbols.length+'個OKX幣種');
  }
  // 同步持倉
  setTimeout(async function(){
    try{
      var pos=await getOkxPositions();
      if(pos.length>0){
        botData.openTrades={};
        pos.forEach(function(p){
          var key=p.instId+'_'+(p.posSide==='long'?'L':'S');
          botData.openTrades[key]={instId:p.instId,side:p.posSide,entry:parseFloat(p.avgPx||0),sz:Math.abs(parseFloat(p.pos||0)),openTime:Date.now()-3600000,stopLoss:0,takeProfit:0,trailLevel:0,tpPhase:1};
        });
        saveData();
      }
      tgAdmin('🏹 OKX獵神啟動！本金:'+botData.stats.capital.toFixed(2)+'U 幣種:'+botData.symbols.length+'個 持倉:'+pos.length+'個\n'+(isFlipMode()?'⚡翻倉(100x)':'📊正常(5x)'));
    }catch(e){log('WARN','啟動同步失敗:'+e.message);}
  },5000);
  tgPoll();
  tradingLoop();
  checkPositions();
  log('INFO','OKX獵神就緒 Port:'+PORT);
}

main().catch(function(e){log('ERROR','啟動失敗:'+e.message);process.exit(1);});
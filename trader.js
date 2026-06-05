'use strict';
const crypto = require('node:crypto');
const https  = require('https');
const fs     = require('fs');

// ══════════════════════════════════
// 系統設定
// ══════════════════════════════════
const BOT_TOKEN  = process.env.BOT_TOKEN  || '8760052481:AAHo8XWWwgkBJ9a2KuIOCcJJpUGBFQPTwwk';
const CHAT_ID    = process.env.CHAT_ID    || '8308748755';
const BX_KEY     = process.env.BX_APIKEY || 'IDrcq954PuXoImAK1U4MEC9sI9HLK2B9PSuctuib9u7maCsZdAMRp7u99uHrPfeErNxDBA4SoOYC54DLfKHQ';
const BX_SECRET  = process.env.BX_SECRET || 'NqpQkRZMwqhzKVcxiC5gECYSGgrZoVhyRKisWBxkQEVsIBxu4iEdtMjCEX174eHFcAfzHT3x9biX8XtcjeJIQ';
const STATS_FILE = '/home/ubuntu/breakout_stats.json';

// ══════════════════════════════════
// 系統參數
// ══════════════════════════════════
const INITIAL_CAPITAL   = 50;
const ORDER_AMT         = 1;
const MAX_POSITIONS     = 5;
const LEVERAGE          = 5;
const MAX_LOSS_PCT      = 0.01;
const MAX_LOSS_MARGIN   = 0.90;
const TP1_RR            = 1.0;
const TP2_RR            = 2.0;
const TP3_RR            = 3.0;
const TP_RATIO          = 1/3;
const FLIP_WIN_RATE     = 0.60;
const FLIP_CAPITAL      = 100;
const FLIP_OFF_WIN_RATE = 0.40;
const TOP_N_SYMBOLS     = 200;
const TF                = '1h';
const SCAN_INTERVAL_MS  = 60000;
const TIME_BLOCK_START  = 2;
const TIME_BLOCK_END    = 6;

// ══════════════════════════════════
// 狀態
// ══════════════════════════════════
let stats     = loadStats();
let positions = {};
let lastCandle= {};
let scanning  = false;
var memLog    = [];

// ══════════════════════════════════
// 持久化
// ══════════════════════════════════
function loadStats() {
  if (fs.existsSync(STATS_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch(e) {}
  }
  return { capital: INITIAL_CAPITAL, total: 0, wins: 0, losses: 0, pnl: 0, flipMode: false, trades: [], symbolPerf: {}, hourPerf: {} };
}
function saveStats() { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); }

// ══════════════════════════════════
// 工具
// ══════════════════════════════════
function nowTW()  { return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }); }
function hourTW() { return parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false })); }
function log(lv, msg) {
  var line = '[' + nowTW() + '][' + lv + '] ' + msg;
  console.log(line);
  memLog.push({ ts: nowTW(), lv: lv, msg: msg });
  if (memLog.length > 300) memLog.shift();
}
function winRate() { return stats.total === 0 ? 0 : stats.wins / stats.total; }
function fmt(n) { if (!n) return '0'; if (n >= 1000) return n.toFixed(2); if (n >= 1) return n.toFixed(3); return n.toFixed(4); }
function stars(n) { return '⭐'.repeat(n) + '☆'.repeat(5 - n); }

function calcStrength(sykes, breakout) {
  var score = 0;
  if (sykes.volRatio >= 2.0) score += 2;
  else if (sykes.volRatio >= 1.5) score += 1;
  if (sykes.wyckoff !== 0) score += 1;
  var spread = Math.abs(breakout.ema9 - breakout.ema20) / breakout.ema200;
  if (spread < 0.01) score += 1;
  var ref = breakout.bullBreak ? breakout.structHigh : breakout.structLow;
  var breakPct = Math.abs(breakout.prevClose - ref) / breakout.curClose;
  if (breakPct > 0.005) score += 1;
  return Math.min(score, 5);
}

// ══════════════════════════════════
// Telegram 發送
// ══════════════════════════════════
function tg(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;
  var body = JSON.stringify({ chat_id: CHAT_ID, text: text, parse_mode: 'Markdown' });
  var req = https.request({
    hostname: 'api.telegram.org',
    path: '/bot' + BOT_TOKEN + '/sendMessage',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, function(res) {
    var d = '';
    res.on('data', function(c) { d += c; });
    res.on('end', function() {
      try { var r = JSON.parse(d); if (!r.ok) log('WARN', 'TG錯誤: ' + d.slice(0, 100)); } catch(e) {}
    });
  });
  req.on('error', function(e) { log('WARN', 'TG send: ' + e.message); });
  req.write(body);
  req.end();
}

// ══════════════════════════════════
// Telegram 輪詢（callback遞迴，穩定版）
// ══════════════════════════════════
var lastUpdateId = 0;
function tgPoll() {
  if (!BOT_TOKEN) return;
  var req = https.request({
    hostname: 'api.telegram.org',
    path: '/bot' + BOT_TOKEN + '/getUpdates?offset=' + (lastUpdateId + 1) + '&timeout=30&limit=10',
    method: 'GET'
  }, function(res) {
    var d = '';
    res.on('data', function(c) { d += c; });
    res.on('end', function() {
      try {
        var json = JSON.parse(d);
        if (json.ok && json.result && json.result.length > 0) {
          json.result.forEach(function(u) {
            if (u.update_id > lastUpdateId) lastUpdateId = u.update_id;
            handleUpdate(u);
          });
        }
      } catch(e) {}
      setTimeout(tgPoll, 1000);
    });
  });
  req.on('error', function(e) { log('WARN', 'TG poll: ' + e.message); setTimeout(tgPoll, 5000); });
  req.setTimeout(35000, function() { req.destroy(); setTimeout(tgPoll, 1000); });
  req.end();
}

// ══════════════════════════════════
// Telegram 指令處理
// ══════════════════════════════════
function handleUpdate(update) {
  var msg = update.message || update.edited_message;
  if (!msg) return;
  var chatId = String(msg.chat.id);
  var text   = (msg.text || '').trim();
  log('INFO', 'TG收到 chatId=' + chatId + ' text=' + text);

  if (text === '/help' || text === '/start') {
    tg(
      '🚀 *突破系統指令*\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '/status    📊 系統狀態\n' +
      '/positions 📋 詳細持倉\n' +
      '/stats     🧠 AI學習統計\n' +
      '/log       📝 最近日誌\n' +
      '/sync      🔄 同步持倉\n' +
      '/closeall  ❌ 全部平倉\n' +
      '/help      📖 指令說明\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '*自動通知*\n' +
      '🚀 開倉（進場強度/止損/止盈）\n' +
      '🎯 TP1/TP2/TP3 達成\n' +
      '✅❌ 結單（含真實PnL）\n' +
      '🔓🔒 翻倉模式開關\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '*翻倉條件*\n' +
      '開啟: 勝率≥60% + 資金≥100U\n' +
      '關閉: 勝率<40%'
    );
    return;
  }

  if (text === '/status') {
    var posLines = Object.keys(positions).map(function(s) {
      var p = positions[s];
      return '  ' + (p.side === 'LONG' ? '📈' : '📉') + ' ' + s + ' @' + fmt(p.entryPrice);
    }).join('\n') || '  (無持倉)';
    tg(
      '📊 *突破系統狀態*\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '資金: ' + stats.capital.toFixed(2) + 'U\n' +
      '總PnL: ' + (stats.pnl >= 0 ? '+' : '') + stats.pnl.toFixed(4) + 'U\n' +
      '勝率: ' + (winRate()*100).toFixed(1) + '% (' + stats.wins + '勝/' + stats.losses + '敗)\n' +
      '翻倉: ' + (stats.flipMode ? '✅全倉' : '❌逐倉') + '\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '持倉 ' + Object.keys(positions).length + '/' + MAX_POSITIONS + ':\n' + posLines
    );
    return;
  }

  if (text === '/positions') {
    if (Object.keys(positions).length === 0) { tg('📋 目前無持倉'); return; }
    Object.keys(positions).forEach(function(sym) {
      var p = positions[sym];
      var holdMin = Math.round((Date.now() - p.openTime) / 60000);
      tg(
        '📋 *' + sym + '*\n' +
        '方向: ' + (p.side === 'LONG' ? '做多 📈' : '做空 📉') + '\n' +
        '進場: ' + fmt(p.entryPrice) + '\n' +
        '止損: ' + (p.sl > 0 ? fmt(p.sl) : '未設定') + '\n' +
        'TP1: ' + (p.tp1 > 0 ? fmt(p.tp1) : '未設定') + ' ' + (p.tp1Done ? '✅' : '⏳') + '\n' +
        'TP2: ' + (p.tp2 > 0 ? fmt(p.tp2) : '未設定') + ' ' + (p.tp2Done ? '✅' : '⏳') + '\n' +
        'TP3: ' + (p.tp3 > 0 ? fmt(p.tp3) : '未設定') + ' ⏳\n' +
        '持倉: ' + holdMin + '分鐘\n' +
        '模式: ' + (p.flipMode ? '全倉' : '逐倉')
      );
    });
    return;
  }

  if (text === '/log') {
    var recent = memLog.slice(-15);
    tg('📝 *最近日誌*\n' + recent.map(function(l) { return '[' + l.lv + '] ' + l.msg; }).join('\n'));
    return;
  }

  if (text === '/sync') {
    syncPositions().then(function() {
      tg('✅ 持倉已同步\n目前: ' + Object.keys(positions).length + '個');
    });
    return;
  }

  if (text === '/closeall') {
    if (Object.keys(positions).length === 0) { tg('目前無持倉'); return; }
    var syms = Object.keys(positions);
    var doClose = function(i) {
      if (i >= syms.length) { tg('✅ 全部持倉已平'); return; }
      var sym = syms[i];
      var pos = positions[sym];
      bxReq('GET', '/openApi/swap/v2/user/positions', { symbol: sym }).then(function(r2) {
        if (r2.code === 0 && r2.data) {
          var ap = r2.data.find(function(p) { return Math.abs(parseFloat(p.positionAmt || 0)) > 0; });
          if (ap) {
            var qty = Math.abs(parseFloat(ap.positionAmt));
            return bxReq('POST', '/openApi/swap/v2/trade/order', {
              symbol: sym, side: pos.side === 'LONG' ? 'SELL' : 'BUY',
              positionSide: pos.side, type: 'MARKET', quantity: String(qty)
            }).then(function() { return onPositionClosed(sym, pos, '手動全平'); });
          }
        }
      }).catch(function(e) { log('ERROR', '平倉失敗 ' + sym + ': ' + e.message); })
        .then(function() { doClose(i + 1); });
    };
    doClose(0);
    return;
  }

  if (text === '/stats') {
    var top = Object.entries(stats.symbolPerf)
      .filter(function(e) { return e[1].total >= 3; })
      .sort(function(a, b) { return b[1].pnl - a[1].pnl; })
      .slice(0, 5)
      .map(function(e) { return '  ' + e[0] + ': ' + e[1].wins + '/' + e[1].total + ' ' + (e[1].pnl >= 0 ? '+' : '') + e[1].pnl.toFixed(2) + 'U'; })
      .join('\n');
    var worst = Object.entries(stats.symbolPerf)
      .filter(function(e) { return e[1].total >= 3; })
      .sort(function(a, b) { return a[1].pnl - b[1].pnl; })
      .slice(0, 3)
      .map(function(e) { return '  ' + e[0] + ': ' + e[1].wins + '/' + e[1].total + ' ' + e[1].pnl.toFixed(2) + 'U'; })
      .join('\n');
    tg(
      '🧠 *AI學習統計*\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '總交易: ' + stats.total + ' | 勝率: ' + (winRate()*100).toFixed(1) + '%\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '🏆 最佳:\n' + (top || '  資料不足') + '\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '⚠️ 最差:\n' + (worst || '  資料不足')
    );
    return;
  }

  if (text.startsWith('/')) {
    tg('未知指令，輸入 /help 查看');
  }
}

// ══════════════════════════════════
// BingX API
// ══════════════════════════════════
function bxReq(method, path, params) {
  params = params || {};
  return new Promise(function(resolve, reject) {
    var p = Object.assign({}, params, { timestamp: Date.now() });
    var qs = Object.keys(p).filter(function(k) { return p[k] != null && p[k] !== ''; }).map(function(k) { return k + '=' + p[k]; }).join('&');
    var sig = crypto.createHmac('sha256', BX_SECRET).update(qs).digest('hex');
    var q = qs + '&signature=' + sig;
    var opt = {
      hostname: 'open-api.bingx.com',
      path: path + '?' + q,
      method: method,
      headers: { 'X-BX-APIKEY': BX_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }
    };
    var req = https.request(opt, function(rsp) {
      var d = '';
      rsp.on('data', function(c) { d += c; });
      rsp.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.slice(0,100))); } });
    });
    req.on('error', function(e) { setTimeout(function() { reject(e); }, 1000); });
    req.setTimeout(12000, function() { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function bxPublic(path, params) {
  return new Promise(function(resolve, reject) {
    var qs = params ? Object.keys(params).map(function(k) { return k + '=' + params[k]; }).join('&') : '';
    var fullPath = qs ? path + '?' + qs : path;
    var req = https.request({ hostname: 'open-api.bingx.com', path: fullPath, method: 'GET' }, function(rsp) {
      var d = '';
      rsp.on('data', function(c) { d += c; });
      rsp.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, function() { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ══════════════════════════════════
// 取得前N交易量幣種
// ══════════════════════════════════
async function getTopSymbols() {
  try {
    var r = await bxPublic('/openApi/swap/v2/quote/ticker');
    if (r.code !== 0 || !Array.isArray(r.data)) return [];
    return r.data
      .filter(function(t) { return t.symbol && t.symbol.endsWith('-USDT'); })
      .sort(function(a, b) { return parseFloat(b.quoteVolume || 0) - parseFloat(a.quoteVolume || 0); })
      .slice(0, TOP_N_SYMBOLS)
      .map(function(t) { return t.symbol; });
  } catch(e) { log('ERROR', '取得幣種失敗: ' + e.message); return []; }
}

async function getKlines(symbol, tf, limit) {
  limit = limit || 210;
  try {
    var r = await bxReq('GET', '/openApi/swap/v2/quote/klines', { symbol: symbol, interval: tf, limit: limit });
    if (r.code === 0 && Array.isArray(r.data)) return r.data;
  } catch(e) {}
  return [];
}

// ══════════════════════════════════
// 技術指標
// ══════════════════════════════════
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  var k = 2 / (period + 1);
  var ema = closes.slice(0, period).reduce(function(s, v) { return s + v; }, 0) / period;
  for (var i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcATR(highs, lows, closes, n) {
  n = n || 14;
  if (highs.length < n + 1) return null;
  var trs = [];
  for (var i = 1; i < highs.length; i++) trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  if (trs.length < n) return null;
  return trs.slice(-n).reduce(function(s, v) { return s + v; }, 0) / n;
}

// ══════════════════════════════════
// 賽克斯（Wyckoff + 量能）
// ══════════════════════════════════
function calcSykes(klines) {
  if (klines.length < 50) return null;
  var closes = klines.map(function(k) { return parseFloat(k[4]); });
  var highs   = klines.map(function(k) { return parseFloat(k[2]); });
  var lows    = klines.map(function(k) { return parseFloat(k[3]); });
  var vols    = klines.map(function(k) { return parseFloat(k[5]); });
  var opens   = klines.map(function(k) { return parseFloat(k[1]); });
  var last    = closes.length - 1;
  var volMA   = vols.slice(-20).reduce(function(s,v){return s+v;},0) / 20;
  var curVol  = vols[last];
  var volRatio= curVol / volMA;
  var isUp    = closes[last] > opens[last];
  var volScore= isUp ? volRatio : -volRatio;
  var lb      = Math.min(50, closes.length);
  var sHigh   = Math.max.apply(null, highs.slice(-lb));
  var sLow    = Math.min.apply(null, lows.slice(-lb));
  var range   = sHigh - sLow;
  if (range === 0) return null;
  var posInRange = (closes[last] - sLow) / range;
  var nearBottom = posInRange < 0.3;
  var nearTop    = posInRange > 0.7;
  var prevLow5   = Math.min.apply(null, lows.slice(-6, -1));
  var prevHigh5  = Math.max.apply(null, highs.slice(-6, -1));
  var springTest = lows[last] <= prevLow5 * 1.002;
  var utadTest   = highs[last] >= prevHigh5 * 0.998;
  var rebound    = closes[last] > opens[last];
  var rejection  = closes[last] < opens[last];
  var volExp     = curVol > volMA * 1.2;
  var wyckoff    = 0;
  if (nearBottom && springTest && rebound && volExp)   wyckoff =  1;
  else if (nearTop && utadTest && rejection && volExp) wyckoff = -1;
  var sykesValue = volScore * (1 + Math.abs(wyckoff));
  return { value: sykesValue, wyckoff: wyckoff, volRatio: volRatio, posInRange: posInRange, longSignal: wyckoff === 1 && sykesValue > 0, shortSignal: wyckoff === -1 && sykesValue < 0 };
}

// ══════════════════════════════════
// 突破條件（EMA + 結構 + 等K線收盤）
// ══════════════════════════════════
function calcBreakout(klines) {
  if (klines.length < 210) return null;
  var closes = klines.map(function(k) { return parseFloat(k[4]); });
  var highs   = klines.map(function(k) { return parseFloat(k[2]); });
  var lows    = klines.map(function(k) { return parseFloat(k[3]); });
  var last    = closes.length - 1;
  var ema9    = calcEMA(closes, 9);
  var ema20   = calcEMA(closes, 20);
  var ema50   = calcEMA(closes, 50);
  var ema200  = calcEMA(closes, 200);
  if (!ema9 || !ema20 || !ema50 || !ema200) return null;
  var curClose  = closes[last];
  var prevClose = closes[last - 1];
  var bullAlign = ema9 > ema20 && ema20 > ema50 && ema50 > ema200 && curClose > ema9;
  var bearAlign = ema9 < ema20 && ema20 < ema50 && ema50 < ema200 && curClose < ema9;
  var structHigh = Math.max.apply(null, highs.slice(-22, -2));
  var structLow  = Math.min.apply(null, lows.slice(-22, -2));
  var bullBreak  = prevClose > structHigh && bullAlign;
  var bearBreak  = prevClose < structLow  && bearAlign;
  var atr = calcATR(highs, lows, closes, 14);
  return { ema9: ema9, ema20: ema20, ema50: ema50, ema200: ema200, bullAlign: bullAlign, bearAlign: bearAlign, bullBreak: bullBreak, bearBreak: bearBreak, structHigh: structHigh, structLow: structLow, atr: atr, curClose: curClose, prevClose: prevClose };
}

function checkSignal(sykes, breakout) {
  if (!sykes || !breakout) return null;
  if (sykes.longSignal  && breakout.bullBreak) return 'LONG';
  if (sykes.shortSignal && breakout.bearBreak) return 'SHORT';
  return null;
}

// ══════════════════════════════════
// 止盈止損計算
// ══════════════════════════════════
function calcLevels(side, entryPrice, atr, flipMode) {
  var slPct  = flipMode ? MAX_LOSS_MARGIN : MAX_LOSS_PCT;
  var slDist = entryPrice * slPct;
  var atrDist= atr ? atr * 1.5 : slDist;
  var useDist= flipMode ? Math.max(slDist, atrDist * 3) : Math.max(slDist, atrDist);
  var sl, tp1, tp2, tp3;
  if (side === 'LONG') { sl = entryPrice - useDist; tp1 = entryPrice + useDist * TP1_RR; tp2 = entryPrice + useDist * TP2_RR; tp3 = entryPrice + useDist * TP3_RR; }
  else                 { sl = entryPrice + useDist; tp1 = entryPrice - useDist * TP1_RR; tp2 = entryPrice - useDist * TP2_RR; tp3 = entryPrice - useDist * TP3_RR; }
  return { sl: sl, tp1: tp1, tp2: tp2, tp3: tp3, dist: useDist };
}

// ══════════════════════════════════
// 槓桿設定
// ══════════════════════════════════
async function setLeverage(symbol, lev, flipMode) {
  var marginType = flipMode ? 'CROSSED' : 'ISOLATED';
  try { await bxReq('POST', '/openApi/swap/v2/trade/marginType', { symbol: symbol, marginType: marginType }); } catch(e) {}
  for (var i = 0; i < 2; i++) {
    try { await bxReq('POST', '/openApi/swap/v2/trade/leverage', { symbol: symbol, side: i === 0 ? 'LONG' : 'SHORT', leverage: lev }); } catch(e) {}
  }
}

// ══════════════════════════════════
// 開倉
// ══════════════════════════════════
async function placeOrder(symbol, side, sl, tp1, flipMode) {
  await setLeverage(symbol, LEVERAGE, flipMode);
  var orderSide = side === 'LONG' ? 'BUY' : 'SELL';
  var closeSide = side === 'LONG' ? 'SELL' : 'BUY';
  var r = await bxReq('POST', '/openApi/swap/v2/trade/order', { symbol: symbol, side: orderSide, positionSide: side, type: 'MARKET', quoteOrderQty: String(ORDER_AMT * LEVERAGE) });
  if (r.code !== 0) throw new Error('開倉失敗: ' + r.msg);
  await new Promise(function(res) { setTimeout(res, 1500); });
  var entryPrice = parseFloat(r.data && r.data.order && r.data.order.avgPrice || 0);
  var qty        = parseFloat(r.data && r.data.order && r.data.order.executedQty || 0);
  var orderId    = r.data && r.data.order && r.data.order.orderId;
  if (qty <= 0) throw new Error('開倉數量為0');
  await bxReq('POST', '/openApi/swap/v2/trade/order', { symbol: symbol, side: closeSide, positionSide: side, type: 'STOP_MARKET', stopPrice: String(sl.toFixed(6)), quantity: String(qty), workingType: 'MARK_PRICE' }).catch(function(e) { log('WARN', 'SL失敗: ' + e.message); });
  var tp1Qty = parseFloat((qty * TP_RATIO).toFixed(6));
  await bxReq('POST', '/openApi/swap/v2/trade/order', { symbol: symbol, side: closeSide, positionSide: side, type: 'TAKE_PROFIT_MARKET', stopPrice: String(tp1.toFixed(6)), quantity: String(tp1Qty), workingType: 'MARK_PRICE' }).catch(function(e) { log('WARN', 'TP1失敗: ' + e.message); });
  return { orderId: orderId, entryPrice: entryPrice, qty: qty };
}

// ══════════════════════════════════
// 同步持倉（重啟恢復）
// ══════════════════════════════════
async function syncPositions() {
  try {
    var r = await bxReq('GET', '/openApi/swap/v2/user/positions', {});
    if (r.code !== 0) return;
    var apiPos = (r.data || []).filter(function(p) { return parseFloat(p.positionAmt || 0) !== 0; });
    Object.keys(positions).forEach(function(sym) {
      if (!apiPos.find(function(p) { return p.symbol === sym; })) { log('INFO', '持倉結束: ' + sym); delete positions[sym]; }
    });
    apiPos.forEach(function(p) {
      if (!positions[p.symbol]) {
        var side = parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT';
        log('INFO', '恢復持倉: ' + p.symbol + ' ' + side + ' @' + parseFloat(p.avgPrice));
        positions[p.symbol] = { side: side, entryPrice: parseFloat(p.avgPrice || 0), qty: Math.abs(parseFloat(p.positionAmt)), sl: 0, tp1: 0, tp2: 0, tp3: 0, tp1Done: false, tp2Done: false, openTime: Date.now(), orderId: null, flipMode: stats.flipMode };
      }
    });
    saveStats();
  } catch(e) { log('ERROR', '同步持倉失敗: ' + e.message); }
}

// ══════════════════════════════════
// 真實PnL（從API讀取）
// ══════════════════════════════════
async function getRealPnl(symbol, openTime) {
  try {
    var r = await bxReq('GET', '/openApi/swap/v2/user/income', { limit: 50, startTime: String(openTime) });
    if (r.code === 0 && r.data && r.data.length > 0) {
      var items = r.data.filter(function(o) {
        return (o.symbol === symbol || !o.symbol) && parseInt(o.time || 0) >= openTime && (o.incomeType === 'REALIZED_PNL' || o.incomeType === 'TRADING_FEE');
      });
      if (items.length > 0) return items.reduce(function(s, o) { return s + parseFloat(o.income || 0); }, 0);
    }
  } catch(e) { log('WARN', 'PnL失敗 ' + symbol + ': ' + e.message); }
  return null;
}

// ══════════════════════════════════
// 翻倉模式管理
// ══════════════════════════════════
function checkFlipMode() {
  var wr  = winRate();
  var cap = stats.capital;
  if (!stats.flipMode && wr >= FLIP_WIN_RATE && cap >= FLIP_CAPITAL) {
    stats.flipMode = true; saveStats();
    tg('🔓 *翻倉模式開啟*\n勝率: ' + (wr*100).toFixed(1) + '%\n資金: ' + cap.toFixed(2) + 'U\n→ 全倉模式');
  } else if (stats.flipMode && wr < FLIP_OFF_WIN_RATE) {
    stats.flipMode = false; saveStats();
    tg('🔒 *翻倉模式關閉*\n勝率: ' + (wr*100).toFixed(1) + '%\n→ 回到逐倉');
  }
}

// ══════════════════════════════════
// 結單處理
// ══════════════════════════════════
async function onPositionClosed(symbol, pos, reason) {
  await new Promise(function(res) { setTimeout(res, 3000); });
  var pnl = await getRealPnl(symbol, pos.openTime);
  var win = pnl !== null ? pnl > 0 : false;
  stats.total++;
  if (win) stats.wins++; else stats.losses++;
  if (pnl !== null) { stats.pnl += pnl; stats.capital += pnl; }
  var hour = new Date(pos.openTime).getHours();
  if (!stats.hourPerf[hour])     stats.hourPerf[hour]     = { total: 0, wins: 0, pnl: 0 };
  if (!stats.symbolPerf[symbol]) stats.symbolPerf[symbol] = { total: 0, wins: 0, pnl: 0 };
  stats.hourPerf[hour].total++;   stats.symbolPerf[symbol].total++;
  if (win) { stats.hourPerf[hour].wins++; stats.symbolPerf[symbol].wins++; }
  if (pnl !== null) { stats.hourPerf[hour].pnl += pnl; stats.symbolPerf[symbol].pnl += pnl; }
  stats.trades.push({ symbol: symbol, side: pos.side, entryPrice: pos.entryPrice, openTime: pos.openTime, closeTime: Date.now(), pnl: pnl !== null ? pnl : 'N/A', reason: reason, flipMode: pos.flipMode });
  if (stats.trades.length > 500) stats.trades.shift();
  delete positions[symbol];
  saveStats();
  checkFlipMode();
  var pnlStr  = pnl !== null ? (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + 'U' : 'N/A';
  var holdMin = Math.round((Date.now() - pos.openTime) / 60000);
  tg((win ? '✅' : '❌') + ' *' + symbol + '* 結單\n━━━━━━━━━━━━━━━━\n方向: ' + (pos.side === 'LONG' ? '做多 📈' : '做空 📉') + '\n原因: ' + reason + '\nPnL: ' + pnlStr + '\n持倉: ' + holdMin + '分鐘\n━━━━━━━━━━━━━━━━\n資金: ' + stats.capital.toFixed(2) + 'U\n勝率: ' + (winRate()*100).toFixed(1) + '% (' + stats.wins + '/' + stats.total + ')\n翻倉: ' + (stats.flipMode ? '✅全倉' : '❌逐倉'));
}

// ══════════════════════════════════
// 監控持倉（TP2/TP3）
// ══════════════════════════════════
async function monitorPositions() {
  var syms = Object.keys(positions);
  for (var i = 0; i < syms.length; i++) {
    var symbol = syms[i];
    var pos    = positions[symbol];
    if (!pos) continue;
    try {
      var r = await bxReq('GET', '/openApi/swap/v2/user/positions', { symbol: symbol });
      if (r.code !== 0) continue;
      var apiPos = (r.data || []).find(function(p) { return Math.abs(parseFloat(p.positionAmt || 0)) > 0; });
      if (!apiPos) { await onPositionClosed(symbol, pos, 'SL/TP1觸發'); continue; }
      var curQty    = Math.abs(parseFloat(apiPos.positionAmt));
      var markPrice = parseFloat(apiPos.markPrice || 0);
      var closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
      if (!pos.tp1Done && curQty < pos.qty * 0.9) { pos.tp1Done = true; tg('🎯 *' + symbol + '* TP1達成 @' + fmt(markPrice)); }
      if (pos.tp1Done && !pos.tp2Done && pos.tp2 > 0) {
        var tp2Hit = pos.side === 'LONG' ? markPrice >= pos.tp2 : markPrice <= pos.tp2;
        if (tp2Hit) {
          var tp2Qty = Math.min(parseFloat((pos.qty * TP_RATIO).toFixed(6)), curQty);
          await bxReq('POST', '/openApi/swap/v2/trade/order', { symbol: symbol, side: closeSide, positionSide: pos.side, type: 'MARKET', quantity: String(tp2Qty) }).catch(function(e) { log('WARN', 'TP2失敗: ' + e.message); });
          pos.tp2Done = true; tg('🎯 *' + symbol + '* TP2達成 @' + fmt(markPrice));
        }
      }
      if (pos.tp2Done && pos.tp3 > 0) {
        var tp3Hit = pos.side === 'LONG' ? markPrice >= pos.tp3 : markPrice <= pos.tp3;
        if (tp3Hit) {
          await bxReq('POST', '/openApi/swap/v2/trade/order', { symbol: symbol, side: closeSide, positionSide: pos.side, type: 'MARKET', quantity: String(curQty) }).catch(function(e) { log('WARN', 'TP3失敗: ' + e.message); });
          tg('🎯 *' + symbol + '* TP3達成 @' + fmt(markPrice) + ' 全部出場');
          await onPositionClosed(symbol, pos, 'TP3');
        }
      }
    } catch(e) { log('ERROR', '監控 ' + symbol + ': ' + e.message); }
  }
}

// ══════════════════════════════════
// 主掃描
// ══════════════════════════════════
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    var hour = hourTW();
    if (hour >= TIME_BLOCK_START && hour < TIME_BLOCK_END) return;
    await monitorPositions();
    if (Object.keys(positions).length >= MAX_POSITIONS) return;
    var symbols = await getTopSymbols();
    if (!symbols.length) return;
    log('INFO', '掃描 ' + symbols.length + ' 幣種 | 持倉 ' + Object.keys(positions).length + '/' + MAX_POSITIONS);
    for (var i = 0; i < symbols.length; i++) {
      var symbol = symbols[i];
      if (positions[symbol]) continue;
      if (Object.keys(positions).length >= MAX_POSITIONS) break;
      try {
        var klines = await getKlines(symbol, TF, 210);
        if (klines.length < 210) continue;
        var lastK    = klines[klines.length - 1];
        var klineTs  = parseInt(lastK[0]);
        if (Date.now() < klineTs + 3600000) continue;
        if (lastCandle[symbol] === klineTs) continue;
        var sykes    = calcSykes(klines);
        var breakout = calcBreakout(klines);
        var signal   = checkSignal(sykes, breakout);
        if (!signal) continue;
        lastCandle[symbol] = klineTs;
        var levels   = calcLevels(signal, breakout.curClose, breakout.atr, stats.flipMode);
        var strength = calcStrength(sykes, breakout);
        try {
          var result = await placeOrder(symbol, signal, levels.sl, levels.tp1, stats.flipMode);
          positions[symbol] = { side: signal, entryPrice: result.entryPrice, qty: result.qty, sl: levels.sl, tp1: levels.tp1, tp2: levels.tp2, tp3: levels.tp3, tp1Done: false, tp2Done: false, openTime: Date.now(), orderId: result.orderId, flipMode: stats.flipMode };
          saveStats();
          var slDist = Math.abs(result.entryPrice - levels.sl);
          var slPctR = (slDist / result.entryPrice * 100).toFixed(2);
          var maxLoss= (ORDER_AMT * (stats.flipMode ? MAX_LOSS_MARGIN : MAX_LOSS_PCT)).toFixed(4);
          tg(
            '🚀 *開倉* ' + symbol + '\n━━━━━━━━━━━━━━━━\n' +
            '方向: ' + (signal === 'LONG' ? '做多 📈' : '做空 📉') + '\n' +
            '進場: ' + fmt(result.entryPrice) + '\n━━━━━━━━━━━━━━━━\n' +
            '🛑 止損: ' + fmt(levels.sl) + ' (' + (signal === 'LONG' ? '-' : '+') + fmt(slDist) + ' / -' + slPctR + '%)\n' +
            '🎯 TP1: ' + fmt(levels.tp1) + ' (+' + fmt(Math.abs(levels.tp1 - result.entryPrice)) + ') RR 1:1\n' +
            '🎯 TP2: ' + fmt(levels.tp2) + ' (+' + fmt(Math.abs(levels.tp2 - result.entryPrice)) + ') RR 1:2\n' +
            '🎯 TP3: ' + fmt(levels.tp3) + ' (+' + fmt(Math.abs(levels.tp3 - result.entryPrice)) + ') RR 1:3\n' +
            '━━━━━━━━━━━━━━━━\n' +
            '💪 強度: ' + stars(strength) + ' (' + strength + '/5)\n' +
            '📊 Wyckoff: ' + (sykes.wyckoff === 1 ? '吸籌完成 Spring' : '派發完成 UTAD') + '\n' +
            '📈 量比: ' + sykes.volRatio.toFixed(2) + 'x ' + (sykes.volRatio >= 2 ? '🔥放量' : sykes.volRatio >= 1.5 ? '量增' : '普通') + '\n' +
            '📉 EMA: ' + (signal === 'LONG' ? '完整多頭排列' : '完整空頭排列') + '\n' +
            '⚠️ 最大虧損: -' + maxLoss + 'U\n' +
            '━━━━━━━━━━━━━━━━\n' +
            '模式: ' + (stats.flipMode ? '全倉翻倉' : '逐倉 1U') + ' | 槓桿: ' + LEVERAGE + 'x | 持倉: ' + Object.keys(positions).length + '/' + MAX_POSITIONS
          );
        } catch(e) { log('ERROR', '開倉失敗 ' + symbol + ': ' + e.message); }
        await new Promise(function(res) { setTimeout(res, 500); });
      } catch(e) { log('ERROR', '掃描 ' + symbol + ': ' + e.message); await new Promise(function(res) { setTimeout(res, 200); }); }
    }
  } catch(e) { log('ERROR', '掃描失敗: ' + e.message); }
  finally { scanning = false; }
}

// ══════════════════════════════════
// 異常處理
// ══════════════════════════════════
process.on('uncaughtException', function(e) { log('ERROR', 'Uncaught: ' + e.message); tg('🚨 突破系統異常!\n' + e.message + '\n請重新啟動!'); });
process.on('unhandledRejection', function(e) { log('ERROR', 'Unhandled: ' + (e && e.message ? e.message : String(e))); });
process.on('SIGINT',  function() { log('INFO', '手動關閉'); tg('⛔ 突破系統已關閉\n持倉: ' + Object.keys(positions).length + '個未平倉'); setTimeout(function() { process.exit(0); }, 2000); });
process.on('SIGTERM', function() { log('INFO', '系統終止'); tg('⛔ 突破系統被終止\n持倉: ' + Object.keys(positions).length + '個未平倉'); setTimeout(function() { process.exit(0); }, 2000); });

// ══════════════════════════════════
// 啟動
// ══════════════════════════════════
async function main() {
  log('INFO', '突破系統啟動');
  await syncPositions();
  tg(
    '🟢 *突破系統啟動*\n━━━━━━━━━━━━━━━━\n' +
    '資金: ' + stats.capital.toFixed(2) + 'U\n' +
    '持倉: ' + Object.keys(positions).length + '個\n' +
    '翻倉: ' + (stats.flipMode ? '✅全倉' : '❌逐倉') + '\n' +
    '勝率: ' + (winRate()*100).toFixed(1) + '% (' + stats.wins + '/' + stats.total + ')\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '發送 /help 查看指令'
  );
  tgPoll();
  setInterval(function() { scan().catch(function(e) { log('ERROR', 'scan: ' + e.message); }); }, SCAN_INTERVAL_MS);
  await scan();
}

main().catch(function(e) { log('ERROR', '啟動失敗: ' + e.message); process.exit(1); });

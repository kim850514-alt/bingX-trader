'use strict';
const crypto = require('crypto'), https = require('https'), fs = require('fs');

const ENV = {
  BINGX_API_KEY: process.env.BINGX_API_KEY || '',
  BINGX_SECRET: process.env.BINGX_SECRET_KEY || '',
  TG_TOKEN: process.env.TELEGRAM_TOKEN || '',
  TG_CHAT: process.env.TELEGRAM_CHAT_ID || ''
};

let cfg = {
  symbols: ['SIREN-USDT', 'XRP-USDT', 'DOGE-USDT'],
  tradeAmount: 1,
  leverage: 5,
  stopLossPercent: 2.0,
  takeProfitPercent: 3.5,
  allowShort: true,
  maxPositions: 3,
  maxHoldMin: 120,
  learnBatchSize: 5,
  scalp: { timeframe: '1m', rsiPeriod: 7, oversold: 30, overbought: 70, volMultiple: 1.5, enabled: true },
  momentum: { timeframe: '4h', emaFast: 9, emaSlow: 21, rsiPeriod: 14, volMultiple: 1.3, enabled: true },
  swing: { timeframe: '1d', emaPeriod: 50, rsiPeriod: 14, oversold: 35, overbought: 65, enabled: true }
};

let stats = loadStats();
let brain = loadBrain();
let positions = {};
let learnCycleCount = 0;
let learningPause = false;
let botRunning = false;

function loadStats() {
  if (fs.existsSync('./stats.json')) try { return JSON.parse(fs.readFileSync('./stats.json', 'utf8')); } catch(e) {}
  return { allTime: { total: 0, wins: 0, losses: 0, pnl: 0 }, daily: {}, trades: [] };
}
function saveStats() { fs.writeFileSync('./stats.json', JSON.stringify(stats, null, 2)); }

function loadBrain() {
  if (fs.existsSync('./brain.json')) try { return JSON.parse(fs.readFileSync('./brain.json', 'utf8')); } catch(e) {}
  return { symbolPerf: {}, hourPerf: {}, strategyPerf: {}, adjustHistory: [], learnCount: 0, bestHours: [], worstHours: [] };
}
function saveBrain() { fs.writeFileSync('./brain.json', JSON.stringify(brain, null, 2)); }

function todayKey() { return new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }); }
function nowTW() { return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }); }
function hourTW() { return parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false })); }
function getDayStat() {
  const d = todayKey();
  if (!stats.daily[d]) stats.daily[d] = { total: 0, wins: 0, losses: 0, pnl: 0 };
  return stats.daily[d];
}

var memLog = [];
function log(lv, msg) {
  console.log('[' + nowTW() + '][' + lv + '] ' + msg);
  memLog.push({ ts: nowTW(), lv, msg });
  if (memLog.length > 300) memLog.shift();
}

function tg(msg) {
  if (!ENV.TG_TOKEN || !ENV.TG_CHAT) return;
  const body = JSON.stringify({ chat_id: ENV.TG_CHAT, text: msg, parse_mode: 'HTML' });
  const opt = {
    hostname: '[api.telegram.org](https://api.telegram.org)',
    path: '/bot' + ENV.TG_TOKEN + '/sendMessage',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  const req = https.request(opt, function(res) { res.resume(); });
  req.on('error', function(e) { log('TG', 'Error: ' + [e.me](https://e.me)ssage); });
  req.write(body);
  req.end();
}

function bxSign(qs) { return crypto.createHmac('sha256', ENV.BINGX_SECRET).update(qs).digest('hex'); }
function bxBuildQ(params) {
  const p = Object.assign({}, params, { timestamp: Date.now() });
  const qs = Object.keys(p).filter(function(k) { return p[k] != null && p[k] !== ''; }).map(function(k) { return k + '=' + p[k]; }).join('&');
  return qs + '&signature=' + bxSign(qs);
}
function bxReq(method, path, params, tries) {
  params = params || {}; tries = tries || 3;
  return new Promise(function(resolve, reject) {
    const q = bxBuildQ(params);
    const opt = {
      hostname: '[open-api.bingx.com](https://open-api.bingx.com)',
      path: method === 'GET' ? path + '?' + q : path,
      method: method,
      headers: { 'X-BX-APIKEY': ENV.BINGX_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }
    };
    const go = function(n) {
      const req = https.request(opt, function(rsp) {
        let d = '';
        rsp.on('data', function(c) { d += c; });
        rsp.on('end', function() { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.slice(0, 80))); } });
      });
      req.on('error', function(e) { if (n > 1) setTimeout(function() { go(n-1); }, 2000); else reject(e); });
      req.setTimeout(12000, function() { req.destroy(); if (n > 1) setTimeout(function() { go(n-1); }, 2000); else reject(new Error('Timeout')); });
      if (method === 'POST') req.write(q);
      req.end();
    };
    go(tries);
  });
}

async function setLeverage(symbol) {
  try {
    await bxReq('POST', '/openApi/swap/v2/trade/leverage', { symbol, side: 'LONG', leverage: cfg.leverage });
    await bxReq('POST', '/openApi/swap/v2/trade/leverage', { symbol, side: 'SHORT', leverage: cfg.leverage });
  } catch(e) { log('API', 'setLeverage error: ' + [e.me](https://e.me)ssage); }
}

async function getKlines(symbol, interval, limit) {
  limit = limit || 100;
  const res = await bxReq('GET', '/openApi/swap/v3/quote/klines', { symbol, interval, limit });
  if (res && res.data) return res.data;
  return [];
}

async function getBalance() {
  const res = await bxReq('GET', '/openApi/swap/v2/user/balance', {});
  if (res && res.data && res.data.balance) return parseFloat(res.data.balance.availableMargin);
  return 0;
}

async function placeOrder(symbol, side, qty) {
  return await bxReq('POST', '/openApi/swap/v2/trade/order', {
    symbol, side, positionSide: side === 'BUY' ? 'LONG' : 'SHORT',
    type: 'MARKET', quantity: qty
  });
}

async function closePosition(symbol, side, qty) {
  const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
  return await bxReq('POST', '/openApi/swap/v2/trade/order', {
    symbol, side: closeSide, positionSide: side,
    type: 'MARKET', quantity: qty
  });
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce(function(a, b) { return a + b; }, 0) / period;
  for (let i = period; i < closes.length; i++) { ema = closes[i] * k + ema * (1 - k); }
  return ema;
}

function calcVolAvg(volumes, period) {
  const slice = volumes.slice(-period);
  return slice.reduce(function(a, b) { return a + b; }, 0) / slice.length;
}

function parseKlines(klines) {
  return {
    closes: klines.map(function(k) { return parseFloat(k[4]); }),
    volumes: klines.map(function(k) { return parseFloat(k[5]); })
  };
}

async function scalpStrategy(symbol) {
  if (!cfg.scalp.enabled) return null;
  const klines = await getKlines(symbol, cfg.scalp.timeframe, 50);
  if (klines.length < 20) return null;
  const { closes, volumes } = parseKlines(klines);
  const rsi = calcRSI(closes, cfg.scalp.rsiPeriod);
  const lastVol = volumes[volumes.length - 1];
  const avgVol = calcVolAvg(volumes, 20);
  const volOK = lastVol > avgVol * cfg.scalp.volMultiple;
  let signal = null;
  if (rsi < cfg.scalp.oversold && volOK) signal = 'LONG';
  else if (rsi > cfg.scalp.overbought && volOK && cfg.allowShort) signal = 'SHORT';
  if (signal) log('SCALP', symbol + ' RSI:' + rsi.toFixed(1) + ' Vol:' + (lastVol/avgVol).toFixed(2) + 'x -> ' + signal);
  return signal ? { signal, strategy: 'scalp' } : null;
}

async function momentumStrategy(symbol) {
  if (!cfg.momentum.enabled) return null;
  const klines = await getKlines(symbol, cfg.momentum.timeframe, 100);
  if (klines.length < 30) return null;
  const { closes, volumes } = parseKlines(klines);
  const emaFast = calcEMA(closes, cfg.momentum.emaFast);
  const emaSlow = calcEMA(closes, cfg.momentum.emaSlow);
  const rsi = calcRSI(closes, cfg.momentum.rsiPeriod);
  const lastVol = volumes[volumes.length - 1];
  const avgVol = calcVolAvg(volumes, 20);
  const volOK = lastVol > avgVol * cfg.momentum.volMultiple;
  let signal = null;
  if (emaFast > emaSlow && rsi > 50 && rsi < 75 && volOK) signal = 'LONG';
  else if (emaFast < emaSlow && rsi < 50 && rsi > 25 && volOK && cfg.allowShort) signal = 'SHORT';
  if (signal) log('MOMENTUM', symbol + ' EMA:' + emaFast.toFixed(4) + '/' + emaSlow.toFixed(4) + ' RSI:' + rsi.toFixed(1) + ' -> ' + signal);
  return signal ? { signal, strategy: 'momentum' } : null;
}

async function swingStrategy(symbol) {
  if (!cfg.swing.enabled) return null;
  const klines = await getKlines(symbol, cfg.swing.timeframe, 100);
  if (klines.length < 60) return null;
  const { closes } = parseKlines(klines);
  const ema = calcEMA(closes, cfg.swing.emaPeriod);
  const rsi = calcRSI(closes, cfg.swing.rsiPeriod);
  const price = closes[closes.length - 1];
  let signal = null;
  if (price > ema && rsi < cfg.swing.oversold) signal = 'LONG';
  else if (price < ema && rsi > cfg.swing.overbought && cfg.allowShort) signal = 'SHORT';
  if (signal) log('SWING', symbol + ' EMA50:' + ema.toFixed(4) + ' RSI:' + rsi.toFixed(1) + ' -> ' + signal);
  return signal ? { signal, strategy: 'swing' } : null;
}

async function tryEntry(symbol) {
  if (positions[symbol]) return;
  if (learningPause) return;
  if (Object.keys(positions).length >= cfg.maxPositions) return;
  let result = null;
  try { result = await scalpStrategy(symbol); } catch(e) { log('ERR', 'scalp: ' + [e.me](https://e.me)ssage); }
  if (!result) try { result = await momentumStrategy(symbol); } catch(e) { log('ERR', 'momentum: ' + [e.me](https://e.me)ssage); }
  if (!result) try { result = await swingStrategy(symbol); } catch(e) { log('ERR', 'swing: ' + [e.me](https://e.me)ssage); }
  if (!result) return;
  const { signal, strategy } = result;
  const balance = await getBalance();
  if (balance < cfg.tradeAmount) { log('RISK', '餘額不足: ' + balance); return; }
  const klines = await getKlines(symbol, '1m', 1);
  if (!klines.length) return;
  const price = parseFloat(klines[klines.length - 1][4]);
  const qty = (cfg.tradeAmount * cfg.leverage / price).toFixed(4);
  const sl = signal === 'LONG' ? price * (1 - cfg.stopLossPercent / 100) : price * (1 + cfg.stopLossPercent / 100);
  const tp = signal === 'LONG' ? price * (1 + cfg.takeProfitPercent / 100) : price * (1 - cfg.takeProfitPercent / 100);
  log('ORDER', symbol + ' ' + signal + ' qty:' + qty + ' price:' + price);
  try {
    await setLeverage(symbol);
    const res = await placeOrder(symbol, signal === 'LONG' ? 'BUY' : 'SELL', qty);
    if (res && res.code === 0) {
      positions[symbol] = { side: signal === 'LONG' ? 'LONG' : 'SHORT', entryPrice: price, qty: parseFloat(qty), sl, tp, strategy, openTime: Date.now() };
      const emoji = signal === 'LONG' ? '🟢' : '🔴';
      tg(emoji + ' <b>' + strategy.toUpperCase() + '</b> 開倉\n幣種: ' + symbol + '\n方向: ' + signal + '\n價格: ' + price + '\nSL: ' + sl.toFixed(6) + '\nTP: ' + tp.toFixed(6));
      log('ORDER', symbol + ' 開倉成功');
    } else {
      log('ORDER', symbol + ' 開倉失敗: ' + JSON.stringify(res));
    }
  } catch(e) { log('ERR', '下單錯誤: ' + [e.me](https://e.me)ssage); }
}

async function checkClose(symbol) {
  const pos = positions[symbol];
  if (!pos) return;
  const klines = await getKlines(symbol, '1m', 1);
  if (!klines.length) return;
  const price = parseFloat(klines[klines.length - 1][4]);
  const holdMin = (Date.now() - pos.openTime) / 60000;
  let shouldClose = false, reason = '', pnl = 0;
  if (pos.side === 'LONG') {
    pnl = (price - pos.entryPrice) / pos.entryPrice * 100 * cfg.leverage;
    if (price <= pos.sl) { shouldClose = true; reason = '止損'; }
    else if (price >= pos.tp) { shouldClose = true; reason = '止盈'; }
  } else {
    pnl = (pos.entryPrice - price) / pos.entryPrice * 100 * cfg.leverage;
    if (price >= pos.sl) { shouldClose = true; reason = '止損'; }
    else if (price <= pos.tp) { shouldClose = true; reason = '止盈'; }
  }
  if (holdMin > cfg.maxHoldMin) { shouldClose = true; reason = '超時平倉'; }
  if (!shouldClose) return;
  log('CLOSE', symbol + ' ' + reason + ' PnL:' + pnl.toFixed(2) + '%');
  try {
    await closePosition(symbol, pos.side, pos.qty);
    const actualPnl = cfg.tradeAmount * pnl / 100;
    const emoji = actualPnl > 0 ? '✅' : '❌';
    tg(emoji + ' <b>平倉</b> [' + reason + ']\n幣種: ' + symbol + '\n方向: ' + pos.side + '\n進場: ' + pos.entryPrice + '\n出場: ' + price + '\nPnL: ' + (actualPnl > 0 ? '+' : '') + actualPnl.toFixed(4) + ' USDT\n持倉: ' + holdMin.toFixed(0) + 'min');
    recordTrade({ symbol, strategy: pos.strategy, side: pos.side, pnl: actualPnl, holdMin, reason });
    delete positions[symbol];
  } catch(e) { log('ERR', '平倉錯誤: ' + [e.me](https://e.me)ssage); }
}

function recordTrade(t) {
  const d = getDayStat();
  d.total++; if (t.pnl > 0) d.wins++; else d.losses++; d.pnl += t.pnl;
  stats.allTime.total++; if (t.pnl > 0) stats.allTime.wins++; else stats.allTime.losses++; stats.allTime.pnl += t.pnl;
  stats.trades.push(Object.assign({}, t, { date: todayKey() }));
  if (stats.trades.length > 500) stats.trades = stats.trades.slice(-500);
  saveStats();
  learnCycleCount++;
  learnFromTrade(t);
  if (learnCycleCount >= cfg.learnBatchSize) {
    learnCycleCount = 0; learningPause = true;
    log('AI', '=== 學習週期觸發！暫停交易 ===');
    tg('[🧠 AI學習] 已完成 ' + cfg.learnBatchSize + ' 筆交易，暫停分析中...');
    autoAdjust();
    setTimeout(function() { learningPause = false; log('AI', '=== 學習完成！恢復交易 ==='); tg('[🧠 AI學習] 完成！恢復交易'); }, 5000);
  }
}

function learnFromTrade(t) {
  brain.learnCount++;
  if (!brain.symbolPerf[t.symbol]) brain.symbolPerf[t.symbol] = { wins: 0, losses: 0, pnl: 0, count: 0 };
  const sp = brain.symbolPerf[t.symbol];
  if (t.pnl > 0) sp.wins++; else sp.losses++; sp.pnl += t.pnl; sp.count++;
  if (!brain.strategyPerf[t.strategy]) brain.strategyPerf[t.strategy] = { wins: 0, losses: 0, pnl: 0 };
  const stp = brain.strategyPerf[t.strategy];
  if (t.pnl > 0) stp.wins++; else stp.losses++; stp.pnl += t.pnl;
  const hr = String(hourTW());
  if (!brain.hourPerf[hr]) brain.hourPerf[hr] = { wins: 0, losses: 0, pnl: 0 };
  const hp = brain.hourPerf[hr];
  if (t.pnl > 0) hp.wins++; else hp.losses++; hp.pnl += t.pnl;
  brain.bestHours = Object.keys(brain.hourPerf).filter(function(h) { const p = brain.hourPerf[h]; const total = p.wins + p.losses; return total >= 3 && p.wins / total >= 0.6; });
  brain.worstHours = Object.keys(brain.hourPerf).filter(function(h) { const p = brain.hourPerf[h]; const total = p.wins + p.losses; return total >= 3 && p.wins / total < 0.35; });
  saveBrain();
  log('AI', t.pnl > 0 ? t.symbol + '(' + t.strategy + ') +' + t.pnl.toFixed(4) + 'U' : t.symbol + '(' + t.strategy + ') ' + t.pnl.toFixed(4) + 'U');
}

function autoAdjust() {
  const recent = stats.trades.slice(-20);
  if (recent.length < 3) return;
  const wins = recent.filter(function(t) { return t.pnl > 0; });
  const losses = recent.filter(function(t) { return t.pnl < 0; });
  const wr = wins.length / recent.length;
  const avgWin = wins.length ? wins.reduce(function(s, t) { return s + t.pnl; }, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce(function(s, t) { return s + t.pnl; }, 0) / losses.length) : 0;
  const rr = avgLoss > 0 ? avgWin / avgLoss : 1;
  const changes = [];
  if (wr < 0.4 && cfg.stopLossPercent > 1.0) { const o = cfg.stopLossPercent; cfg.stopLossPercent = +(Math.max(1.0, o - 0.2)).toFixed(1); changes.push('SL收緊 ' + o + '->' + cfg.stopLossPercent + '%'); }
  if (wr > 0.6 && cfg.stopLossPercent < 3.5) { const o = cfg.stopLossPercent; cfg.stopLossPercent = +(Math.min(3.5, o + 0.2)).toFixed(1); changes.push('SL放寬 ' + o + '->' + cfg.stopLossPercent + '%'); }
  if (rr < 1.5 && cfg.takeProfitPercent < 8) { const o = cfg.takeProfitPercent; cfg.takeProfitPercent = +(Math.min(8, o + 0.5)).toFixed(1); changes.push('TP提高 ' + o + '->' + cfg.takeProfitPercent + '%'); }
  if (rr > 3.0 && cfg.takeProfitPercent > 2.0) { const o = cfg.takeProfitPercent; cfg.takeProfitPercent = +(Math.max(2.0, o - 0.3)).toFixed(1); changes.push('TP降低 ' + o + '->' + cfg.takeProfitPercent + '%'); }
  const stratWr = function(s) { const p = brain.strategyPerf[s]; if (!p || (p.wins + p.losses) < 5) return 0.5; return p.wins / (p.wins + p.losses); };
  if (stratWr('scalp') < 0.3) { cfg.scalp.enabled = false; changes.push('剝頭皮暫停'); }
  else if (!cfg.scalp.enabled && stratWr('scalp') > 0.5) { cfg.scalp.enabled = true; changes.push('剝頭皮恢復'); }
  if (stratWr('momentum') < 0.3) { cfg.momentum.enabled = false; changes.push('動量暫停'); }
  else if (!cfg.momentum.enabled && stratWr('momentum') > 0.5) { cfg.momentum.enabled = true; changes.push('動量恢復'); }
  if (stratWr('swing') < 0.3) { cfg.swing.enabled = false; changes.push('波段暫停'); }
  else if (!cfg.swing.enabled && stratWr('swing') > 0.5) { cfg.swing.enabled = true; changes.push('波段恢復'); }
  if (changes.length) {
    brain.adjustHistory.push({ date: todayKey(), changes, wr: (wr * 100).toFixed(1), rr: rr.toFixed(2) });
    if (brain.adjustHistory.length > 100) brain.adjustHistory = brain.adjustHistory.slice(-100);
    log('AI', '自動調整: ' + changes.join(' | '));
    tg('[🧠 自動調整]\n' + changes.join('\n') + '\nWR: ' + (wr * 100).toFixed(1) + '% RR: ' + rr.toFixed(2));
  }
}

function sendReport() {
  const d = getDayStat();
  const pos = Object.keys(positions).map(function(s) { const p = positions[s]; return s + ' ' + p.side + ' [' + p.strategy + ']'; }).join('\n') || '無';
  tg('📊 <b>每日報告</b>\n今日: ' + d.total + '筆 | 勝:' + d.wins + ' 敗:' + d.losses + '\nPnL: ' + (d.pnl > 0 ? '+' : '') + d.pnl.toFixed(4) + ' USDT\n總計: ' + stats.allTime.total + '筆 | ' + stats.allTime.pnl.toFixed(4) + ' USDT\n當前持倉:\n' + pos + '\n策略: 剝頭皮' + (cfg.scalp.enabled ? '✅' : '❌') + ' 動量' + (cfg.momentum.enabled ? '✅' : '❌') + ' 波段' + (cfg.swing.enabled ? '✅' : '❌'));
}

let lastReportHour = -1;
async function mainLoop() {
  if (!botRunning) return;
  log('LOOP', '掃描中...');
  for (const symbol of cfg.symbols) {
    try { await tryEntry(symbol); } catch(e) { log('ERR', symbol + ' entry: ' + [e.me](https://e.me)ssage); }
    try { await checkClose(symbol); } catch(e) { log('ERR', symbol + ' close: ' + [e.me](https://e.me)ssage); }
    await new Promise(function(r) { setTimeout(r, 1000); });
  }
  const h = hourTW();
  if (h === 8 && lastReportHour !== 8) { lastReportHour = 8; sendReport(); }
  if (h !== 8) lastReportHour = -1;
}

async function start() {
  log('BOT', '=== BingX 交易機器人啟動 ===');
  log('BOT', '幣種: ' + cfg.symbols.join(', '));
  log('BOT', '每筆: ' + cfg.tradeAmount + 'U | 槓桿: ' + cfg.leverage + 'x | SL: ' + cfg.stopLossPercent + '% TP: ' + cfg.takeProfitPercent + '%');
  if (!ENV.BINGX_API_KEY) { log('ERR', 'BINGX_API_KEY 未設定！'); process.exit(1); }
  if (!ENV.BINGX_SECRET) { log('ERR', 'BINGX_SECRET_KEY 未設定！'); process.exit(1); }
  botRunning = true;
  tg('🤖 <b>交易機器人啟動！</b>\n幣種: ' + cfg.symbols.join(', ') + '\n每筆: ' + cfg.tradeAmount + 'U | 槓桿: ' + cfg.leverage + 'x\nSL: ' + cfg.stopLossPercent + '% | TP: ' + cfg.takeProfitPercent + '%\n策略: 剝頭皮(1m) + 動量突破(4H) + 波段(1D)');
  setInterval(mainLoop, 30000);
  await mainLoop();
}

start().catch(function(e) { log('ERR', '啟動失敗: ' + [e.me](https://e.me)ssage); process.exit(1); });

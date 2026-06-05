'use strict';
const crypto = require('node:crypto');
const https = require('https');
const fs = require('fs');

// ══════════════════════════════════
// 系統設定
// ══════════════════════════════════
const BOT_TOKEN = process.env.BOT_TOKEN || '8760052481:AAHo8XWWwgkBJ9a2KuIOCcJJpUGBFQPTwwk';
const CHAT_ID   = process.env.CHAT_ID   || '8308748755';
const BX_KEY    = process.env.BX_APIKEY || 'IDrcq954PuXoImAK1U4MEC9sI9HLK2B9PSuctuib9u7maCsZdAMRp7u99uHrPfeErNxDBA4SoOYC54DLfKHQ';
const BX_SECRET = process.env.BX_SECRET || 'NqpQkRZMwqhzKVcxiC5gECYSGgrZoVhyRKisWBxkQEVsIBxu4iEdtMjCEX174eHFcAfzHT3x9biX8XtcjeJIQ';
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
let stats = loadStats();
let positions = {};
let lastCandle = {};
let scanning = false;

// ══════════════════════════════════
// 持久化
// ══════════════════════════════════
function loadStats() {
  if (fs.existsSync(STATS_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch(e) {}
  }
  return {
    capital: INITIAL_CAPITAL,
    total: 0, wins: 0, losses: 0, pnl: 0,
    flipMode: false,
    trades: [],
    symbolPerf: {},
    hourPerf: {},
    patternPerf: {}
  };
}

function saveStats() {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

// ══════════════════════════════════
// 工具
// ══════════════════════════════════
function nowTW() { return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }); }
function hourTW() { return parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour: 'numeric', hour12: false })); }
function log(lv, msg) { console.log(`[${nowTW()}][${lv}] ${msg}`); }
function winRate() { return stats.total === 0 ? 0 : stats.wins / stats.total; }

function fmt(n, d) {
  d = d || 4;
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1)    return n.toFixed(3);
  return n.toFixed(d);
}

// 進場強度評分（1-5星）
function calcStrength(sykes, breakout) {
  let score = 0;

  // 量比（最高2分）
  if (sykes.volRatio >= 2.0) score += 2;
  else if (sykes.volRatio >= 1.5) score += 1;

  // Wyckoff確認（1分）
  if (sykes.wyckoff !== 0) score += 1;

  // EMA排列緊密度（1分）
  const spread = Math.abs(breakout.ema9 - breakout.ema20) / breakout.ema200;
  if (spread < 0.01) score += 1; // EMA靠近，排列剛形成

  // 結構突破幅度（1分）
  const breakPct = Math.abs(breakout.prevClose - (breakout.bullBreak ? breakout.structHigh : breakout.structLow)) / breakout.curClose;
  if (breakPct > 0.005) score += 1; // 突破超過0.5%

  return Math.min(score, 5);
}

function stars(n) {
  return '⭐'.repeat(n) + '☆'.repeat(5 - n);
}

// ══════════════════════════════════
// BingX API
// ══════════════════════════════════
function bxReq(method, path, params) {
  params = params || {};
  return new Promise((resolve, reject) => {
    const p = Object.assign({}, params, { timestamp: Date.now() });
    const qs = Object.keys(p).filter(k => p[k] != null && p[k] !== '').map(k => `${k}=${p[k]}`).join('&');
    const sig = crypto.createHmac('sha256', BX_SECRET).update(qs).digest('hex');
    const q = qs + '&signature=' + sig;
    const opt = {
      hostname: 'open-api.bingx.com',
      path: path + '?' + q,
      method,
      headers: { 'X-BX-APIKEY': BX_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }
    };
    const req = https.request(opt, rsp => {
      let d = '';
      rsp.on('data', c => d += c);
      rsp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.slice(0,100))); } });
    });
    req.on('error', e => setTimeout(() => reject(e), 1000));
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function bxPublic(path, params) {
  return new Promise((resolve, reject) => {
    const qs = params ? Object.keys(params).map(k => `${k}=${params[k]}`).join('&') : '';
    const fullPath = qs ? path + '?' + qs : path;
    const req = https.request({ hostname: 'open-api.bingx.com', path: fullPath, method: 'GET' }, rsp => {
      let d = '';
      rsp.on('data', c => d += c);
      rsp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ══════════════════════════════════
// 取得前N交易量幣種
// ══════════════════════════════════
async function getTopSymbols() {
  try {
    const r = await bxPublic('/openApi/swap/v2/quote/ticker');
    if (r.code !== 0 || !Array.isArray(r.data)) return [];
    return r.data
      .filter(t => t.symbol && t.symbol.endsWith('-USDT'))
      .sort((a, b) => parseFloat(b.quoteVolume || 0) - parseFloat(a.quoteVolume || 0))
      .slice(0, TOP_N_SYMBOLS)
      .map(t => t.symbol);
  } catch(e) {
    log('ERROR', '取得幣種清單失敗: ' + e.message);
    return [];
  }
}

// ══════════════════════════════════
// 取得K線
// ══════════════════════════════════
async function getKlines(symbol, tf, limit) {
  limit = limit || 210;
  try {
    const r = await bxReq('GET', '/openApi/swap/v2/quote/klines', { symbol, interval: tf, limit });
    if (r.code === 0 && Array.isArray(r.data)) return r.data;
  } catch(e) {}
  return [];
}

// ══════════════════════════════════
// 技術指標
// ══════════════════════════════════
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcATR(highs, lows, closes, n) {
  n = n || 14;
  if (highs.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]));
    trs.push(tr);
  }
  if (trs.length < n) return null;
  return trs.slice(-n).reduce((s, v) => s + v, 0) / n;
}

// ══════════════════════════════════
// 賽克斯指標（Wyckoff + 量能）
// ══════════════════════════════════
function calcSykes(klines) {
  if (klines.length < 50) return null;

  const closes  = klines.map(k => parseFloat(k[4]));
  const highs   = klines.map(k => parseFloat(k[2]));
  const lows    = klines.map(k => parseFloat(k[3]));
  const volumes = klines.map(k => parseFloat(k[5]));
  const opens   = klines.map(k => parseFloat(k[1]));
  const len     = closes.length;
  const last    = len - 1;

  const volMA      = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
  const curVol     = volumes[last];
  const volRatio   = curVol / volMA;
  const isUp       = closes[last] > opens[last];
  const volScore   = isUp ? volRatio : -volRatio;

  const lookback      = Math.min(50, len);
  const recentHighs   = highs.slice(-lookback);
  const recentLows    = lows.slice(-lookback);
  const structureHigh = Math.max(...recentHighs);
  const structureLow  = Math.min(...recentLows);
  const range         = structureHigh - structureLow;
  if (range === 0) return null;

  const curClose   = closes[last];
  const posInRange = (curClose - structureLow) / range;

  const nearBottom   = posInRange < 0.3;
  const prevLow5     = Math.min(...lows.slice(-6, -1));
  const springTest   = lows[last] <= prevLow5 * 1.002;
  const rebound      = closes[last] > opens[last];
  const volExpansion = curVol > volMA * 1.2;

  const nearTop    = posInRange > 0.7;
  const prevHigh5  = Math.max(...highs.slice(-6, -1));
  const utadTest   = highs[last] >= prevHigh5 * 0.998;
  const rejection  = closes[last] < opens[last];

  let wyckoffScore = 0;
  if (nearBottom && springTest && rebound && volExpansion) wyckoffScore = 1;
  else if (nearTop && utadTest && rejection && volExpansion) wyckoffScore = -1;

  const sykesValue = volScore * (1 + Math.abs(wyckoffScore));

  return {
    value: sykesValue,
    wyckoff: wyckoffScore,
    volRatio,
    posInRange,
    longSignal:  wyckoffScore === 1  && sykesValue > 0,
    shortSignal: wyckoffScore === -1 && sykesValue < 0
  };
}

// ══════════════════════════════════
// 突破條件
// ══════════════════════════════════
function calcBreakout(klines) {
  if (klines.length < 210) return null;

  const closes = klines.map(k => parseFloat(k[4]));
  const highs  = klines.map(k => parseFloat(k[2]));
  const lows   = klines.map(k => parseFloat(k[3]));
  const last   = closes.length - 1;

  const ema9   = calcEMA(closes, 9);
  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  if (!ema9 || !ema20 || !ema50 || !ema200) return null;

  const curClose  = closes[last];
  const prevClose = closes[last - 1];

  const bullAlign = ema9 > ema20 && ema20 > ema50 && ema50 > ema200 && curClose > ema9;
  const bearAlign = ema9 < ema20 && ema20 < ema50 && ema50 < ema200 && curClose < ema9;

  const recent20Highs = highs.slice(-22, -2);
  const recent20Lows  = lows.slice(-22, -2);
  const structHigh    = Math.max(...recent20Highs);
  const structLow     = Math.min(...recent20Lows);

  const bullBreak = prevClose > structHigh && bullAlign;
  const bearBreak = prevClose < structLow  && bearAlign;

  const atr = calcATR(highs, lows, closes, 14);

  return {
    ema9, ema20, ema50, ema200,
    bullAlign, bearAlign,
    bullBreak, bearBreak,
    structHigh, structLow,
    atr, curClose, prevClose
  };
}

function checkSignal(sykes, breakout) {
  if (!sykes || !breakout) return null;
  if (sykes.longSignal  && breakout.bullBreak) return 'LONG';
  if (sykes.shortSignal && breakout.bearBreak) return 'SHORT';
  return null;
}

// ══════════════════════════════════
// 計算止盈止損
// ══════════════════════════════════
function calcLevels(side, entryPrice, atr, flipMode) {
  const slPct   = flipMode ? MAX_LOSS_MARGIN : MAX_LOSS_PCT;
  const slDist  = entryPrice * slPct;
  const atrDist = atr ? atr * 1.5 : slDist;
  const useDist = flipMode ? Math.max(slDist, atrDist * 3) : Math.max(slDist, atrDist);

  let sl, tp1, tp2, tp3;
  if (side === 'LONG') {
    sl  = entryPrice - useDist;
    tp1 = entryPrice + useDist * TP1_RR;
    tp2 = entryPrice + useDist * TP2_RR;
    tp3 = entryPrice + useDist * TP3_RR;
  } else {
    sl  = entryPrice + useDist;
    tp1 = entryPrice - useDist * TP1_RR;
    tp2 = entryPrice - useDist * TP2_RR;
    tp3 = entryPrice - useDist * TP3_RR;
  }

  return { sl, tp1, tp2, tp3, dist: useDist };
}

// ══════════════════════════════════
// 設定槓桿
// ══════════════════════════════════
async function setLeverage(symbol, lev, flipMode) {
  const marginType = flipMode ? 'CROSSED' : 'ISOLATED';
  try { await bxReq('POST', '/openApi/swap/v2/trade/marginType', { symbol, marginType }); } catch(e) {}
  for (const side of ['LONG', 'SHORT']) {
    try { await bxReq('POST', '/openApi/swap/v2/trade/leverage', { symbol, side, leverage: lev }); } catch(e) {}
  }
}

// ══════════════════════════════════
// 開倉
// ══════════════════════════════════
async function placeOrder(symbol, side, sl, tp1, flipMode) {
  await setLeverage(symbol, LEVERAGE, flipMode);

  const positionSide = side;
  const orderSide    = side === 'LONG' ? 'BUY' : 'SELL';
  const closeSide    = side === 'LONG' ? 'SELL' : 'BUY';
  const notional     = ORDER_AMT * LEVERAGE;

  const r = await bxReq('POST', '/openApi/swap/v2/trade/order', {
    symbol, side: orderSide, positionSide,
    type: 'MARKET',
    quoteOrderQty: String(notional)
  });

  if (r.code !== 0) throw new Error('開倉失敗: ' + r.msg);

  await new Promise(res => setTimeout(res, 1500));

  const entryPrice = parseFloat(r.data?.order?.avgPrice || 0);
  const qty        = parseFloat(r.data?.order?.executedQty || 0);
  const orderId    = r.data?.order?.orderId;

  if (qty <= 0) throw new Error('開倉數量為0');

  await bxReq('POST', '/openApi/swap/v2/trade/order', {
    symbol, side: closeSide, positionSide,
    type: 'STOP_MARKET',
    stopPrice: String(sl.toFixed(6)),
    quantity: String(qty),
    workingType: 'MARK_PRICE'
  }).catch(e => log('WARN', `SL設定失敗: ${e.message}`));

  const tp1Qty = parseFloat((qty * TP_RATIO).toFixed(6));
  await bxReq('POST', '/openApi/swap/v2/trade/order', {
    symbol, side: closeSide, positionSide,
    type: 'TAKE_PROFIT_MARKET',
    stopPrice: String(tp1.toFixed(6)),
    quantity: String(tp1Qty),
    workingType: 'MARK_PRICE'
  }).catch(e => log('WARN', `TP1設定失敗: ${e.message}`));

  return { orderId, entryPrice, qty };
}

// ══════════════════════════════════
// 同步持倉
// ══════════════════════════════════
async function syncPositions() {
  try {
    const r = await bxReq('GET', '/openApi/swap/v2/user/positions', {});
    if (r.code !== 0) return;

    const apiPos = (r.data || []).filter(p => parseFloat(p.positionAmt || 0) !== 0);

    for (const sym of Object.keys(positions)) {
      if (!apiPos.find(p => p.symbol === sym)) {
        log('INFO', `持倉結束，清除: ${sym}`);
        delete positions[sym];
      }
    }

    for (const p of apiPos) {
      if (!positions[p.symbol]) {
        const side       = parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT';
        const entryPrice = parseFloat(p.avgPrice || 0);
        const qty        = Math.abs(parseFloat(p.positionAmt));
        log('INFO', `恢復持倉: ${p.symbol} ${side} @${entryPrice}`);
        positions[p.symbol] = {
          side, entryPrice, qty,
          sl: 0, tp1: 0, tp2: 0, tp3: 0,
          tp1Done: false, tp2Done: false,
          openTime: Date.now(),
          orderId: null,
          flipMode: stats.flipMode
        };
      }
    }
    saveStats();
  } catch(e) {
    log('ERROR', '同步持倉失敗: ' + e.message);
  }
}

// ══════════════════════════════════
// 真實PnL
// ══════════════════════════════════
async function getRealPnl(symbol, openTime) {
  try {
    const r = await bxReq('GET', '/openApi/swap/v2/user/income', {
      limit: 50,
      startTime: String(openTime)
    });
    if (r.code === 0 && r.data && r.data.length > 0) {
      const items = r.data.filter(o =>
        (o.symbol === symbol || !o.symbol) &&
        parseInt(o.time || 0) >= openTime &&
        (o.incomeType === 'REALIZED_PNL' || o.incomeType === 'TRADING_FEE')
      );
      if (items.length > 0) return items.reduce((s, o) => s + parseFloat(o.income || 0), 0);
    }
  } catch(e) {
    log('WARN', `PnL讀取失敗 ${symbol}: ${e.message}`);
  }
  return null;
}

// ══════════════════════════════════
// 翻倉模式
// ══════════════════════════════════
function checkFlipMode() {
  const wr  = winRate();
  const cap = stats.capital;

  if (!stats.flipMode && wr >= FLIP_WIN_RATE && cap >= FLIP_CAPITAL) {
    stats.flipMode = true;
    saveStats();
    tg(`🔓 *翻倉模式開啟*\n勝率: ${(wr*100).toFixed(1)}%\n資金: ${cap.toFixed(2)}U\n→ 全倉模式`);
  } else if (stats.flipMode && wr < FLIP_OFF_WIN_RATE) {
    stats.flipMode = false;
    saveStats();
    tg(`🔒 *翻倉模式關閉*\n勝率: ${(wr*100).toFixed(1)}%\n→ 回到逐倉初始狀態`);
  }
}

// ══════════════════════════════════
// 結單
// ══════════════════════════════════
async function onPositionClosed(symbol, pos, reason) {
  await new Promise(res => setTimeout(res, 3000));

  const pnl = await getRealPnl(symbol, pos.openTime);
  const win = pnl !== null ? pnl > 0 : false;

  stats.total++;
  if (win) stats.wins++; else stats.losses++;
  if (pnl !== null) { stats.pnl += pnl; stats.capital += pnl; }

  const hour = new Date(pos.openTime).getHours();
  if (!stats.hourPerf[hour])     stats.hourPerf[hour]     = { total: 0, wins: 0, pnl: 0 };
  if (!stats.symbolPerf[symbol]) stats.symbolPerf[symbol] = { total: 0, wins: 0, pnl: 0 };
  stats.hourPerf[hour].total++;
  stats.symbolPerf[symbol].total++;
  if (win) { stats.hourPerf[hour].wins++; stats.symbolPerf[symbol].wins++; }
  if (pnl !== null) { stats.hourPerf[hour].pnl += pnl; stats.symbolPerf[symbol].pnl += pnl; }

  stats.trades.push({
    symbol, side: pos.side,
    entryPrice: pos.entryPrice,
    openTime: pos.openTime,
    closeTime: Date.now(),
    pnl: pnl !== null ? pnl : 'N/A',
    reason, flipMode: pos.flipMode
  });
  if (stats.trades.length > 500) stats.trades.shift();

  delete positions[symbol];
  saveStats();
  checkFlipMode();

  const pnlStr  = pnl !== null ? (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + 'U' : 'N/A';
  const holdMin = Math.round((Date.now() - pos.openTime) / 60000);

  tg(
    `${win ? '✅' : '❌'} *${symbol}* 結單\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `方向: ${pos.side === 'LONG' ? '做多 📈' : '做空 📉'}\n` +
    `原因: ${reason}\n` +
    `PnL: ${pnlStr}\n` +
    `持倉: ${holdMin}分鐘\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `資金: ${stats.capital.toFixed(2)}U\n` +
    `勝率: ${(winRate()*100).toFixed(1)}% (${stats.wins}/${stats.total})\n` +
    `翻倉: ${stats.flipMode ? '✅全倉' : '❌逐倉'}`
  );
}

// ══════════════════════════════════
// 監控持倉
// ══════════════════════════════════
async function monitorPositions() {
  for (const symbol of Object.keys(positions)) {
    const pos = positions[symbol];
    try {
      const r = await bxReq('GET', '/openApi/swap/v2/user/positions', { symbol });
      if (r.code !== 0) continue;

      const apiPos = (r.data || []).find(p => Math.abs(parseFloat(p.positionAmt || 0)) > 0);

      if (!apiPos) {
        await onPositionClosed(symbol, pos, 'SL/TP1觸發');
        continue;
      }

      const curQty    = Math.abs(parseFloat(apiPos.positionAmt));
      const markPrice = parseFloat(apiPos.markPrice || 0);
      const unrealPnl = parseFloat(apiPos.unrealizedProfit || 0);
      const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';

      if (!pos.tp1Done && curQty < pos.qty * 0.9) {
        pos.tp1Done = true;
        log('INFO', `${symbol} TP1達成`);
        tg(`🎯 *${symbol}* TP1達成\n價格: ${fmt(markPrice)}\n未實現PnL: ${unrealPnl >= 0 ? '+' : ''}${unrealPnl.toFixed(4)}U`);
      }

      if (pos.tp1Done && !pos.tp2Done && pos.tp2 > 0) {
        const tp2Hit = pos.side === 'LONG' ? markPrice >= pos.tp2 : markPrice <= pos.tp2;
        if (tp2Hit) {
          const tp2Qty = Math.min(parseFloat((pos.qty * TP_RATIO).toFixed(6)), curQty);
          await bxReq('POST', '/openApi/swap/v2/trade/order', {
            symbol, side: closeSide, positionSide: pos.side,
            type: 'MARKET', quantity: String(tp2Qty)
          }).catch(e => log('WARN', `TP2失敗: ${e.message}`));
          pos.tp2Done = true;
          tg(`🎯 *${symbol}* TP2達成\n價格: ${fmt(markPrice)}`);
        }
      }

      if (pos.tp2Done && pos.tp3 > 0) {
        const tp3Hit = pos.side === 'LONG' ? markPrice >= pos.tp3 : markPrice <= pos.tp3;
        if (tp3Hit) {
          await bxReq('POST', '/openApi/swap/v2/trade/order', {
            symbol, side: closeSide, positionSide: pos.side,
            type: 'MARKET', quantity: String(curQty)
          }).catch(e => log('WARN', `TP3失敗: ${e.message}`));
          tg(`🎯 *${symbol}* TP3達成 @${fmt(markPrice)} 全部出場`);
          await onPositionClosed(symbol, pos, 'TP3');
        }
      }

    } catch(e) {
      log('ERROR', `監控 ${symbol}: ${e.message}`);
    }
  }
}

// ══════════════════════════════════
// 主掃描
// ══════════════════════════════════
async function scan() {
  if (scanning) return;
  scanning = true;

  try {
    const hour = hourTW();
    if (hour >= TIME_BLOCK_START && hour < TIME_BLOCK_END) return;

    await monitorPositions();

    if (Object.keys(positions).length >= MAX_POSITIONS) return;

    const symbols = await getTopSymbols();
    if (!symbols.length) return;

    log('INFO', `掃描 ${symbols.length} 幣種 | 持倉 ${Object.keys(positions).length}/${MAX_POSITIONS}`);

    for (const symbol of symbols) {
      if (positions[symbol]) continue;
      if (Object.keys(positions).length >= MAX_POSITIONS) break;

      try {
        const klines = await getKlines(symbol, TF, 210);
        if (klines.length < 210) continue;

        const lastK      = klines[klines.length - 1];
        const klineTs    = parseInt(lastK[0]);
        const klineEndTs = klineTs + 3600000;
        if (Date.now() < klineEndTs) continue;
        if (lastCandle[symbol] === klineTs) continue;

        const sykes    = calcSykes(klines);
        const breakout = calcBreakout(klines);
        const signal   = checkSignal(sykes, breakout);
        if (!signal) continue;

        lastCandle[symbol] = klineTs;

        const { sl, tp1, tp2, tp3, dist } = calcLevels(signal, breakout.curClose, breakout.atr, stats.flipMode);
        const strength = calcStrength(sykes, breakout);
        const slPct    = (dist / breakout.curClose * 100).toFixed(2);
        const atrMult  = breakout.atr ? (dist / breakout.atr).toFixed(1) : 'N/A';

        try {
          const { orderId, entryPrice, qty } = await placeOrder(symbol, signal, sl, tp1, stats.flipMode);

          positions[symbol] = {
            side: signal, entryPrice, qty,
            sl, tp1, tp2, tp3,
            tp1Done: false, tp2Done: false,
            openTime: Date.now(),
            orderId, flipMode: stats.flipMode
          };

          saveStats();

          const slDist  = Math.abs(entryPrice - sl);
          const slPctR  = (slDist / entryPrice * 100).toFixed(2);
          const tp1Dist = Math.abs(tp1 - entryPrice);
          const tp2Dist = Math.abs(tp2 - entryPrice);
          const tp3Dist = Math.abs(tp3 - entryPrice);
          const maxLoss = (ORDER_AMT * (stats.flipMode ? MAX_LOSS_MARGIN : MAX_LOSS_PCT)).toFixed(4);

          tg(
            `🚀 *開倉* ${symbol}\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `方向: ${signal === 'LONG' ? '做多 📈' : '做空 📉'}\n` +
            `進場: ${fmt(entryPrice)}\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `🛑 止損: ${fmt(sl)} (${signal === 'LONG' ? '-' : '+'}${fmt(slDist)} / -${slPctR}%)\n` +
            `🎯 TP1:  ${fmt(tp1)} (+${fmt(tp1Dist)}) RR 1:1\n` +
            `🎯 TP2:  ${fmt(tp2)} (+${fmt(tp2Dist)}) RR 1:2\n` +
            `🎯 TP3:  ${fmt(tp3)} (+${fmt(tp3Dist)}) RR 1:3\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `💪 強度: ${stars(strength)} (${strength}/5)\n` +
            `📊 Wyckoff: ${sykes.wyckoff === 1 ? '吸籌完成 Spring' : '派發完成 UTAD'}\n` +
            `📈 量比: ${sykes.volRatio.toFixed(2)}x ${sykes.volRatio >= 2 ? '🔥放量' : sykes.volRatio >= 1.5 ? '量增' : '普通'}\n` +
            `📉 EMA排列: ${signal === 'LONG' ? '完整多頭' : '完整空頭'}\n` +
            `⚠️ 最大虧損: -${maxLoss}U\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `模式: ${stats.flipMode ? '全倉翻倉' : '逐倉 1U'} | 槓桿: ${LEVERAGE}x\n` +
            `持倉: ${Object.keys(positions).length}/${MAX_POSITIONS}`
          );
        } catch(e) {
          log('ERROR', `開倉失敗 ${symbol}: ${e.message}`);
        }

        await new Promise(res => setTimeout(res, 500));

      } catch(e) {
        log('ERROR', `掃描 ${symbol}: ${e.message}`);
        await new Promise(res => setTimeout(res, 200));
      }
    }
  } catch(e) {
    log('ERROR', '掃描失敗: ' + e.message);
  } finally {
    scanning = false;
  }
}

// ══════════════════════════════════
// Telegram
// ══════════════════════════════════
function tg(msg) {
  const body = JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'Markdown' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  });
  req.on('error', e => log('WARN', 'TG: ' + e.message));
  req.write(body);
  req.end();
}

let tgOffset = 0;
async function pollTg() {
  try {
    const r = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/getUpdates?offset=${tgOffset}&timeout=10`,
        method: 'GET'
      }, rsp => {
        let d = '';
        rsp.on('data', c => d += c);
        rsp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });

    if (!r.ok || !r.result) return;

    for (const upd of r.result) {
      tgOffset = upd.update_id + 1;
      const text   = upd.message?.text || '';
      const chatId = upd.message?.chat?.id;
      if (String(chatId) !== String(CHAT_ID)) continue;

      // ── /help ──
      if (text === '/help') {
        tg(
          `📖 *突破系統指令列表*\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `/status   📊 系統狀態、持倉、資金\n` +
          `/positions 📋 詳細持倉資訊\n` +
          `/stats    🧠 AI學習統計\n` +
          `/sync     🔄 同步持倉（重啟後用）\n` +
          `/closeall ❌ 全部平倉\n` +
          `/help     📖 顯示此說明\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `*自動通知*\n` +
          `🚀 開倉（含進場強度/止損/止盈）\n` +
          `🎯 TP1/TP2/TP3 達成\n` +
          `✅/❌ 結單（含真實PnL）\n` +
          `🔓/🔒 翻倉模式開關\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `*翻倉條件*\n` +
          `開啟: 勝率≥60% + 資金≥100U\n` +
          `關閉: 勝率<40%`
        );
      }

      // ── /status ──
      if (text === '/status') {
        const posLines = Object.keys(positions).map(s => {
          const p = positions[s];
          return `  ${p.side === 'LONG' ? '📈' : '📉'} ${s} @${fmt(p.entryPrice)}`;
        }).join('\n') || '  (無持倉)';

        tg(
          `📊 *突破系統狀態*\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `資金: ${stats.capital.toFixed(2)}U\n` +
          `總PnL: ${stats.pnl >= 0 ? '+' : ''}${stats.pnl.toFixed(4)}U\n` +
          `勝率: ${(winRate()*100).toFixed(1)}% (${stats.wins}勝/${stats.losses}敗)\n` +
          `翻倉: ${stats.flipMode ? '✅全倉模式' : '❌逐倉模式'}\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `持倉 ${Object.keys(positions).length}/${MAX_POSITIONS}:\n${posLines}\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `下次翻倉開啟: 勝率${(winRate()*100).toFixed(1)}%/${(FLIP_WIN_RATE*100)}% 資金${stats.capital.toFixed(0)}U/${FLIP_CAPITAL}U`
        );
      }

      // ── /positions ──
      if (text === '/positions') {
        if (Object.keys(positions).length === 0) {
          tg('📋 目前無持倉');
        } else {
          for (const sym of Object.keys(positions)) {
            const p = positions[sym];
            const holdMin = Math.round((Date.now() - p.openTime) / 60000);
            tg(
              `📋 *${sym}*\n` +
              `方向: ${p.side === 'LONG' ? '做多 📈' : '做空 📉'}\n` +
              `進場: ${fmt(p.entryPrice)}\n` +
              `止損: ${p.sl > 0 ? fmt(p.sl) : '未設定'}\n` +
              `TP1: ${p.tp1 > 0 ? fmt(p.tp1) : '未設定'} ${p.tp1Done ? '✅' : '⏳'}\n` +
              `TP2: ${p.tp2 > 0 ? fmt(p.tp2) : '未設定'} ${p.tp2Done ? '✅' : '⏳'}\n` +
              `TP3: ${p.tp3 > 0 ? fmt(p.tp3) : '未設定'} ⏳\n` +
              `持倉: ${holdMin}分鐘\n` +
              `模式: ${p.flipMode ? '全倉' : '逐倉'}`
            );
          }
        }
      }

      // ── /sync ──
      if (text === '/sync') {
        await syncPositions();
        tg(`✅ 持倉已同步\n目前: ${Object.keys(positions).length}個`);
      }

      // ── /closeall ──
      if (text === '/closeall') {
        if (Object.keys(positions).length === 0) {
          tg('目前無持倉');
        } else {
          for (const sym of Object.keys(positions)) {
            const pos = positions[sym];
            try {
              const r2 = await bxReq('GET', '/openApi/swap/v2/user/positions', { symbol: sym });
              if (r2.code === 0 && r2.data) {
                const ap = r2.data.find(p => Math.abs(parseFloat(p.positionAmt || 0)) > 0);
                if (ap) {
                  const qty = Math.abs(parseFloat(ap.positionAmt));
                  await bxReq('POST', '/openApi/swap/v2/trade/order', {
                    symbol: sym,
                    side: pos.side === 'LONG' ? 'SELL' : 'BUY',
                    positionSide: pos.side,
                    type: 'MARKET',
                    quantity: String(qty)
                  });
                  await onPositionClosed(sym, pos, '手動全平');
                }
              }
            } catch(e) { log('ERROR', `平倉失敗 ${sym}: ${e.message}`); }
          }
          tg('✅ 全部持倉已平');
        }
      }

      // ── /stats ──
      if (text === '/stats') {
        const top = Object.entries(stats.symbolPerf)
          .filter(([, v]) => v.total >= 3)
          .sort((a, b) => b[1].pnl - a[1].pnl)
          .slice(0, 5)
          .map(([s, v]) => `  ${s}: ${v.wins}/${v.total} ${v.pnl >= 0 ? '+' : ''}${v.pnl.toFixed(2)}U`)
          .join('\n');

        const worst = Object.entries(stats.symbolPerf)
          .filter(([, v]) => v.total >= 3)
          .sort((a, b) => a[1].pnl - b[1].pnl)
          .slice(0, 3)
          .map(([s, v]) => `  ${s}: ${v.wins}/${v.total} ${v.pnl.toFixed(2)}U`)
          .join('\n');

        tg(
          `🧠 *AI學習統計*\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `總交易: ${stats.total} | 勝率: ${(winRate()*100).toFixed(1)}%\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `🏆 最佳幣種:\n${top || '  資料不足(需3筆以上)'}\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `⚠️ 最差幣種:\n${worst || '  資料不足'}`
        );
      }
    }
  } catch(e) {}
}

// ══════════════════════════════════
// 啟動
// ══════════════════════════════════
async function main() {
  log('INFO', '突破系統啟動');
  await syncPositions();

  tg(
    `🟢 *突破系統啟動*\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `資金: ${stats.capital.toFixed(2)}U\n` +
    `持倉: ${Object.keys(positions).length}個\n` +
    `翻倉: ${stats.flipMode ? '✅全倉' : '❌逐倉'}\n` +
    `勝率: ${(winRate()*100).toFixed(1)}% (${stats.wins}/${stats.total})\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `發送 /help 查看指令`
  );

  setInterval(scan, SCAN_INTERVAL_MS);
  setInterval(pollTg, 3000);

  await scan();
}

main().catch(e => {
  log('ERROR', '主程序崩潰: ' + e.message);
  process.exit(1);
});

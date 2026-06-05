'use strict';
const https = require('https');
const crypto = require('node:crypto');
const fs = require('fs');
const http = require('http');

// ══════════════════════════════════════════════════
// 環境設定
// ══════════════════════════════════════════════════
const BX_KEY    = process.env.BX_KEY    || 'YOUR_BINGX_API_KEY';
const BX_SECRET = process.env.BX_SECRET || 'YOUR_BINGX_SECRET';
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const CHAT_ID   = process.env.CHAT_ID   || 'YOUR_TELEGRAM_CHAT_ID';
const PORT      = process.env.PORT      || 3003;
const STATE_FILE = '/home/ubuntu/hades_state.json';

// ══════════════════════════════════════════════════
// 工具函數
// ══════════════════════════════════════════════════
function ts() {
  return new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
}
function log(level, msg) {
  console.log(`[${ts()}][HADES][${level}] ${msg}`);
}
function hourTW() {
  return (new Date().getUTCHours() + 8) % 24;
}
function todayKey() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}
function round(n, d) {
  return parseFloat(n.toFixed(d));
}
function pct(a, b) {
  return ((a - b) / b * 100).toFixed(2);
}

// ══════════════════════════════════════════════════
// 狀態管理
// ══════════════════════════════════════════════════
function defaultState() {
  return {
    running: true,
    capital: 50,
    leverage: 5,
    amount: 1,
    allowShort: true,
    maxPositions: 5,
    maxSameDir: 3,
    dailyLossPct: 5,
    symbols: [],
    openTrades: {},
    slCooldown: {},
    stats: {
      allTime: { total: 0, wins: 0, losses: 0, pnl: 0 },
      daily: {},
      trades: []
    }
  };
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch(e) {}
  }
  return defaultState();
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let state = loadState();

// ══════════════════════════════════════════════════
// BingX API
// ══════════════════════════════════════════════════
function bxReq(method, path, params) {
  params = params || {};
  return new Promise((resolve, reject) => {
    const p = { ...params, timestamp: Date.now() };
    const qs = Object.keys(p).sort()
      .filter(k => p[k] != null && p[k] !== '')
      .map(k => `${k}=${p[k]}`).join('&');
    const sig = crypto.createHmac('sha256', BX_SECRET).update(qs).digest('hex');
    const fullQs = qs + '&signature=' + sig;
    const opt = {
      hostname: 'open-api.bingx.com',
      path: path + '?' + fullQs,
      method,
      headers: { 'X-BX-APIKEY': BX_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }
    };
    const req = https.request(opt, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.slice(0, 80))); } });
    });
    req.on('error', e => setTimeout(() => reject(e), 1000));
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function bxPublic(path, params) {
  return new Promise((resolve, reject) => {
    const qs = params ? Object.keys(params).map(k => `${k}=${params[k]}`).join('&') : '';
    const fullPath = qs ? `${path}?${qs}` : path;
    const req = https.request({ hostname: 'open-api.bingx.com', path: fullPath, method: 'GET' }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ══════════════════════════════════════════════════
// Telegram API
// ══════════════════════════════════════════════════
function tgReq(payload) {
  return new Promise(resolve => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${payload.method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', () => resolve({}));
    req.write(body); req.end();
  });
}

function tgSend(chatId, text, extra) {
  return tgReq({ method: 'sendMessage', chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

function tgEdit(chatId, msgId, text, extra) {
  return tgReq({ method: 'editMessageText', chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', ...extra });
}

function tgAnswer(cbId, text) {
  return tgReq({ method: 'answerCallbackQuery', callback_query_id: cbId, text: text || '' });
}

function notify(msg) {
  return tgSend(CHAT_ID, msg);
}

// ══════════════════════════════════════════════════
// 技術指標
// ══════════════════════════════════════════════════
const I = {
  ema(arr, n) {
    if (arr.length < n) return null;
    const k = 2 / (n + 1);
    let e = arr.slice(0, n).reduce((s, v) => s + v, 0) / n;
    for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
    return e;
  },
  rsi(arr, n) {
    if (arr.length < n + 1) return null;
    let g = 0, l = 0;
    for (let i = arr.length - n; i < arr.length; i++) {
      const d = arr[i] - arr[i - 1];
      d > 0 ? g += d : l -= d;
    }
    return 100 - 100 / (1 + (g / n) / ((l / n) || 0.001));
  },
  atr(H, L, C, n) {
    if (!H || !L || !C || C.length < n + 1) return null;
    let t = [];
    for (let i = C.length - n; i < C.length; i++)
      t.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i-1]), Math.abs(L[i] - C[i-1])));
    return t.reduce((s, v) => s + v, 0) / n;
  },
  macd(arr) {
    const fast = I.ema(arr, 12);
    const slow = I.ema(arr, 26);
    const pFast = I.ema(arr.slice(0, -1), 12);
    const pSlow = I.ema(arr.slice(0, -1), 26);
    if (!fast || !slow || !pFast || !pSlow) return null;
    return { macd: fast - slow, prev: pFast - pSlow };
  }
};

// ══════════════════════════════════════════════════
// 策略分析（三重確認）
// ══════════════════════════════════════════════════
// 1. Hades EMA 排列（主信號）
function analyzeHades(closes, highs, lows) {
  const result = { signal: 'NONE', score: 0, detail: '', strength: 0 };
  if (closes.length < 200) return result;

  const e9   = I.ema(closes, 9);
  const e20  = I.ema(closes, 20);
  const e50  = I.ema(closes, 50);
  const e200 = I.ema(closes, 200);
  const rsi  = I.rsi(closes, 14) || 50;
  const cur  = closes[closes.length - 1];

  if (!e9 || !e20 || !e50 || !e200) return result;

  const nearE50 = Math.abs(cur - e50) / e50 < 0.012;

  // 多頭排列：e9 > e20 > e50 > e200，價格在 e9 之上
  if (e9 > e20 && e20 > e50 && e50 > e200 && cur > e9 && rsi > 45 && rsi < 80) {
    result.signal = 'BUY';
    result.score = 3;
    // 靠近e50 = 更好的入場點
    if (nearE50) result.score += 1;
    result.detail = `多頭排列 EMA9>${e9.toFixed(2)} EMA20>${e20.toFixed(2)} EMA50>${e50.toFixed(2)} EMA200>${e200.toFixed(2)}`;
  }

  // 空頭排列：e9 < e20 < e50 < e200，價格在 e9 之下
  if (e9 < e20 && e20 < e50 && e50 < e200 && cur < e9 && rsi > 20 && rsi < 55) {
    result.signal = 'SELL';
    result.score = -3;
    if (nearE50) result.score -= 1;
    result.detail = `空頭排列 EMA9<${e9.toFixed(2)} EMA20<${e20.toFixed(2)} EMA50<${e50.toFixed(2)} EMA200<${e200.toFixed(2)}`;
  }

  result.strength = Math.abs(result.score);
  return result;
}

// 2. 賽克斯 Wyckoff 結構確認
function analyzeWyckoff(closes, highs, lows, vols) {
  const result = { confirm: false, score: 0, detail: '' };
  if (closes.length < 30) return result;

  const last = closes.length - 1;
  const cur = closes[last];
  const prev = closes[last - 1];
  const support = Math.min(...lows.slice(-30, -1));
  const resistance = Math.max(...highs.slice(-30, -1));
  const avgVol = vols.slice(-20, -1).reduce((s, v) => s + v, 0) / 19;
  const volSpike = vols[last] > avgVol * 1.2;
  const rsi = I.rsi(closes, 14) || 50;

  // 強勢突破（SOS）= 多頭確認
  if (cur > resistance && prev <= resistance && volSpike && rsi > 52) {
    result.score += 2; result.detail = 'Wyckoff SOS突破阻力';
  }
  // 彈簧（Spring）= 多頭確認
  if (lows[last-1] < support * 1.001 && cur > support && cur > prev && volSpike && rsi < 50) {
    result.score += 2; result.detail = 'Wyckoff Spring彈簧';
  }
  // 弱勢跌破（SOW）= 空頭確認
  if (cur < support && prev >= support && volSpike && rsi < 48) {
    result.score -= 2; result.detail = 'Wyckoff SOW跌破支撐';
  }
  // 推力（Upthrust）= 空頭確認
  if (highs[last-1] > resistance * 0.999 && cur < resistance && cur < prev && volSpike && rsi > 50) {
    result.score -= 2; result.detail = 'Wyckoff Upthrust推力';
  }

  result.confirm = result.score !== 0;
  return result;
}

// 3. MACD 突破確認
function analyzeBreakout(closes, highs, lows) {
  const result = { confirm: false, score: 0, detail: '' };
  if (closes.length < 50) return result;

  const m = I.macd(closes);
  const e20 = I.ema(closes, 20);
  const e60 = I.ema(closes, 60);
  const rsi = I.rsi(closes, 14) || 50;

  if (!m || !e20 || !e60) return result;

  // MACD 金叉 = 多頭
  if (m.prev < 0 && m.macd > 0 && e20 > e60 && rsi > 45 && rsi < 75) {
    result.score += 1; result.detail = 'MACD金叉';
  }
  // MACD 死叉 = 空頭
  if (m.prev > 0 && m.macd < 0 && e20 < e60 && rsi < 55 && rsi > 25) {
    result.score -= 1; result.detail = 'MACD死叉';
  }
  // MACD 持續多頭
  if (m.macd > 0 && m.macd > m.prev && e20 > e60) {
    result.score += 0.5; result.detail += ' +動能';
  }
  // MACD 持續空頭
  if (m.macd < 0 && m.macd < m.prev && e20 < e60) {
    result.score -= 0.5; result.detail += ' +動能';
  }

  result.confirm = result.score !== 0;
  return result;
}

// 三重確認整合
function tripleConfirm(closes, highs, lows, vols) {
  const hades    = analyzeHades(closes, highs, lows);
  const wyckoff  = analyzeWyckoff(closes, highs, lows, vols);
  const breakout = analyzeBreakout(closes, highs, lows);

  if (hades.signal === 'NONE') return { signal: 'NONE', score: 0, reasons: [] };

  const dir = hades.signal === 'BUY' ? 1 : -1;

  // 賽克斯方向一致 且 突破確認方向一致 才通過
  const wyckoffOk  = wyckoff.score * dir > 0;
  const breakoutOk = breakout.score * dir > 0;

  if (!wyckoffOk && !breakoutOk) return { signal: 'NONE', score: 0, reasons: ['三重確認未通過'] };

  const totalScore = hades.score + wyckoff.score + breakout.score;
  const reasons = [hades.detail, wyckoff.detail, breakout.detail].filter(Boolean);

  return {
    signal: hades.signal,
    score: totalScore,
    hadesScore: hades.score,
    wyckoffScore: wyckoff.score,
    breakoutScore: breakout.score,
    strength: Math.abs(totalScore),
    reasons,
    wyckoffOk,
    breakoutOk
  };
}

// ══════════════════════════════════════════════════
// 取市值前200幣種（獵人掃描）
// ══════════════════════════════════════════════════
const BLACKLIST = ['NCSK', 'NCSI', 'NCCO', 'BABYSHARK', 'HOOLI', 'BROCCOLIF3B', '1000000BOB', 'SWARMS', 'KOMA', 'PRL'];

async function getTop200Symbols() {
  try {
    const r = await bxPublic('/openApi/swap/v2/quote/contracts');
    if (r.code === 0 && r.data) {
      const syms = r.data.filter(s => {
        if (!s.symbol || !s.symbol.endsWith('-USDT')) return false;
        const name = s.symbol.replace('-USDT', '');
        return !BLACKLIST.some(b => name.startsWith(b));
      });
      syms.sort((a, b) => parseFloat(b.volume || 0) - parseFloat(a.volume || 0));
      return syms.slice(0, 200).map(s => s.symbol);
    }
  } catch(e) { log('WARN', '取幣種失敗: ' + e.message); }
  return ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'XRP-USDT', 'DOGE-USDT',
          'ADA-USDT', 'SUI-USDT', 'HYPE-USDT', 'WIF-USDT', 'RUNE-USDT'];
}

// ══════════════════════════════════════════════════
// 交易所操作
// ══════════════════════════════════════════════════
async function getPrice(sym) {
  const r = await bxPublic('/openApi/swap/v2/quote/ticker', { symbol: sym });
  return parseFloat(r?.data?.lastPrice || 0);
}

async function getBalance() {
  const r = await bxReq('GET', '/openApi/swap/v2/user/balance', {});
  if (r.code === 0) return parseFloat(r.data.balance.availableMargin || 0);
  return 0;
}

async function getKlines(sym, tf, limit) {
  try {
    const r = await bxReq('GET', '/openApi/swap/v2/quote/klines', { symbol: sym, interval: tf || '1h', limit: limit || 210 });
    if (r.code === 0 && Array.isArray(r.data)) return r.data;
  } catch(e) {}
  return [];
}

async function setLeverage(sym, lev) {
  for (const side of ['LONG', 'SHORT']) {
    try { await bxReq('POST', '/openApi/swap/v2/trade/leverage', { symbol: sym, side, leverage: lev }); } catch(e) {}
  }
}

async function placeOrder(sym, side, posSide, qty, sl, tp, lev) {
  await setLeverage(sym, lev);
  const r = await bxReq('POST', '/openApi/swap/v2/trade/order', {
    symbol: sym, side, positionSide: posSide, type: 'MARKET', quantity: String(qty)
  });
  if (r.code !== 0) throw new Error('開單失敗: ' + r.msg);
  await new Promise(res => setTimeout(res, 1000));
  const execQty   = parseFloat(r.data.order.executedQty || qty);
  const execPrice = parseFloat(r.data.order.avgPrice || 0);
  const closeSide = posSide === 'LONG' ? 'SELL' : 'BUY';
  if (sl && execQty > 0)
    await bxReq('POST', '/openApi/swap/v2/trade/order', {
      symbol: sym, side: closeSide, positionSide: posSide,
      type: 'STOP_MARKET', stopPrice: String(sl), quantity: String(execQty), workingType: 'MARK_PRICE'
    }).catch(() => {});
  if (tp && execQty > 0)
    await bxReq('POST', '/openApi/swap/v2/trade/order', {
      symbol: sym, side: closeSide, positionSide: posSide,
      type: 'TAKE_PROFIT_MARKET', stopPrice: String(tp), quantity: String(execQty), workingType: 'MARK_PRICE'
    }).catch(() => {});
  return { qty: execQty, price: execPrice };
}

async function cancelAllOrders(sym, ps) {
  try {
    const r = await bxReq('GET', '/openApi/swap/v2/trade/openOrders', { symbol: sym });
    if (r.code === 0 && r.data?.orders) {
      for (const o of r.data.orders.filter(o => o.positionSide === ps)) {
        await bxReq('POST', '/openApi/swap/v2/trade/cancel', { symbol: sym, orderId: o.orderId }).catch(() => {});
        await new Promise(r => setTimeout(r, 200));
      }
    }
  } catch(e) {}
}

async function getPositions(sym) {
  try {
    const r = await bxReq('GET', '/openApi/swap/v2/user/positions', sym ? { symbol: sym } : {});
    if (r.code === 0) return (r.data || []).filter(p => parseFloat(p.positionAmt || 0) !== 0);
  } catch(e) {}
  return [];
}

async function getRealPnl(sym, openTime) {
  try {
    const r = await bxReq('GET', '/openApi/swap/v2/user/income', { limit: 50, startTime: String(openTime - 3600000) });
    if (r.code === 0 && r.data?.length > 0) {
      const items = r.data.filter(o =>
        o.symbol === sym && parseInt(o.time || 0) > openTime &&
        (o.incomeType === 'REALIZED_PNL' || o.incomeType === 'TRADING_FEE')
      );
      if (items.length > 0) return items.reduce((s, o) => s + parseFloat(o.income || 0), 0);
    }
  } catch(e) {}
  return null;
}

// ══════════════════════════════════════════════════
// 統計記錄
// ══════════════════════════════════════════════════
function recordTrade(sym, side, pnl, holdMin) {
  const today = todayKey();
  if (!state.stats.daily[today])
    state.stats.daily[today] = { total: 0, wins: 0, losses: 0, pnl: 0 };
  const d = state.stats.daily[today];
  d.total++; pnl > 0 ? d.wins++ : d.losses++; d.pnl = round(d.pnl + pnl, 4);
  state.stats.allTime.total++;
  pnl > 0 ? state.stats.allTime.wins++ : state.stats.allTime.losses++;
  state.stats.allTime.pnl = round(state.stats.allTime.pnl + pnl, 4);
  state.capital = round(state.capital + pnl, 4);
  state.stats.trades.push({ symbol: sym, side, pnl, holdMin, date: today, time: Date.now() });
  if (state.stats.trades.length > 500) state.stats.trades = state.stats.trades.slice(-500);
  saveState();
}

// ══════════════════════════════════════════════════
// 開單通知（詳細版）
// ══════════════════════════════════════════════════
function buildOpenMsg(sym, sig, entry, sl, tp1, tp2, tp3, qty, lev) {
  const dir   = sig.signal === 'BUY';
  const emoji = dir ? '🟢' : '🔴';
  const dirTxt = dir ? '多單 LONG' : '空單 SHORT';
  const slDist = Math.abs(entry - sl);
  const slPct  = (slDist / entry * 100).toFixed(2);
  const tp1Pct = (Math.abs(entry - tp1) / entry * 100).toFixed(2);
  const notional = round(qty * entry, 2);

  // 強度視覺化
  const bars = '█'.repeat(Math.min(sig.strength, 5)) + '░'.repeat(Math.max(0, 5 - sig.strength));
  const hadesBar  = Math.abs(sig.hadesScore || 0);
  const wyckBar   = Math.abs(sig.wyckoffScore || 0);
  const brkBar    = Math.abs(sig.breakoutScore || 0);

  let msg = `╔═══════════════════════╗\n`;
  msg += `║  ${emoji} HADES 開倉通知  ${emoji}  ║\n`;
  msg += `╚═══════════════════════╝\n\n`;
  msg += `<b>幣種：</b>${sym}\n`;
  msg += `<b>方向：</b>${emoji} ${dirTxt}\n`;
  msg += `<b>槓桿：</b>${lev}x　<b>數量：</b>${qty}（名目 ${notional}U）\n\n`;
  msg += `━━━ 價位 ━━━\n`;
  msg += `📍 入場：<b>${entry}</b>\n`;
  msg += `🛑 止損：<code>${sl}</code>（-${slPct}%）\n`;
  msg += `🎯 TP1：<code>${tp1}</code>（+${tp1Pct}% | RR 1:1）\n`;
  if (tp2) msg += `🎯 TP2：<code>${tp2}</code>（+${(Math.abs(entry-tp2)/entry*100).toFixed(2)}% | RR 1:2）\n`;
  if (tp3) msg += `🎯 TP3：<code>${tp3}</code>（+${(Math.abs(entry-tp3)/entry*100).toFixed(2)}% | RR 1:3）\n`;
  msg += `\n━━━ 三重確認分析 ━━━\n`;
  msg += `🗡️ Hades EMA：  ${bars} ${sig.hadesScore >= 0 ? '+' : ''}${sig.hadesScore || 0}\n`;
  msg += `🏛️ Wyckoff結構：${bars} ${sig.wyckoffScore >= 0 ? '+' : ''}${sig.wyckoffScore || 0}\n`;
  msg += `⚡ MACD突破：   ${bars} ${sig.breakoutScore >= 0 ? '+' : ''}${sig.breakoutScore || 0}\n`;
  msg += `📊 總分：<b>${sig.score >= 0 ? '+' : ''}${sig.score}</b>　強度：[${bars}]\n\n`;
  msg += `━━━ 信號依據 ━━━\n`;
  sig.reasons.forEach(r => msg += `• ${r}\n`);
  msg += `\n⏰ ${ts()}`;
  return msg;
}

function buildCloseMsg(t, pnl, holdMin, cur) {
  const win   = pnl >= 0;
  const emoji = win ? '✅' : '❌';
  const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + 'U';
  const pctStr = (pnl >= 0 ? '+' : '') + ((pnl / state.amount) * 100).toFixed(1) + '%';
  const today  = todayKey();
  const d      = state.stats.daily[today] || { pnl: 0, total: 0, wins: 0 };

  let msg = `${emoji} <b>HADES 平倉</b>\n\n`;
  msg += `<b>幣種：</b>${t.symbol}　${t.side === 'LONG' ? '🟢多' : '🔴空'}\n`;
  msg += `<b>入場：</b>${t.entry}　<b>出場：</b>${cur || '—'}\n`;
  msg += `<b>持倉：</b>${holdMin} 分鐘\n\n`;
  msg += `💰 本次PnL：<b>${pnlStr}</b>（${pctStr}）\n\n`;
  msg += `━━━ 今日戰績 ━━━\n`;
  msg += `筆數：${d.total}　WR：${d.total > 0 ? (d.wins / d.total * 100).toFixed(0) : 0}%\n`;
  msg += `今日PnL：${d.pnl >= 0 ? '+' : ''}${(d.pnl).toFixed(4)}U\n`;
  msg += `本金：${state.capital.toFixed(2)}U\n`;
  msg += `\n⏰ ${ts()}`;
  return msg;
}

// ══════════════════════════════════════════════════
// Telegram 選單（Inline Keyboard）
// ══════════════════════════════════════════════════
const MENUS = {
  main: {
    text: () => {
      const at  = state.stats.allTime;
      const wr  = at.total > 0 ? (at.wins / at.total * 100).toFixed(1) : '0.0';
      const today = todayKey();
      const d   = state.stats.daily[today] || { total: 0, wins: 0, pnl: 0 };
      const dwr = d.total > 0 ? (d.wins / d.total * 100).toFixed(0) : '0';
      const openCount = Object.keys(state.openTrades).length;
      const statusIcon = state.running ? '🟢 運行中' : '🔴 已停止';

      return `🗡️ <b>HADES 三重確認機器人</b>\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `狀態：${statusIcon}\n` +
        `本金：<b>${state.capital.toFixed(2)}U</b>　槓桿：${state.leverage}x\n` +
        `持倉：${openCount}/${state.maxPositions}　幣種：${state.symbols.length}\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `今日 ${d.total}筆  WR ${dwr}%  PnL ${d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(4)}U\n` +
        `累計 ${at.total}筆  WR ${wr}%  PnL ${at.pnl >= 0 ? '+' : ''}${at.pnl.toFixed(4)}U\n` +
        `━━━━━━━━━━━━━━━━━\n` +
        `<i>選擇功能：</i>`;
    },
    keyboard: () => ({
      inline_keyboard: [
        [
          { text: state.running ? '⏹ 停止交易' : '▶️ 啟動交易', callback_data: 'toggle_run' },
          { text: '🔄 同步持倉', callback_data: 'sync' }
        ],
        [
          { text: '📊 持倉狀態', callback_data: 'positions' },
          { text: '📈 今日戰績', callback_data: 'today_stats' }
        ],
        [
          { text: '🔍 掃描市場', callback_data: 'scan' },
          { text: '⚙️ 設定', callback_data: 'settings' }
        ],
        [
          { text: '📜 近期交易', callback_data: 'recent_trades' },
          { text: '🏆 最佳幣種', callback_data: 'best_symbols' }
        ],
        [
          { text: '❓ 策略說明', callback_data: 'strategy_info' }
        ]
      ]
    })
  }
};

async function showMenu(chatId, msgId) {
  const text = MENUS.main.text();
  const replyMarkup = MENUS.main.keyboard();
  if (msgId) {
    await tgEdit(chatId, msgId, text, { reply_markup: replyMarkup });
  } else {
    await tgSend(chatId, text, { reply_markup: replyMarkup });
  }
}

// ══════════════════════════════════════════════════
// Callback 處理
// ══════════════════════════════════════════════════
async function handleCallback(cbq) {
  const data   = cbq.data;
  const chatId = cbq.message.chat.id;
  const msgId  = cbq.message.message_id;

  await tgAnswer(cbq.id);

  if (data === 'main') { await showMenu(chatId, msgId); return; }

  if (data === 'toggle_run') {
    state.running = !state.running;
    saveState();
    await showMenu(chatId, msgId);
    return;
  }

  if (data === 'sync') {
    await tgEdit(chatId, msgId, '🔄 同步中...', {});
    await syncPositions();
    await showMenu(chatId, msgId);
    return;
  }

  if (data === 'scan') {
    await tgEdit(chatId, msgId, '🔍 掃描市值前200幣種...', {});
    const syms = await getTop200Symbols();
    state.symbols = syms;
    saveState();
    await tgEdit(chatId, msgId,
      `✅ 掃描完成！\n載入 <b>${syms.length}</b> 個幣種\n` +
      `前10名：${syms.slice(0,10).map(s=>s.replace('-USDT','')).join(', ')}\n\n` +
      `⏰ ${ts()}`,
      { reply_markup: { inline_keyboard: [[{ text: '← 返回', callback_data: 'main' }]] } }
    );
    return;
  }

  if (data === 'positions') {
    const keys = Object.keys(state.openTrades);
    if (keys.length === 0) {
      await tgEdit(chatId, msgId,
        `📊 <b>目前持倉</b>\n\n目前無持倉`,
        { reply_markup: { inline_keyboard: [[{ text: '← 返回', callback_data: 'main' }]] } }
      );
      return;
    }
    let msg = `📊 <b>目前持倉</b>（${keys.length}/${state.maxPositions}）\n━━━━━━━━━━━━━━━━━\n`;
    for (const k of keys) {
      const t = state.openTrades[k];
      if (!t) continue;
      const holdMin = Math.round((Date.now() - t.openTime) / 60000);
      let cur = 0;
      try { cur = await getPrice(t.symbol); } catch(e) {}
      const pctChg = cur ? (t.side === 'LONG' ? pct(cur, t.entry) : pct(t.entry, cur)) : '—';
      const pnlEst = cur ? round((t.side === 'LONG' ? cur - t.entry : t.entry - cur) * t.qty, 4) : 0;
      const dirIcon = t.side === 'LONG' ? '🟢' : '🔴';
      msg += `${dirIcon} <b>${t.symbol}</b>（${t.side}）\n`;
      msg += `   入場：${t.entry}　現價：${cur || '?'}\n`;
      msg += `   損益：${pnlEst >= 0 ? '+' : ''}${pnlEst}U（${pctChg}%）　持倉：${holdMin}min\n`;
      msg += `   SL：${t.stopLoss || '—'}　TP1：${t.takeProfit || '—'}\n`;
      msg += `━━━━━━━━━━━━━━━━━\n`;
    }
    await tgEdit(chatId, msgId, msg, {
      reply_markup: { inline_keyboard: [[{ text: '🔄 刷新', callback_data: 'positions' }, { text: '← 返回', callback_data: 'main' }]] }
    });
    return;
  }

  if (data === 'today_stats') {
    const today = todayKey();
    const d = state.stats.daily[today] || { total: 0, wins: 0, losses: 0, pnl: 0 };
    const wr = d.total > 0 ? (d.wins / d.total * 100).toFixed(1) : '0.0';
    const at = state.stats.allTime;
    const awr = at.total > 0 ? (at.wins / at.total * 100).toFixed(1) : '0.0';
    const msg =
      `📈 <b>今日戰績</b>（${today}）\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `總筆數：${d.total}　勝：${d.wins}　敗：${d.losses}\n` +
      `勝率：<b>${wr}%</b>\n` +
      `今日PnL：<b>${d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(4)}U</b>\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `📊 累計統計\n` +
      `總筆數：${at.total}　WR：<b>${awr}%</b>\n` +
      `累計PnL：<b>${at.pnl >= 0 ? '+' : ''}${at.pnl.toFixed(4)}U</b>\n` +
      `當前本金：<b>${state.capital.toFixed(2)}U</b>\n` +
      `\n⏰ ${ts()}`;
    await tgEdit(chatId, msgId, msg, {
      reply_markup: { inline_keyboard: [[{ text: '← 返回', callback_data: 'main' }]] }
    });
    return;
  }

  if (data === 'recent_trades') {
    const trades = state.stats.trades.slice(-10).reverse();
    if (trades.length === 0) {
      await tgEdit(chatId, msgId, `📜 尚無交易記錄`,
        { reply_markup: { inline_keyboard: [[{ text: '← 返回', callback_data: 'main' }]] } });
      return;
    }
    let msg = `📜 <b>近10筆交易</b>\n━━━━━━━━━━━━━━━━━\n`;
    trades.forEach((t, i) => {
      const icon = t.pnl >= 0 ? '✅' : '❌';
      const dirIcon = t.side === 'LONG' ? '🟢' : '🔴';
      msg += `${i + 1}. ${icon}${dirIcon} ${t.symbol.replace('-USDT', '')}\n`;
      msg += `   PnL：${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(4)}U　持倉：${t.holdMin}min\n`;
    });
    await tgEdit(chatId, msgId, msg, {
      reply_markup: { inline_keyboard: [[{ text: '← 返回', callback_data: 'main' }]] }
    });
    return;
  }

  if (data === 'best_symbols') {
    const trades = state.stats.trades;
    const symMap = {};
    trades.forEach(t => {
      if (!symMap[t.symbol]) symMap[t.symbol] = { wins: 0, losses: 0, pnl: 0, total: 0 };
      symMap[t.symbol].total++;
      t.pnl > 0 ? symMap[t.symbol].wins++ : symMap[t.symbol].losses++;
      symMap[t.symbol].pnl += t.pnl;
    });
    const sorted = Object.entries(symMap).sort((a, b) => b[1].pnl - a[1].pnl).slice(0, 8);
    if (sorted.length === 0) {
      await tgEdit(chatId, msgId, `🏆 尚無足夠數據`,
        { reply_markup: { inline_keyboard: [[{ text: '← 返回', callback_data: 'main' }]] } });
      return;
    }
    let msg = `🏆 <b>最佳幣種排名</b>\n━━━━━━━━━━━━━━━━━\n`;
    sorted.forEach(([sym, s], i) => {
      const wr = (s.wins / s.total * 100).toFixed(0);
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
      msg += `${medal} ${sym.replace('-USDT', '')}\n`;
      msg += `   WR：${wr}%  PnL：${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(3)}U  (${s.total}筆)\n`;
    });
    await tgEdit(chatId, msgId, msg, {
      reply_markup: { inline_keyboard: [[{ text: '← 返回', callback_data: 'main' }]] }
    });
    return;
  }

  if (data === 'settings') {
    const msg =
      `⚙️ <b>目前設定</b>\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `本金：${state.capital.toFixed(2)}U\n` +
      `每單金額：${state.amount}U\n` +
      `槓桿：${state.leverage}x\n` +
      `最大持倉：${state.maxPositions}個\n` +
      `同向上限：${state.maxSameDir}個\n` +
      `允許做空：${state.allowShort ? '✅ 是' : '❌ 否'}\n` +
      `每日虧損上限：${state.dailyLossPct}%\n` +
      `━━━━━━━━━━━━━━━━━\n` +
      `<i>修改設定請使用指令：</i>\n` +
      `/set_amount 金額\n/set_lev 槓桿\n/set_short on|off`;
    await tgEdit(chatId, msgId, msg, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: state.allowShort ? '🔴 關閉做空' : '🟢 開啟做空', callback_data: 'toggle_short' }
          ],
          [{ text: '← 返回', callback_data: 'main' }]
        ]
      }
    });
    return;
  }

  if (data === 'toggle_short') {
    state.allowShort = !state.allowShort;
    saveState();
    await handleCallback({ ...cbq, data: 'settings' });
    return;
  }

  if (data === 'strategy_info') {
    const msg =
      `🗡️ <b>HADES 三重確認策略</b>\n` +
      `━━━━━━━━━━━━━━━━━\n\n` +
      `<b>1️⃣ 獵人掃描（市場篩選）</b>\n` +
      `• 掃描市值前200幣種\n` +
      `• 過濾低流動性及問題幣\n\n` +
      `<b>2️⃣ Hades EMA（主信號）</b>\n` +
      `• 多頭：EMA9 > EMA20 > EMA50 > EMA200\n` +
      `• 空頭：EMA9 < EMA20 < EMA50 < EMA200\n` +
      `• 靠近EMA50 = 最佳入場點\n\n` +
      `<b>3️⃣ Wyckoff 結構確認</b>\n` +
      `• SOS/彈簧 = 多頭確認\n` +
      `• SOW/推力 = 空頭確認\n` +
      `• 需成交量配合\n\n` +
      `<b>4️⃣ MACD 突破確認</b>\n` +
      `• 金叉/死叉 + MA方向一致\n\n` +
      `<b>🛡️ 風控機制</b>\n` +
      `• 三重確認必須≥2個通過\n` +
      `• 止損：ATR×3 或 1.5%\n` +
      `• TP1/TP2/TP3（RR 1:1~1:3）\n` +
      `• 移動止損保護利潤\n` +
      `• 每日最大虧損${state.dailyLossPct}%`;
    await tgEdit(chatId, msgId, msg, {
      reply_markup: { inline_keyboard: [[{ text: '← 返回', callback_data: 'main' }]] }
    });
    return;
  }
}

// ══════════════════════════════════════════════════
// 指令處理
// ══════════════════════════════════════════════════
async function handleCmd(text, chatId) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (cmd === '/start' || cmd === '/menu') {
    await showMenu(chatId, null);
    return;
  }
  if (cmd === '/set_amount' && parts[1]) {
    const v = parseFloat(parts[1]);
    if (v > 0) { state.amount = v; saveState(); await tgSend(chatId, `✅ 每單金額設為 ${v}U`); }
    return;
  }
  if (cmd === '/set_lev' && parts[1]) {
    const v = parseInt(parts[1]);
    if (v > 0 && v <= 125) { state.leverage = v; saveState(); await tgSend(chatId, `✅ 槓桿設為 ${v}x`); }
    return;
  }
  if (cmd === '/set_short') {
    state.allowShort = parts[1] === 'on';
    saveState();
    await tgSend(chatId, `✅ 做空 ${state.allowShort ? '開啟' : '關閉'}`);
    return;
  }
  if (cmd === '/sync') {
    await syncPositions();
    await showMenu(chatId, null);
    return;
  }
}

// ══════════════════════════════════════════════════
// 同步持倉
// ══════════════════════════════════════════════════
async function syncPositions() {
  try {
    const pos = await getPositions();
    if (!pos || pos.length === 0) { state.openTrades = {}; saveState(); return; }
    const newTrades = {};
    pos.forEach(p => {
      const sym = p.symbol, side = p.positionSide;
      const qty = Math.abs(parseFloat(p.positionAmt));
      const entry = parseFloat(p.avgPrice);
      const key = sym + '_' + (side === 'LONG' ? 'L' : 'S');
      newTrades[key] = {
        symbol: sym, side, entry, qty,
        openTime: Date.now() - 3600000,
        stopLoss: 0, takeProfit: 0,
        trailLevel: 0, tpPhase: 1
      };
    });
    state.openTrades = newTrades;
    saveState();
    log('INFO', `同步 ${pos.length} 個持倉`);
    notify(`🔄 同步完成！${pos.length} 個持倉\n本金：${state.capital.toFixed(2)}U`);
  } catch(e) { log('WARN', '同步失敗: ' + e.message); }
}

// ══════════════════════════════════════════════════
// 主交易循環
// ══════════════════════════════════════════════════
async function tradingLoop() {
  while (true) {
    try {
      if (!state.running) { await sleep(30000); continue; }

      const h = hourTW();
      if (h >= 2 && h < 6) { await sleep(60000); continue; }

      const today = todayKey();
      const todayPnl = (state.stats.daily[today]?.pnl) || 0;
      if (todayPnl < -state.capital * state.dailyLossPct / 100) {
        log('INFO', '今日虧損達上限');
        await sleep(300000); continue;
      }

      const balance = await getBalance().catch(() => 0);
      if (balance < state.amount) { await sleep(60000); continue; }

      for (const sym of state.symbols) {
        if (Object.keys(state.openTrades).length >= state.maxPositions) break;
        if (!state.running) break;

        // 已有此幣種持倉跳過
        if (Object.keys(state.openTrades).some(k => k.indexOf(sym) === 0)) continue;

        // 止損冷卻
        if (state.slCooldown[sym] && Date.now() - state.slCooldown[sym] < 3600000) continue;

        // 取K線
        const kl = await getKlines(sym, '1h', 210);
        if (!kl || kl.length < 200) continue;
        const closes = kl.map(k => parseFloat(k[4] || k.close || 0));
        const highs  = kl.map(k => parseFloat(k[2] || k.high  || 0));
        const lows_  = kl.map(k => parseFloat(k[3] || k.low   || 0));
        const vols   = kl.map(k => parseFloat(k[5] || k.volume || 0));

        const sig = tripleConfirm(closes, highs, lows_, vols);
        if (sig.signal === 'NONE') continue;
        if (sig.strength < 3) continue; // 最低強度門檻

        // 方向限制
        const longCnt  = Object.values(state.openTrades).filter(t => t.side === 'LONG').length;
        const shortCnt = Object.values(state.openTrades).filter(t => t.side === 'SHORT').length;
        if (sig.signal === 'BUY'  && longCnt  >= state.maxSameDir) continue;
        if (sig.signal === 'SELL' && shortCnt >= state.maxSameDir) continue;
        if (sig.signal === 'SELL' && !state.allowShort) continue;

        const cur = closes[closes.length - 1];
        const atrV = I.atr(highs, lows_, closes, 14) || cur * 0.02;
        const posSide = sig.signal === 'BUY' ? 'LONG' : 'SHORT';
        const orderSide = sig.signal === 'BUY' ? 'BUY' : 'SELL';
        const slDist = Math.max(atrV * 3, cur * 0.015);
        const slP = sig.signal === 'BUY' ? round(cur - slDist, 6) : round(cur + slDist, 6);
        const tp1 = sig.signal === 'BUY' ? round(cur + slDist * 1.0, 6) : round(cur - slDist * 1.0, 6);
        const tp2 = sig.signal === 'BUY' ? round(cur + slDist * 2.0, 6) : round(cur - slDist * 2.0, 6);
        const tp3 = sig.signal === 'BUY' ? round(cur + slDist * 3.0, 6) : round(cur - slDist * 3.0, 6);

        const notional = state.amount * state.leverage;
        let qty = parseFloat((notional / cur).toFixed(1));
        if (qty <= 0) qty = parseFloat((notional / cur).toFixed(2));
        if (qty <= 0) qty = parseFloat((notional / cur).toFixed(3));

        try {
          const lo = await placeOrder(sym, orderSide, posSide, qty, slP, tp1, state.leverage);
          const key = sym + '_' + (sig.signal === 'BUY' ? 'L' : 'S');
          state.openTrades[key] = {
            symbol: sym, side: posSide,
            entry: lo.price || cur, qty: lo.qty || qty,
            openTime: Date.now(),
            stopLoss: slP, takeProfit: tp1, tp2, tp3,
            tpPhase: 1, trailLevel: 0
          };
          saveState();
          notify(buildOpenMsg(sym, sig, lo.price || cur, slP, tp1, tp2, tp3, lo.qty || qty, state.leverage));
          log('INFO', `開倉 ${sym} ${sig.signal} score:${sig.score}`);
        } catch(e) {
          log('ERROR', `${sym} 開單失敗: ${e.message}`);
        }

        await sleep(2000);
      }
    } catch(e) { log('ERROR', 'tradingLoop: ' + e.message); }
    await sleep(60000);
  }
}

// ══════════════════════════════════════════════════
// 持倉監控
// ══════════════════════════════════════════════════
const closedCache = {};

async function checkPositions() {
  while (true) {
    try {
      for (const key of Object.keys(state.openTrades)) {
        const t = state.openTrades[key];
        if (!t?.symbol) continue;

        try {
          const pos = await getPositions(t.symbol);
          const stillOpen = pos.some(p => p.positionSide === t.side && parseFloat(p.positionAmt || 0) !== 0);
          const holdMin   = Math.round((Date.now() - t.openTime) / 60000);
          const cur       = await getPrice(t.symbol);
          if (!cur) continue;

          const estPct = t.side === 'LONG' ? parseFloat(pct(cur, t.entry)) : parseFloat(pct(t.entry, cur));

          // 移動止損
          if (estPct > 0.2 && !t.flipMode) {
            const newTrailLevel = Math.floor(estPct / 5);
            if (newTrailLevel > (t.trailLevel || 0) && newTrailLevel >= 1) {
              t.trailLevel = newTrailLevel;
              const lockPct = Math.max(0, (newTrailLevel - 1) * 5 + 2);
              const newSl = t.side === 'LONG'
                ? round(t.entry * (1 + lockPct / 100), 6)
                : round(t.entry * (1 - lockPct / 100), 6);
              try {
                await cancelAllOrders(t.symbol, t.side);
                await sleep(500);
                const closeSide = t.side === 'LONG' ? 'SELL' : 'BUY';
                const nextTp = t.tpPhase === 1 ? t.tp2 : t.tp3;
                if (nextTp) {
                  await bxReq('POST', '/openApi/swap/v2/trade/order', {
                    symbol: t.symbol, side: closeSide, positionSide: t.side,
                    type: 'STOP_MARKET', stopPrice: String(newSl),
                    quantity: String(t.qty), workingType: 'MARK_PRICE'
                  }).catch(() => {});
                  await bxReq('POST', '/openApi/swap/v2/trade/order', {
                    symbol: t.symbol, side: closeSide, positionSide: t.side,
                    type: 'TAKE_PROFIT_MARKET', stopPrice: String(nextTp),
                    quantity: String(round(t.qty / 3, 3)), workingType: 'MARK_PRICE'
                  }).catch(() => {});
                }
                t.stopLoss = newSl;
                saveState();
                notify(`🗡️ 移動止損 ${t.symbol}\n獲利：+${estPct.toFixed(1)}%\n新止損：${newSl}${lockPct === 0 ? ' (保本)' : ` (+${lockPct}%)`}`);
              } catch(e) { log('WARN', `${t.symbol} 移動止損失敗`); }
            }
          }

          // 已平倉
          if (!stillOpen && holdMin > 1) {
            const cid = t.symbol + '_' + t.openTime;
            if (closedCache[cid]) { delete state.openTrades[key]; saveState(); continue; }
            closedCache[cid] = Date.now();

            await sleep(2000);
            let pnl = await getRealPnl(t.symbol, t.openTime);
            if (pnl === null) pnl = 0;

            const sym = t.symbol, side = t.side, hold = holdMin;
            delete state.openTrades[key];
            recordTrade(sym, side, pnl, hold);
            await cancelAllOrders(sym, side);
            notify(buildCloseMsg(t, pnl, hold, cur));
            if (pnl < 0) state.slCooldown[sym] = Date.now();
            saveState();
            log('INFO', `${sym} 平倉 PnL:${pnl.toFixed(4)}U`);
          }
        } catch(e) { log('ERROR', `checkPos ${t.symbol}: ${e.message}`); }
      }
    } catch(e) { log('ERROR', 'checkPositions: ' + e.message); }
    await sleep(30000);
  }
}

// ══════════════════════════════════════════════════
// Telegram Polling
// ══════════════════════════════════════════════════
let tgOffset = 0;

async function tgPoll() {
  while (true) {
    try {
      const r = await new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.telegram.org',
          path: `/bot${BOT_TOKEN}/getUpdates?offset=${tgOffset}&timeout=30&limit=10`,
          method: 'GET'
        }, res => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ ok: false }); } });
        });
        req.on('error', () => resolve({ ok: false }));
        req.setTimeout(35000, () => { req.destroy(); resolve({ ok: false }); });
        req.end();
      });

      if (r.ok && r.result?.length > 0) {
        for (const upd of r.result) {
          tgOffset = upd.update_id + 1;
          if (upd.message?.text) {
            await handleCmd(upd.message.text, upd.message.chat.id).catch(() => {});
          }
          if (upd.callback_query) {
            await handleCallback(upd.callback_query).catch(() => {});
          }
        }
      }
    } catch(e) {}
    await sleep(1000);
  }
}

// ══════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════════════
// 啟動
// ══════════════════════════════════════════════════
http.createServer((req, res) => res.end('HADES OK')).listen(PORT);

async function main() {
  log('INFO', 'HADES 三重確認系統啟動');

  // 初始化幣種
  if (!state.symbols || state.symbols.length === 0) {
    log('INFO', '載入幣種列表...');
    const syms = await getTop200Symbols().catch(() =>
      ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'XRP-USDT', 'DOGE-USDT']
    );
    state.symbols = syms;
    saveState();
    log('INFO', `載入 ${syms.length} 個幣種`);
  }

  // 5秒後同步持倉
  setTimeout(() => syncPositions().catch(() => {}), 5000);

  // 啟動各循環
  tgPoll();
  tradingLoop();
  checkPositions();

  notify(
    `🗡️ <b>HADES 三重確認機器人啟動！</b>\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `本金：${state.capital.toFixed(2)}U　槓桿：${state.leverage}x\n` +
    `幣種：${state.symbols.length} 個\n` +
    `策略：Hades EMA + Wyckoff + MACD\n` +
    `━━━━━━━━━━━━━━━━━\n` +
    `發送 /menu 開啟控制面板`
  );

  log('INFO', `系統就緒 Port:${PORT}`);
}

main().catch(e => { log('ERROR', '啟動失敗: ' + e.message); process.exit(1); });

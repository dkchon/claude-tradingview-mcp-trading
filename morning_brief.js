/**
 * Morning Brief — TradingView Bot
 * Run: node morning_brief.js
 * Outputs: MCP health, open positions + P&L, last 24h trades, overnight Railway summary
 */

import "dotenv/config";
import { readFileSync, existsSync } from "fs";
import crypto from "crypto";

const POSITIONS_FILE = process.env.POSITIONS_FILE || "positions.json";
const CSV_FILE = process.env.USERPROFILE
  ? `${process.env.USERPROFILE}\\Documents\\trades.csv`.replace(/\\/g, "/")
  : "trades.csv";
const SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK;
const KRAKEN_API_KEY = process.env.KRAKEN_API_KEY || process.env.BITGET_API_KEY;
const KRAKEN_SECRET  = process.env.KRAKEN_SECRET_KEY || process.env.BITGET_SECRET_KEY;

const KRAKEN_ASSET_MAP = {
  "XXBT": { symbol: "BTCUSDT",  pair: "XBTUSD",  name: "BTC"  },
  "XETH": { symbol: "ETHUSDT",  pair: "ETHUSD",   name: "ETH"  },
  "XXRP": { symbol: "XRPUSDT",  pair: "XRPUSD",   name: "XRP"  },
  "LINK": { symbol: "LINKUSDT", pair: "LINKUSD",  name: "LINK" },
  "HBAR": { symbol: "HBARUSDT", pair: "HBARUSD",  name: "HBAR" },
  "XXLM": { symbol: "XLMUSDT",  pair: "XLMUSD",   name: "XLM"  },
  "SHIB": { symbol: "SHIBUSDT", pair: "SHIBUSD",  name: "SHIB" },
  "TAO":  { symbol: "TAOUSDT",  pair: "TAOUSD",   name: "TAO"  },
  "CC":   { symbol: "CCUSDT",   pair: "CCUSD",    name: "CC"   },
  "FLR":  { symbol: "FLRUSDT",  pair: "FLRUSD",   name: "FLR"  },
  "EWT":  { symbol: "EWTUSDT",  pair: "EWTUSD",   name: "EWT"  },
  "SGB":  { symbol: "SGBUSDT",  pair: "SGBUSD",   name: "SGB"  },
};

const KRAKEN_SYMBOL_MAP = {
  "BTCUSDT":  "XBTUSD",
  "ETHUSDT":  "ETHUSD",
  "XRPUSDT":  "XRPUSD",
  "LINKUSDT": "LINKUSD",
  "HBARUSDT": "HBARUSD",
  "XLMUSDT":  "XLMUSD",
  "TAOUSDT":  "TAOUSD",
  "FLRUSDT":  "FLRUSD",
  "SHIBUSDT": "SHIBUSD",
  "CCUSDT":   "CCUSD",
  "GRASSUSDT":"GRASSUSD",
  "SOLUSDT":  "SOLUSD",
  "HYPEUSDT": "HYPEUSD",
  "EWTUSDT":  "EWTUSD",
  "SGBUSDT":  "SGBUSD",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadPositions() {
  if (SHEETS_WEBHOOK) {
    try {
      const res = await fetch(SHEETS_WEBHOOK + "?action=positions", { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        if (data.positions && Object.keys(data.positions).length > 0) return data.positions;
      }
    } catch { /* fall through */ }
  }
  if (!existsSync(POSITIONS_FILE)) return {};
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}

function loadRecentTrades(hours = 24) {
  if (!existsSync(CSV_FILE)) return { live: [], paper: [], blocked: [] };
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(2);
  const cutoff = Date.now() - hours * 60 * 60 * 1000;

  const live = [], paper = [], blocked = [];
  for (const line of lines) {
    const cols = line.split(",");
    const [date, time, , symbol, side, qty, price, total, , , orderId, mode, notes] = cols;
    if (!date || !time) continue;
    const ts = new Date(`${date}T${time}Z`).getTime();
    if (isNaN(ts) || ts < cutoff) continue;
    const row = { date, time, symbol, side, qty, price, total, orderId, mode, notes };
    if (mode === "LIVE") live.push(row);
    else if (mode === "PAPER") paper.push(row);
    else if (mode === "BLOCKED") blocked.push(row);
  }
  return { live, paper, blocked };
}

async function fetchSheetsRecent() {
  if (!SHEETS_WEBHOOK) return null;
  try {
    const url = SHEETS_WEBHOOK + "?action=recent&hours=24";
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function checkMCP() {
  try {
    const res = await fetch("http://localhost:9222/json/version", {
      signal: AbortSignal.timeout(3000),
    });
    const data = await res.json();
    return { connected: true, browser: data.Browser };
  } catch {
    return { connected: false };
  }
}

async function fetchPrices(symbols) {
  const prices = {};
  await Promise.all(symbols.map(async (symbol) => {
    const pair = KRAKEN_SYMBOL_MAP[symbol];
    if (!pair) return;
    try {
      const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`,
        { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      const key = Object.keys(data.result)[0];
      prices[symbol] = parseFloat(data.result[key].c[0]);
    } catch { /* skip */ }
  }));
  return prices;
}

function pnlLine(symbol, pos, currentPrice) {
  if (!currentPrice) return `  • ${symbol}  entry: $${pos.entryPrice}  (price unavailable)`;

  const pnl = pos.side === "buy"
    ? (currentPrice - pos.entryPrice) * pos.quantity
    : (pos.entryPrice - currentPrice) * pos.quantity;
  const pnlPct = pos.side === "buy"
    ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;

  const arrow = pnl >= 0 ? "▲" : "▼";
  const sign  = pnl >= 0 ? "+" : "";
  const label = pnl >= 0 ? "PROFIT" : "LOSS";

  return `  ${arrow} ${symbol.replace("USDT","")}  qty: ${pos.quantity}  entry: $${pos.entryPrice}  now: $${currentPrice.toFixed(4)}  ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)  [${label}]`;
}

// Map position symbol → Kraken asset code
const SYMBOL_TO_KRAKEN = {
  "BTCUSDT":  "XXBT",
  "ETHUSDT":  "XETH",
  "XRPUSDT":  "XXRP",
  "LINKUSDT": "LINK",
  "HBARUSDT": "HBAR",
  "XLMUSDT":  "XXLM",
  "SHIBUSDT": "SHIB",
  "TAOUSDT":  "TAO",
  "CCUSDT":   "CC",
  "FLRUSDT":  "FLR",
  "EWTUSDT":  "EWT",
  "SGBUSDT":  "SGB",
};

async function fetchKrakenBalances() {
  if (!KRAKEN_API_KEY || !KRAKEN_SECRET) return null;
  try {
    const path = "/0/private/Balance";
    const nonce = Date.now().toString();
    const postData = new URLSearchParams({ nonce }).toString();
    const secret = Buffer.from(KRAKEN_SECRET, "base64");
    const message = path + crypto.createHash("sha256").update(nonce + postData).digest("binary");
    const sig = crypto.createHmac("sha512", secret).update(message, "binary").digest("base64");
    const res = await fetch("https://api.kraken.com" + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "API-Key": KRAKEN_API_KEY, "API-Sign": sig },
      body: postData,
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (data.error?.length > 0) return null;
    // Return as { assetCode: qty }
    const balances = {};
    for (const [asset, qty] of Object.entries(data.result)) {
      balances[asset] = parseFloat(qty);
    }
    return balances;
  } catch {
    return null;
  }
}

async function reconcilePositions(positions, krakenBalances) {
  if (!krakenBalances) return null;
  const mismatches = [];
  const matches = [];
  const untracked = [];

  // Pass 1 — check every tracked position against Kraken
  for (const [symbol, pos] of Object.entries(positions)) {
    const krakenAsset = SYMBOL_TO_KRAKEN[symbol];
    if (!krakenAsset) continue;
    const krakenQty = krakenBalances[krakenAsset] || 0;
    const posQty = pos.quantity;
    const diff = Math.abs(krakenQty - posQty);
    const pct = posQty > 0 ? (diff / posQty) * 100 : 0;

    if (pct > 1 || (diff > 0.00001 && pct > 0.1)) {
      mismatches.push({ symbol, posQty, krakenQty, diff, pct });
    } else {
      matches.push(symbol);
    }
  }

  // Pass 2 — check Kraken balances for holdings not in positions.json
  const trackedAssets = new Set(
    Object.keys(positions).map(s => SYMBOL_TO_KRAKEN[s]).filter(Boolean)
  );
  const skipAssets = new Set(["ZUSD", "KFEE", "USDC", "USDT"]);
  for (const [asset, rawQty] of Object.entries(krakenBalances)) {
    if (skipAssets.has(asset)) continue;
    const qty = parseFloat(rawQty);
    if (qty <= 0) continue;
    if (trackedAssets.has(asset)) continue;
    const info = KRAKEN_ASSET_MAP[asset];
    const symbol = info ? info.symbol : asset;
    untracked.push({ asset, symbol, qty });
  }

  return { mismatches, matches, untracked };
}

async function syncBalances(krakenBalances) {
  if (!SHEETS_WEBHOOK || !KRAKEN_API_KEY || !KRAKEN_SECRET) return { ok: 0, total: 0 };
  if (!krakenBalances) return { ok: 0, total: 0 };
  try {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 19);
    let ok = 0, total = 0;

    for (const [asset, qty] of Object.entries(krakenBalances)) {
      const amount = parseFloat(qty);
      if (amount <= 0 || asset === "ZUSD" || asset === "KFEE") continue;
      const info = KRAKEN_ASSET_MAP[asset];
      if (!info) continue;
      total++;
      try {
        const tickRes = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${info.pair}`,
          { signal: AbortSignal.timeout(4000) });
        const tickData = await tickRes.json();
        const tickKey = Object.keys(tickData.result)[0];
        const price = parseFloat(tickData.result[tickKey].c[0]);
        const totalUSD = (amount * price).toFixed(2);
        const postRes = await fetch(SHEETS_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date, time, exchange: "Kraken", symbol: info.symbol,
            side: "BALANCE", quantity: amount.toFixed(6),
            price: price.toFixed(4), totalUSD, fee: "0", netAmount: totalUSD,
            orderId: "BALANCE-SYNC", mode: "BALANCE-SYNC",
            notes: `${amount.toFixed(6)} ${info.name} @ $${price.toFixed(4)}`,
          }),
        });
        const text = await postRes.text();
        if (text.includes("success")) ok++;
      } catch { /* skip individual asset */ }
    }
    return { ok, total };
  } catch {
    return { ok: 0, total: 0 };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const LINE = "─".repeat(55);

console.log(`\n${"═".repeat(55)}`);
console.log(`  📊 TRADINGVIEW BOT — MORNING BRIEF`);
console.log(`  ${new Date().toUTCString()}`);
console.log(`${"═".repeat(55)}\n`);

const positions = await loadPositions();
const posEntries = Object.entries(positions);
const posSymbols = posEntries.map(([sym]) => sym);

// Run all checks in parallel
const [mcp, sheetsData, prices, krakenBalances] = await Promise.all([
  checkMCP(),
  fetchSheetsRecent(),
  fetchPrices(posSymbols),
  fetchKrakenBalances(),
]);
const [balanceSync, reconciliation] = await Promise.all([
  syncBalances(krakenBalances),
  reconcilePositions(positions, krakenBalances),
]);
const { live, paper, blocked } = loadRecentTrades(24);

// ─── MCP Status ───────────────────────────────────────────────────────────────
console.log(`${LINE}`);
console.log(`  MCP / TRADINGVIEW`);
console.log(`${LINE}`);
console.log(mcp.connected
  ? `  ✅ CDP connected  (${mcp.browser})`
  : `  ❌ TradingView not running with CDP — run tv_launch`);

// ─── Open Positions + P&L ────────────────────────────────────────────────────
console.log(`\n${LINE}`);
console.log(`  OPEN POSITIONS & P&L`);
console.log(`${LINE}`);
if (posEntries.length === 0) {
  console.log(`  None`);
} else {
  let totalPnl = 0;
  for (const [symbol, pos] of posEntries) {
    const currentPrice = prices[symbol];
    console.log(pnlLine(symbol, pos, currentPrice));
    if (currentPrice) {
      const pnl = pos.side === "buy"
        ? (currentPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - currentPrice) * pos.quantity;
      totalPnl += pnl;
    }
  }
  const totalSign = totalPnl >= 0 ? "+" : "";
  console.log(`\n  Total unrealised P&L: ${totalSign}$${totalPnl.toFixed(2)}`);
}

// ─── Last 24h Trades ──────────────────────────────────────────────────────────
console.log(`\n${LINE}`);
console.log(`  LAST 24H — LOCAL RUNS`);
console.log(`${LINE}`);
if (live.length === 0 && paper.length === 0) {
  console.log(`  No trades executed locally in last 24h`);
  console.log(`  Blocked signals: ${blocked.length}`);
  if (blocked.length > 0) {
    const reasons = {};
    for (const b of blocked) {
      const reason = b.notes?.replace(/^"|"$/g, "").replace("Failed: ", "") || "unknown";
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
    for (const [reason, count] of Object.entries(reasons)) {
      console.log(`    • ${reason} (×${count})`);
    }
  }
} else {
  if (live.length > 0) {
    console.log(`  🔴 LIVE trades: ${live.length}`);
    for (const t of live) {
      console.log(`    ${t.time}  ${t.symbol}  ${t.side?.toUpperCase()}  $${t.total}  [${t.orderId}]`);
    }
  }
  if (paper.length > 0) {
    console.log(`  📋 Paper trades: ${paper.length}`);
    for (const t of paper) {
      console.log(`    ${t.time}  ${t.symbol}  ${t.side?.toUpperCase()}  $${t.total}`);
    }
  }
}

// ─── Post P&L Snapshot to Google Sheets ──────────────────────────────────────
console.log(`\n${LINE}`);
console.log(`  P&L SNAPSHOT → GOOGLE SHEETS`);
console.log(`${LINE}`);
if (!SHEETS_WEBHOOK) {
  console.log(`  ⚠️  GOOGLE_SHEETS_WEBHOOK not set — skipping`);
} else if (posEntries.length === 0) {
  console.log(`  No open positions to snapshot`);
} else {
  const snapDate = new Date().toISOString().slice(0, 10);
  const snapTime = new Date().toISOString().slice(11, 19);
  let snapOk = 0;
  for (const [symbol, pos] of posEntries) {
    const currentPrice = prices[symbol];
    if (!currentPrice) { console.log(`  ⚠️  No price for ${symbol} — skipping`); continue; }
    const pnl = pos.side === "buy"
      ? (currentPrice - pos.entryPrice) * pos.quantity
      : (pos.entryPrice - currentPrice) * pos.quantity;
    const pnlPct = pos.side === "buy"
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
    const currentValue = (currentPrice * pos.quantity).toFixed(2);
    const sign = pnl >= 0 ? "+" : "";
    try {
      const res = await fetch(SHEETS_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: snapDate, time: snapTime,
          exchange: "Kraken", symbol,
          side: "P&L-SNAPSHOT",
          quantity: pos.quantity.toFixed(6),
          price: currentPrice.toFixed(4),
          totalUSD: currentValue,
          fee: "0",
          netAmount: currentValue,
          orderId: "P&L-SNAPSHOT",
          mode: "P&L-SNAPSHOT",
          notes: `Entry: $${pos.entryPrice} | P&L: ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`,
        }),
      });
      const text = await res.text();
      const ok = text.includes("success");
      console.log(`  ${ok ? "✅" : "❌"} ${symbol.replace("USDT","")}  ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`);
      if (ok) snapOk++;
    } catch (err) {
      console.log(`  ❌ ${symbol}: ${err.message}`);
    }
  }
  console.log(`  ${snapOk}/${posEntries.length} snapshots posted`);
}

// ─── Railway / Google Sheets Overnight ───────────────────────────────────────
console.log(`\n${LINE}`);
console.log(`  OVERNIGHT — RAILWAY (via Google Sheets)`);
console.log(`${LINE}`);
if (sheetsData && Array.isArray(sheetsData.trades)) {
  const overnightLive = sheetsData.trades.filter(t => t.mode === "LIVE");
  const overnightPaper = sheetsData.trades.filter(t => t.mode === "PAPER");
  if (overnightLive.length === 0 && overnightPaper.length === 0) {
    console.log(`  No trades overnight`);
  } else {
    if (overnightLive.length > 0) {
      console.log(`  🔴 LIVE: ${overnightLive.length} trade(s)`);
      for (const t of overnightLive) {
        // Find the date value — column A header may vary, look for an ISO date string among values
        const dateVal = t.date || Object.values(t).find(v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) || "";
        const dateStr = dateVal ? dateVal.toString().slice(0, 10) : "";
        const timeStr = t.time ? new Date(t.time).toISOString().slice(11, 19) : "";
        console.log(`    ${dateStr} ${timeStr}  ${t.symbol}  ${t.side?.toUpperCase()}  $${t.totalusd}`);
      }
    }
    if (overnightPaper.length > 0) {
      console.log(`  📋 Paper: ${overnightPaper.length} trade(s)`);
    }
  }
} else {
  console.log(`  ⚠️  Google Sheets read not available`);
}

// ─── Reconciliation ───────────────────────────────────────────────────────────
console.log(`\n${LINE}`);
console.log(`  POSITION RECONCILIATION — KRAKEN vs TRACKED`);
console.log(`${LINE}`);
if (!reconciliation) {
  console.log(`  ⚠️  Kraken API not available — skipping reconciliation`);
} else {
  const { mismatches, matches, untracked } = reconciliation;
  if (mismatches.length === 0 && untracked.length === 0) {
    console.log(`  ✅ All ${matches.length} positions match Kraken balances`);
  } else {
    if (matches.length > 0) console.log(`  ✅ ${matches.length} position(s) match`);
    for (const m of mismatches) {
      const sym = m.symbol.replace("USDT", "");
      console.log(`  ❌ ${sym.padEnd(6)}  tracked: ${m.posQty.toFixed(6)}  kraken: ${m.krakenQty.toFixed(6)}  diff: ${m.diff.toFixed(6)} (${m.pct.toFixed(1)}%)`);
    }
    for (const u of untracked) {
      const sym = u.symbol.replace("USDT", "");
      console.log(`  ⚠️  ${sym.padEnd(6)}  kraken balance: ${u.qty.toFixed(6)}  — NOT in positions.json (Railway bought?)`);
    }
  }
}

// ─── Balance Sync ─────────────────────────────────────────────────────────────
console.log(`\n${LINE}`);
console.log(`  BALANCES → GOOGLE SHEETS`);
console.log(`${LINE}`);
if (!SHEETS_WEBHOOK) {
  console.log(`  ⚠️  GOOGLE_SHEETS_WEBHOOK not set — skipping`);
} else if (balanceSync.total === 0) {
  console.log(`  ⚠️  Could not fetch balances from Kraken`);
} else {
  console.log(`  ✅ ${balanceSync.ok}/${balanceSync.total} balances updated`);
}

console.log(`\n${"═".repeat(55)}\n`);

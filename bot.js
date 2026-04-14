/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data from
 * Kraken (free, no auth), calculates all indicators, runs safety check,
 * executes via Kraken if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# Kraken credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your Kraken credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  console.log(`\n📄 Trade log: ${CSV_FILE}`);
  console.log(
    `   Open in Excel any time — auto-updates after every bot run.\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  kraken: {
    apiKey: process.env.BITGET_API_KEY,
    privateKey: process.env.BITGET_SECRET_KEY,
    baseUrl: "https://api.kraken.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Kraken public API — free, no auth, no geo-block) ───────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Map symbol from Binance format to Kraken format
  const symbolMap = {
    "BTCUSDT": "XBTUSD",
    "ETHUSDT": "ETHUSD",
    "XRPUSDT": "XRPUSD",
    "LINKUSDT": "LINKUSD",
    "HBARUSDT": "HBARUSD",
    "XLMUSDT": "XLMUSD",
    "TAOUSDT": "TAOUSD",
    "FLRUSDT": "FLRUSD",
    "SHIBUSDT": "SHIBUSD",
    "CCUSDT": "CCUSD",
    "GRASSUSDT": "GRASSUSD",
  };
  const krakenSymbol = symbolMap[symbol] || symbol;

  // Map timeframe to Kraken interval in minutes
  const intervalMap = {
    "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30,
    "1H": 60, "4H": 240, "1D": 1440, "1W": 10080,
  };
  const krakenInterval = intervalMap[interval] || 1;

  const url = `https://api.kraken.com/0/public/OHLC?pair=${krakenSymbol}&interval=${krakenInterval}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kraken API error: ${res.status}`);
  const json = await res.json();
  if (json.error && json.error.length > 0) throw new Error(`Kraken API error: ${json.error[0]}`);

  const pairKey = Object.keys(json.result).find(k => k !== "last");
  const data = json.result[pairKey].slice(-limit);

  return data.map((k) => ({
    time: k[0] * 1000,
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[6]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias first
  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    // 1. Price above VWAP
    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    // 2. Price above EMA(8)
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );

    // 3. RSI(3) pullback
    check(
      "RSI(3) below 30 (snap-back setup in uptrend)",
      "< 30",
      rsi3.toFixed(2),
      rsi3 < 30,
    );

    // 4. Not overextended from VWAP
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );

    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );

    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  console.log(
    `✅ Trade size: $${CONFIG.maxTradeSizeUSD.toFixed(2)} per trade`,
  );

  return true;
}

// ─── Kraken Execution ────────────────────────────────────────────────────────

// Kraken symbol map (Binance-style → Kraken pair)
const KRAKEN_SYMBOL_MAP = {
  "BTCUSDT": "XBTUSD",
  "ETHUSDT": "ETHUSD",
  "XRPUSDT": "XRPUSD",
  "LINKUSDT": "LINKUSD",
  "HBARUSDT": "HBARUSD",
  "XLMUSDT": "XLMUSD",
  "TAOUSDT": "TAOUSD",
  "FLRUSDT": "FLRUSD",
  "SHIBUSDT": "SHIBUSD",
  "CCUSDT": "CCUSD",
  "GRASSUSDT": "GRASSUSD",
};

function signKraken(path, nonce, postData) {
  const secret = Buffer.from(CONFIG.kraken.privateKey, "base64");
  const message = path + crypto.createHash("sha256").update(nonce + postData).digest("binary");
  return crypto.createHmac("sha512", secret).update(message, "binary").digest("base64");
}

async function placeKrakenOrder(symbol, side, sizeUSD, price) {
  const pair = KRAKEN_SYMBOL_MAP[symbol] || symbol;
  const volume = (sizeUSD / price).toFixed(8);
  const nonce = Date.now().toString();
  const path = "/0/private/AddOrder";

  const postData = new URLSearchParams({
    nonce,
    ordertype: "market",
    type: side === "buy" ? "buy" : "sell",
    volume,
    pair,
  }).toString();

  const signature = signKraken(path, nonce, postData);

  const res = await fetch(`${CONFIG.kraken.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "API-Key": CONFIG.kraken.apiKey,
      "API-Sign": signature,
    },
    body: postData,
  });

  const data = await res.json();
  if (data.error && data.error.length > 0) {
    throw new Error(`Kraken order failed: ${data.error[0]}`);
  }

  return { orderId: data.result.txid[0] };
}

// ─── Position Tracking ───────────────────────────────────────────────────────

const POSITIONS_FILE = "positions.json";

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return {};
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}

function savePositions(positions) {
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

function checkExitConditions(position, price, rsi3) {
  const { side, entryPrice } = position;
  if (side === "buy") {
    const stopLoss = entryPrice * 0.97;
    if (rsi3 > 70) return { exit: true, reason: `Take profit — RSI(3) ${rsi3.toFixed(2)} above 70` };
    if (price < stopLoss) return { exit: true, reason: `Stop loss — price $${price.toFixed(4)} below entry -3% ($${stopLoss.toFixed(4)})` };
  } else {
    const stopLoss = entryPrice * 1.03;
    if (rsi3 < 30) return { exit: true, reason: `Take profit — RSI(3) ${rsi3.toFixed(2)} below 30` };
    if (price > stopLoss) return { exit: true, reason: `Stop loss — price $${price.toFixed(4)} above entry +3% ($${stopLoss.toFixed(4)})` };
  }
  return { exit: false };
}

// ─── Google Sheets Logging ───────────────────────────────────────────────────

async function postToSheets(row) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });
  } catch (err) {
    console.log(`  ⚠️  Google Sheets post failed: ${err.message}`);
  }
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = process.env.USERPROFILE
  ? `${process.env.USERPROFILE}\\Documents\\trades.csv`.replace(/\\/g, "/")
  : "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

async function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (logEntry.action === "close") {
    // Exit trade row
    side = logEntry.side === "buy" ? "SELL" : "BUY";
    quantity = logEntry.quantity.toFixed(6);
    totalUSD = (logEntry.quantity * logEntry.price).toFixed(2);
    fee = (parseFloat(totalUSD) * 0.001).toFixed(4);
    const pnl = logEntry.side === "buy"
      ? ((logEntry.price - logEntry.entryPrice) * logEntry.quantity).toFixed(4)
      : ((logEntry.entryPrice - logEntry.price) * logEntry.quantity).toFixed(4);
    netAmount = (parseFloat(totalUSD) - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = logEntry.paperTrading ? "PAPER" : "LIVE";
    notes = `${logEntry.exitReason} | P&L: $${pnl}`;
  } else if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = logEntry.tradeSide === "sell" ? "SELL" : "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = logEntry.tradeSide === "sell" ? "SELL" : "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "Kraken",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);

  // Mirror to Google Sheets
  await postToSheets({
    date, time, exchange: "Kraken", symbol: logEntry.symbol,
    side, quantity, price: logEntry.price.toFixed(2),
    totalUSD, fee, netAmount, orderId, mode,
    notes: notes.replace(/^"|"$/g, ""),
  });
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function runSymbol(symbol, timeframe, rules, log, tradeSize, positions) {
  console.log(`\n${"─".repeat(59)}`);
  console.log(`  ${symbol}`);
  console.log(`${"─".repeat(59)}`);

  // Fetch candle data
  const candles = await fetchCandles(symbol, timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const p = price < 0.01 ? 8 : price < 1 ? 5 : 2;

  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  Price: $${price.toFixed(p)}  EMA(8): $${ema8.toFixed(p)}  VWAP: $${vwap ? vwap.toFixed(p) : "N/A"}  RSI(3): ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("  ⚠️  Not enough data — skipping.");
    return [];
  }

  const entries = [];

  // ── Check open position first ──────────────────────────────────────────────
  const openPosition = positions[symbol];
  if (openPosition) {
    const { exit, reason } = checkExitConditions(openPosition, price, rsi3);
    console.log(`\n── Open Position — ${openPosition.side.toUpperCase()} @ $${openPosition.entryPrice.toFixed(p)} ──`);
    if (exit) {
      console.log(`\n💰 EXIT TRIGGERED — ${reason}`);
      const closeEntry = {
        action: "close",
        timestamp: new Date().toISOString(),
        symbol,
        price,
        side: openPosition.side,
        quantity: openPosition.quantity,
        entryPrice: openPosition.entryPrice,
        exitReason: reason,
        paperTrading: CONFIG.paperTrading,
        orderId: null,
      };
      if (CONFIG.paperTrading) {
        closeEntry.orderId = `PAPER-CLOSE-${Date.now()}`;
        console.log(`📋 PAPER SELL — ${openPosition.quantity.toFixed(6)} ${symbol} @ $${price.toFixed(p)}`);
      } else {
        try {
          const order = await placeKrakenOrder(symbol, "sell", openPosition.quantity * price, price);
          closeEntry.orderId = order.orderId;
          console.log(`✅ SELL ORDER PLACED — ${order.orderId}`);
        } catch (err) {
          console.log(`❌ SELL FAILED — ${err.message}`);
          closeEntry.error = err.message;
        }
      }
      delete positions[symbol];
      entries.push(closeEntry);
      await writeTradeCsv(closeEntry);
      return entries;
    } else {
      const pnl = openPosition.side === "buy"
        ? ((price - openPosition.entryPrice) / openPosition.entryPrice * 100).toFixed(2)
        : ((openPosition.entryPrice - price) / openPosition.entryPrice * 100).toFixed(2);
      console.log(`  Holding — unrealised P&L: ${pnl >= 0 ? "+" : ""}${pnl}%`);
      console.log(`  Exit when: ${openPosition.side === "buy" ? "RSI(3) > 70 or price < entry -3%" : "RSI(3) < 30 or price > entry +3%"}`);
      return entries;
    }
  }

  // ── No open position — look for entry ─────────────────────────────────────
  const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules);

  const bullishBias = price > vwap && price > ema8;
  const tradeSide = bullishBias ? "buy" : "sell";

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol, timeframe, price,
    indicators: { ema8, vwap, rsi3 },
    conditions: results, allPass, tradeSize,
    tradeSide,
    orderPlaced: false, orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  console.log("\n── Decision ──────────────────────────────────────────────\n");

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);
    const quantity = tradeSize / price;
    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER ${tradeSide.toUpperCase()} — ${symbol} ~$${tradeSize.toFixed(2)} at market`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(`\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${tradeSide.toUpperCase()} ${symbol}`);
      try {
        const order = await placeKrakenOrder(symbol, tradeSide, tradeSize, price);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
    if (logEntry.orderPlaced || CONFIG.paperTrading) {
      positions[symbol] = {
        side: tradeSide,
        entryPrice: price,
        quantity,
        entryTime: logEntry.timestamp,
        orderId: logEntry.orderId,
      };
    }
  }

  entries.push(logEntry);
  return entries;
}

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy and watchlist
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  const watchlist = rules.watchlist || [CONFIG.symbol];
  const timeframe = rules.default_timeframe || CONFIG.timeframe;

  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Watchlist: ${watchlist.join(", ")} | Timeframe: ${timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  const tradeSize = CONFIG.maxTradeSizeUSD;

  // Load open positions
  const positions = loadPositions();
  const openCount = Object.keys(positions).length;
  if (openCount > 0) {
    console.log(`\n── Open Positions: ${openCount} ─────────────────────────────────`);
    Object.entries(positions).forEach(([sym, pos]) => {
      console.log(`  ${sym} — ${pos.side.toUpperCase()} @ $${pos.entryPrice} since ${pos.entryTime.slice(0,16)}`);
    });
  }

  console.log("\n── Fetching market data from Kraken ────────────────────\n");

  // Run each symbol sequentially to avoid rate limits
  for (const symbol of watchlist) {
    const todayCount = countTodaysTrades(log);
    if (todayCount >= CONFIG.maxTradesPerDay) {
      console.log(`\n🚫 Daily trade limit reached (${todayCount}/${CONFIG.maxTradesPerDay}) — stopping.`);
      break;
    }

    try {
      const entries = await runSymbol(symbol, timeframe, rules, log, tradeSize, positions);
      for (const entry of entries) {
        if (entry.action !== "close") {
          log.trades.push(entry);
          await writeTradeCsv(entry);
        }
      }
    } catch (err) {
      console.log(`\n❌ Error processing ${symbol}: ${err.message}`);
    }
  }

  savePositions(positions);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}

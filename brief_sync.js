// brief_sync.js — run during morning brief to sync local CSV snapshots
// Overwrites positions.csv, appends to pnl.csv and balances.csv

import "dotenv/config";
import https from "https";
import crypto from "crypto";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POSITIONS_FILE = path.join(__dirname, "positions.json");
const DOCS_DIR = (process.env.USERPROFILE || process.env.HOME || ".").replace(/\\/g, "/") + "/Documents";
const POSITIONS_CSV = DOCS_DIR + "/positions.csv";
const PNL_CSV       = DOCS_DIR + "/pnl.csv";
const BALANCES_CSV  = DOCS_DIR + "/balances.csv";

const API_KEY    = process.env.KRAKEN_API_KEY;
const API_SECRET = process.env.KRAKEN_SECRET_KEY;

// Binance-style symbol → Kraken public ticker pair
const TICKER_MAP = {
  BTCUSDT:  "XBTUSD",
  ETHUSDT:  "ETHUSD",
  XRPUSDT:  "XRPUSD",
  LINKUSDT: "LINKUSD",
  HBARUSDT: "HBARUSD",
  TAOUSDT:  "TAOUSD",
  FLRUSDT:  "FLRUSD",
  EWTUSDT:  "EWTUSD",
  SGBUSDT:  "SGBUSD",
  XLMUSDT:  "XLMUSD",
  SHIBUSDT: "SHIBUSD",
};

// Binance-style symbol → Kraken asset code (for /Balance endpoint)
const ASSET_MAP = {
  BTCUSDT:  "XXBT",
  ETHUSDT:  "XETH",
  XRPUSDT:  "XXRP",
  LINKUSDT: "LINK",
  HBARUSDT: "HBAR",
  TAOUSDT:  "TAO",
  FLRUSDT:  "FLR",
  EWTUSDT:  "EWT",
  SGBUSDT:  "SGB",
  XLMUSDT:  "XXLM",
  SHIBUSDT: "SHIB",
};

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    }).on("error", reject);
  });
}

function krakenPost(urlPath, params = {}) {
  return new Promise((resolve, reject) => {
    const nonce = Date.now().toString();
    const postData = new URLSearchParams({ nonce, ...params }).toString();
    const secret = Buffer.from(API_SECRET, "base64");
    const msg = urlPath + crypto.createHash("sha256").update(nonce + postData).digest("binary");
    const sig = crypto.createHmac("sha512", secret).update(msg, "binary").digest("base64");
    const body = Buffer.from(postData);
    const req = https.request({
      hostname: "api.kraken.com",
      path: urlPath,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": body.length,
        "API-Key": API_KEY,
        "API-Sign": sig,
      },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function csvRow(fields) {
  return fields.map(f => {
    const s = String(f ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",");
}

function ensureHeaders(file, headers) {
  if (!existsSync(file)) writeFileSync(file, headers + "\n");
}

async function run() {
  const positions = JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
  const symbols = Object.keys(positions);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19);

  // ── 1. Fetch live prices via Kraken public ticker ──────────────────────────
  const pairs = [...new Set(symbols.map(s => TICKER_MAP[s]).filter(Boolean))];
  const tickerRes = await httpsGet(`https://api.kraken.com/0/public/Ticker?pair=${pairs.join(",")}`);
  const priceByKrakenPair = {};
  if (tickerRes.result) {
    for (const [pair, info] of Object.entries(tickerRes.result)) {
      priceByKrakenPair[pair] = parseFloat(info.c[0]);
    }
  }

  // Resolve prices back to our symbols
  const prices = {};
  for (const sym of symbols) {
    const kPair = TICKER_MAP[sym];
    if (!kPair) continue;
    // Kraken may return pairs under alternate keys (e.g. XXBTZUSD vs XBTUSD)
    const match = Object.entries(priceByKrakenPair).find(([k]) =>
      k === kPair ||
      k.replace(/^X/, "").replace(/Z?USD$/, "USD") === kPair ||
      k === kPair.replace("XBT", "XXBT").replace("USD", "ZUSD")
    );
    if (match) prices[sym] = match[1];
  }

  // ── 2. Fetch Kraken account balances ──────────────────────────────────────
  let krakenBalances = {};
  if (API_KEY && API_SECRET) {
    const balRes = await krakenPost("/0/private/Balance");
    krakenBalances = balRes.result || {};
  }

  // ── 3. Build rows ──────────────────────────────────────────────────────────
  const POS_HEADERS = csvRow(["Date","Time","Symbol","Side","EntryPrice","CurrentPrice","Quantity","Value_USD","PnL_USD","PnL_Pct","EntryTime","OrderId","Paper","Notes"]);
  const PNL_HEADERS = csvRow(["Date","Time","Symbol","EntryPrice","CurrentPrice","Quantity","PnL_USD","PnL_Pct","HighWaterMark"]);
  const BAL_HEADERS = csvRow(["Date","Time","Symbol","KrakenAsset","HoldingQty","CurrentPrice","Value_USD"]);

  ensureHeaders(PNL_CSV, PNL_HEADERS);
  ensureHeaders(BALANCES_CSV, BAL_HEADERS);

  const posRows = [POS_HEADERS];
  const pnlRows = [];
  const balRows = [];

  for (const [symbol, pos] of Object.entries(positions)) {
    const currentPrice = prices[symbol] ?? null;
    const qty   = parseFloat(pos.quantity);
    const entry = parseFloat(pos.entryPrice);

    const valueUSD = currentPrice != null ? (qty * currentPrice).toFixed(2) : "";
    const pnlUSD   = currentPrice != null ? ((currentPrice - entry) * qty).toFixed(2) : "";
    const pnlPct   = currentPrice != null ? (((currentPrice - entry) / entry) * 100).toFixed(2) + "%" : "";
    const hwm      = pos.highWaterMark ?? "";

    posRows.push(csvRow([
      dateStr, timeStr, symbol, pos.side,
      entry, currentPrice ?? "N/A",
      qty, valueUSD, pnlUSD, pnlPct,
      pos.entryTime, pos.orderId, pos.paper ? "true" : "false", pos.notes ?? ""
    ]));

    pnlRows.push(csvRow([
      dateStr, timeStr, symbol,
      entry, currentPrice ?? "N/A",
      qty, pnlUSD, pnlPct, hwm
    ]));

    const asset = ASSET_MAP[symbol];
    const krakenQty = asset != null ? parseFloat(krakenBalances[asset] ?? 0) : null;
    balRows.push(csvRow([
      dateStr, timeStr, symbol,
      asset ?? "N/A",
      krakenQty != null ? krakenQty : "N/A",
      currentPrice ?? "N/A",
      krakenQty != null && currentPrice != null ? (krakenQty * currentPrice).toFixed(2) : "N/A"
    ]));
  }

  // ── 4. Write files ─────────────────────────────────────────────────────────
  writeFileSync(POSITIONS_CSV, posRows.join("\n") + "\n");
  appendFileSync(PNL_CSV,      pnlRows.map(r => r + "\n").join(""));
  appendFileSync(BALANCES_CSV, balRows.map(r => r + "\n").join(""));

  console.log(`✅ positions.csv  — ${symbols.length} positions (overwritten)`);
  console.log(`✅ pnl.csv        — ${pnlRows.length} rows appended`);
  console.log(`✅ balances.csv   — ${balRows.length} rows appended`);
  console.log(`\nLive prices:`);
  for (const sym of symbols) {
    const p = prices[sym];
    console.log(`  ${sym.padEnd(12)} ${p != null ? "$" + p.toFixed(6) : "N/A"}`);
  }
}

run().catch(e => { console.error("brief_sync failed:", e.message); process.exit(1); });

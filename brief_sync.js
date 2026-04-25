// brief_sync.js — run during morning brief to sync trades.xlsx + individual CSVs
//
// Writes / updates:
//   ~/Documents/trades.xlsx        — 4 tabs: Trades, Positions, P&L, Balances
//   ~/Documents/trades.csv         — Trades tab backup (append-only)
//   ~/Documents/positions.csv      — Positions tab backup (overwrite each run)
//   ~/Documents/pnl.csv            — P&L tab backup (append each run)
//   ~/Documents/balances.csv       — Balances tab backup (append each run)

import "dotenv/config";
import https from "https";
import crypto from "crypto";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POSITIONS_FILE = path.join(__dirname, "positions.json");
const DOCS_DIR = (process.env.USERPROFILE || process.env.HOME || ".").replace(/\\/g, "/") + "/Documents";

const XLSX_FILE     = DOCS_DIR + "/trades.xlsx";
const TRADES_CSV    = DOCS_DIR + "/trades.csv";
const POSITIONS_CSV = DOCS_DIR + "/positions.csv";
const PNL_CSV       = DOCS_DIR + "/pnl.csv";
const BALANCES_CSV  = DOCS_DIR + "/balances.csv";

const API_KEY    = process.env.KRAKEN_API_KEY;
const API_SECRET = process.env.KRAKEN_SECRET_KEY;

const TICKER_MAP = {
  BTCUSDT:  "XBTUSD",  ETHUSDT:  "ETHUSD",  XRPUSDT:  "XRPUSD",
  LINKUSDT: "LINKUSD", HBARUSDT: "HBARUSD", TAOUSDT:  "TAOUSD",
  FLRUSDT:  "FLRUSD",  EWTUSDT:  "EWTUSD",  SGBUSDT:  "SGBUSD",
  XLMUSDT:  "XLMUSD",  SHIBUSDT: "SHIBUSD",  CCUSDT: "CCUSD",  GRASSUSDT: "GRASSUSD",  ZBCNUSDT: "ZBCNUSD",
};

const ASSET_MAP = {
  BTCUSDT: "XXBT", ETHUSDT: "XETH",  XRPUSDT:  "XXRP",  LINKUSDT: "LINK",
  HBARUSDT: "HBAR", TAOUSDT: "TAO",  FLRUSDT:  "FLR",   EWTUSDT:  "EWT",
  SGBUSDT: "SGB",  XLMUSDT: "XXLM", SHIBUSDT: "SHIB",  CCUSDT: "CC",  GRASSUSDT: "GRASS",  ZBCNUSDT: "ZBCN",
};

// CSV headers matching trades.csv on disk
const TRADES_HEADERS = [
  "Date", "Time (UTC)", "Exchange", "Symbol", "Side",
  "Quantity", "Price", "Total USD", "Fee", "Net Amount",
  "Order ID", "Mode", "Notes"
];

const POS_HEADERS = [
  "Date", "Time", "Symbol", "Side", "EntryPrice", "CurrentPrice",
  "Quantity", "Value_USD", "PnL_USD", "PnL_Pct",
  "EntryTime", "OrderId", "Paper", "Notes"
];

const PNL_HEADERS = [
  "Date", "Time", "Symbol", "EntryPrice", "CurrentPrice",
  "Quantity", "PnL_USD", "PnL_Pct", "HighWaterMark"
];

const BAL_HEADERS = [
  "Date", "Time", "Symbol", "KrakenAsset",
  "HoldingQty", "CurrentPrice", "Value_USD"
];

// ── Helpers ──────────────────────────────────────────────────────────────────

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
      hostname: "api.kraken.com", path: urlPath, method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": body.length,
        "API-Key": API_KEY, "API-Sign": sig,
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
  if (!existsSync(file)) writeFileSync(file, csvRow(headers) + "\n");
}

// Parse existing trades.csv into array-of-arrays for the Trades sheet
function loadTradesCsv() {
  if (!existsSync(TRADES_CSV)) return [TRADES_HEADERS];
  const lines = readFileSync(TRADES_CSV, "utf8").trim().split("\n").filter(Boolean);
  return lines.map(line => {
    // Simple CSV parse (handles quoted fields)
    const fields = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQ = !inQ; }
      else if (line[i] === "," && !inQ) { fields.push(cur); cur = ""; }
      else cur += line[i];
    }
    fields.push(cur);
    return fields;
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const positions = JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
  const symbols = Object.keys(positions);
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19);

  // 1. Live prices
  const pairs = [...new Set(symbols.map(s => TICKER_MAP[s]).filter(Boolean))];
  const tickerRes = await httpsGet(`https://api.kraken.com/0/public/Ticker?pair=${pairs.join(",")}`);
  const rawPrices = {};
  if (tickerRes.result) {
    for (const [pair, info] of Object.entries(tickerRes.result)) {
      rawPrices[pair] = parseFloat(info.c[0]);
    }
  }
  const prices = {};
  for (const sym of symbols) {
    const kPair = TICKER_MAP[sym];
    if (!kPair) continue;
    const match = Object.entries(rawPrices).find(([k]) =>
      k === kPair ||
      k.replace(/^X/, "").replace(/Z?USD$/, "USD") === kPair ||
      k === kPair.replace("XBT", "XXBT").replace("USD", "ZUSD")
    );
    if (match) prices[sym] = match[1];
  }

  // 2. Kraken balances
  let krakenBalances = {};
  if (API_KEY && API_SECRET) {
    const balRes = await krakenPost("/0/private/Balance");
    krakenBalances = balRes.result || {};
  }

  // 3. Build Positions, P&L, Balances row data
  const posDataRows  = [];
  const pnlDataRows  = [];
  const balDataRows  = [];

  const newPnlCsvRows = [];
  const newBalCsvRows = [];

  for (const [symbol, pos] of Object.entries(positions)) {
    const currentPrice = prices[symbol] ?? null;
    const qty   = parseFloat(pos.quantity);
    const entry = parseFloat(pos.entryPrice);

    const valueUSD = currentPrice != null ? +(qty * currentPrice).toFixed(2) : null;
    const pnlUSD   = currentPrice != null ? +((currentPrice - entry) * qty).toFixed(2) : null;
    const pnlPct   = currentPrice != null ? +(((currentPrice - entry) / entry) * 100).toFixed(2) : null;
    const hwm      = pos.highWaterMark ?? null;

    // Positions sheet row
    posDataRows.push([
      dateStr, timeStr, symbol, pos.side,
      entry, currentPrice ?? "N/A",
      qty, valueUSD ?? "", pnlUSD ?? "",
      pnlPct != null ? pnlPct + "%" : "",
      pos.entryTime, pos.orderId,
      pos.paper ? "true" : "false",
      pos.notes ?? ""
    ]);

    // P&L sheet row
    pnlDataRows.push([
      dateStr, timeStr, symbol,
      entry, currentPrice ?? "N/A",
      qty, pnlUSD ?? "", pnlPct != null ? pnlPct + "%" : "",
      hwm ?? ""
    ]);
    newPnlCsvRows.push([
      dateStr, timeStr, symbol,
      entry, currentPrice ?? "N/A",
      qty, pnlUSD ?? "", pnlPct != null ? pnlPct + "%" : "",
      hwm ?? ""
    ]);

    // Balances sheet row
    const asset = ASSET_MAP[symbol];
    const krakenQty = asset != null ? parseFloat(krakenBalances[asset] ?? 0) : null;
    const balVal = krakenQty != null && currentPrice != null
      ? +(krakenQty * currentPrice).toFixed(2) : null;

    balDataRows.push([
      dateStr, timeStr, symbol, asset ?? "N/A",
      krakenQty ?? "N/A", currentPrice ?? "N/A",
      balVal ?? "N/A"
    ]);
    newBalCsvRows.push([
      dateStr, timeStr, symbol, asset ?? "N/A",
      krakenQty ?? "N/A", currentPrice ?? "N/A",
      balVal ?? "N/A"
    ]);
  }

  // 4. Load existing workbook or create new one
  let wb;
  if (existsSync(XLSX_FILE)) {
    wb = XLSX.readFile(XLSX_FILE);
  } else {
    wb = XLSX.utils.book_new();
  }

  // Helper: replace or add a sheet
  function setSheet(name, headers, dataRows) {
    const wsData = [headers, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    if (wb.SheetNames.includes(name)) {
      wb.Sheets[name] = ws;
    } else {
      XLSX.utils.book_append_sheet(wb, ws, name);
    }
  }

  // Trades sheet — loaded from trades.csv (source of truth)
  const tradesData = loadTradesCsv();
  setSheet("Trades", [], tradesData); // headers already in CSV

  // Positions — overwrite with today's snapshot
  setSheet("Positions", POS_HEADERS, posDataRows);

  // P&L — append today's rows to existing sheet data
  let existingPnl = [];
  if (wb.SheetNames.includes("P&L")) {
    existingPnl = XLSX.utils.sheet_to_json(wb.Sheets["P&L"], { header: 1 }).slice(1); // skip header
  }
  setSheet("P&L", PNL_HEADERS, [...existingPnl, ...pnlDataRows]);

  // Balances — append today's rows to existing sheet data
  let existingBal = [];
  if (wb.SheetNames.includes("Balances")) {
    existingBal = XLSX.utils.sheet_to_json(wb.Sheets["Balances"], { header: 1 }).slice(1);
  }
  setSheet("Balances", BAL_HEADERS, [...existingBal, ...balDataRows]);

  // Enforce tab order: Trades first
  const desiredOrder = ["Trades", "Positions", "P&L", "Balances"];
  wb.SheetNames = desiredOrder.filter(n => wb.SheetNames.includes(n));

  XLSX.writeFile(wb, XLSX_FILE);

  // 5. Update individual CSV backups
  writeFileSync(POSITIONS_CSV,
    csvRow(POS_HEADERS) + "\n" +
    posDataRows.map(r => csvRow(r.map(String))).join("\n") + "\n"
  );

  ensureHeaders(PNL_CSV, PNL_HEADERS);
  appendFileSync(PNL_CSV, newPnlCsvRows.map(r => csvRow(r.map(String)) + "\n").join(""));

  ensureHeaders(BALANCES_CSV, BAL_HEADERS);
  appendFileSync(BALANCES_CSV, newBalCsvRows.map(r => csvRow(r.map(String)) + "\n").join(""));

  // trades.csv is never touched here — bot.js owns it (append-only on each trade)

  console.log(`✅ trades.xlsx     — 4 tabs updated (Trades, Positions, P&L, Balances)`);
  console.log(`✅ positions.csv   — ${symbols.length} positions (overwritten)`);
  console.log(`✅ pnl.csv         — ${pnlDataRows.length} rows appended`);
  console.log(`✅ balances.csv    — ${balDataRows.length} rows appended`);
  console.log(`\nLive prices:`);
  for (const sym of symbols) {
    const p = prices[sym];
    const pos = positions[sym];
    const entry = parseFloat(pos.entryPrice);
    const pnlPct = p != null ? (((p - entry) / entry) * 100).toFixed(2) : null;
    const sign = pnlPct != null ? (pnlPct >= 0 ? "+" : "") : "";
    console.log(`  ${sym.padEnd(12)} $${p != null ? p.toFixed(6) : "N/A"}  ${pnlPct != null ? sign + pnlPct + "%" : ""}`);
  }
}

run().catch(e => { console.error("brief_sync failed:", e.message); process.exit(1); });

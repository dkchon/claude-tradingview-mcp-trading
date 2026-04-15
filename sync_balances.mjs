/**
 * One-time balance sync — posts current Kraken balances to Google Sheets
 * Run: node sync_balances.mjs
 */
import 'dotenv/config';
import crypto from 'crypto';

const apiKey = process.env.KRAKEN_API_KEY || process.env.BITGET_API_KEY;
const privateKey = process.env.KRAKEN_SECRET_KEY || process.env.BITGET_SECRET_KEY;
const SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK;

// Fetch Kraken balance
async function getBalance() {
  const path = '/0/private/Balance';
  const nonce = Date.now().toString();
  const postData = new URLSearchParams({ nonce }).toString();
  const secret = Buffer.from(privateKey, 'base64');
  const message = path + crypto.createHash('sha256').update(nonce + postData).digest('binary');
  const signature = crypto.createHmac('sha512', secret).update(message, 'binary').digest('base64');
  const res = await fetch('https://api.kraken.com' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'API-Key': apiKey, 'API-Sign': signature },
    body: postData,
  });
  const data = await res.json();
  if (data.error?.length > 0) throw new Error(data.error[0]);
  return data.result;
}

// Fetch current price from Kraken public API
async function getPrice(krakenPair) {
  try {
    const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${krakenPair}`);
    const data = await res.json();
    const key = Object.keys(data.result)[0];
    return parseFloat(data.result[key].c[0]);
  } catch { return null; }
}

// Kraken asset → readable symbol + price pair
const ASSET_MAP = {
  'XXBT': { symbol: 'BTCUSDT',  pair: 'XBTUSD',  name: 'BTC'  },
  'XETH': { symbol: 'ETHUSDT',  pair: 'ETHUSD',   name: 'ETH'  },
  'XXRP': { symbol: 'XRPUSDT',  pair: 'XRPUSD',   name: 'XRP'  },
  'LINK': { symbol: 'LINKUSDT', pair: 'LINKUSD',  name: 'LINK' },
  'HBAR': { symbol: 'HBARUSDT', pair: 'HBARUSD',  name: 'HBAR' },
  'FLR':  { symbol: 'FLRUSDT',  pair: 'FLRUSD',   name: 'FLR'  },
  'TAO':  { symbol: 'TAOUSDT',  pair: 'TAOUSD',   name: 'TAO'  },
  'CC':   { symbol: 'CCUSDT',   pair: 'CCUSD',    name: 'CC'   },
  'SGB':  { symbol: 'SGBUSDT',  pair: 'SGBUSD',   name: 'SGB'  },
  'EWT':  { symbol: 'EWTUSDT',  pair: 'EWTUSD',   name: 'EWT'  },
};

// Post row to Google Sheets
async function postToSheets(row) {
  const res = await fetch(SHEETS_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(row),
  });
  const text = await res.text();
  return text.includes('success');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('\n📊 Syncing Kraken balances to Google Sheets...\n');

const balances = await getBalance();
const now = new Date();
const date = now.toISOString().slice(0, 10);
const time = now.toISOString().slice(11, 19);

let synced = 0;
for (const [asset, qty] of Object.entries(balances)) {
  const amount = parseFloat(qty);
  if (amount <= 0) continue;
  if (asset === 'ZUSD' || asset === 'KFEE') continue; // skip USD and fee credits

  const info = ASSET_MAP[asset];
  if (!info) {
    console.log(`  ⚠️  Unknown asset ${asset} (${amount}) — skipping`);
    continue;
  }

  const price = await getPrice(info.pair);
  const totalUSD = price ? (amount * price).toFixed(2) : '0.00';
  const fee = price ? (parseFloat(totalUSD) * 0.0026).toFixed(4) : '0.0000';

  const row = {
    date, time,
    exchange: 'Kraken',
    symbol: info.symbol,
    side: 'BALANCE',
    quantity: amount.toFixed(6),
    price: price ? price.toFixed(2) : 'N/A',
    totalUSD,
    fee,
    netAmount: totalUSD,
    orderId: 'BALANCE-SYNC',
    mode: 'BALANCE-SYNC',
    notes: `Balance sync — ${amount.toFixed(6)} ${info.name} @ $${price ? price.toFixed(2) : 'N/A'}`,
  };

  const ok = await postToSheets(row);
  console.log(`  ${ok ? '✅' : '❌'} ${info.name}: ${amount.toFixed(6)} (~$${totalUSD})`);
  if (ok) synced++;

  await new Promise(r => setTimeout(r, 300)); // avoid rate limits
}

console.log(`\n✅ Synced ${synced} assets to Google Sheets.\n`);

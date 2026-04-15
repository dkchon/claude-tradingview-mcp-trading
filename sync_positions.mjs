/**
 * One-time positions sync — pushes local positions.json to Google Sheets Positions tab
 * Run: node sync_positions.mjs
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';

const SHEETS_WEBHOOK = process.env.GOOGLE_SHEETS_WEBHOOK;
const POSITIONS_FILE = process.env.POSITIONS_FILE || 'positions.json';

if (!SHEETS_WEBHOOK) {
  console.error('❌ GOOGLE_SHEETS_WEBHOOK not set in .env');
  process.exit(1);
}

if (!existsSync(POSITIONS_FILE)) {
  console.error(`❌ ${POSITIONS_FILE} not found`);
  process.exit(1);
}

const positions = JSON.parse(readFileSync(POSITIONS_FILE, 'utf8'));
const symbols = Object.keys(positions);
console.log(`\n📋 Syncing ${symbols.length} positions to Google Sheets...\n`);

let synced = 0;
for (const [symbol, pos] of Object.entries(positions)) {
  try {
    const res = await fetch(SHEETS_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'POSITION-OPEN',
        symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        quantity: pos.quantity,
        entryTime: pos.entryTime,
        orderId: pos.orderId || '',
        paper: pos.paper || false,
        notes: pos.notes || '',
      }),
    });
    const text = await res.text();
    const ok = text.includes('success');
    console.log(`  ${ok ? '✅' : '❌'} ${symbol}`);
    if (ok) synced++;
  } catch (err) {
    console.log(`  ❌ ${symbol}: ${err.message}`);
  }
  await new Promise(r => setTimeout(r, 200));
}

console.log(`\n✅ Synced ${synced}/${symbols.length} positions to Google Sheets.\n`);

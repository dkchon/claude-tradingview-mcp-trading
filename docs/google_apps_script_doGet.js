function normalizeKey(s) {
  return s.replace(/\s*\(.*?\)\s*/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ── Portfolio Summary ─────────────────────────────────────────────────────────
// Reads all LIVE trades, calculates realized P&L per symbol + overall total,
// and writes/refreshes the "Portfolio" tab. Called after every trade append.

function updatePortfolioSummary(ss) {
  var tradeSheet = ss.getSheetByName("Trades") || ss.getActiveSheet();
  var data = tradeSheet.getDataRange().getValues();
  if (data.length < 2) return;

  var headers = data[0].map(function(h) { return normalizeKey(h); });
  var symIdx     = headers.indexOf("symbol");
  var sideIdx    = headers.indexOf("side");
  var totalIdx   = headers.indexOf("totalusd");
  var feeIdx     = headers.indexOf("fee");
  var netIdx     = headers.indexOf("netamount");
  var modeIdx    = headers.indexOf("mode");

  var summary = {}; // { symbol: { spent, received, fees, buys, sells } }

  for (var i = 1; i < data.length; i++) {
    var mode = (data[i][modeIdx] || "").toString();
    if (mode !== "LIVE") continue;

    var sym  = (data[i][symIdx]  || "").toString();
    var side = (data[i][sideIdx] || "").toString().toUpperCase();
    var totalUSD  = parseFloat(data[i][totalIdx]) || 0;
    var fee       = parseFloat(data[i][feeIdx])   || 0;
    var netAmount = parseFloat(data[i][netIdx])   || 0;
    if (!sym || (side !== "BUY" && side !== "SELL")) continue;

    if (!summary[sym]) summary[sym] = { spent: 0, received: 0, fees: 0, buys: 0, sells: 0 };
    if (side === "BUY") {
      summary[sym].spent    += totalUSD;
      summary[sym].fees     += fee;
      summary[sym].buys     += 1;
    } else {
      summary[sym].received += netAmount > 0 ? netAmount : totalUSD;
      summary[sym].fees     += fee;
      summary[sym].sells    += 1;
    }
  }

  // ── Build / refresh Portfolio tab ────────────────────────────────────────────
  var portSheet = ss.getSheetByName("Portfolio");
  if (!portSheet) portSheet = ss.insertSheet("Portfolio");
  portSheet.clearContents();
  portSheet.clearFormats();

  // Header row
  var headerRow = ["Symbol", "Buys", "Total Spent", "Sells", "Total Received", "Fees", "Realized P&L", "Status"];
  portSheet.getRange(1, 1, 1, headerRow.length).setValues([headerRow]).setFontWeight("bold");

  // Data rows sorted by P&L descending
  var rows = [];
  var grandSpent = 0, grandReceived = 0, grandFees = 0;

  for (var sym in summary) {
    var s = summary[sym];
    var pnl = s.received - s.spent - s.fees;
    rows.push([
      sym.replace("USDT", ""),
      s.buys,
      parseFloat(s.spent.toFixed(2)),
      s.sells,
      parseFloat(s.received.toFixed(2)),
      parseFloat(s.fees.toFixed(4)),
      parseFloat(pnl.toFixed(2)),
      pnl >= 0 ? "PROFIT" : "LOSS"
    ]);
    grandSpent    += s.spent;
    grandReceived += s.received;
    grandFees     += s.fees;
  }

  rows.sort(function(a, b) { return b[6] - a[6]; });

  if (rows.length > 0) {
    portSheet.getRange(2, 1, rows.length, headerRow.length).setValues(rows);

    // Color PROFIT green, LOSS red in Status column
    for (var r = 0; r < rows.length; r++) {
      var cell = portSheet.getRange(r + 2, 8);
      cell.setFontColor(rows[r][6] >= 0 ? "#2e7d32" : "#c62828");
    }
  }

  // Totals row
  var totalRow = rows.length + 2;
  var grandPnl  = grandReceived - grandSpent - grandFees;
  portSheet.getRange(totalRow, 1, 1, headerRow.length).setValues([[
    "TOTAL",
    "",
    parseFloat(grandSpent.toFixed(2)),
    "",
    parseFloat(grandReceived.toFixed(2)),
    parseFloat(grandFees.toFixed(4)),
    parseFloat(grandPnl.toFixed(2)),
    grandPnl >= 0 ? "PROFIT" : "LOSS"
  ]]).setFontWeight("bold");
  portSheet.getRange(totalRow, 8).setFontColor(grandPnl >= 0 ? "#2e7d32" : "#c62828");

  // Timestamp
  portSheet.getRange(totalRow + 2, 1).setValue("Last updated: " + new Date().toUTCString());
}

function doPost(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var row = JSON.parse(e.postData.contents);

  // ── Position open/close → Positions tab ─────────────────────────────────────
  if (row.mode === "POSITION-OPEN" || row.mode === "POSITION-CLOSE") {
    var posSheet = ss.getSheetByName("Positions");
    if (!posSheet) {
      posSheet = ss.insertSheet("Positions");
      posSheet.appendRow(["Symbol","Side","EntryPrice","Quantity","EntryTime","OrderId","Paper","Notes"]);
    }
    var posHeaders = posSheet.getRange(1, 1, 1, posSheet.getLastColumn()).getValues()[0];
    var posSymCol = -1;
    for (var ph = 0; ph < posHeaders.length; ph++) {
      if (normalizeKey(posHeaders[ph]) === "symbol") { posSymCol = ph; break; }
    }
    var posData = posSheet.getDataRange().getValues();

    if (row.mode === "POSITION-CLOSE") {
      for (var pd = 1; pd < posData.length; pd++) {
        if (posSymCol >= 0 && posData[pd][posSymCol] === row.symbol) {
          posSheet.deleteRow(pd + 1);
          return ContentService.createTextOutput(JSON.stringify({ success: true, action: "deleted" }))
            .setMimeType(ContentService.MimeType.JSON);
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ success: true, action: "not_found" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // POSITION-OPEN: upsert by symbol
    var posNorm = {};
    for (var pk in row) { posNorm[normalizeKey(pk)] = row[pk]; }
    var posValues = posHeaders.map(function(h) {
      var n = normalizeKey(h);
      return posNorm[n] !== undefined ? posNorm[n] : "";
    });
    for (var pu = 1; pu < posData.length; pu++) {
      if (posSymCol >= 0 && posData[pu][posSymCol] === row.symbol) {
        posSheet.getRange(pu + 1, 1, 1, posValues.length).setValues([posValues]);
        return ContentService.createTextOutput(JSON.stringify({ success: true, action: "updated" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
    posSheet.appendRow(posValues);
    return ContentService.createTextOutput(JSON.stringify({ success: true, action: "inserted" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── Trade / P&L / Balance rows ───────────────────────────────────────────────
  var sheetName = "Trades";
  if (row.mode === "P&L-SNAPSHOT") sheetName = "P&L";
  else if (row.mode === "BALANCE-SYNC") sheetName = "Balances";
  else if (row.mode === "LIVE" || row.mode === "PAPER") sheetName = "Trades";

  var sheet = ss.getSheetByName(sheetName) || ss.getActiveSheet();
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  var rowNorm = {};
  for (var k in row) { rowNorm[normalizeKey(k)] = row[k]; }

  var values = headers.map(function(h) {
    var norm = normalizeKey(h);
    return rowNorm[norm] !== undefined ? rowNorm[norm] : "";
  });

  var modeCol = -1, symbolCol = -1;
  for (var h = 0; h < headers.length; h++) {
    var n = normalizeKey(headers[h]);
    if (n === "mode") modeCol = h;
    if (n === "symbol") symbolCol = h;
  }

  if (row.mode === "P&L-SNAPSHOT" || row.mode === "BALANCE-SYNC") {
    var upsertData = sheet.getDataRange().getValues();
    for (var si = 1; si < upsertData.length; si++) {
      if (modeCol >= 0 && symbolCol >= 0 &&
          upsertData[si][modeCol] === row.mode && upsertData[si][symbolCol] === row.symbol) {
        sheet.getRange(si + 1, 1, 1, values.length).setValues([values]);
        return ContentService.createTextOutput(JSON.stringify({ success: true, action: "updated" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
    sheet.appendRow(values);
    return ContentService.createTextOutput(JSON.stringify({ success: true, action: "inserted" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  sheet.appendRow(values);

  // ── Refresh Portfolio summary after every live trade ─────────────────────────
  if (row.mode === "LIVE" || row.mode === "PAPER") {
    updatePortfolioSummary(ss);
  }

  return ContentService.createTextOutput(JSON.stringify({ success: true, action: "appended" }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var action = e && e.parameter ? e.parameter.action : null;
  var hours = parseInt((e && e.parameter && e.parameter.hours) ? e.parameter.hours : "24");
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── Manually trigger portfolio refresh ───────────────────────────────────────
  if (action === "refresh-portfolio") {
    updatePortfolioSummary(ss);
    return ContentService.createTextOutput(JSON.stringify({ success: true, action: "portfolio-refreshed" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── Return open positions ────────────────────────────────────────────────────
  if (action === "positions") {
    var posSheet = ss.getSheetByName("Positions");
    if (!posSheet) {
      return ContentService.createTextOutput(JSON.stringify({ positions: {} }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    var posData = posSheet.getDataRange().getValues();
    var posHeaders = posData[0];
    var posSymCol = -1;
    for (var ph = 0; ph < posHeaders.length; ph++) {
      if (normalizeKey(posHeaders[ph]) === "symbol") { posSymCol = ph; break; }
    }
    var positions = {};
    for (var pi = 1; pi < posData.length; pi++) {
      if (!posData[pi][0]) continue;
      var sym = posSymCol >= 0 ? posData[pi][posSymCol] : null;
      if (!sym) continue;
      var obj = {};
      posHeaders.forEach(function(h, idx) { obj[normalizeKey(h)] = posData[pi][idx]; });
      positions[sym] = {
        side: obj.side || "buy",
        entryPrice: parseFloat(obj.entryprice) || 0,
        quantity: parseFloat(obj.quantity) || 0,
        entryTime: obj.entrytime || "",
        orderId: obj.orderid || "",
        paper: obj.paper === "true" || obj.paper === true,
        notes: obj.notes || "",
      };
    }
    return ContentService.createTextOutput(JSON.stringify({ positions: positions }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // ── Return recent trades ─────────────────────────────────────────────────────
  if (action === "recent") {
    var tradeSheet = ss.getSheetByName("Trades") || ss.getActiveSheet();
    var tradeData = tradeSheet.getDataRange().getValues();
    var tradeHeaders = tradeData[0];
    var cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    var trades = [];
    for (var ti = 1; ti < tradeData.length; ti++) {
      var rawDate = tradeData[ti][0];
      var rawTime = tradeData[ti][1];
      if (!rawDate || !rawTime) continue;
      // Handle Date objects (Google Sheets auto-converts date strings to Date objects)
      var dateStr = rawDate instanceof Date
        ? Utilities.formatDate(rawDate, "UTC", "yyyy-MM-dd")
        : String(rawDate);
      var timeStr = rawTime instanceof Date
        ? Utilities.formatDate(rawTime, "UTC", "HH:mm:ss")
        : String(rawTime);
      var ts = new Date(dateStr + "T" + timeStr + "Z");
      if (isNaN(ts) || ts < cutoff) continue;
      var tObj = {};
      // Use normalizeKey so callers can filter by t.mode, t.symbol, etc. (lowercase)
      tradeHeaders.forEach(function(h, idx) { tObj[normalizeKey(h)] = tradeData[ti][idx]; });
      trades.push(tObj);
    }
    return ContentService.createTextOutput(JSON.stringify({ trades: trades }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ error: "unknown action" }))
    .setMimeType(ContentService.MimeType.JSON);
}

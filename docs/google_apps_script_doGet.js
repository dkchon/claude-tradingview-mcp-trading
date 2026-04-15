function normalizeKey(s) {
  return s.replace(/\s*\(.*?\)\s*/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
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
  return ContentService.createTextOutput(JSON.stringify({ success: true, action: "appended" }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var action = e && e.parameter ? e.parameter.action : null;
  var hours = parseInt((e && e.parameter && e.parameter.hours) ? e.parameter.hours : "24");
  var ss = SpreadsheetApp.getActiveSpreadsheet();

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
      var dateStr = tradeData[ti][0];
      var timeStr = tradeData[ti][1];
      if (!dateStr || !timeStr) continue;
      var ts = new Date(dateStr + "T" + timeStr + "Z");
      if (isNaN(ts) || ts < cutoff) continue;
      var tObj = {};
      tradeHeaders.forEach(function(h, idx) { tObj[h] = tradeData[ti][idx]; });
      trades.push(tObj);
    }
    return ContentService.createTextOutput(JSON.stringify({ trades: trades }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ error: "unknown action" }))
    .setMimeType(ContentService.MimeType.JSON);
}

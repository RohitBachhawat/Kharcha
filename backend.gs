// ══════════════════════════════════════════════════════════
//  KHARCHA v5 — Google Apps Script Backend
//  Deploy → New Deployment → Web App
//  Execute as: Me | Who has access: Anyone
// ══════════════════════════════════════════════════════════

const SHEET_ID       = '1_oRggcTg8JBWik-q15-m7BfIH30kz4cTsIcipdjhYuo'; // ← replace this
const SHEET_EXPENSES = 'Expenses';
const SHEET_SHAADI   = 'Shaadi';

// Columns: Date, Item, Amount, Shop, Comment, Tag, Category, Logged By, Raw Text, Timestamp, Last Updated

// ══════════════════════════════════════════════════════════
//  POST — add / update / move
// ══════════════════════════════════════════════════════════
function doPost(e) {
  try {
    if (!e) return fail('No event object received');
    let data = null;

    // Apps Script with no-cors can deliver body in different ways — try all
    if (e.postData && e.postData.contents && e.postData.contents.trim().length > 2) {
      try {
        var parsed = JSON.parse(e.postData.contents);
        // Handle both object {..} and mistaken array [{..}]
        data = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch(parseErr) {
        return fail('JSON parse error: ' + parseErr.message + ' | raw: ' + e.postData.contents.substring(0, 100));
      }
    } else if (e.parameter && e.parameter.item) {
      // Fallback: form-encoded parameters
      data = e.parameter;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      var raw = e.postData ? (e.postData.contents || '(empty)') : '(no postData)';
      return fail('No valid data received. Raw: ' + raw.substring(0, 200));
    }

    // ── Update existing row ──────────────────────────────
    if (data.action === 'updateRow') {
      const ss    = SpreadsheetApp.openById(SHEET_ID);
      const sheet = ss.getSheetByName(data.sheetName || SHEET_EXPENSES);
      if (!sheet) throw new Error('Sheet not found: ' + data.sheetName);
      const rowNum = parseInt(data.rowNum);
      if (isNaN(rowNum) || rowNum < 2) throw new Error('Invalid row: ' + data.rowNum);
      const now = new Date();
      sheet.getRange(rowNum, 1).setValue(data.date     || '');
      sheet.getRange(rowNum, 2).setValue(data.item     || '');
      sheet.getRange(rowNum, 3).setValue(data.amount   || '');
      sheet.getRange(rowNum, 4).setValue(data.shop     || '');
      sheet.getRange(rowNum, 5).setValue(data.comment  || '');
      sheet.getRange(rowNum, 6).setValue(data.tag      || '');
      sheet.getRange(rowNum, 7).setValue(data.category || '');
      sheet.getRange(rowNum, 8).setValue(data.loggedBy || '');
      sheet.getRange(rowNum, 9).setValue(data.rawText  || '');
      // Col 10 = Timestamp (keep original, don't touch)
      sheet.getRange(rowNum, 11).setValue(now.toLocaleString('en-IN'));
      return ok({ action: 'updated', row: rowNum });
    }

    // ── Move row between sheets ──────────────────────────
    if (data.action === 'moveRow') {
      const ss        = SpreadsheetApp.openById(SHEET_ID);
      const fromSheet = ss.getSheetByName(data.fromSheet);
      if (!fromSheet) throw new Error('Source sheet not found: ' + data.fromSheet);

      // Read original timestamp before deleting
      const rowNum = parseInt(data.rowNum);
      if (isNaN(rowNum) || rowNum < 2) throw new Error('Invalid row: ' + data.rowNum);
      const originalTs = fromSheet.getRange(rowNum, 10).getValue();

      // Delete from source sheet
      fromSheet.deleteRow(rowNum);

      // Write to destination sheet
      const toSheetName = (data.toSheet === 'Shaadi') ? SHEET_SHAADI : SHEET_EXPENSES;
      let toSheet = ss.getSheetByName(toSheetName);
      if (!toSheet) {
        toSheet = ss.insertSheet(toSheetName);
        if (!toSheet) throw new Error('Could not create sheet: ' + toSheetName);
        setupHeaders(toSheet, toSheetName);
        // Use object returned by insertSheet directly — no re-fetch
      }

      const now = new Date();
      toSheet.appendRow([
        data.date     || '',
        data.item     || '',
        data.amount   || '',
        data.shop     || '',
        data.comment  || '',
        data.tag      || '',
        data.category || '',
        data.loggedBy || '',
        data.rawText  || '',
        originalTs || now.toLocaleString('en-IN'), // preserve original timestamp
        now.toLocaleString('en-IN')                // last updated = now
      ]);

      return ok({ action: 'moved', from: data.fromSheet, to: data.toSheet });
    }

    // ── Gemini Vision via POST ───────────────────────────
    if (data.action === 'geminiVision') {
      const result = callGeminiVision(data.apiKey, data.mimeType || 'image/jpeg', data.base64Data);
      return ok({ result: result });
    }

    // ── Add new row ──────────────────────────────────────
    const isShaadi  = (data.sheetName === 'Shaadi') || (data.tag && data.tag.toLowerCase() === 'shaadi');
    const sheetName = isShaadi ? SHEET_SHAADI : SHEET_EXPENSES;
    const rowNum    = writeToSheet(data, sheetName);
    return ok({ action: 'added', sheet: sheetName, row: rowNum });

  } catch (err) {
    return fail(err.message);
  }
}

// ══════════════════════════════════════════════════════════
//  GET — getRecent | getSummary | geminiProxy | geminiVision | test
// ══════════════════════════════════════════════════════════
function doGet(e) {
  try {
    const action = e && e.parameter && e.parameter.action;

    // ── Recent rows ──────────────────────────────────────
    if (action === 'getRecent') {
      const sheetName = (e.parameter.sheet === 'Shaadi') ? SHEET_SHAADI : SHEET_EXPENSES;
      const n         = parseInt(e.parameter.n) || 10;
      const offset    = parseInt(e.parameter.offset) || 0;
      return ok({ sheet: sheetName, rows: getRecentRows(sheetName, n, offset) });
    }

    // ── Analytics summary ────────────────────────────────
    if (action === 'getSummary') {
      return ok(getSummary());
    }

    // ── Gemini text proxy ────────────────────────────────
    if (action === 'geminiProxy') {
      const apiKey = e.parameter.apiKey;
      const prompt = e.parameter.prompt;
      if (!apiKey || !prompt) throw new Error('Missing apiKey or prompt');
      const result = callGemini(apiKey, prompt, null, null);
      return ok({ result: result });
    }

    // ── Gemini Vision (image/PDF) ────────────────────────
    if (action === 'geminiVision') {
      const apiKey    = e.parameter.apiKey;
      const mimeType  = e.parameter.mimeType || 'image/jpeg';
      const base64Data= e.parameter.base64Data;
      if (!apiKey || !base64Data) throw new Error('Missing apiKey or base64Data');
      const result = callGeminiVision(apiKey, mimeType, base64Data);
      return ok({ result: result });
    }

    // ── Test ─────────────────────────────────────────────
    if (e && e.parameter && e.parameter.test) {
      const sheet = e.parameter.sheet === 'Shaadi' ? SHEET_SHAADI : SHEET_EXPENSES;
      const rowNum = writeToSheet({
        date: new Date().toLocaleDateString('en-IN'),
        item: 'TEST ENTRY — delete this row',
        amount: 1, shop: 'Test', comment: 'Auto test',
        tag: 'Regular', category: 'Other',
        loggedBy: 'Setup Test', rawText: 'test 1'
      }, sheet);
      return ok({ message: 'Test row written to "' + sheet + '" at row ' + rowNum });
    }

    return ok({ message: 'Kharcha backend is live! v5' });

  } catch (err) {
    return fail(err.message);
  }
}

// ══════════════════════════════════════════════════════════
//  ANALYTICS
// ══════════════════════════════════════════════════════════
function getSummary() {
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(SHEET_EXPENSES);
  if (!sheet || sheet.getLastRow() < 2) return { thisMonth: 0, lastMonth: 0, thisWeek: 0 };

  const IST_OFFSET = 5.5 * 60 * 60 * 1000;
  const now        = new Date(Date.now() + IST_OFFSET);
  const thisMonth  = now.getUTCMonth();
  const thisYear   = now.getUTCFullYear();
  const lastMonth  = thisMonth === 0 ? 11 : thisMonth - 1;
  const lastYear   = thisMonth === 0 ? thisYear - 1 : thisYear;

  const dayOfWeek  = now.getUTCDay();
  const diffToMon  = (dayOfWeek === 0) ? 6 : dayOfWeek - 1;
  const weekStart  = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - diffToMon);
  weekStart.setUTCHours(0, 0, 0, 0);

  const lastRow = sheet.getLastRow();
  const values  = sheet.getRange(2, 1, lastRow - 1, 3).getValues();

  let thisMonthTotal = 0, lastMonthTotal = 0, thisWeekTotal = 0;

  values.forEach(row => {
    const rawDate = row[0];
    const amount  = parseFloat(row[2]) || 0;
    if (!rawDate || !amount) return;
    let d = rawDate instanceof Date ? rawDate : new Date(String(rawDate).trim());
    if (isNaN(d.getTime())) return;
    const dIST = new Date(d.getTime() + IST_OFFSET);
    const m = dIST.getUTCMonth(), y = dIST.getUTCFullYear();
    if (m === thisMonth && y === thisYear)  thisMonthTotal += amount;
    if (m === lastMonth && y === lastYear)  lastMonthTotal += amount;
    if (dIST >= weekStart && dIST <= now)   thisWeekTotal  += amount;
  });

  return {
    thisMonth: Math.round(thisMonthTotal),
    lastMonth: Math.round(lastMonthTotal),
    thisWeek:  Math.round(thisWeekTotal)
  };
}

// ══════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════
function formatDate(val) {
  if (!val) return '';
  var d = (val instanceof Date) ? val : new Date(String(val).trim());
  if (isNaN(d.getTime())) return String(val);
  var days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return days[d.getDay()] + ', ' + String(d.getDate()).padStart(2,'0') + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

function getRecentRows(sheetName, n, offset) {
  offset = offset || 0;
  const ss    = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const lastRow  = sheet.getLastRow();
  // Work backwards from the end, skipping `offset` rows
  const endRow   = Math.max(2, lastRow - offset);
  const startRow = Math.max(2, endRow - n + 1);
  const numRows  = endRow - startRow + 1;
  if(numRows <= 0) return [];
  const values   = sheet.getRange(startRow, 1, numRows, 11).getValues();
  const rows = [];
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    rows.push({
      rowNum:      startRow + i,
      sheetName,
      date:        formatDate(v[0]),
      item:        String(v[1]  || ''),
      amount:      v[2] !== '' ? v[2] : null,
      shop:        String(v[3]  || ''),
      comment:     String(v[4]  || ''),
      tag:         String(v[5]  || ''),
      category:    String(v[6]  || ''),
      loggedBy:    String(v[7]  || ''),
      rawText:     String(v[8]  || ''),
      timestamp:   String(v[9]  || ''),
      lastUpdated: String(v[10] || ''),
    });
  }
  return rows;
}

function writeToSheet(data, sheetName) {
  if (!data || typeof data !== 'object') throw new Error('writeToSheet called with no data — bug in doPost. data=' + JSON.stringify(data));
  if (!data.item && (data.amount === undefined || data.amount === null || String(data.amount).trim() === '')) {
    throw new Error('writeToSheet: both item and amount are empty. data=' + JSON.stringify(data));
  }

  // Always resolve to known constants — never create arbitrary sheet names
  const resolvedName = (sheetName === SHEET_SHAADI || sheetName === 'Shaadi')
    ? SHEET_SHAADI : SHEET_EXPENSES;

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss  = SpreadsheetApp.openById(SHEET_ID);
    let sheet = ss.getSheetByName(resolvedName);
    if (!sheet) {
      // Sheet genuinely doesn't exist — create it
      sheet = ss.insertSheet(resolvedName);
      if (!sheet) throw new Error('Could not create sheet: ' + resolvedName);
      setupHeaders(sheet, resolvedName);
      // Use the object insertSheet returned — no re-fetch needed
    }
    const now = new Date();
    const ts  = now.toLocaleString('en-IN');
    sheet.appendRow([
      data.date     || now.toLocaleDateString('en-IN'),
      data.item     || '',
      data.amount   || '',
      data.shop     || '',
      data.comment  || '',
      data.tag      || '',
      data.category || '',
      data.loggedBy || '',
      data.rawText  || '',
      ts,
      ts,
      data.payMode  || 'Cash'
    ]);
    return sheet.getLastRow();
  } finally {
    lock.releaseLock();
  }
}

function setupHeaders(sheet, sheetName) {
  if (!sheet) throw new Error('setupHeaders: sheet is null for ' + sheetName);
  const headers = ['Date','Item','Amount (₹)','Shop','Comment','Tag','Category','Logged By','Raw Text','Timestamp','Last Updated','Payment Mode'];
  sheet.appendRow(headers);
  const r = sheet.getRange(1, 1, 1, headers.length);
  if (sheetName === SHEET_SHAADI) { r.setBackground('#880E4F'); r.setFontColor('#FFD6EC'); }
  else { r.setBackground('#1B2A1B'); r.setFontColor('#7CFC00'); }
  r.setFontWeight('bold');
  sheet.setFrozenRows(1);
  [100,220,100,150,220,100,110,100,240,160,160,110].forEach((w,i) => sheet.setColumnWidth(i+1, w));
}

// ══════════════════════════════════════════════════════════
//  GEMINI TEXT PROXY
// ══════════════════════════════════════════════════════════
function callGemini(apiKey, prompt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=' + apiKey;
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 600 }
    }),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) throw new Error('Gemini API error ' + code + ': ' + body.substring(0, 300));
  const json = JSON.parse(body);
  return json.candidates[0].content.parts[0].text;
}

// ══════════════════════════════════════════════════════════
//  GEMINI VISION (image / PDF)
// ══════════════════════════════════════════════════════════
function callGeminiVision(apiKey, mimeType, base64Data) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=' + apiKey;

  const prompt = 'You are an expense extractor. Look at this bill, receipt, passbook or document image and extract ALL expense items. Return ONLY a valid JSON array, no markdown.\n\n'
    + 'Return: [{"date":"DD Mon YYYY or today if unclear","item":"description in English","amount":number_or_null,"shop":"merchant_or_null","comment":"any note or null","category":"Food|Transport|Shopping|Utilities|Health|Entertainment|Other|null"}]\n\n'
    + 'If multiple items on the bill, return one object per item. Return ONLY the JSON array.';

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64Data } }
      ]
    }],
    generationConfig: { maxOutputTokens: 1000 }
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = response.getContentText();
  if (code !== 200) throw new Error('Gemini Vision error ' + code + ': ' + body.substring(0, 300));
  const json = JSON.parse(body);
  return json.candidates[0].content.parts[0].text;
}

function ok(data)  { return ContentService.createTextOutput(JSON.stringify({ success: true,  ...data })).setMimeType(ContentService.MimeType.JSON); }
function fail(msg) { return ContentService.createTextOutput(JSON.stringify({ success: false, error: msg })).setMimeType(ContentService.MimeType.JSON); }

// ══════════════════════════════════════════════════════════
//  MANUAL TESTS — run from Apps Script editor
// ══════════════════════════════════════════════════════════
function testAdd()     { Logger.log(doPost({postData:{contents:JSON.stringify({date:'07 May 2026',item:'Tea',amount:20,shop:'Tapri',category:'Food',tag:'Regular',loggedBy:'Test',rawText:'chai 20 tapri',sheetName:'Expenses'})}}).getContent()); }
function testUpdate()  { Logger.log(doPost({postData:{contents:JSON.stringify({action:'updateRow',rowNum:2,sheetName:'Expenses',date:'07 May 2026',item:'Tea updated',amount:25,shop:'Tapri',category:'Food',tag:'Regular',loggedBy:'Test',rawText:''})}}).getContent()); }
function testMove()    { Logger.log(doPost({postData:{contents:JSON.stringify({action:'moveRow',rowNum:2,fromSheet:'Expenses',toSheet:'Shaadi',date:'07 May 2026',item:'Saree',amount:5000,shop:'Nalli',category:'Shopping',tag:'Shaadi',loggedBy:'Test',rawText:'saree 5000'})}}).getContent()); }
function testRecent()  { Logger.log(doGet({parameter:{action:'getRecent',sheet:'Expenses',n:'5'}}).getContent()); }
function testSummary() { Logger.log(doGet({parameter:{action:'getSummary'}}).getContent()); }

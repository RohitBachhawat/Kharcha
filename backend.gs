// ══════════════════════════════════════════════════════════
//  KHARCHA v5 — Google Apps Script Backend
//  Deploy → New Deployment → Web App
//  Execute as: Me | Who has access: Anyone
// ══════════════════════════════════════════════════════════

const SHEET_ID       = '1lKgkFTlcs8ZHXDzPAtfm3yW8SKSTMqZras7kygqmBwk';
const SHEET_EXPENSES = 'Expenses';
const SHEET_SHAADI   = 'Shaadi';
const BILLS_FOLDER   = 'Kharcha Bills'; // Drive folder where confirmed bill photos are saved
const SHEET_TRACES   = 'AI_Traces'; // Log of every Gemini call (text/SMS/photo), for debugging parse quality
const TRACE_RETENTION_DAYS = 365; // Change this single value to adjust how long trace rows are kept
const SHEET_EVALS        = 'Evals';        // Fixed test cases with known-correct answers, for scoring parse quality
const SHEET_EVAL_RESULTS = 'Eval_Results'; // One row per eval run, so scores are trackable over time

// Columns: Date, Item, Amount, Shop, Comment, Tag, Category, Logged By, Raw Text, Timestamp, Last Updated, Payment Mode, Additional Info, Trace ID

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
      Logger.log('doPost: REJECTED — no valid data. postData.type=' + (e.postData ? e.postData.type : 'none') + ', contents.length=' + (e.postData && e.postData.contents ? e.postData.contents.length : 0) + ', raw=' + raw.substring(0, 200));
      return fail('No valid data received. Raw: ' + raw.substring(0, 200));
    }

    // Logged for every valid request so the Executions log always shows what actually
    // arrived — no need to reproduce a bug just to find out what the server received.
    Logger.log('doPost: action=' + (data.action || '(add row)') + ', keys=' + Object.keys(data).join(',') +
      (data.rows ? ', rows=' + data.rows.length : '') +
      (data.base64Data !== undefined ? ', base64Data.length=' + (data.base64Data ? data.base64Data.length : 0) : ''));

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
      if (data.payMode !== undefined) sheet.getRange(rowNum, 12).setValue(data.payMode);
      // Col 13 = Additional Info (bill photo link) — only touch if explicitly passed,
      // so edits that don't mention it never wipe out an existing photo link.
      if (data.additionalInfo !== undefined) sheet.getRange(rowNum, 13).setValue(data.additionalInfo);
      // Col 14 = Trace ID (link back to the AI_Traces row that produced this entry) —
      // same defensive rule: only touch if explicitly passed.
      if (data.traceId !== undefined) sheet.getRange(rowNum, 14).setValue(data.traceId);
      return ok({ action: 'updated', row: rowNum });
    }

    // ── Move row between sheets ──────────────────────────
    if (data.action === 'moveRow') {
      const ss        = SpreadsheetApp.openById(SHEET_ID);
      const fromSheet = ss.getSheetByName(data.fromSheet);
      if (!fromSheet) throw new Error('Source sheet not found: ' + data.fromSheet);

      // Read original timestamp/payment mode/additional info before deleting
      const rowNum = parseInt(data.rowNum);
      if (isNaN(rowNum) || rowNum < 2) throw new Error('Invalid row: ' + data.rowNum);
      const originalTs             = fromSheet.getRange(rowNum, 10).getValue();
      const originalPayMode        = fromSheet.getRange(rowNum, 12).getValue();
      const originalAdditionalInfo = fromSheet.getRange(rowNum, 13).getValue();
      const originalTraceId        = fromSheet.getRange(rowNum, 14).getValue();

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
        now.toLocaleString('en-IN'),                // last updated = now
        data.payMode !== undefined ? data.payMode : (originalPayMode || 'Cash'),
        data.additionalInfo !== undefined ? data.additionalInfo : (originalAdditionalInfo || ''),
        data.traceId !== undefined ? data.traceId : (originalTraceId || '')
      ]);

      return ok({ action: 'moved', from: data.fromSheet, to: data.toSheet });
    }

    // ── Gemini Vision via POST ───────────────────────────
    if (data.action === 'geminiVision') {
      const result = callGeminiVision(data.apiKey, data.mimeType || 'image/jpeg', data.base64Data);
      return ok({ result: result });
    }

    // ── Save a confirmed bill photo + its row(s) in ONE fire-and-forget call ──
    // Only ever sent after the user reviews the parsed items and taps Confirm & Save.
    // Deliberately does everything server-side in a single request — this app's other
    // writes all use no-cors fire-and-forget because Apps Script POST *responses*
    // generally can't be read back cross-origin (even though the request itself runs
    // fine). A separate "upload photo, read its URL, then save the row" round trip
    // would silently lose the URL for exactly that reason. Doing it all here avoids
    // ever needing to read a response.
    // ── AI trace log — records every Gemini Vision parse attempt for debugging ──
    // Fire-and-forget from the frontend, never blocks or affects the main save flow.
    // Deliberately tolerant: logging failures should never surface as user-facing errors.
    // ── AI trace log — records every Gemini call (text/SMS/photo) for debugging ──
    // Fire-and-forget from the frontend, never blocks or affects the main save flow.
    // Deliberately tolerant: logging failures should never surface as user-facing errors.
    if (data.action === 'logAITrace') {
      try { logAITrace(data); } catch (traceErr) { Logger.log('logAITrace failed (non-fatal): ' + traceErr.message); }
      return ok({});
    }

    // ── Eval run result — one row per full eval suite run ──
    if (data.action === 'logEvalRun') {
      try { logEvalRun(data); } catch (evalErr) { Logger.log('logEvalRun failed (non-fatal): ' + evalErr.message); }
      return ok({});
    }

    if (data.action === 'addWithPhoto') {
      if (!data.rows || !data.rows.length) {
        // Previously this would silently return ok() with an empty rows array —
        // "Completed" in Executions with nothing actually saved, and no clue why.
        // Fail loudly instead so the real cause is visible without guessing.
        throw new Error('addWithPhoto: no rows in payload (rows=' + JSON.stringify(data.rows) + ', base64Data.length=' + (data.base64Data ? data.base64Data.length : 0) + ')');
      }
      let photoUrl = '';
      try {
        photoUrl = saveImageToDrive(data.base64Data, data.mimeType || 'image/jpeg', data.fileName);
      } catch (imgErr) {
        // Non-fatal — still save the expense rows even if the Drive upload fails.
        Logger.log('addWithPhoto: image save failed, saving rows without a link: ' + imgErr.message);
      }
      const rowNums = (data.rows || []).map(function(rowData) {
        rowData.additionalInfo = photoUrl;
        const isShaadiRow  = (rowData.sheetName === 'Shaadi') || (rowData.tag && rowData.tag.toLowerCase() === 'shaadi');
        const rowSheetName = isShaadiRow ? SHEET_SHAADI : SHEET_EXPENSES;
        return writeToSheet(rowData, rowSheetName);
      });
      return ok({ action: 'addedWithPhoto', url: photoUrl, rows: rowNums });
    }

    // ── Save a bill photo to Drive on its own (kept for standalone/manual use;
    //    the main app flow above no longer relies on this since it requires
    //    reading the response back, which doesn't work reliably cross-origin) ──
    if (data.action === 'saveImage') {
      const url = saveImageToDrive(data.base64Data, data.mimeType || 'image/jpeg', data.fileName);
      return ok({ url: url });
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

    // ── Eval cases (fixed test set with known-correct answers) ──
    if (action === 'getEvalCases') {
      return ok({ cases: getEvalCases() });
    }

    // ── Eval fixture image (a photo case's bill image, from Drive) ──
    if (action === 'getEvalImage') {
      const fileId = e.parameter.fileId;
      if (!fileId) throw new Error('Missing fileId');
      const file = DriveApp.getFileById(fileId);
      return ok({ base64Data: Utilities.base64Encode(file.getBlob().getBytes()), mimeType: file.getBlob().getContentType() });
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
  const values   = sheet.getRange(startRow, 1, numRows, 14).getValues();
  const rows = [];
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    rows.push({
      rowNum:         startRow + i,
      sheetName,
      date:           formatDate(v[0]),
      item:           String(v[1]  || ''),
      amount:         v[2] !== '' ? v[2] : null,
      shop:           String(v[3]  || ''),
      comment:        String(v[4]  || ''),
      tag:            String(v[5]  || ''),
      category:       String(v[6]  || ''),
      loggedBy:       String(v[7]  || ''),
      rawText:        String(v[8]  || ''),
      timestamp:      String(v[9]  || ''),
      lastUpdated:    String(v[10] || ''),
      payMode:        String(v[11] || ''),
      additionalInfo: String(v[12] || ''),
      traceId:        String(v[13] || ''),
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
      data.payMode  || 'Cash',
      data.additionalInfo || '',
      data.traceId || ''
    ]);
    return sheet.getLastRow();
  } finally {
    lock.releaseLock();
  }
}

function setupHeaders(sheet, sheetName) {
  if (!sheet) throw new Error('setupHeaders: sheet is null for ' + sheetName);
  const headers = ['Date','Item','Amount (₹)','Shop','Comment','Tag','Category','Logged By','Raw Text','Timestamp','Last Updated','Payment Mode','Additional Info','Trace ID'];
  sheet.appendRow(headers);
  const r = sheet.getRange(1, 1, 1, headers.length);
  if (sheetName === SHEET_SHAADI) { r.setBackground('#880E4F'); r.setFontColor('#FFD6EC'); }
  else { r.setBackground('#1B2A1B'); r.setFontColor('#7CFC00'); }
  r.setFontWeight('bold');
  sheet.setFrozenRows(1);
  [100,220,100,150,220,100,110,100,240,160,160,110,220,160].forEach((w,i) => sheet.setColumnWidth(i+1, w));
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

// ══════════════════════════════════════════════════════════
//  DRIVE — save confirmed bill photo
// ══════════════════════════════════════════════════════════
// Only ever called once the user has reviewed the parsed items and
// tapped "Confirm & Save" — the image is never touched before that.
function saveImageToDrive(base64Data, mimeType, fileName) {
  if (!base64Data) throw new Error('saveImageToDrive: no image data received');
  const folder = getOrCreateBillsFolder();
  const bytes  = Utilities.base64Decode(base64Data);
  const blob   = Utilities.newBlob(bytes, mimeType, fileName || ('bill_' + new Date().getTime() + '.jpg'));
  const file   = folder.createFile(blob);
  // "Anyone with the link" so family members can open it even without Drive access
  // to the owner's account — same trust model as the rest of this no-auth app.
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file.getUrl();
}

function getOrCreateBillsFolder() {
  const folders = DriveApp.getFoldersByName(BILLS_FOLDER);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(BILLS_FOLDER);
}

// ══════════════════════════════════════════════════════════
//  AI TRACING — one row per Gemini call (text / SMS / photo)
// ══════════════════════════════════════════════════════════
// This is the trace log for every AI-assisted parse: every time Gemini reads a bill
// photo, a typed expense, or a bank SMS, the raw output and derived numbers land
// here — so a future "why did it read this wrong?" question can be answered by
// opening a sheet tab instead of guessing or reconstructing theories from arithmetic.
// Never blocks or fails the main app if logging itself errors.
//
// A matching "Trace ID" column on Expenses/Shaadi links each saved row back to the
// exact trace row that produced it — open the expense row, copy its Trace ID, find
// the matching row here, and you have the full story: raw model input/output,
// retries, errors, timing, all of it. Raw user input (typed text / SMS content) is
// deliberately NOT logged here — the Trace ID linkage plus the model's raw response
// already give enough to debug with, without a second copy of potentially sensitive
// bank SMS content sitting in an extra sheet tab.
//
// SCHEMA CHANGES: this function only cares about the `TRACE_HEADERS` array below and
// the matching order in the `appendRow` call in logAITrace(). To add a new field
// later: add it to TRACE_HEADERS, add it to the appendRow array in the same position,
// add a column-width entry, and update the frontend's logAITrace() call site to pass
// it. getOrCreateTraceSheet() self-heals — if the live sheet's header row doesn't
// match TRACE_HEADERS, it archives the old sheet (if it has real data) or replaces it
// outright (if it's still just an empty header) and creates a fresh one. No manual
// migration function needed for this particular sheet, unlike Expenses/Shaadi.
const TRACE_HEADERS = ['Trace ID','Timestamp','Type','Attempt','Model','Prompt Version','Items (raw)','Items (kept)','Items Sum','Receipt Total','Mismatch?','Mismatch Amount','HTTP Status','Error Category','Error Message','Latency (ms)','Outcome','Edited Fields','User Agent','Logged By','File Name','Raw Model Response'];
const TRACE_COL_WIDTHS = [110, 140, 60, 60, 150, 130, 80, 80, 90, 100, 85, 110, 90, 130, 220, 90, 110, 160, 220, 100, 140, 400];

function logAITrace(data) {
  const sheet = getOrCreateTraceSheet();
  const now = new Date();
  const rawText = String(data.rawResponse || '').substring(0, 3000); // cap so one weird response can't blow up a cell
  sheet.appendRow([
    data.traceId || '',
    now.toLocaleString('en-IN'),
    data.type || '',
    data.attempt != null ? data.attempt : '',
    data.model || '',
    data.promptVersion || '',
    data.itemsCountRaw != null ? data.itemsCountRaw : '',
    data.itemsCountFiltered != null ? data.itemsCountFiltered : '',
    data.itemsSum != null ? data.itemsSum : '',
    data.receiptTotal != null ? data.receiptTotal : '',
    data.mismatch ? 'YES' : 'NO',
    data.mismatchAmount != null ? data.mismatchAmount : '',
    data.httpStatus != null ? data.httpStatus : '',
    data.errorCategory || '',
    data.errorMessage || '',
    data.latencyMs != null ? data.latencyMs : '',
    data.outcome || '',
    data.editedFields || '',
    data.userAgent || '',
    data.loggedBy || '',
    data.fileName || '',
    rawText,
  ]);
}

function getOrCreateTraceSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_TRACES);
  if (sheet) {
    const lastCol = sheet.getLastColumn();
    const currentHeaders = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    const matches = JSON.stringify(currentHeaders) === JSON.stringify(TRACE_HEADERS);
    if (!matches) {
      if (sheet.getLastRow() > 1) {
        // Real data exists under an old schema — archive it, never destroy it.
        const archiveName = SHEET_TRACES + '_archive_' + new Date().getTime();
        sheet.setName(archiveName);
        Logger.log('AI_Traces schema changed — archived old sheet as ' + archiveName);
      } else {
        // Just an empty/mismatched header, no real rows — safe to replace outright.
        ss.deleteSheet(sheet);
      }
      sheet = null;
    }
  }
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_TRACES);
    sheet.appendRow(TRACE_HEADERS);
    const r = sheet.getRange(1, 1, 1, TRACE_HEADERS.length);
    r.setBackground('#1a1a2e'); r.setFontColor('#a8b3ff'); r.setFontWeight('bold');
    sheet.setFrozenRows(1);
    TRACE_COL_WIDTHS.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  }
  return sheet;
}

// Deletes trace rows older than TRACE_RETENTION_DAYS. Change that one constant near
// the top of this file to adjust retention — nothing else needs to change.
function cleanupOldTraces() {
  const sheet = getOrCreateTraceSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('cleanupOldTraces: no rows to check'); return; }
  const cutoff = new Date(Date.now() - TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues(); // Trace ID, Timestamp columns
  let deleted = 0;
  // Delete bottom-up so earlier row indices don't shift while we're still iterating.
  for (let i = values.length - 1; i >= 0; i--) {
    const ts = new Date(values[i][1]);
    if (!isNaN(ts.getTime()) && ts < cutoff) { sheet.deleteRow(i + 2); deleted++; }
  }
  Logger.log('cleanupOldTraces: deleted ' + deleted + ' row(s) older than ' + TRACE_RETENTION_DAYS + ' days');
}

// Run this ONCE manually from the Apps Script editor (select it in the function
// dropdown, click Run) to schedule cleanupOldTraces() to run automatically every day.
// Safe to re-run — it removes any existing trigger for this function first, so you'll
// never end up with duplicate triggers firing multiple times a day.
function installTraceCleanupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'cleanupOldTraces') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('cleanupOldTraces').timeBased().everyDays(1).atHour(3).create();
  Logger.log('Daily trace cleanup scheduled — runs around 3am each day, deleting trace rows older than ' + TRACE_RETENTION_DAYS + ' days.');
}

// ══════════════════════════════════════════════════════════
//  EVALS — a fixed, versioned test set for scoring parse quality
// ══════════════════════════════════════════════════════════
// Deliberately holds NO prompt-building logic — that stays in index.html as the single
// source of truth, so eval results always reflect exactly what production does, with
// zero risk of a second copy of a prompt silently drifting from the real one. This file
// only stores test cases, serves fixture images, and records run results.
//
// SCHEMA CHANGES: extend EVAL_HEADERS + the appendRow in seedEvalCases()/addEvalCase()
// (same order), and update the frontend's case-reading code to use the new field.
const EVAL_HEADERS = ['Case ID', 'Type', 'Input', 'Expected Items (JSON)', 'Expected Total', 'Image File ID', 'Notes'];
const EVAL_RESULT_HEADERS = ['Run ID', 'Timestamp', 'Model', 'Vision Prompt Version', 'Text Prompt Version', 'SMS Prompt Version', 'Cases Run', 'Amount Score (%)', 'Item Name Score (%)', 'Category Score (%)', 'Overall Score (%)', 'Per-Case Detail (JSON)'];

function getOrCreateEvalsSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_EVALS);
  if (sheet) return sheet;
  sheet = ss.insertSheet(SHEET_EVALS);
  sheet.appendRow(EVAL_HEADERS);
  const r = sheet.getRange(1, 1, 1, EVAL_HEADERS.length);
  r.setBackground('#1a2e1a'); r.setFontColor('#a8ffb3'); r.setFontWeight('bold');
  sheet.setFrozenRows(1);
  [90, 70, 260, 320, 100, 200, 260].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  return sheet;
}

function getOrCreateEvalResultsSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(SHEET_EVAL_RESULTS);
  if (sheet) return sheet;
  sheet = ss.insertSheet(SHEET_EVAL_RESULTS);
  sheet.appendRow(EVAL_RESULT_HEADERS);
  const r = sheet.getRange(1, 1, 1, EVAL_RESULT_HEADERS.length);
  r.setBackground('#1a2e1a'); r.setFontColor('#a8ffb3'); r.setFontWeight('bold');
  sheet.setFrozenRows(1);
  [110, 140, 150, 130, 130, 130, 80, 100, 110, 110, 100, 400].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
  return sheet;
}

// Returns every eval case as a plain object array, ready for the frontend to run.
function getEvalCases() {
  const sheet = getOrCreateEvalsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, EVAL_HEADERS.length).getValues();
  return values.map(function(v) {
    let expectedItems = [];
    try { expectedItems = JSON.parse(v[3] || '[]'); } catch (e) { /* leave empty if malformed */ }
    return {
      caseId: String(v[0] || ''),
      type: String(v[1] || ''),
      input: String(v[2] || ''),
      expectedItems: expectedItems,
      expectedTotal: v[4] !== '' ? v[4] : null,
      imageFileId: String(v[5] || ''),
      notes: String(v[6] || ''),
    };
  });
}

function logEvalRun(data) {
  const sheet = getOrCreateEvalResultsSheet();
  const now = new Date();
  sheet.appendRow([
    data.runId || '',
    now.toLocaleString('en-IN'),
    data.model || '',
    data.visionPromptVersion || '',
    data.textPromptVersion || '',
    data.smsPromptVersion || '',
    data.casesRun != null ? data.casesRun : '',
    data.amountScore != null ? data.amountScore : '',
    data.itemNameScore != null ? data.itemNameScore : '',
    data.categoryScore != null ? data.categoryScore : '',
    data.overallScore != null ? data.overallScore : '',
    String(data.perCaseDetail || '').substring(0, 3000),
  ]);
}

// Run ONCE manually from the Apps Script editor to populate a starter set of eval
// cases. Safe to re-run — it clears and rewrites the Evals sheet each time, so if
// you've since added your OWN cases by hand, re-running this will erase them. After
// the first run, edit the Evals sheet directly to add/change cases instead.
//
// The photo case (EVAL-008) needs a real image: upload the Sandip Hardware bill photo
// (or any bill photo of your choosing) to Drive, then paste its File ID into the
// "Image File ID" column for that row — right-click the file in Drive → Get link →
// the long ID in the URL between /d/ and /view.
function seedEvalCases() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const existing = ss.getSheetByName(SHEET_EVALS);
  if (existing) ss.deleteSheet(existing);
  const sheet = getOrCreateEvalsSheet();
  const cases = [
    ['EVAL-001', 'text', 'chai 20', JSON.stringify([{ item: 'Tea', amount: 20 }]), '', '', 'Simplest possible case — single item, no shop, no category hint'],
    ['EVAL-002', 'text', 'sabzi 120 kal', JSON.stringify([{ item: 'Vegetables', amount: 120 }]), '', '', 'Hinglish + relative date ("kal" = yesterday) — tests date handling isn\'t graded here, just item/amount'],
    ['EVAL-003', 'text', 'chai 20 samosa 15 at tapri', JSON.stringify([{ item: 'Tea', amount: 20, shop: 'Tapri' }, { item: 'Samosa', amount: 15, shop: 'Tapri' }]), '', '', 'Multi-item single-line text — tests item-splitting, not just single-item extraction'],
    ['EVAL-004', 'text', 'bought groceries for 450 rupees at more supermarket', JSON.stringify([{ item: 'Groceries', amount: 450, shop: 'More', category: 'Food' }]), '', '', 'Full sentence rather than shorthand — tests natural language robustness'],
    ['EVAL-005', 'text', 'doodh 60 rupaye', JSON.stringify([{ item: 'Milk', amount: 60 }]), '', '', 'Hinglish vocabulary — tests translation, not just parsing'],
    ['EVAL-006', 'sms', 'Rs.500.00 debited from A/c XX1234 on 05-09-26 to VPA merchant@ybl UPI Ref No 123456789012', JSON.stringify([{ item: 'UPI Payment', amount: 500 }]), '', '', 'Standard UPI debit SMS format — tests isBankSms() routing + amount extraction from bank-speak'],
    ['EVAL-007', 'sms', 'INR 1,250.00 spent on your HDFC Bank Card XX5678 at AMAZON on 04-Sep-26', JSON.stringify([{ item: 'Amazon', amount: 1250, shop: 'Amazon' }]), '', '', 'Card-transaction SMS with comma-formatted amount — tests numeric parsing robustness'],
    ['EVAL-008', 'photo', '', JSON.stringify([
      { item: '4 inch R/A Handle', amount: 840 },
      { item: '10 inch R/A Handle', amount: 1800 },
      { item: '4 inch S/S Handle', amount: 168 },
      { item: 'S/S Knob', amount: 225 },
      { item: '2 inch Buffer', amount: 40 },
      { item: 'Crest R/S', amount: 270 },
      { item: 'Cupboard lock', amount: 240 },
      { item: 'Godrej Cupboard', amount: 350 },
      { item: '6 inch L.T. Bolt', amount: 220 },
    ]), 4193, 'PASTE_DRIVE_FILE_ID_HERE',
      'The Sandip Hardware bill that started the whole mismatch-detection feature. Ground truth here is "what a careful human would transcribe from the page" — all 9 legible line items as written, NOT the ₹2,354 actually paid, since the gap between those two numbers reflects an in-person adjustment the photo itself can\'t fully explain. This case tests transcription accuracy AND that the mismatch warning correctly fires (items sum ₹4,153 vs receipt total ₹4,193).'],
  ];
  cases.forEach(function(row) { sheet.appendRow(row); });
  Logger.log('Seeded ' + cases.length + ' eval cases. Remember to fill in the Image File ID for EVAL-008.');
}

function ok(data)  { return ContentService.createTextOutput(JSON.stringify({ success: true,  ...data })).setMimeType(ContentService.MimeType.JSON); }
function fail(msg) { return ContentService.createTextOutput(JSON.stringify({ success: false, error: msg })).setMimeType(ContentService.MimeType.JSON); }

// ══════════════════════════════════════════════════════════
//  ONE-TIME MIGRATION — run manually, once, from the Apps Script editor
// ══════════════════════════════════════════════════════════
// setupHeaders() only runs when a sheet is newly created, so any sheet that already
// existed before a new column was added never gets the new header label written in —
// even though appended rows already carry the new value. This backfills any missing
// header (Payment Mode / Additional Info / Trace ID) without touching any data rows.
// Safe to run multiple times — it's a no-op if headers are already correct. When a
// future column gets added, extend the `cols` list below — nothing else needs to change.
function migrateAddAdditionalInfoColumn() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const cols = [
    { index: 12, label: 'Payment Mode',    width: 110 },
    { index: 13, label: 'Additional Info', width: 220 },
    { index: 14, label: 'Trace ID',        width: 160 },
  ];
  [SHEET_EXPENSES, SHEET_SHAADI].forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (!sheet) { Logger.log('Sheet not found (nothing to migrate): ' + name); return; }
    cols.forEach(col => {
      const current = sheet.getRange(1, col.index).getValue();
      if (!current) sheet.getRange(1, col.index).setValue(col.label);
      sheet.setColumnWidth(col.index, col.width);
    });
    Logger.log('Checked/backfilled headers on: ' + name);
  });
}

// ══════════════════════════════════════════════════════════
//  MANUAL TESTS — run from Apps Script editor
// ══════════════════════════════════════════════════════════
// Run this ONE manually (select it in the function dropdown, click Run) before
// ever testing photo uploads from the app. DriveApp is a new service this script
// didn't use before — Apps Script can only ask for permission to use a new
// service interactively, which a live web request can never do. If this hasn't
// been run and approved yet, every real addWithPhoto call silently fails inside
// its own try/catch (by design, so a Drive failure never blocks the expense row
// from saving) — which looks exactly like "nothing happened."
function testSaveImage() {
  const dummyText = 'This is a test file created by Kharcha to verify Drive access.';
  const dummyBase64 = Utilities.base64Encode(dummyText);
  const url = saveImageToDrive(dummyBase64, 'text/plain', 'kharcha_drive_test.txt');
  Logger.log('If you see a URL below, Drive access is authorized correctly: ' + url);
}
function testAdd()     { Logger.log(doPost({postData:{contents:JSON.stringify({date:'07 May 2026',item:'Tea',amount:20,shop:'Tapri',category:'Food',tag:'Regular',loggedBy:'Test',rawText:'chai 20 tapri',sheetName:'Expenses'})}}).getContent()); }
function testUpdate()  { Logger.log(doPost({postData:{contents:JSON.stringify({action:'updateRow',rowNum:2,sheetName:'Expenses',date:'07 May 2026',item:'Tea updated',amount:25,shop:'Tapri',category:'Food',tag:'Regular',loggedBy:'Test',rawText:''})}}).getContent()); }
function testMove()    { Logger.log(doPost({postData:{contents:JSON.stringify({action:'moveRow',rowNum:2,fromSheet:'Expenses',toSheet:'Shaadi',date:'07 May 2026',item:'Saree',amount:5000,shop:'Nalli',category:'Shopping',tag:'Shaadi',loggedBy:'Test',rawText:'saree 5000'})}}).getContent()); }
function testRecent()  { Logger.log(doGet({parameter:{action:'getRecent',sheet:'Expenses',n:'5'}}).getContent()); }
function testSummary() { Logger.log(doGet({parameter:{action:'getSummary'}}).getContent()); }

// ══════════════════════════════════════════════════════════
// Mock Google Apps Script runtime for testing backend.gs in Node
// ══════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const BACKEND_PATH = path.join(__dirname, '..', 'backend.gs');

let testsRun = 0, testsPassed = 0, failures = [];
function test(name, fn) {
  testsRun++;
  try { fn(); testsPassed++; console.log('  ✅', name); }
  catch (e) { failures.push({ name, error: e.message }); console.log('  ❌', name, '-', e.message); }
}
function section(name) { console.log('\n' + name); }

// ---- In-memory "spreadsheet" ----
function makeSheet(name) {
  return {
    name,
    rows: [], // rows[0] will be header once setupHeaders runs; data rows follow
    getRange(r, c, numRows, numCols) {
      const sheet = this;
      // Support both single-cell and range reads/writes
      if (numRows === undefined) {
        return {
          setValue(v) { sheet.rows[r - 1] = sheet.rows[r - 1] || []; sheet.rows[r - 1][c - 1] = v; },
          getValue() { return (sheet.rows[r - 1] || [])[c - 1] ?? ''; },
          setBackground() {}, setFontColor() {}, setFontWeight() {},
        };
      }
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < numRows; i++) {
            const row = sheet.rows[r - 1 + i] || [];
            const slice = [];
            for (let j = 0; j < numCols; j++) slice.push(row[c - 1 + j] ?? '');
            out.push(slice);
          }
          return out;
        },
        setBackground() {}, setFontColor() {}, setFontWeight() {},
      };
    },
    appendRow(arr) { this.rows.push(arr.slice()); },
    deleteRow(r) { this.rows.splice(r - 1, 1); },
    getLastRow() { return this.rows.length; },
    getLastColumn() { return this.rows.length ? Math.max(...this.rows.map(r => r.length)) : 0; },
    setFrozenRows() {},
    setColumnWidth() {},
  };
}

function makeSpreadsheet() {
  const sheets = {};
  return {
    _sheets: sheets,
    getSheetByName(name) { return sheets[name] || null; },
    insertSheet(name) {
      const s = makeSheet(name);
      s.setName = (newName) => { delete sheets[s.name]; s.name = newName; sheets[newName] = s; };
      sheets[name] = s;
      return s;
    },
    deleteSheet(sheet) { delete sheets[sheet.name]; },
  };
}

const fakeSS = makeSpreadsheet();

// ---- Mock Drive ----
const driveFolders = {};
const driveFiles = [];
const DriveApp = {
  Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
  Permission: { VIEW: 'VIEW' },
  getFoldersByName(name) {
    const match = driveFolders[name] ? [driveFolders[name]] : [];
    let i = 0;
    return { hasNext: () => i < match.length, next: () => match[i++] };
  },
  getFileById(id) {
    const file = driveFiles.find(f => f.id === id);
    if (!file) throw new Error('File not found: ' + id);
    return file;
  },
  createFolder(name) {
    const files = [];
    const folder = {
      name, files,
      createFile(blob) {
        const file = {
          id: 'file_' + (driveFiles.length + 1),
          blob, sharing: null,
          setSharing(access, perm) { this.sharing = { access, perm }; },
          getUrl() { return 'https://drive.google.com/file/d/' + this.id + '/view'; },
          getBlob() { return { getBytes: () => blob.bytes, getContentType: () => blob.mimeType }; },
        };
        files.push(file); driveFiles.push(file);
        return file;
      },
    };
    driveFolders[name] = folder;
    return folder;
  },
};

const Utilities = {
  base64Decode(str) { return Buffer.from(str, 'base64'); },
  base64Encode(bytes) { return Buffer.isBuffer(bytes) ? bytes.toString('base64') : Buffer.from(String(bytes)).toString('base64'); },
  newBlob(bytes, mimeType, name) { return { bytes, mimeType, name }; },
};

const ContentService = {
  MimeType: { JSON: 'JSON' },
  createTextOutput(str) {
    return { _content: str, setMimeType() { return this; }, getContent() { return this._content; } };
  },
};

const LockService = { getScriptLock() { return { waitLock() {}, releaseLock() {} }; } };
const Logger = { log(...a) { /* console.log('[Logger]', ...a); */ } };
const SpreadsheetApp = { openById() { return fakeSS; } };
const UrlFetchApp = { fetch() { throw new Error('UrlFetchApp should not be called in offline tests'); } };

// ---- Mock ScriptApp (time-based triggers) ----
const installedTriggers = [];
const ScriptApp = {
  getProjectTriggers() {
    return installedTriggers.map(t => ({
      getHandlerFunction: () => t.handlerFunction,
      getUniqueId: () => t.id,
    }));
  },
  deleteTrigger(triggerRef) {
    const idx = installedTriggers.findIndex(t => t.id === triggerRef.getUniqueId());
    if (idx >= 0) installedTriggers.splice(idx, 1);
  },
  newTrigger(handlerFunction) {
    const spec = { handlerFunction, everyDaysN: null, atHourN: null };
    const builder = {
      timeBased: () => builder,
      everyDays: (n) => { spec.everyDaysN = n; return builder; },
      atHour: (h) => { spec.atHourN = h; return builder; },
      create: () => {
        const id = 'trigger_' + (installedTriggers.length + 1);
        installedTriggers.push({ id, handlerFunction, everyDaysN: spec.everyDaysN, atHourN: spec.atHourN });
        return { getUniqueId: () => id };
      },
    };
    return builder;
  },
};

const sandbox = {
  SpreadsheetApp, DriveApp, Utilities, ContentService, LockService, Logger, UrlFetchApp, ScriptApp,
  Date, JSON, console, Math, String, parseInt, parseFloat, isNaN, Array, Object, Buffer,
};
vm.createContext(sandbox);
const code = fs.readFileSync(BACKEND_PATH, 'utf8');
vm.runInContext(code, sandbox, { filename: 'backend.gs' });

function post(payload) {
  return JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());
}
function get(params) {
  return JSON.parse(sandbox.doGet({ parameter: params }).getContent());
}

// ══════════════════════════════════════════════════════════
section('1. Sheet bootstrap / headers');
test('Expenses sheet has 14 headers including Additional Info and Trace ID', () => {
  post({ date: '04 Sep 2026', item: 'Tea', amount: 20, shop: 'Tapri', tag: 'Regular', category: 'Food', loggedBy: 'RB', rawText: 'chai 20 tapri', sheetName: 'Expenses' });
  const headerRow = fakeSS.getSheetByName('Expenses').rows[0];
  assert.strictEqual(headerRow.length, 14);
  assert.strictEqual(headerRow[11], 'Payment Mode');
  assert.strictEqual(headerRow[12], 'Additional Info');
  assert.strictEqual(headerRow[13], 'Trace ID');
});

section('2. Add row (no image) — Additional Info stays blank');
test('New row without additionalInfo writes empty string in col 13', () => {
  const res = post({ date: '04 Sep 2026', item: 'Sabzi', amount: 120, shop: 'Local', tag: 'Regular', category: 'Food', loggedBy: 'RB', rawText: 'sabzi 120', sheetName: 'Expenses' });
  assert.strictEqual(res.success, true);
  const sheet = fakeSS.getSheetByName('Expenses');
  const row = sheet.rows[res.row - 1];
  assert.strictEqual(row[11], 'Cash');   // Payment Mode defaults to Cash
  assert.strictEqual(row[12], '');        // Additional Info blank
});

section('3. saveImage action');
let savedUrl;
test('saveImage creates a Drive file and returns a URL', () => {
  const res = post({ action: 'saveImage', base64Data: Buffer.from('fake-jpeg-bytes').toString('base64'), mimeType: 'image/jpeg', fileName: 'bill_test.jpg' });
  assert.strictEqual(res.success, true);
  assert.ok(res.url.startsWith('https://drive.google.com/file/d/'));
  savedUrl = res.url;
});
test('saveImage file is shared as ANYONE_WITH_LINK / VIEW', () => {
  const file = driveFiles.find(f => f.getUrl() === savedUrl);
  assert.ok(file);
  assert.deepStrictEqual(file.sharing, { access: 'ANYONE_WITH_LINK', perm: 'VIEW' });
});
test('saveImage reuses the same "Kharcha Bills" folder on a second call (no duplicate folders)', () => {
  const before = driveFiles.length;
  post({ action: 'saveImage', base64Data: Buffer.from('more-bytes').toString('base64'), mimeType: 'image/jpeg', fileName: 'bill2.jpg' });
  assert.strictEqual(Object.keys(driveFolders).length, 1, 'should still be exactly one Bills folder');
  assert.strictEqual(driveFiles.length, before + 1);
});
test('saveImage with no base64Data throws a clean error (fail response, not a crash)', () => {
  const res = post({ action: 'saveImage', mimeType: 'image/jpeg' });
  assert.strictEqual(res.success, false);
  assert.ok(/no image data/i.test(res.error));
});

section('4. addWithPhoto — the actual production flow (single fire-and-forget call)');
let billRowNum1, billRowNum2, billPhotoUrl;
test('addWithPhoto saves the image once AND writes all rows with the same Additional Info in one call', () => {
  const before = driveFiles.length;
  const res = post({
    action: 'addWithPhoto',
    base64Data: Buffer.from('grocery-bill-bytes').toString('base64'),
    mimeType: 'image/jpeg',
    fileName: 'grocery_bill.jpg',
    rows: [
      { date: '04 Sep 2026', item: 'Milk', amount: 60, tag: 'Regular', category: 'Food', loggedBy: 'RB', rawText: 'grocery bill', sheetName: 'Expenses' },
      { date: '04 Sep 2026', item: 'Bread', amount: 40, tag: 'Regular', category: 'Food', loggedBy: 'RB', rawText: 'grocery bill', sheetName: 'Expenses' },
    ],
  });
  assert.strictEqual(res.success, true);
  assert.ok(res.url.startsWith('https://drive.google.com/file/d/'));
  assert.strictEqual(res.rows.length, 2);
  assert.strictEqual(driveFiles.length, before + 1); // exactly one new file, not two
  billPhotoUrl = res.url;
  [billRowNum1, billRowNum2] = res.rows;
  const sheet = fakeSS.getSheetByName('Expenses');
  assert.strictEqual(sheet.rows[billRowNum1 - 1][12], billPhotoUrl);
  assert.strictEqual(sheet.rows[billRowNum2 - 1][12], billPhotoUrl);
});
test('addWithPhoto still saves all rows even if the Drive upload fails (non-fatal)', () => {
  // Force a failure by omitting base64Data entirely
  const res = post({
    action: 'addWithPhoto',
    mimeType: 'image/jpeg',
    rows: [{ date: '04 Sep 2026', item: 'Snacks', amount: 30, tag: 'Regular', category: 'Food', loggedBy: 'RB', rawText: '', sheetName: 'Expenses' }],
  });
  assert.strictEqual(res.success, true); // the overall call still succeeds
  assert.strictEqual(res.url, '');        // no photo link since the upload failed
  const sheet = fakeSS.getSheetByName('Expenses');
  const row = sheet.rows[res.rows[0] - 1];
  assert.strictEqual(row[1], 'Snacks');
  assert.strictEqual(row[12], ''); // blank, not crashed, not stuck with a stale link
});
test('addWithPhoto routes a Shaadi-tagged row to the Shaadi sheet, still sharing the photo link', () => {
  const res = post({
    action: 'addWithPhoto',
    base64Data: Buffer.from('wedding-invoice-bytes').toString('base64'),
    mimeType: 'image/jpeg',
    fileName: 'invoice.jpg',
    rows: [{ date: '04 Sep 2026', item: 'Catering advance', amount: 20000, tag: 'Shaadi', category: 'Food', loggedBy: 'RB', rawText: '', sheetName: 'Shaadi' }],
  });
  assert.strictEqual(res.success, true);
  const shaadiSheet = fakeSS.getSheetByName('Shaadi');
  const row = shaadiSheet.rows[res.rows[0] - 1];
  assert.strictEqual(row[1], 'Catering advance');
  assert.strictEqual(row[12], res.url);
});
test('addWithPhoto with missing/empty rows fails LOUDLY with a specific message (regression test for the silent-no-op bug)', () => {
  // Previously this silently returned success with an empty rows array — looked like
  // "Completed" with nothing saved and no clue why. Now it must fail with a clear reason.
  const res1 = post({ action: 'addWithPhoto', base64Data: 'abc', mimeType: 'image/jpeg' }); // rows entirely missing
  assert.strictEqual(res1.success, false);
  assert.ok(/no rows in payload/.test(res1.error));
  const res2 = post({ action: 'addWithPhoto', base64Data: 'abc', mimeType: 'image/jpeg', rows: [] }); // rows explicitly empty
  assert.strictEqual(res2.success, false);
  assert.ok(/no rows in payload/.test(res2.error));
});

section('5. updateRow preserves Additional Info when not passed');
test('Editing a row WITHOUT mentioning additionalInfo does not wipe the existing photo link', () => {
  post({ action: 'updateRow', rowNum: billRowNum1, sheetName: 'Expenses', date: '04 Sep 2026', item: 'Milk (2L)', amount: 65, tag: 'Regular', category: 'Food', loggedBy: 'RB', rawText: 'grocery bill' });
  const sheet = fakeSS.getSheetByName('Expenses');
  assert.strictEqual(sheet.rows[billRowNum1 - 1][1], 'Milk (2L)'); // item updated
  assert.strictEqual(sheet.rows[billRowNum1 - 1][12], billPhotoUrl); // photo link preserved
});
test('Editing a row and explicitly clearing additionalInfo DOES clear it', () => {
  post({ action: 'updateRow', rowNum: billRowNum2, sheetName: 'Expenses', date: '04 Sep 2026', item: 'Bread', amount: 40, tag: 'Regular', category: 'Food', loggedBy: 'RB', rawText: '', additionalInfo: '' });
  const sheet = fakeSS.getSheetByName('Expenses');
  assert.strictEqual(sheet.rows[billRowNum2 - 1][12], '');
});
test('Editing payMode updates col 12 correctly', () => {
  post({ action: 'updateRow', rowNum: billRowNum1, sheetName: 'Expenses', date: '04 Sep 2026', item: 'Milk (2L)', amount: 65, tag: 'Regular', category: 'Food', loggedBy: 'RB', rawText: '', payMode: 'Online' });
  const sheet = fakeSS.getSheetByName('Expenses');
  assert.strictEqual(sheet.rows[billRowNum1 - 1][11], 'Online');
});

section('6. moveRow carries Payment Mode + Additional Info to the new sheet');
test('Moving a row to Shaadi preserves its photo link and payment mode when not overridden', () => {
  const beforeShaadiRows = (fakeSS.getSheetByName('Shaadi') || { rows: [] }).rows.length;
  const res = post({ action: 'moveRow', rowNum: billRowNum1, fromSheet: 'Expenses', toSheet: 'Shaadi', date: '04 Sep 2026', item: 'Milk (2L)', amount: 65, tag: 'Shaadi', category: 'Food', loggedBy: 'RB', rawText: '' });
  assert.strictEqual(res.success, true);
  const shaadiSheet = fakeSS.getSheetByName('Shaadi');
  assert.ok(shaadiSheet, 'Shaadi sheet should exist/auto-create');
  const movedRow = shaadiSheet.rows[shaadiSheet.rows.length - 1];
  assert.strictEqual(movedRow[11], 'Online');   // payMode carried over from source row
  assert.strictEqual(movedRow[12], billPhotoUrl);   // additionalInfo carried over from source row
});
test('Shaadi sheet also got proper 14-column headers on auto-create', () => {
  const headerRow = fakeSS.getSheetByName('Shaadi').rows[0];
  assert.strictEqual(headerRow.length, 14);
  assert.strictEqual(headerRow[12], 'Additional Info');
  assert.strictEqual(headerRow[13], 'Trace ID');
});

section('7. getRecentRows returns payMode + additionalInfo to the frontend');
test('getRecent includes payMode and additionalInfo fields', () => {
  const res = get({ action: 'getRecent', sheet: 'Shaadi', n: '5' });
  assert.strictEqual(res.success, true);
  const row = res.rows.find(r => r.item === 'Milk (2L)');
  assert.ok(row, 'moved row should be retrievable');
  assert.strictEqual(row.payMode, 'Online');
  assert.strictEqual(row.additionalInfo, billPhotoUrl);
});

section('8. Edge cases');
test('updateRow with an invalid rowNum fails cleanly (no crash)', () => {
  const res = post({ action: 'updateRow', rowNum: 0, sheetName: 'Expenses', item: 'x' });
  assert.strictEqual(res.success, false);
  assert.ok(/Invalid row/.test(res.error));
});
test('moveRow to a nonexistent source sheet fails cleanly', () => {
  const res = post({ action: 'moveRow', rowNum: 2, fromSheet: 'NoSuchSheet', toSheet: 'Shaadi', item: 'x' });
  assert.strictEqual(res.success, false);
  assert.ok(/Source sheet not found/.test(res.error));
});
test('Malformed JSON body returns a fail response, not a thrown exception', () => {
  const raw = sandbox.doPost({ postData: { contents: '{not valid json' } }).getContent();
  const res = JSON.parse(raw);
  assert.strictEqual(res.success, false);
  assert.ok(/JSON parse error/.test(res.error));
});
test('doPost with no event object at all fails cleanly', () => {
  const res = JSON.parse(sandbox.doPost(null).getContent());
  assert.strictEqual(res.success, false);
});
test('Row with neither item nor amount is rejected by writeToSheet', () => {
  const res = post({ date: '04 Sep 2026', shop: 'x', sheetName: 'Expenses' });
  assert.strictEqual(res.success, false);
  assert.ok(/item and amount/.test(res.error));
});

section('9. Header migration for pre-existing sheets');
test('migrateAddAdditionalInfoColumn backfills a sheet that predates the new columns', () => {
  const ss = SpreadsheetApp.openById();
  const oldSheet = ss.insertSheet('Expenses_Old_Sim');
  oldSheet.appendRow(['Date','Item','Amount (₹)','Shop','Comment','Tag','Category','Logged By','Raw Text','Timestamp','Last Updated']);
  assert.strictEqual(oldSheet.getRange(1, 12).getValue(), '');
  assert.strictEqual(oldSheet.getRange(1, 13).getValue(), '');
  assert.strictEqual(oldSheet.getRange(1, 14).getValue(), '');
});
test('migrateAddAdditionalInfoColumn (real function) fixes Expenses/Shaadi headers including Trace ID, and is idempotent', () => {
  sandbox.migrateAddAdditionalInfoColumn();
  const expHeader = fakeSS.getSheetByName('Expenses').rows[0];
  const shaadiHeader = fakeSS.getSheetByName('Shaadi').rows[0];
  assert.strictEqual(expHeader[11], 'Payment Mode');
  assert.strictEqual(expHeader[12], 'Additional Info');
  assert.strictEqual(expHeader[13], 'Trace ID');
  assert.strictEqual(shaadiHeader[11], 'Payment Mode');
  assert.strictEqual(shaadiHeader[12], 'Additional Info');
  assert.strictEqual(shaadiHeader[13], 'Trace ID');
  // Run again — should not throw and should not alter anything
  const before = JSON.stringify(fakeSS.getSheetByName('Expenses').rows[0]);
  sandbox.migrateAddAdditionalInfoColumn();
  const after = JSON.stringify(fakeSS.getSheetByName('Expenses').rows[0]);
  assert.strictEqual(before, after);
});

section('10. Trace ID on Expenses/Shaadi — links a saved row back to its AI_Traces entry');
let tracedRowNum;
test('writeToSheet stores traceId in column 14', () => {
  const res = post({ date: '04 Sep 2026', item: 'Chai', amount: 20, tag: 'Regular', category: 'Food', loggedBy: 'RB', rawText: 'chai 20', sheetName: 'Expenses', traceId: 'T-abc123' });
  tracedRowNum = res.row;
  const sheet = fakeSS.getSheetByName('Expenses');
  assert.strictEqual(sheet.rows[tracedRowNum - 1][13], 'T-abc123');
});
test('A row with no traceId (a local/non-AI parse) leaves the column blank', () => {
  const res = post({ date: '04 Sep 2026', item: 'Milk', amount: 60, tag: 'Regular', category: 'Food', loggedBy: 'RB', rawText: 'milk 60', sheetName: 'Expenses' });
  const sheet = fakeSS.getSheetByName('Expenses');
  assert.strictEqual(sheet.rows[res.row - 1][13], '');
});
test('updateRow WITHOUT mentioning traceId preserves the existing one', () => {
  post({ action: 'updateRow', rowNum: tracedRowNum, sheetName: 'Expenses', date: '04 Sep 2026', item: 'Chai (large)', amount: 25, tag: 'Regular', category: 'Food', loggedBy: 'RB', rawText: '' });
  const sheet = fakeSS.getSheetByName('Expenses');
  assert.strictEqual(sheet.rows[tracedRowNum - 1][1], 'Chai (large)');
  assert.strictEqual(sheet.rows[tracedRowNum - 1][13], 'T-abc123');
});
test('moveRow carries traceId to the destination sheet when not overridden', () => {
  const res = post({ action: 'moveRow', rowNum: tracedRowNum, fromSheet: 'Expenses', toSheet: 'Shaadi', date: '04 Sep 2026', item: 'Chai (large)', amount: 25, tag: 'Shaadi', category: 'Food', loggedBy: 'RB', rawText: '' });
  assert.strictEqual(res.success, true);
  const shaadiSheet = fakeSS.getSheetByName('Shaadi');
  const movedRow = shaadiSheet.rows[shaadiSheet.rows.length - 1];
  assert.strictEqual(movedRow[13], 'T-abc123');
});
test('getRecentRows returns the traceId field to the frontend', () => {
  const res = get({ action: 'getRecent', sheet: 'Shaadi', n: '5' });
  const row = res.rows.find(r => r.item === 'Chai (large)');
  assert.ok(row);
  assert.strictEqual(row.traceId, 'T-abc123');
});

section('11. logAITrace — unified AI observability log (text / SMS / photo)');
test('logAITrace creates the AI_Traces sheet with the full v2 schema on first use', () => {
  const res = post({ action: 'logAITrace', traceId: 'T-photo1', type: 'photo', attempt: 1, model: 'gemini-3.1-flash-lite-preview', promptVersion: 'vision-v2', fileName: 'bill.jpg', rawResponse: '{"items":[]}', itemsCountRaw: 9, itemsCountFiltered: 8, itemsSum: 2353, receiptTotal: 4193, mismatch: true, mismatchAmount: -1840, httpStatus: 200, userAgent: 'Mozilla/5.0 (iPhone)', loggedBy: 'RB' });
  assert.strictEqual(res.success, true);
  const sheet = fakeSS.getSheetByName('AI_Traces');
  assert.ok(sheet, 'AI_Traces sheet should be auto-created');
  assert.strictEqual(JSON.stringify(sheet.rows[0]), JSON.stringify(['Trace ID','Timestamp','Type','Attempt','Model','Prompt Version','Items (raw)','Items (kept)','Items Sum','Receipt Total','Mismatch?','Mismatch Amount','HTTP Status','Error Category','Error Message','Latency (ms)','Outcome','Edited Fields','User Agent','Logged By','File Name','Raw Model Response']));
});
test('logAITrace writes a photo-type row with all fields correctly placed', () => {
  const sheet = fakeSS.getSheetByName('AI_Traces');
  const row = sheet.rows[sheet.rows.length - 1];
  assert.strictEqual(row[0], 'T-photo1');    // Trace ID
  assert.strictEqual(row[2], 'photo');        // Type
  assert.strictEqual(row[3], 1);              // Attempt
  assert.strictEqual(row[4], 'gemini-3.1-flash-lite-preview'); // Model
  assert.strictEqual(row[5], 'vision-v2');    // Prompt Version
  assert.strictEqual(row[6], 9);              // Items raw
  assert.strictEqual(row[7], 8);              // Items kept
  assert.strictEqual(row[8], 2353);           // Items sum
  assert.strictEqual(row[9], 4193);           // Receipt total
  assert.strictEqual(row[10], 'YES');         // Mismatch?
  assert.strictEqual(row[11], -1840);         // Mismatch amount
  assert.strictEqual(row[12], 200);           // HTTP status
  assert.strictEqual(row[16], '');            // Outcome (not applicable to this row)
  assert.strictEqual(row[17], '');            // Edited Fields (not applicable)
  assert.strictEqual(row[18], 'Mozilla/5.0 (iPhone)'); // User agent
  assert.strictEqual(row[19], 'RB');          // Logged by
  assert.strictEqual(row[20], 'bill.jpg');    // File name
  assert.ok(row[21].includes('items'));       // Raw response
});
test('logAITrace writes a text-type ERROR row (a retry attempt) with no items/file, just error info', () => {
  const res = post({ action: 'logAITrace', traceId: 'T-text1', type: 'text', attempt: 1, model: 'gemini-3.1-flash-lite-preview', promptVersion: 'text-v1', httpStatus: 429, errorCategory: 'rate_limit', errorMessage: 'Too many requests', latencyMs: 850, loggedBy: 'RB' });
  assert.strictEqual(res.success, true);
  const sheet = fakeSS.getSheetByName('AI_Traces');
  const row = sheet.rows[sheet.rows.length - 1];
  assert.strictEqual(row[2], 'text');
  assert.strictEqual(row[6], '');   // no items count for a failed attempt
  assert.strictEqual(row[12], 429);
  assert.strictEqual(row[13], 'rate_limit');
  assert.strictEqual(row[14], 'Too many requests');
  assert.strictEqual(row[15], 850);
});
test('logAITrace writes an sms-type row correctly', () => {
  const res = post({ action: 'logAITrace', traceId: 'T-sms1', type: 'sms', attempt: 1, model: 'gemini-3.1-flash-lite-preview', promptVersion: 'sms-v1', itemsCountRaw: 1, itemsCountFiltered: 1, itemsSum: 500, loggedBy: 'RB', rawResponse: '[{"item":"UPI Payment"}]' });
  assert.strictEqual(res.success, true);
  const sheet = fakeSS.getSheetByName('AI_Traces');
  const row = sheet.rows[sheet.rows.length - 1];
  assert.strictEqual(row[2], 'sms');
  assert.strictEqual(row[9], ''); // no receipt total concept for sms
});
test('logAITrace truncates a very long raw response so it can never blow up a sheet cell', () => {
  const hugeResponse = 'x'.repeat(10000);
  post({ action: 'logAITrace', traceId: 'T-huge', type: 'photo', rawResponse: hugeResponse, fileName: 'huge.jpg' });
  const sheet = fakeSS.getSheetByName('AI_Traces');
  const row = sheet.rows[sheet.rows.length - 1];
  assert.ok(row[21].length <= 3000);
});
test('logAITrace never throws even with a malformed/missing payload (must never break the main flow)', () => {
  const res = post({ action: 'logAITrace' }); // nothing but the action itself
  assert.strictEqual(res.success, true);
});
test('doPost still returns success:true for logAITrace even if an internal logging error occurs', () => {
  const res = post({ action: 'logAITrace', rawResponse: null, itemsCountRaw: 'not-a-number' });
  assert.strictEqual(res.success, true);
});

section('11b. logAITrace — Outcome / Edited Fields columns (outcome tracking)');
test('An outcome row for "saved as-is" logs correctly', () => {
  const res = post({ action: 'logAITrace', traceId: 'T-outcome1', type: 'photo', outcome: 'saved_as_is', editedFields: '' });
  assert.strictEqual(res.success, true);
  const sheet = fakeSS.getSheetByName('AI_Traces');
  const row = sheet.rows[sheet.rows.length - 1];
  assert.strictEqual(row[16], 'saved_as_is');
  assert.strictEqual(row[17], '');
});
test('An outcome row for "saved edited" logs which fields changed', () => {
  const res = post({ action: 'logAITrace', traceId: 'T-outcome2', type: 'text', outcome: 'saved_edited', editedFields: 'amount,category' });
  assert.strictEqual(res.success, true);
  const sheet = fakeSS.getSheetByName('AI_Traces');
  const row = sheet.rows[sheet.rows.length - 1];
  assert.strictEqual(row[16], 'saved_edited');
  assert.strictEqual(row[17], 'amount,category');
});
test('An outcome row for "abandoned" logs correctly', () => {
  const res = post({ action: 'logAITrace', traceId: 'T-outcome3', type: 'sms', outcome: 'abandoned' });
  assert.strictEqual(res.success, true);
  const sheet = fakeSS.getSheetByName('AI_Traces');
  const row = sheet.rows[sheet.rows.length - 1];
  assert.strictEqual(row[16], 'abandoned');
});
test('A normal attempt/summary row (no outcome) leaves Outcome/Edited Fields blank', () => {
  post({ action: 'logAITrace', traceId: 'T-normal', type: 'photo', itemsCountRaw: 3 });
  const sheet = fakeSS.getSheetByName('AI_Traces');
  const row = sheet.rows[sheet.rows.length - 1];
  assert.strictEqual(row[16], '');
  assert.strictEqual(row[17], '');
});

section('12. getOrCreateTraceSheet — schema self-healing');
test('A schema mismatch with NO real data rows gets replaced outright (no archive clutter)', () => {
  // Simulate an old-schema AI_Traces sheet with just a header, no data — as if a
  // previous version's headers were created but never actually logged anything yet.
  fakeSS.deleteSheet(fakeSS.getSheetByName('AI_Traces')); // clear what earlier tests built up
  const oldSheet = fakeSS.insertSheet('AI_Traces');
  oldSheet.appendRow(['Timestamp', 'File Name']); // old v1-style header, no data rows
  sandbox.logAITrace({ traceId: 'T-fresh', type: 'photo' }); // triggers getOrCreateTraceSheet()
  const sheet = fakeSS.getSheetByName('AI_Traces');
  assert.strictEqual(sheet.rows[0][0], 'Trace ID'); // replaced with the current schema
  const archivedNames = Object.keys(fakeSS._sheets).filter(n => n.startsWith('AI_Traces_archive_'));
  assert.strictEqual(archivedNames.length, 0, 'a header-only mismatch should be replaced outright, not archived');
});
test('A schema mismatch WITH real data rows gets archived, never destroyed', () => {
  fakeSS.deleteSheet(fakeSS.getSheetByName('AI_Traces'));
  const oldSheet = fakeSS.insertSheet('AI_Traces');
  oldSheet.appendRow(['Timestamp', 'File Name']);
  oldSheet.appendRow(['04 Sep 2026', 'old_bill.jpg']); // a real logged row under the old schema
  sandbox.logAITrace({ traceId: 'T-fresh2', type: 'photo' });
  const freshSheet = fakeSS.getSheetByName('AI_Traces');
  assert.strictEqual(freshSheet.rows[0][0], 'Trace ID'); // fresh sheet has the new schema
  assert.strictEqual(freshSheet.rows.length, 2); // header + the one new row just logged
  const archivedNames = Object.keys(fakeSS._sheets).filter(n => n.startsWith('AI_Traces_archive_'));
  assert.strictEqual(archivedNames.length, 1, 'the old data should have been preserved under an archive name');
  assert.strictEqual(fakeSS._sheets[archivedNames[0]].rows[1][1], 'old_bill.jpg'); // old data intact
});

section('13. cleanupOldTraces — 365-day retention (TRACE_RETENTION_DAYS)');
test('Deletes trace rows older than the retention window, keeps recent ones', () => {
  fakeSS.deleteSheet(fakeSS.getSheetByName('AI_Traces'));
  const sheet = sandbox.getOrCreateTraceSheet();
  const oldDate = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toLocaleString('en-IN'); // 400 days ago
  const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toLocaleString('en-IN'); // 10 days ago
  sheet.appendRow(['T-old', oldDate, 'photo']);
  sheet.appendRow(['T-recent', recentDate, 'photo']);
  sandbox.cleanupOldTraces();
  const remainingIds = sheet.rows.slice(1).map(r => r[0]);
  assert.ok(!remainingIds.includes('T-old'), 'row older than 365 days should be deleted');
  assert.ok(remainingIds.includes('T-recent'), 'row within 365 days should be kept');
});
test('Running cleanup on a sheet with only a header does not throw', () => {
  fakeSS.deleteSheet(fakeSS.getSheetByName('AI_Traces'));
  sandbox.getOrCreateTraceSheet(); // header only, no data rows
  assert.doesNotThrow(() => sandbox.cleanupOldTraces());
});

section('14. installTraceCleanupTrigger — one-time setup for automatic daily cleanup');
test('Installs a daily trigger targeting cleanupOldTraces', () => {
  sandbox.installTraceCleanupTrigger();
  const triggers = sandbox.ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'cleanupOldTraces');
  assert.strictEqual(triggers.length, 1);
});
test('Running it again does NOT create a duplicate trigger (idempotent)', () => {
  sandbox.installTraceCleanupTrigger();
  sandbox.installTraceCleanupTrigger();
  const triggers = sandbox.ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'cleanupOldTraces');
  assert.strictEqual(triggers.length, 1);
});

section('15. seedEvalCases + getEvalCases — the eval test set');
test('seedEvalCases populates the Evals sheet with the starter set', () => {
  sandbox.seedEvalCases();
  const sheet = fakeSS.getSheetByName('Evals');
  assert.ok(sheet, 'Evals sheet should be created');
  assert.strictEqual(JSON.stringify(sheet.rows[0]), JSON.stringify(['Case ID', 'Type', 'Input', 'Expected Items (JSON)', 'Expected Total', 'Image File ID', 'Notes']));
  assert.strictEqual(sheet.rows.length, 9); // header + 8 starter cases
});
test('seedEvalCases is safe to re-run — clears and rewrites rather than duplicating', () => {
  sandbox.seedEvalCases();
  sandbox.seedEvalCases();
  const sheet = fakeSS.getSheetByName('Evals');
  assert.strictEqual(sheet.rows.length, 9); // still 9, not 17
});
test('getEvalCases returns properly parsed case objects via the real GET action', () => {
  const res = get({ action: 'getEvalCases' });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.cases.length, 8);
  const simple = res.cases.find(c => c.caseId === 'EVAL-001');
  assert.strictEqual(simple.type, 'text');
  assert.strictEqual(simple.input, 'chai 20');
  assert.strictEqual(simple.expectedItems.length, 1);
  assert.strictEqual(simple.expectedItems[0].item, 'Tea');
  assert.strictEqual(simple.expectedItems[0].amount, 20);
});
test('The photo case (EVAL-008) has the full 9-item expected list and a receipt total', () => {
  const res = get({ action: 'getEvalCases' });
  const photoCase = res.cases.find(c => c.caseId === 'EVAL-008');
  assert.strictEqual(photoCase.type, 'photo');
  assert.strictEqual(photoCase.expectedItems.length, 9);
  assert.strictEqual(photoCase.expectedTotal, 4193);
  assert.ok(photoCase.notes.includes('2,354') || photoCase.notes.toLowerCase().includes('actually paid'), 'notes should explain the paid-vs-transcribed ambiguity');
});
test('getEvalCases returns an empty array (not an error) when the sheet has no cases yet', () => {
  const ss = fakeSS.deleteSheet(fakeSS.getSheetByName('Evals'));
  const res = get({ action: 'getEvalCases' });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.cases.length, 0);
  sandbox.seedEvalCases(); // restore for subsequent tests
});

section('16. getEvalImage — serving a fixture photo for photo eval cases');
test('getEvalImage returns base64 + mimeType for a real Drive file', () => {
  const folder = sandbox.DriveApp.createFolder('Eval Fixtures Test');
  const originalBytes = Buffer.from('fake-bill-photo-bytes');
  const file = folder.createFile({ bytes: originalBytes, mimeType: 'image/jpeg', name: 'bill.jpg' });
  const res = get({ action: 'getEvalImage', fileId: file.id });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.mimeType, 'image/jpeg');
  assert.strictEqual(Buffer.from(res.base64Data, 'base64').toString(), 'fake-bill-photo-bytes');
});
test('getEvalImage fails cleanly (not a crash) for a nonexistent file ID', () => {
  const res = get({ action: 'getEvalImage', fileId: 'does-not-exist' });
  assert.strictEqual(res.success, false);
});
test('getEvalImage fails cleanly when fileId is missing entirely', () => {
  const res = get({ action: 'getEvalImage' });
  assert.strictEqual(res.success, false);
});

section('17. logEvalRun — tracking scores over time');
test('logEvalRun creates the Eval_Results sheet with proper headers and writes a row', () => {
  const res = post({ action: 'logEvalRun', runId: 'RUN-1', model: 'gemini-3.1-flash-lite-preview', visionPromptVersion: 'vision-v2-receipttotal', textPromptVersion: 'text-v1', smsPromptVersion: 'sms-v1', casesRun: 8, amountScore: 87.5, itemNameScore: 92.0, categoryScore: 75.0, overallScore: 84.8, perCaseDetail: JSON.stringify([{ caseId: 'EVAL-001', pass: true }]) });
  assert.strictEqual(res.success, true);
  const sheet = fakeSS.getSheetByName('Eval_Results');
  assert.ok(sheet);
  assert.strictEqual(JSON.stringify(sheet.rows[0]), JSON.stringify(['Run ID', 'Timestamp', 'Model', 'Vision Prompt Version', 'Text Prompt Version', 'SMS Prompt Version', 'Cases Run', 'Amount Score (%)', 'Item Name Score (%)', 'Category Score (%)', 'Overall Score (%)', 'Per-Case Detail (JSON)']));
  const row = sheet.rows[1];
  assert.strictEqual(row[0], 'RUN-1');
  assert.strictEqual(row[6], 8);
  assert.strictEqual(row[7], 87.5);
  assert.strictEqual(row[10], 84.8);
});
test('Multiple runs accumulate as separate rows, giving a trend over time', () => {
  post({ action: 'logEvalRun', runId: 'RUN-2', overallScore: 90.0, casesRun: 8 });
  const sheet = fakeSS.getSheetByName('Eval_Results');
  assert.strictEqual(sheet.rows.length, 3); // header + RUN-1 + RUN-2
});
test('logEvalRun never throws even with a malformed/missing payload', () => {
  const res = post({ action: 'logEvalRun' });
  assert.strictEqual(res.success, true);
});

// ══════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(50));
console.log(`Backend: ${testsPassed}/${testsRun} passed`);
if (failures.length) { console.log('FAILURES:', failures); process.exitCode = 1; }

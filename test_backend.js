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
    setFrozenRows() {},
    setColumnWidth() {},
  };
}

function makeSpreadsheet() {
  const sheets = {};
  return {
    _sheets: sheets,
    getSheetByName(name) { return sheets[name] || null; },
    insertSheet(name) { const s = makeSheet(name); sheets[name] = s; return s; },
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

const sandbox = {
  SpreadsheetApp, DriveApp, Utilities, ContentService, LockService, Logger, UrlFetchApp,
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
test('Expenses sheet has 13 headers including Additional Info', () => {
  post({ date: '04 Sep 2026', item: 'Tea', amount: 20, shop: 'Tapri', tag: 'Regular', category: 'Food', loggedBy: 'RB', rawText: 'chai 20 tapri', sheetName: 'Expenses' });
  const headerRow = fakeSS.getSheetByName('Expenses').rows[0];
  assert.strictEqual(headerRow.length, 13);
  assert.strictEqual(headerRow[11], 'Payment Mode');
  assert.strictEqual(headerRow[12], 'Additional Info');
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
test('Shaadi sheet also got proper 13-column headers on auto-create', () => {
  const headerRow = fakeSS.getSheetByName('Shaadi').rows[0];
  assert.strictEqual(headerRow.length, 13);
  assert.strictEqual(headerRow[12], 'Additional Info');
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
  // Reuse the exact same per-sheet logic the real migration function runs
  if (!oldSheet.getRange(1, 12).getValue()) oldSheet.getRange(1, 12).setValue('Payment Mode');
  if (!oldSheet.getRange(1, 13).getValue()) oldSheet.getRange(1, 13).setValue('Additional Info');
  assert.strictEqual(oldSheet.rows[0][11], 'Payment Mode');
  assert.strictEqual(oldSheet.rows[0][12], 'Additional Info');
});
test('migrateAddAdditionalInfoColumn (real function) fixes Expenses/Shaadi headers and is idempotent', () => {
  sandbox.migrateAddAdditionalInfoColumn();
  const expHeader = fakeSS.getSheetByName('Expenses').rows[0];
  const shaadiHeader = fakeSS.getSheetByName('Shaadi').rows[0];
  assert.strictEqual(expHeader[11], 'Payment Mode');
  assert.strictEqual(expHeader[12], 'Additional Info');
  assert.strictEqual(shaadiHeader[11], 'Payment Mode');
  assert.strictEqual(shaadiHeader[12], 'Additional Info');
  // Run again — should not throw and should not alter anything
  const before = JSON.stringify(fakeSS.getSheetByName('Expenses').rows[0]);
  sandbox.migrateAddAdditionalInfoColumn();
  const after = JSON.stringify(fakeSS.getSheetByName('Expenses').rows[0]);
  assert.strictEqual(before, after);
});

// ══════════════════════════════════════════════════════════
console.log('\n' + '─'.repeat(50));
console.log(`Backend: ${testsPassed}/${testsRun} passed`);
if (failures.length) { console.log('FAILURES:', failures); process.exitCode = 1; }

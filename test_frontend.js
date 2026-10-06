// ══════════════════════════════════════════════════════════
// Minimal fake DOM + fetch harness to exercise confirmAndSave()
// and pure helper functions directly from index.html's real JS.
// ══════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// The app fires several fetch() calls without awaiting or .catch()-ing them
// (fire-and-forget writes) — that's fine in a browser (an unhandled rejection
// just logs a console warning, it doesn't crash the tab), but Node terminates
// the process on an unhandled rejection by default. Match browser behavior here.
process.on('unhandledRejection', () => {});

const INDEX_HTML_PATH = path.join(__dirname, '..', 'index.html');

// Pulls the single inline <script>...</script> block out of index.html so
// it can be evaluated directly — no build step, matching this repo's
// "no build, no dependencies" philosophy.
function extractInlineScript(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!matches.length) throw new Error('No inline <script> block found in ' + htmlPath);
  return matches.map(m => m[1]).join('\n\n');
}

let testsRun = 0, testsPassed = 0, failures = [];
async function test(name, fn) {
  testsRun++;
  try { await fn(); testsPassed++; console.log('  ✅', name); }
  catch (e) { failures.push({ name, error: e.stack }); console.log('  ❌', name, '-', e.message); }
}
function section(name) { console.log('\n' + name); }

// ---- fake localStorage ----
function makeLocalStorage() {
  const store = {};
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    _store: store,
  };
}

// ---- fake element ----
function makeEl(id) {
  const listeners = {};
  return {
    id, value: '', textContent: '', innerHTML: '', dataset: {}, style: {}, disabled: false,
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
    },
    addEventListener(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    click() { (listeners['click'] || []).forEach(fn => fn()); },
    appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  };
}

function makeDocument(elements) {
  return {
    _elements: elements,
    getElementById(id) {
      if (!elements[id]) elements[id] = makeEl(id); // auto-stub anything not pre-defined
      return elements[id];
    },
    querySelectorAll() { return { forEach() {} }; },
    querySelector() { return null; },
    addEventListener() {}, createElement() { return makeEl('_created'); },
  };
}

function buildSandbox({ elements = {}, fetchImpl }) {
  const localStorage = makeLocalStorage();
  const document = makeDocument(elements);
  const fetchCalls = [];
  const fetch = (url, opts) => {
    fetchCalls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return fetchImpl(url, opts);
  };
  const sandbox = {
    localStorage, document, fetch, console,
    setTimeout: (fn) => { fn(); return 0; }, // run "later" work immediately for deterministic tests
    clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    Date, JSON, Math, String, parseInt, parseFloat, isNaN, Array, Object, Function, RegExp, URLSearchParams,
    navigator: { onLine: true, serviceWorker: undefined },
    alert: () => {},
    history: { pushState: () => {}, replaceState: () => {}, back: () => {} },
    location: { href: 'https://kharcha.example/', reload: () => {} },
  };
  sandbox.window = {
    addEventListener: () => {}, removeEventListener: () => {},
    innerWidth: 400, innerHeight: 800,
    location: sandbox.location, history: sandbox.history,
    matchMedia: () => ({ matches: false, addListener: () => {} }),
  };
  vm.createContext(sandbox);
  const code = extractInlineScript(INDEX_HTML_PATH);
  vm.runInContext(code, sandbox, { filename: 'index.html-inline.js' });
  // NOTE: parsedItems/multiMode/pendingImage* are declared with `let` at module scope.
  // Assigning sandbox.x = ... from outside does NOT reach those bindings (a vm quirk:
  // `let`/`const` don't become properties of the context object, only `var`/function
  // declarations do). So state injection must run as code INSIDE the same context.
  sandbox.__setState = (assignments) => {
    const stmts = Object.entries(assignments).map(([k, v]) => `${k} = ${JSON.stringify(v)};`).join('\n');
    vm.runInContext(stmts, sandbox, { filename: 'test-state-injection.js' });
  };
  return { sandbox, fetchCalls, elements };
}

function setInput(elements, id, value) { elements[id] = makeEl(id); elements[id].value = value; return elements[id]; }

(async () => {
// ══════════════════════════════════════════════════════════
section('1. Pure helper functions (calcAmount / fmtAmt / dates)');
{
  const { sandbox } = buildSandbox({ elements: {}, fetchImpl: async () => ({ json: async () => ({}) }) });
  await test('calcAmount evaluates simple arithmetic like "200-20"', () => {
    assert.strictEqual(sandbox.calcAmount('200-20'), '180');
  });
  await test('calcAmount evaluates division like "500/2"', () => {
    assert.strictEqual(sandbox.calcAmount('500/2'), '250');
  });
  await test('calcAmount passes through a plain number unchanged', () => {
    assert.strictEqual(sandbox.calcAmount('45'), '45');
  });
  await test('calcAmount rejects negative results', () => {
    assert.strictEqual(sandbox.calcAmount('10-20'), '');
  });
  await test('calcAmount rejects non-numeric junk', () => {
    assert.strictEqual(sandbox.calcAmount('abc'), '');
  });
  await test('fmtAmt formats with Indian digit grouping', () => {
    assert.strictEqual(sandbox.fmtAmt(150000), '1,50,000');
  });
  await test('fmtAmt handles empty/null gracefully', () => {
    assert.strictEqual(sandbox.fmtAmt(''), '');
    assert.strictEqual(sandbox.fmtAmt(null), '');
  });
  await test('fromDateInput converts yyyy-mm-dd to "DD Mon YYYY"', () => {
    assert.strictEqual(sandbox.fromDateInput('2026-09-04'), '04 Sep 2026');
  });
  await test('validateDate rejects future dates', () => {
    assert.ok(sandbox.validateDate('2099-01-01'));
  });
  await test('validateDate accepts today', () => {
    assert.strictEqual(sandbox.validateDate('2026-09-04'), null);
  });
}

// ══════════════════════════════════════════════════════════
section('2. confirmAndSave() — text-only entry (no image)');
{
  const elements = {};
  setInput(elements, 'expenseInput', 'chai 20 tapri');
  elements['expenseInput'].dataset.imageParsed = ''; // not image-sourced
  setInput(elements, 'rv-date-0', '2026-09-04');
  setInput(elements, 'rv-cat-0', 'Food');
  setInput(elements, 'rv-tag-0', 'Regular');
  setInput(elements, 'rv-item-0', 'Tea');
  setInput(elements, 'rv-shop-0', 'Tapri');
  setInput(elements, 'rv-comment-0', '');
  setInput(elements, 'rv-amount-0', '20');
  setInput(elements, 'rv-pay-0', 'Cash');

  const { sandbox, fetchCalls } = buildSandbox({
    elements,
    fetchImpl: async () => ({ json: async () => ({ success: true }) }),
  });
  sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', userName: 'RB' }));
  sandbox.__setState({
    parsedItems: ([{ category: 'Food' }]),
    multiMode: ('separate'),
  });

  await test('No saveImage call is made when the entry did not come from an image', async () => {
    await sandbox.confirmAndSave();
    const saveImageCalls = fetchCalls.filter(c => c.body && c.body.action === 'saveImage');
    assert.strictEqual(saveImageCalls.length, 0);
  });
  await test('The row payload sent to the backend has no additionalInfo field for a text-only entry', () => {
    const rowCall = fetchCalls.find(c => c.body && c.body.item === 'Tea');
    assert.ok(rowCall, 'expected a row-save fetch call for Tea');
    assert.strictEqual(rowCall.body.additionalInfo, undefined);
    assert.strictEqual(rowCall.body.amount, '20');
    assert.strictEqual(rowCall.body.sheetName, 'Expenses');
  });
  await test('An entry with no pending Trace ID saves with an empty traceId, not undefined', () => {
    const rowCall = fetchCalls.find(c => c.body && c.body.item === 'Tea');
    assert.strictEqual(rowCall.body.traceId, '');
  });
}

// ══════════════════════════════════════════════════════════
section('2b. confirmAndSave() — stamps a real Trace ID for a Gemini-sourced text entry');
{
  const elements = {};
  setInput(elements, 'expenseInput', 'bought some hardware stuff, complicated bill');
  elements['expenseInput'].dataset.imageParsed = ''; // text path, not photo — but WAS Gemini-parsed
  setInput(elements, 'rv-date-0', '2026-09-04');
  setInput(elements, 'rv-cat-0', 'Shopping');
  setInput(elements, 'rv-tag-0', 'Regular');
  setInput(elements, 'rv-item-0', 'Hardware items');
  setInput(elements, 'rv-shop-0', 'Sandip Hardware');
  setInput(elements, 'rv-comment-0', '');
  setInput(elements, 'rv-amount-0', '500');
  setInput(elements, 'rv-pay-0', 'Cash');

  const { sandbox, fetchCalls } = buildSandbox({
    elements,
    fetchImpl: async () => ({ json: async () => ({ success: true }) }),
  });
  sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', userName: 'RB' }));
  sandbox.__setState({
    parsedItems: ([{ category: 'Shopping' }]),
    multiMode: ('separate'),
    pendingTraceId: ('T-real-trace-abc12'), // as if parseWithGemini had just set this
  });

  await test('The saved row carries the real Trace ID set by a prior Gemini text parse', async () => {
    await sandbox.confirmAndSave();
    const rowCall = fetchCalls.find(c => c.body && c.body.item === 'Hardware items');
    assert.ok(rowCall);
    assert.strictEqual(rowCall.body.traceId, 'T-real-trace-abc12');
  });
}

// ══════════════════════════════════════════════════════════
section('3. confirmAndSave() — image-sourced single item sends ONE addWithPhoto request');
{
  const elements = {};
  setInput(elements, 'expenseInput', '');
  elements['expenseInput'].dataset.imageParsed = '1';
  setInput(elements, 'rv-date-0', '2026-09-04');
  setInput(elements, 'rv-cat-0', 'Food');
  setInput(elements, 'rv-tag-0', 'Regular');
  setInput(elements, 'rv-item-0', 'Groceries');
  setInput(elements, 'rv-shop-0', 'DMart');
  setInput(elements, 'rv-comment-0', '');
  setInput(elements, 'rv-amount-0', '500');
  setInput(elements, 'rv-pay-0', 'Cash');

  const { sandbox, fetchCalls } = buildSandbox({
    elements,
    fetchImpl: async () => ({ json: async () => ({ success: true }) }), // no-cors: response is never read
  });
  sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', userName: 'RB' }));
  const expectedBase64 = Buffer.from('fake-image-bytes').toString('base64');
  sandbox.__setState({
    parsedItems: ([{ category: 'Food' }]),
    multiMode: ('separate'),
    pendingImageBase64: (expectedBase64),
    pendingImageMimeType: ('image/jpeg'),
    pendingImageFileName: ('bill.jpg'),
  });

  await test('Exactly one addWithPhoto call is made (silentRefreshHistory\'s later getRecent calls are separate and expected)', async () => {
    await sandbox.confirmAndSave();
    const addWithPhotoCalls = fetchCalls.filter(c => c.body && c.body.action === 'addWithPhoto');
    assert.strictEqual(addWithPhotoCalls.length, 1);
  });
  await test('The request is sent with mode:no-cors AND a CORS-safelisted Content-Type (regression test: application/json under no-cors was silently dropped/mangled on mobile Safari)', () => {
    const call = fetchCalls.find(c => c.body && c.body.action === 'addWithPhoto');
    assert.strictEqual(call.opts.mode, 'no-cors');
    assert.strictEqual(call.opts.headers['Content-Type'], 'text/plain;charset=utf-8');
  });
  await test('The image bytes and the row data travel together in the same request', () => {
    const body = fetchCalls.find(c => c.body && c.body.action === 'addWithPhoto').body;
    assert.strictEqual(body.base64Data, expectedBase64);
    assert.strictEqual(body.mimeType, 'image/jpeg');
    assert.strictEqual(body.rows.length, 1);
    assert.strictEqual(body.rows[0].item, 'Groceries');
    assert.strictEqual(body.rows[0].amount, '500');
    // additionalInfo is NOT set client-side anymore — the backend fills it in
    // server-side, in the same request, once the Drive upload succeeds.
    assert.strictEqual(body.rows[0].additionalInfo, undefined);
  });
}

// ══════════════════════════════════════════════════════════
section('4. confirmAndSave() — multi-item bill: still ONE request, ONE upload, for all items');
{
  const elements = {};
  setInput(elements, 'expenseInput', '');
  elements['expenseInput'].dataset.imageParsed = '1';
  ['0', '1', '2'].forEach((i, idx) => {
    setInput(elements, 'rv-date-' + i, '2026-09-04');
    setInput(elements, 'rv-cat-' + i, 'Food');
    setInput(elements, 'rv-tag-' + i, 'Regular');
    setInput(elements, 'rv-item-' + i, ['Milk', 'Bread', 'Eggs'][idx]);
    setInput(elements, 'rv-shop-' + i, 'BigBasket');
    setInput(elements, 'rv-comment-' + i, '');
    setInput(elements, 'rv-amount-' + i, ['60', '40', '80'][idx]);
    setInput(elements, 'rv-pay-' + i, 'Online');
  });

  const { sandbox, fetchCalls } = buildSandbox({
    elements,
    fetchImpl: async () => ({ json: async () => ({ success: true }) }),
  });
  sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', userName: 'RB' }));
  sandbox.__setState({
    parsedItems: ([{ category: 'Food' }, { category: 'Food' }, { category: 'Food' }]),
    multiMode: ('separate'),
    pendingImageBase64: (Buffer.from('grocery-bill-bytes').toString('base64')),
    pendingImageMimeType: ('image/jpeg'),
    pendingImageFileName: ('grocery_bill.jpg'),
  });

  await test('A 3-item bill still results in exactly ONE addWithPhoto call (one upload, not three)', async () => {
    await sandbox.confirmAndSave();
    const addWithPhotoCalls = fetchCalls.filter(c => c.body && c.body.action === 'addWithPhoto');
    assert.strictEqual(addWithPhotoCalls.length, 1);
  });
  await test('All 3 items are bundled into that single request\'s rows array', () => {
    const rows = fetchCalls.find(c => c.body && c.body.action === 'addWithPhoto').body.rows;
    assert.strictEqual(rows.length, 3);
    assert.deepStrictEqual(rows.map(r => r.item), ['Milk', 'Bread', 'Eggs']);
  });
}

// ══════════════════════════════════════════════════════════
section('5. confirmAndSave() — addWithPhoto is now AWAITED (mobile-reliability fix)');
{
  // This section exists because of a real bug: on mobile, a large photo payload sent
  // fire-and-forget could get silently dropped if the tab backgrounded before the
  // slow upload finished. The fix is to await the request before declaring success.
  function makeElements() {
    const elements = {};
    setInput(elements, 'expenseInput', '');
    elements['expenseInput'].dataset.imageParsed = '1';
    setInput(elements, 'rv-date-0', '2026-09-04');
    setInput(elements, 'rv-cat-0', 'Food');
    setInput(elements, 'rv-tag-0', 'Regular');
    setInput(elements, 'rv-item-0', 'Snacks');
    setInput(elements, 'rv-shop-0', 'Shop');
    setInput(elements, 'rv-comment-0', '');
    setInput(elements, 'rv-amount-0', '75');
    setInput(elements, 'rv-pay-0', 'Cash');
    return elements;
  }
  function setImageState(sandbox) {
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', userName: 'RB' }));
    sandbox.__setState({
      parsedItems: ([{ category: 'Food' }]),
      multiMode: ('separate'),
      pendingImageBase64: (Buffer.from('bytes').toString('base64')),
      pendingImageMimeType: ('image/jpeg'),
      pendingImageFileName: ('x.jpg'),
    });
  }

  // ---- Success case: confirmAndSave genuinely waits for the request to resolve ----
  let resolveFetch;
  const pendingFetch = new Promise(res => { resolveFetch = res; });
  let resolvedBeforeFormReset = null;
  const elementsOk = makeElements();
  const { sandbox: sandboxOk, fetchCalls: callsOk } = buildSandbox({
    elements: elementsOk,
    fetchImpl: async () => pendingFetch, // stays pending until we manually resolve it below
  });
  setImageState(sandboxOk);
  // Override resetAddForm to record whether the fetch had already resolved by the time it runs
  const originalReset = sandboxOk.resetAddForm;
  sandboxOk.resetAddForm = function () { resolvedBeforeFormReset = true; return originalReset(); };

  await test('confirmAndSave does not reset the form until the addWithPhoto fetch actually resolves', async () => {
    const savePromise = sandboxOk.confirmAndSave();
    // At this point the fetch is still pending — form should NOT have reset yet
    assert.strictEqual(resolvedBeforeFormReset, null);
    resolveFetch({}); // now let the network "response" arrive
    await savePromise;
    assert.strictEqual(resolvedBeforeFormReset, true);
    assert.strictEqual(callsOk.filter(c => c.body && c.body.action === 'addWithPhoto').length, 1);
  });

  // ---- Progress indicator: a spinner+message must be visible WHILE the request is pending ----
  let resolveFetch2;
  const pendingFetch2 = new Promise(res => { resolveFetch2 = res; });
  const elementsProgress = makeElements();
  const { sandbox: sandboxProgress } = buildSandbox({
    elements: elementsProgress,
    fetchImpl: async () => pendingFetch2,
  });
  setImageState(sandboxProgress);

  await test('A spinner + "Saving..." message shows on the toast WHILE the upload is still in flight', async () => {
    const savePromise = sandboxProgress.confirmAndSave();
    // Still pending — check the toast NOW, before resolving anything
    const toastHtml = elementsProgress['toast'].innerHTML;
    assert.match(toastHtml, /toast-spinner/);
    assert.match(toastHtml, /Saving/);
    resolveFetch2({});
    await savePromise;
    // After completion, the spinner is gone and the toast shows the real result
    assert.doesNotMatch(elementsProgress['toast'].innerHTML, /toast-spinner/);
  });

  // ---- Failure case: a genuinely rejected fetch now surfaces as a real failure, not a false "Saved!" ----
  const elementsFail = makeElements();
  const { sandbox: sandboxFail, fetchCalls: callsFail } = buildSandbox({
    elements: elementsFail,
    fetchImpl: async () => { throw new Error('simulated: mobile dropped the connection mid-upload'); },
  });
  setImageState(sandboxFail);

  await test('confirmAndSave does NOT throw when the network request genuinely fails', async () => {
    await assert.doesNotReject(sandboxFail.confirmAndSave());
  });
  await test('A real send failure shows a failure toast rather than a false "Saved!"', () => {
    assert.match(elementsFail['toast'].textContent, /failed/i);
  });
  await test('The request was attempted (so this is a real send failure, not a silent no-op)', () => {
    const addWithPhotoCalls = callsFail.filter(c => c.body && c.body.action === 'addWithPhoto');
    assert.strictEqual(addWithPhotoCalls.length, 1);
  });
}

// ══════════════════════════════════════════════════════════
section('5b. filterValidAmountItems() — drops items with no real amount before they ever reach review');
{
  const { sandbox } = buildSandbox({ elements: {}, fetchImpl: async () => ({ json: async () => ({}) }) });

  await test('Keeps items with a valid positive amount', () => {
    const result = sandbox.filterValidAmountItems([{ item: 'Tea', amount: 20 }, { item: 'Milk', amount: 60 }]);
    assert.strictEqual(result.length, 2);
  });
  await test('Drops an item with amount: null (e.g. a struck-through/cancelled line)', () => {
    const result = sandbox.filterValidAmountItems([{ item: 'Tea', amount: 20 }, { item: '10 inch Handle', amount: null }]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].item, 'Tea');
  });
  await test('Drops an item with amount: 0', () => {
    const result = sandbox.filterValidAmountItems([{ item: 'Free sample', amount: 0 }, { item: 'Tea', amount: 20 }]);
    assert.strictEqual(result.length, 1);
  });
  await test('Drops an item with a missing amount field entirely', () => {
    const result = sandbox.filterValidAmountItems([{ item: 'Tea' }, { item: 'Milk', amount: 60 }]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].item, 'Milk');
  });
  await test('Drops an item with a negative amount', () => {
    const result = sandbox.filterValidAmountItems([{ item: 'Refund?', amount: -50 }, { item: 'Tea', amount: 20 }]);
    assert.strictEqual(result.length, 1);
  });
  await test('Keeps an item whose amount is an evaluable expression string (e.g. "200-20")', () => {
    const result = sandbox.filterValidAmountItems([{ item: 'Combo', amount: '200-20' }]);
    assert.strictEqual(result.length, 1);
  });
  await test('Handles null/undefined input gracefully (returns empty array, no crash)', () => {
    assert.strictEqual(sandbox.filterValidAmountItems(null).length, 0);
    assert.strictEqual(sandbox.filterValidAmountItems(undefined).length, 0);
  });
  await test('The exact Sandip Hardware scenario: the struck-through 10" handle is dropped, everything else stays', () => {
    const rawGeminiItems = [
      { item: '4 inch R/A Handle', amount: 840 },
      { item: '10 inch R/A Handle', amount: null }, // struck through on the receipt
      { item: '4 inch S/S Handle', amount: 168 },
      { item: 'S/S Knob', amount: 225 },
      { item: '2 inch Buffer', amount: 40 },
      { item: 'Crest R/S', amount: 270 },
      { item: 'Cupboard lock', amount: 240 },
      { item: 'Godrej Cupboard', amount: 350 },
      { item: '6 inch L.T. Bolt', amount: 220 },
    ];
    const result = sandbox.filterValidAmountItems(rawGeminiItems);
    assert.strictEqual(result.length, 8);
    assert.ok(!result.some(i => i.item === '10 inch R/A Handle'), 'the cancelled item must not appear at all — not in the list, not in any total');
    const sum = result.reduce((s, i) => s + i.amount, 0);
    assert.strictEqual(sum, 2353); // matches what was actually paid, within ₹1 rounding
  });
}

// ══════════════════════════════════════════════════════════
section('6. checkTotalMismatch() — receipt-total warning banner');
{
  function setup(imageParsed, receiptTotal) {
    const elements = {};
    setInput(elements, 'expenseInput', '');
    elements['expenseInput'].dataset.imageParsed = imageParsed ? '1' : '';
    const { sandbox } = buildSandbox({ elements, fetchImpl: async () => ({ json: async () => ({}) }) });
    sandbox.__setState({ pendingReceiptTotal: (receiptTotal) });
    return { sandbox, elements };
  }

  await test('No banner when the entry is not image-sourced, even with a mismatch', () => {
    const { sandbox, elements } = setup(false, 4193);
    sandbox.checkTotalMismatch([{ amount: 100 }]);
    assert.strictEqual(elements['totalMismatchWarning'].style.display, 'none');
  });
  await test('No banner when no receipt total was found (pendingReceiptTotal is null)', () => {
    const { sandbox, elements } = setup(true, null);
    sandbox.checkTotalMismatch([{ amount: 100 }]);
    assert.strictEqual(elements['totalMismatchWarning'].style.display, 'none');
  });
  await test('No banner when items sum matches the receipt total exactly', () => {
    const { sandbox, elements } = setup(true, 300);
    sandbox.checkTotalMismatch([{ amount: 100 }, { amount: 200 }]);
    assert.strictEqual(elements['totalMismatchWarning'].style.display, 'none');
  });
  await test('No banner for a trivial ₹1 rounding-level difference', () => {
    const { sandbox, elements } = setup(true, 301);
    sandbox.checkTotalMismatch([{ amount: 100 }, { amount: 200 }]);
    assert.strictEqual(elements['totalMismatchWarning'].style.display, 'none');
  });
  await test('Banner SHOWS for a real mismatch, with both amounts in the message', () => {
    const { sandbox, elements } = setup(true, 4193);
    // The exact Sandip Hardware scenario that motivated this feature
    sandbox.checkTotalMismatch([
      { amount: 840 }, { amount: 1800 }, { amount: 168 }, { amount: 225 }, { amount: 40 },
      { amount: 270 }, { amount: 240 }, { amount: 350 }, { amount: 220 },
    ]);
    assert.strictEqual(elements['totalMismatchWarning'].style.display, 'block');
    assert.match(elements['totalMismatchWarning'].innerHTML, /4,153/);
    assert.match(elements['totalMismatchWarning'].innerHTML, /4,193/);
  });
  await test('Banner correctly says items sum to MORE than the receipt total when that\'s the case', () => {
    const { sandbox, elements } = setup(true, 100);
    sandbox.checkTotalMismatch([{ amount: 500 }]);
    assert.match(elements['totalMismatchWarning'].innerHTML, /more than/);
  });
  await test('Banner correctly says items sum to LESS than the receipt total when that\'s the case', () => {
    const { sandbox, elements } = setup(true, 500);
    sandbox.checkTotalMismatch([{ amount: 100 }]);
    assert.match(elements['totalMismatchWarning'].innerHTML, /less than/);
  });
  await test('Handles amount expressions (e.g. "200-20") the same way calcAmount does elsewhere', () => {
    const { sandbox, elements } = setup(true, 100);
    sandbox.checkTotalMismatch([{ amount: '200-20' }]); // evaluates to 180, still off from 100
    assert.strictEqual(elements['totalMismatchWarning'].style.display, 'block');
    assert.match(elements['totalMismatchWarning'].innerHTML, /180/);
  });
}

// ══════════════════════════════════════════════════════════
section('6b. logAITrace() — fire-and-forget AI observability logging (unified text/sms/photo)');
{
  const cfg = { scriptUrl: 'https://script.google.com/fake', userName: 'RB' };

  await test('Sends a logAITrace request with all the diagnostic fields', () => {
    const elements = {};
    const { sandbox, fetchCalls } = buildSandbox({ elements, fetchImpl: async () => ({}) });
    sandbox.logAITrace(cfg, { traceId: 'T-1', type: 'photo', attempt: 1, model: 'gemini-3.1-flash-lite-preview', promptVersion: 'vision-v2', fileName: 'bill.jpg', rawResponse: '{"items":[]}', itemsCountRaw: 9, itemsCountFiltered: 8, itemsSum: 2353, receiptTotal: 4193 });
    assert.strictEqual(fetchCalls.length, 1);
    const body = fetchCalls[0].body;
    assert.strictEqual(body.action, 'logAITrace');
    assert.strictEqual(body.traceId, 'T-1');
    assert.strictEqual(body.type, 'photo');
    assert.strictEqual(body.fileName, 'bill.jpg');
    assert.strictEqual(body.itemsCountRaw, 9);
    assert.strictEqual(body.itemsCountFiltered, 8);
    assert.strictEqual(body.itemsSum, 2353);
    assert.strictEqual(body.receiptTotal, 4193);
    assert.strictEqual(body.loggedBy, 'RB');
  });
  await test('Correctly computes and flags a real mismatch', () => {
    const { sandbox, fetchCalls } = buildSandbox({ elements: {}, fetchImpl: async () => ({}) });
    sandbox.logAITrace(cfg, { traceId: 'T-2', type: 'photo', itemsSum: 2353, receiptTotal: 4193 });
    const body = fetchCalls[0].body;
    assert.strictEqual(body.mismatch, true);
    assert.strictEqual(body.mismatchAmount, 2353 - 4193);
  });
  await test('Does not flag a mismatch when items sum matches the receipt total', () => {
    const { sandbox, fetchCalls } = buildSandbox({ elements: {}, fetchImpl: async () => ({}) });
    sandbox.logAITrace(cfg, { traceId: 'T-3', type: 'photo', itemsSum: 300, receiptTotal: 300 });
    assert.strictEqual(fetchCalls[0].body.mismatch, false);
  });
  await test('Does not flag a mismatch when no receipt total was found (receiptTotal null, e.g. text/sms)', () => {
    const { sandbox, fetchCalls } = buildSandbox({ elements: {}, fetchImpl: async () => ({}) });
    sandbox.logAITrace(cfg, { traceId: 'T-4', type: 'text', itemsSum: 300 });
    assert.strictEqual(fetchCalls[0].body.mismatch, false);
    assert.strictEqual(fetchCalls[0].body.mismatchAmount, null);
  });
  await test('Uses no-cors + text/plain, same as every other write (consistent with the mobile-reliability fix)', () => {
    const { sandbox, fetchCalls } = buildSandbox({ elements: {}, fetchImpl: async () => ({}) });
    sandbox.logAITrace(cfg, { traceId: 'T-5', type: 'text' });
    assert.strictEqual(fetchCalls[0].opts.mode, 'no-cors');
    assert.strictEqual(fetchCalls[0].opts.headers['Content-Type'], 'text/plain;charset=utf-8');
  });
  await test('Carries error/attempt fields through untouched for a retry/error log', () => {
    const { sandbox, fetchCalls } = buildSandbox({ elements: {}, fetchImpl: async () => ({}) });
    sandbox.logAITrace(cfg, { traceId: 'T-6', type: 'text', attempt: 2, httpStatus: 429, errorCategory: 'rate_limit', errorMessage: 'Too many requests', latencyMs: 900 });
    const body = fetchCalls[0].body;
    assert.strictEqual(body.attempt, 2);
    assert.strictEqual(body.httpStatus, 429);
    assert.strictEqual(body.errorCategory, 'rate_limit');
    assert.strictEqual(body.errorMessage, 'Too many requests');
    assert.strictEqual(body.latencyMs, 900);
  });
  await test('NEVER throws, even if fetch itself throws synchronously — logging must not break the upload flow', () => {
    const elements = {};
    const { sandbox } = buildSandbox({ elements, fetchImpl: () => { throw new Error('boom'); } });
    assert.doesNotThrow(() => sandbox.logAITrace(cfg, { traceId: 'T-7', type: 'photo' }));
  });
}

// ══════════════════════════════════════════════════════════
section('6c. parseWithGemini() — Trace ID generation, type detection, filtering, and logging');
{
  function setupTextSandbox(replyText) {
    const elements = {};
    const { sandbox, fetchCalls } = buildSandbox({
      elements,
      fetchImpl: async (url) => {
        // GET requests to the Apps Script geminiProxy action — respond with a canned Gemini reply
        return { ok: true, status: 200, json: async () => ({ success: true, result: replyText }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' }));
    return { sandbox, fetchCalls };
  }

  await test('A plain expense text gets type="text" and a fresh Trace ID', async () => {
    const { sandbox, fetchCalls } = setupTextSandbox('[{"item":"Tea","amount":20,"shop":"Tapri","category":"Food"}]');
    const items = await sandbox.parseWithGemini('chai and samosa at the corner shop');
    assert.strictEqual(items.length, 1);
    const traceCall = fetchCalls.find(c => c.body && c.body.action === 'logAITrace');
    assert.ok(traceCall, 'a final outcome trace should have been logged');
    assert.strictEqual(traceCall.body.type, 'text');
    assert.match(traceCall.body.traceId, /^T-/); // generateTraceId()'s format
  });
  await test('Bank SMS text gets type="sms" instead of "text"', async () => {
    const { sandbox, fetchCalls } = setupTextSandbox('[{"item":"UPI Payment","amount":500,"shop":"Merchant"}]');
    const smsText = 'Rs.500 debited from your account XX1234 via UPI to MERCHANT on 04-09-26';
    await sandbox.parseWithGemini(smsText);
    const traceCall = fetchCalls.find(c => c.body && c.body.action === 'logAITrace');
    assert.strictEqual(traceCall.body.type, 'sms');
  });
  await test('Applies filterValidAmountItems the same way the photo path does — drops items with no real amount', async () => {
    const { sandbox } = setupTextSandbox('[{"item":"Tea","amount":20},{"item":"Cancelled thing","amount":null}]');
    const items = await sandbox.parseWithGemini('chai 20 and something else');
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].item, 'Tea');
  });
  await test('A JSON parse failure logs an error trace with the raw response, then throws', async () => {
    const { sandbox, fetchCalls } = setupTextSandbox('not valid json at all');
    await assert.rejects(() => sandbox.parseWithGemini('some garbled input'));
    const traceCall = fetchCalls.find(c => c.body && c.body.action === 'logAITrace' && c.body.errorCategory === 'json_parse_error');
    assert.ok(traceCall, 'a json_parse_error trace should have been logged');
    assert.strictEqual(traceCall.body.rawResponse, 'not valid json at all');
  });
}

// ══════════════════════════════════════════════════════════
section('6d. computeEditedFields() — pure comparison logic');
{
  const { sandbox } = buildSandbox({ elements: {}, fetchImpl: async () => ({}) });

  await test('No changes at all returns an empty list', () => {
    const original = { item: 'Tea', amount: 20, shop: 'Tapri', comment: '', category: 'Food', date: '04 Sep 2026' };
    const final = { item: 'Tea', amount: '20', shop: 'Tapri', comment: '', category: 'Food', date: '2026-09-04' };
    assert.strictEqual(sandbox.computeEditedFields(original, final).length, 0);
  });
  await test('A changed item name is detected', () => {
    const result = sandbox.computeEditedFields({ item: 'Tea', amount: 20 }, { item: 'Chai Latte', amount: '20' });
    assert.ok(result.includes('item'));
  });
  await test('A changed amount is detected (numeric tolerance for float rounding)', () => {
    const result = sandbox.computeEditedFields({ item: 'Tea', amount: 20 }, { item: 'Tea', amount: '25' });
    assert.ok(result.includes('amount'));
  });
  await test('A trivial floating point difference under 0.01 is NOT flagged', () => {
    const result = sandbox.computeEditedFields({ item: 'Tea', amount: 20.001 }, { item: 'Tea', amount: '20.005' });
    assert.ok(!result.includes('amount'));
  });
  await test('A changed shop is detected', () => {
    const result = sandbox.computeEditedFields({ item: 'Tea', shop: 'Tapri' }, { item: 'Tea', shop: 'Different Shop' });
    assert.ok(result.includes('shop'));
  });
  await test('A changed comment is detected', () => {
    const result = sandbox.computeEditedFields({ item: 'Tea', comment: 'morning' }, { item: 'Tea', comment: 'evening' });
    assert.ok(result.includes('comment'));
  });
  await test('A changed category IS flagged when Gemini originally proposed one', () => {
    const result = sandbox.computeEditedFields({ item: 'Tea', category: 'Food' }, { item: 'Tea', category: 'Other' });
    assert.ok(result.includes('category'));
  });
  await test('Category is NOT flagged when Gemini left it blank and the user just picked one (not a correction)', () => {
    const result = sandbox.computeEditedFields({ item: 'Tea', category: '' }, { item: 'Tea', category: 'Food' });
    assert.ok(!result.includes('category'));
  });
  await test('A changed date is detected', () => {
    const result = sandbox.computeEditedFields({ item: 'Tea', date: '04 Sep 2026' }, { item: 'Tea', date: '2026-09-03' });
    assert.ok(result.includes('date'));
  });
  await test('Multiple simultaneous changes are all listed', () => {
    const result = sandbox.computeEditedFields({ item: 'Tea', amount: 20, shop: 'A' }, { item: 'Chai', amount: '25', shop: 'B' });
    assert.strictEqual(result.length, 3);
  });
  await test('A null/undefined original (e.g. no corresponding parsedItems entry) returns empty, not a crash', () => {
    assert.strictEqual(sandbox.computeEditedFields(null, { item: 'Tea' }).length, 0);
    assert.strictEqual(sandbox.computeEditedFields(undefined, { item: 'Tea' }).length, 0);
  });
}

// ══════════════════════════════════════════════════════════
section('6e. logOutcomeTrace() — the wrapper that feeds the Outcome/Edited Fields columns');
{
  const cfg = { scriptUrl: 'https://script.google.com/fake', userName: 'RB' };

  await test('Logs outcome + comma-joined edited fields', () => {
    const { sandbox, fetchCalls } = buildSandbox({ elements: {}, fetchImpl: async () => ({}) });
    sandbox.logOutcomeTrace(cfg, 'T-1', 'text', 'saved_edited', ['amount', 'category']);
    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].body.outcome, 'saved_edited');
    assert.strictEqual(fetchCalls[0].body.editedFields, 'amount,category');
    assert.strictEqual(fetchCalls[0].body.traceId, 'T-1');
  });
  await test('Does nothing (no fetch at all) when traceId is falsy — nothing to link the outcome to', () => {
    const { sandbox, fetchCalls } = buildSandbox({ elements: {}, fetchImpl: async () => ({}) });
    sandbox.logOutcomeTrace(cfg, null, 'text', 'abandoned', []);
    assert.strictEqual(fetchCalls.length, 0);
  });
  await test('An empty edited-fields array logs as an empty string, not "undefined"', () => {
    const { sandbox, fetchCalls } = buildSandbox({ elements: {}, fetchImpl: async () => ({}) });
    sandbox.logOutcomeTrace(cfg, 'T-2', 'photo', 'saved_as_is', []);
    assert.strictEqual(fetchCalls[0].body.editedFields, '');
  });
}

// ══════════════════════════════════════════════════════════
section('6f. confirmAndSave() — outcome tracking integration');
{
  function makeTextElements(itemVal, amountVal) {
    const elements = {};
    setInput(elements, 'expenseInput', 'some ai-parsed text');
    elements['expenseInput'].dataset.imageParsed = '';
    setInput(elements, 'rv-date-0', '2026-09-04');
    setInput(elements, 'rv-cat-0', 'Food');
    setInput(elements, 'rv-tag-0', 'Regular');
    setInput(elements, 'rv-item-0', itemVal);
    setInput(elements, 'rv-shop-0', 'Tapri');
    setInput(elements, 'rv-comment-0', '');
    setInput(elements, 'rv-amount-0', amountVal);
    setInput(elements, 'rv-pay-0', 'Cash');
    return elements;
  }
  function setup(elements) {
    const { sandbox, fetchCalls } = buildSandbox({ elements, fetchImpl: async () => ({ json: async () => ({ success: true }) }) });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', userName: 'RB' }));
    return { sandbox, fetchCalls };
  }

  await test('Saving EXACTLY what Gemini proposed logs outcome=saved_as_is with no edited fields', async () => {
    const { sandbox, fetchCalls } = setup(makeTextElements('Tea', '20'));
    sandbox.__setState({
      parsedItems: ([{ item: 'Tea', amount: 20, shop: 'Tapri', comment: '', category: 'Food', date: '04 Sep 2026' }]),
      multiMode: ('separate'),
      pendingTraceId: ('T-asis'),
      pendingTraceType: ('text'),
    });
    await sandbox.confirmAndSave();
    const outcomeCall = fetchCalls.find(c => c.body && c.body.outcome);
    assert.ok(outcomeCall, 'an outcome trace should have been logged');
    assert.strictEqual(outcomeCall.body.outcome, 'saved_as_is');
    assert.strictEqual(outcomeCall.body.editedFields, '');
  });
  await test('Editing the amount before saving logs outcome=saved_edited with "amount" listed', async () => {
    const { sandbox, fetchCalls } = setup(makeTextElements('Tea', '35')); // Gemini said 20, user changed to 35
    sandbox.__setState({
      parsedItems: ([{ item: 'Tea', amount: 20, shop: 'Tapri', comment: '', category: 'Food', date: '04 Sep 2026' }]),
      multiMode: ('separate'),
      pendingTraceId: ('T-edited'),
      pendingTraceType: ('text'),
    });
    await sandbox.confirmAndSave();
    const outcomeCall = fetchCalls.find(c => c.body && c.body.outcome);
    assert.ok(outcomeCall);
    assert.strictEqual(outcomeCall.body.outcome, 'saved_edited');
    assert.strictEqual(outcomeCall.body.editedFields, 'amount');
  });
  await test('No outcome trace at all when there is no pending Trace ID', async () => {
    const { sandbox, fetchCalls } = setup(makeTextElements('Tea', '20'));
    sandbox.__setState({ parsedItems: ([{ item: 'Tea', amount: 20 }]), multiMode: ('separate') });
    await sandbox.confirmAndSave();
    const outcomeCall = fetchCalls.find(c => c.body && c.body.outcome);
    assert.strictEqual(outcomeCall, undefined);
  });
  await test('No outcome trace in merge mode (1:1 comparison doesn\'t apply to a merged row)', async () => {
    const elements = makeTextElements('Tea, Milk', '80');
    const { sandbox, fetchCalls } = setup(elements);
    sandbox.__setState({
      parsedItems: ([{ item: 'Tea', amount: 20 }, { item: 'Milk', amount: 60 }]),
      multiMode: ('merge'),
      pendingTraceId: ('T-merge'),
      pendingTraceType: ('text'),
    });
    await sandbox.confirmAndSave();
    const outcomeCall = fetchCalls.find(c => c.body && c.body.outcome);
    assert.strictEqual(outcomeCall, undefined);
  });
}

// ══════════════════════════════════════════════════════════
section('6g. closeReview() — abandonment tracking');
{
  function setup() {
    const elements = {};
    const { sandbox, fetchCalls } = buildSandbox({ elements, fetchImpl: async () => ({}) });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', userName: 'RB' }));
    return { sandbox, fetchCalls, elements };
  }

  await test('Closing a Gemini-parsed review WITHOUT saving logs outcome=abandoned', () => {
    const { sandbox, fetchCalls } = setup();
    sandbox.__setState({ pendingTraceId: ('T-abandon1'), pendingTraceType: ('text'), multiMode: ('separate') });
    sandbox.closeReview();
    const outcomeCall = fetchCalls.find(c => c.body && c.body.outcome);
    assert.ok(outcomeCall, 'an abandoned trace should have been logged');
    assert.strictEqual(outcomeCall.body.outcome, 'abandoned');
    assert.strictEqual(outcomeCall.body.traceId, 'T-abandon1');
  });
  await test('closeReview() called as part of a SUCCESSFUL save does NOT log abandoned', () => {
    const { sandbox, fetchCalls } = setup();
    sandbox.__setState({ pendingTraceId: ('T-notabandoned'), pendingTraceType: ('text'), multiMode: ('separate'), reviewJustSaved: (true) });
    sandbox.closeReview();
    const outcomeCall = fetchCalls.find(c => c.body && c.body.outcome === 'abandoned');
    assert.strictEqual(outcomeCall, undefined);
  });
  await test('reviewJustSaved resets after closeReview() runs, so the NEXT close is evaluated fresh', () => {
    const { sandbox, fetchCalls } = setup();
    sandbox.__setState({ pendingTraceId: ('T-seq1'), pendingTraceType: ('text'), multiMode: ('separate'), reviewJustSaved: (true) });
    sandbox.closeReview(); // suppressed — this was a save
    sandbox.__setState({ pendingTraceId: ('T-seq2') }); // a new review session begins
    sandbox.closeReview(); // this one should NOT be suppressed
    const abandonedCalls = fetchCalls.filter(c => c.body && c.body.outcome === 'abandoned');
    assert.strictEqual(abandonedCalls.length, 1);
    assert.strictEqual(abandonedCalls[0].body.traceId, 'T-seq2');
  });
  await test('No abandonment log when there is no pending Trace ID', () => {
    const { sandbox, fetchCalls } = setup();
    sandbox.closeReview();
    assert.strictEqual(fetchCalls.length, 0);
  });
  await test('No abandonment log in merge mode', () => {
    const { sandbox, fetchCalls } = setup();
    sandbox.__setState({ pendingTraceId: ('T-mergeabandon'), pendingTraceType: ('text'), multiMode: ('merge') });
    sandbox.closeReview();
    assert.strictEqual(fetchCalls.length, 0);
  });
}

// ══════════════════════════════════════════════════════════
section('6h. scoreEvalCase() — pure scoring logic');
{
  const { sandbox } = buildSandbox({ elements: {}, fetchImpl: async () => ({}) });

  await test('A perfect match scores 100 on amount and item name', () => {
    const result = sandbox.scoreEvalCase([{ item: 'Tea', amount: 20 }], [{ item: 'Tea', amount: 20 }]);
    assert.strictEqual(result.amountScore, 100);
    assert.strictEqual(result.itemNameScore, 100);
    assert.strictEqual(result.extraActualItems, 0);
  });
  await test('A wrong amount lowers the amount score but not necessarily the item name score', () => {
    const result = sandbox.scoreEvalCase([{ item: 'Tea', amount: 999 }], [{ item: 'Tea', amount: 20 }]);
    assert.strictEqual(result.amountScore, 0);
    assert.strictEqual(result.itemNameScore, 100); // still matched to the closest-amount item, name still correct
  });
  await test('Item name uses a loose substring match, not exact equality', () => {
    const result = sandbox.scoreEvalCase([{ item: 'Tea (Masala)', amount: 20 }], [{ item: 'Tea', amount: 20 }]);
    assert.strictEqual(result.itemNameScore, 100);
  });
  await test('A completely different item name fails the item-name score', () => {
    const result = sandbox.scoreEvalCase([{ item: 'Bus Ticket', amount: 20 }], [{ item: 'Tea', amount: 20 }]);
    assert.strictEqual(result.itemNameScore, 0);
  });
  await test('Missing an expected item (actual has fewer items) is scored as a miss for that item', () => {
    const result = sandbox.scoreEvalCase([{ item: 'Tea', amount: 20 }], [{ item: 'Tea', amount: 20 }, { item: 'Milk', amount: 60 }]);
    assert.strictEqual(result.amountScore, 50); // 1 of 2 expected items matched
  });
  await test('Extra unmatched actual items (possible hallucination) are counted separately', () => {
    const result = sandbox.scoreEvalCase([{ item: 'Tea', amount: 20 }, { item: 'Phantom Item', amount: 999 }], [{ item: 'Tea', amount: 20 }]);
    assert.strictEqual(result.amountScore, 100); // the one expected item still matched correctly
    assert.strictEqual(result.extraActualItems, 1); // but there's a leftover actual item nothing expected
  });
  await test('Category score is null (not 0) when no expected item specifies a category — "not applicable", not "failed"', () => {
    const result = sandbox.scoreEvalCase([{ item: 'Tea', amount: 20 }], [{ item: 'Tea', amount: 20 }]);
    assert.strictEqual(result.categoryScore, null);
  });
  await test('Category score is computed only over expected items that actually specify one', () => {
    const result = sandbox.scoreEvalCase(
      [{ item: 'Tea', amount: 20, category: 'Food' }, { item: 'Bus', amount: 30, category: 'Other' }],
      [{ item: 'Tea', amount: 20, category: 'Food' }, { item: 'Bus', amount: 30 }], // second expected item has no category
    );
    assert.strictEqual(result.categoryScore, 100); // only the first pair counted, and it matched
  });
  await test('Multiple items are matched correctly via greedy best-amount matching (no double-claiming)', () => {
    const result = sandbox.scoreEvalCase(
      [{ item: 'Milk', amount: 60 }, { item: 'Tea', amount: 20 }],
      [{ item: 'Tea', amount: 20 }, { item: 'Milk', amount: 60 }], // different order
    );
    assert.strictEqual(result.amountScore, 100);
    assert.strictEqual(result.itemNameScore, 100);
  });
}

// ══════════════════════════════════════════════════════════
section('6i. runEvals() — full orchestration against the exact production code paths');
{
  function buildEvalCasesResponse(cases) { return { success: true, cases }; }

  await test('Runs text cases through the real parseWithGemini and scores them', async () => {
    const elements = {};
    const cases = [
      { caseId: 'EVAL-001', type: 'text', input: 'chai 20', expectedItems: [{ item: 'Tea', amount: 20 }], expectedTotal: null, imageFileId: '', notes: '' },
    ];
    const { sandbox } = buildSandbox({
      elements,
      fetchImpl: async (url, opts) => {
        if (typeof url === 'string' && url.includes('action=getEvalCases')) return { ok: true, json: async () => buildEvalCasesResponse(cases), text: async () => JSON.stringify(buildEvalCasesResponse(cases)) };
        if (typeof url === 'string' && url.includes('action=geminiProxy')) return { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Tea","amount":20}]' }) };
        return { json: async () => ({ success: true }) }; // logEvalRun (no-cors, response unused)
      },
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' }));
    const out = await sandbox.runEvals();
    assert.strictEqual(out.results.length, 1);
    assert.strictEqual(out.results[0].amountScore, 100);
    assert.strictEqual(out.summary.overallScore, 100);
  });

  await test('Runs photo cases through the real runVisionParse and checks total match', async () => {
    const elements = {};
    const cases = [
      { caseId: 'EVAL-008', type: 'photo', input: '', expectedItems: [{ item: 'Tea', amount: 20 }], expectedTotal: 20, imageFileId: 'file123', notes: '' },
    ];
    const { sandbox } = buildSandbox({
      elements,
      fetchImpl: async (url, opts) => {
        if (typeof url === 'string' && url.includes('action=getEvalCases')) return { ok: true, json: async () => buildEvalCasesResponse(cases), text: async () => JSON.stringify(buildEvalCasesResponse(cases)) };
        if (typeof url === 'string' && url.includes('action=getEvalImage')) { const r = { success: true, base64Data: Buffer.from('fake-bill').toString('base64'), mimeType: 'image/jpeg' }; return { ok: true, json: async () => r, text: async () => JSON.stringify(r) }; }
        if (typeof url === 'string' && url.startsWith('https://generativelanguage.googleapis.com')) {
          return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"items":[{"item":"Tea","amount":20}],"receiptTotal":20}' }] } }] }) };
        }
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' }));
    const out = await sandbox.runEvals();
    assert.strictEqual(out.results[0].amountScore, 100);
    assert.strictEqual(out.results[0].totalMatch, true);
  });

  await test('A photo case with no Image File ID errors gracefully instead of crashing the whole run', async () => {
    const elements = {};
    const cases = [
      { caseId: 'EVAL-008', type: 'photo', input: '', expectedItems: [], expectedTotal: null, imageFileId: '', notes: '' },
      { caseId: 'EVAL-001', type: 'text', input: 'chai 20', expectedItems: [{ item: 'Tea', amount: 20 }], expectedTotal: null, imageFileId: '', notes: '' },
    ];
    const { sandbox } = buildSandbox({
      elements,
      fetchImpl: async (url) => {
        if (typeof url === 'string' && url.includes('action=getEvalCases')) return { ok: true, json: async () => buildEvalCasesResponse(cases), text: async () => JSON.stringify(buildEvalCasesResponse(cases)) };
        if (typeof url === 'string' && url.includes('action=geminiProxy')) return { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Tea","amount":20}]' }) };
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' }));
    const out = await sandbox.runEvals();
    assert.strictEqual(out.results.length, 2);
    assert.ok(out.results[0].error, 'the photo case without an Image File ID should error');
    assert.strictEqual(out.results[1].amountScore, 100, 'the second (valid) case should still run fine');
    assert.strictEqual(out.summary.casesErrored, 1);
  });

  await test('The run gets logged via logEvalRun with the right model/prompt version metadata', async () => {
    const elements = {};
    const cases = [{ caseId: 'EVAL-001', type: 'text', input: 'chai 20', expectedItems: [{ item: 'Tea', amount: 20 }], expectedTotal: null, imageFileId: '', notes: '' }];
    const { sandbox, fetchCalls } = buildSandbox({
      elements,
      fetchImpl: async (url) => {
        if (typeof url === 'string' && url.includes('action=getEvalCases')) return { ok: true, json: async () => buildEvalCasesResponse(cases), text: async () => JSON.stringify(buildEvalCasesResponse(cases)) };
        if (typeof url === 'string' && url.includes('action=geminiProxy')) return { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Tea","amount":20}]' }) };
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' }));
    await sandbox.runEvals();
    const logCall = fetchCalls.find(c => c.body && c.body.action === 'logEvalRun');
    assert.ok(logCall, 'logEvalRun should have been called');
    assert.strictEqual(logCall.body.model, 'gemini-3.1-flash-lite-preview');
    assert.ok(logCall.body.textPromptVersion);
    assert.strictEqual(logCall.opts.mode, 'no-cors');
  });

  await test('Eval runs do NOT pollute AI_Traces — no logAITrace calls during a run', async () => {
    const elements = {};
    const cases = [{ caseId: 'EVAL-001', type: 'text', input: 'chai 20', expectedItems: [{ item: 'Tea', amount: 20 }], expectedTotal: null, imageFileId: '', notes: '' }];
    const { sandbox, fetchCalls } = buildSandbox({
      elements,
      fetchImpl: async (url) => {
        if (typeof url === 'string' && url.includes('action=getEvalCases')) return { ok: true, json: async () => buildEvalCasesResponse(cases), text: async () => JSON.stringify(buildEvalCasesResponse(cases)) };
        if (typeof url === 'string' && url.includes('action=geminiProxy')) return { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Tea","amount":20}]' }) };
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' }));
    await sandbox.runEvals();
    const traceCalls = fetchCalls.filter(c => c.body && c.body.action === 'logAITrace');
    assert.strictEqual(traceCalls.length, 0);
  });
  await test('REGRESSION: errored cases count as 0 toward the score, not silently excluded from the average (the exact bug found in real use — 2 of 8 cases erroring still showed 100%)', async () => {
    const elements = {};
    const cases = [
      { caseId: 'EVAL-001', type: 'text', input: 'chai 20', expectedItems: [{ item: 'Tea', amount: 20 }], expectedTotal: null, imageFileId: '', notes: '' },
      { caseId: 'EVAL-002', type: 'photo', input: '', expectedItems: [{ item: 'X', amount: 1 }], expectedTotal: null, imageFileId: '', notes: '' }, // no imageFileId — will error
    ];
    const { sandbox } = buildSandbox({
      elements,
      fetchImpl: async (url) => {
        if (typeof url === 'string' && url.includes('action=getEvalCases')) return { ok: true, json: async () => ({ success: true, cases }), text: async () => JSON.stringify({ success: true, cases }) };
        if (typeof url === 'string' && url.includes('action=geminiProxy')) return { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Tea","amount":20}]' }) };
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' }));
    const out = await sandbox.runEvals();
    assert.strictEqual(out.summary.casesRun, 2);
    assert.strictEqual(out.summary.casesErrored, 1);
    // 1 case scored 100%, 1 case errored (counts as 0) → average must be 50%, NOT 100%
    assert.strictEqual(out.summary.amountScore, 50);
    assert.strictEqual(out.summary.itemNameScore, 50);
  });
  await test('casesErrored is included in the logged run payload as its own field', async () => {
    const elements = {};
    const cases = [{ caseId: 'EVAL-002', type: 'photo', input: '', expectedItems: [], expectedTotal: null, imageFileId: '', notes: '' }];
    const { sandbox, fetchCalls } = buildSandbox({
      elements,
      fetchImpl: async (url) => {
        if (typeof url === 'string' && url.includes('action=getEvalCases')) return { ok: true, json: async () => ({ success: true, cases }), text: async () => JSON.stringify({ success: true, cases }) };
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' }));
    await sandbox.runEvals();
    const logCall = fetchCalls.find(c => c.body && c.body.action === 'logEvalRun');
    assert.strictEqual(logCall.body.casesErrored, 1);
  });
}

// ══════════════════════════════════════════════════════════
section('6j. Fixes for the real mixed-error eval run (503/404/malformed-HTML)');
{
  await test('REGRESSION: showToast/showProgressToast do not crash when #toast genuinely does not exist (eval mode replaces the whole DOM and has no toast UI) — this was the actual cause of "Cannot set properties of null (setting \'innerHTML\')" during eval retries', async () => {
    // Build a document where getElementById('toast') genuinely returns null, unlike the
    // harness default which auto-stubs any missing element — this reproduces the real
    // eval-mode DOM (document.body.innerHTML fully replaced, no #toast anywhere).
    const elements = {};
    const { sandbox } = buildSandbox({ elements, fetchImpl: async () => ({}) });
    const originalGetById = sandbox.document.getElementById;
    sandbox.document.getElementById = (id) => (id === 'toast' ? null : originalGetById(id));
    assert.doesNotThrow(() => sandbox.showToast('some retry message'));
    assert.doesNotThrow(() => sandbox.showProgressToast('some progress message'));
  });
  await test('REGRESSION: a full retry sequence (transient error → retry → success) completes without crashing even with no #toast element', async () => {
    const elements = {};
    let attempts = 0;
    const { sandbox } = buildSandbox({
      elements,
      fetchImpl: async () => {
        attempts++;
        if (attempts === 1) return { ok: true, status: 200, json: async () => ({ success: false, error: 'Gemini API error 503: UNAVAILABLE' }) };
        return { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Tea","amount":20}]' }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key' }));
    const originalGetById = sandbox.document.getElementById;
    sandbox.document.getElementById = (id) => (id === 'toast' ? null : originalGetById(id));
    // This exact sequence (transient error → showToast retry notice → retry → success)
    // is what crashed in production before the fix.
    const result = await sandbox.callGeminiProxy('some prompt', null);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(result, '[{"item":"Tea","amount":20}]');
  });
  await test('safeJson (via getEvalCases) fails with a clear message when Google returns HTML instead of JSON', async () => {
    const { sandbox } = buildSandbox({
      elements: {},
      fetchImpl: async () => ({ ok: true, text: async () => '<!DOCTYPE html><html>Some Google error page</html>' }),
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key' }));
    await assert.rejects(() => sandbox.runEvals(), /non-JSON response/);
  });

  await test('callGeminiProxy retries on a 503 (Gemini overload) the same way it retries on 429', async () => {
    let attempts = 0;
    const { sandbox } = buildSandbox({
      elements: {},
      fetchImpl: async () => {
        attempts++;
        if (attempts < 2) {
          return { ok: true, status: 200, json: async () => ({ success: false, error: 'Gemini API error 503: {"error":{"code":503,"status":"UNAVAILABLE"}}' }) };
        }
        return { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Tea","amount":20}]' }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key' }));
    const result = await sandbox.callGeminiProxy('some prompt', null);
    assert.strictEqual(attempts, 2);
    assert.strictEqual(result, '[{"item":"Tea","amount":20}]');
  });

  await test('callGeminiProxy gives up after MAX_RETRIES on persistent 503s, with a clear error', async () => {
    const { sandbox } = buildSandbox({
      elements: {},
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: false, error: '503 UNAVAILABLE: model overloaded' }) }),
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key' }));
    await assert.rejects(() => sandbox.callGeminiProxy('some prompt', null), /Service Unavailable|All \d+ retries failed/);
  });

  await test('runEvals paces cases with a delay between each — not fired as a zero-delay burst', async () => {
    const cases = [
      { caseId: 'EVAL-001', type: 'text', input: 'chai 20', expectedItems: [{ item: 'Tea', amount: 20 }], expectedTotal: null, imageFileId: '', notes: '' },
      { caseId: 'EVAL-002', type: 'text', input: 'sabzi 60', expectedItems: [{ item: 'Vegetables', amount: 60 }], expectedTotal: null, imageFileId: '', notes: '' },
    ];
    const timeoutDelays = [];
    const elements = {};
    const { sandbox } = buildSandbox({
      elements,
      fetchImpl: async (url) => {
        if (typeof url === 'string' && url.includes('action=getEvalCases')) return { ok: true, json: async () => ({ success: true, cases }), text: async () => JSON.stringify({ success: true, cases }) };
        if (typeof url === 'string' && url.includes('action=geminiProxy')) return { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"X","amount":1}]' }) };
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' }));
    // Override setTimeout just for this test to record delays instead of the harness's always-instant version
    const originalSetTimeout = sandbox.setTimeout;
    sandbox.setTimeout = (fn, ms) => { timeoutDelays.push(ms); return originalSetTimeout(fn, ms); };
    await sandbox.runEvals();
    assert.ok(timeoutDelays.includes(3000), 'expected a 3000ms pacing delay between eval cases, got: ' + JSON.stringify(timeoutDelays));
  });

  await test('REGRESSION: a transient Apps Script HTTP error (e.g. 404) now retries instead of failing on attempt 1 — this was the actual bug behind the real-world "Apps Script HTTP 404" failures, since the retry loop only ever retried Gemini\'s own 429/503, not Apps Script\'s own transient errors', async () => {
    let attempts = 0;
    const { sandbox } = buildSandbox({
      elements: {},
      fetchImpl: async () => {
        attempts++;
        if (attempts === 1) return { ok: false, status: 404 }; // simulates the exact real-world symptom
        return { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Tea","amount":20}]' }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key' }));
    const result = await sandbox.callGeminiProxy('some prompt', null);
    assert.strictEqual(attempts, 2, 'should have retried once after the transient 404 and succeeded on attempt 2');
    assert.strictEqual(result, '[{"item":"Tea","amount":20}]');
  });
  await test('REGRESSION: a persistent Apps Script HTTP error still fails cleanly after exhausting retries, not silently', async () => {
    const { sandbox } = buildSandbox({
      elements: {},
      fetchImpl: async () => ({ ok: false, status: 404 }),
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key' }));
    await assert.rejects(() => sandbox.callGeminiProxy('some prompt', null), /Apps Script HTTP 404 after \d+ attempts/);
  });
  await test('fetchWithRetry (used by getEvalCases/getEvalImage) also retries past a transient HTTP error', async () => {
    let attempts = 0;
    const { sandbox } = buildSandbox({
      elements: {},
      fetchImpl: async () => {
        attempts++;
        if (attempts === 1) return { ok: false, status: 404 };
        return { ok: true, text: async () => 'success-body' };
      },
    });
    const res = await sandbox.fetchWithRetry('https://script.google.com/fake?action=getEvalCases', 'getEvalCases');
    assert.strictEqual(attempts, 2);
    assert.strictEqual(await res.text(), 'success-body');
  });
}

// ══════════════════════════════════════════════════════════
section('7. confirmAndSave() — validation still blocks bad input');
{
  const elements = {};
  setInput(elements, 'expenseInput', 'x');
  elements['expenseInput'].dataset.imageParsed = '';
  setInput(elements, 'rv-date-0', '2026-09-04');
  setInput(elements, 'rv-cat-0', 'Food');
  setInput(elements, 'rv-tag-0', 'Regular');
  setInput(elements, 'rv-item-0', ''); // missing item — should block
  setInput(elements, 'rv-shop-0', '');
  setInput(elements, 'rv-comment-0', '');
  setInput(elements, 'rv-amount-0', '20');
  setInput(elements, 'rv-pay-0', 'Cash');

  const { sandbox, fetchCalls } = buildSandbox({
    elements,
    fetchImpl: async () => ({ json: async () => ({ success: true }) }),
  });
  sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', userName: 'RB' }));
  sandbox.__setState({
    parsedItems: ([{ category: 'Food' }]),
    multiMode: ('separate'),
  });

  await test('Missing item name blocks save entirely — no fetch calls at all', async () => {
    await sandbox.confirmAndSave();
    assert.strictEqual(fetchCalls.length, 0);
  });
}

// ══════════════════════════════════════════════════════════
section('18. Observability: latency / token / model metadata on text+SMS+photo traces');
{
  function setupMetaSandbox(proxyBody) {
    const { sandbox, fetchCalls } = buildSandbox({
      elements: {},
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => proxyBody }),
    });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' }));
    return { sandbox, fetchCalls };
  }
  await test('A text parse trace now carries latency, token counts, finish reason and served model', async () => {
    const { sandbox, fetchCalls } = setupMetaSandbox({ success: true, result: '[{"item":"Tea","amount":20}]', meta: { promptTokens: 210, outputTokens: 35, totalTokens: 245, finishReason: 'STOP', safety: '', servedModel: 'gem-x' } });
    await sandbox.parseWithGemini('chai and samosa at the corner shop');
    const t = fetchCalls.find(c => c.body && c.body.action === 'logAITrace');
    assert.ok(t);
    assert.strictEqual(typeof t.body.latencyMs, 'number');
    assert.strictEqual(t.body.promptTokens, 210);
    assert.strictEqual(t.body.outputTokens, 35);
    assert.strictEqual(t.body.totalTokens, 245);
    assert.strictEqual(t.body.finishReason, 'STOP');
    assert.strictEqual(t.body.servedModel, 'gem-x');
    assert.strictEqual(t.body.attempt, 1);
  });
  await test('An older backend with no meta block still parses and logs a trace (with latency only)', async () => {
    const { sandbox, fetchCalls } = setupMetaSandbox({ success: true, result: '[{"item":"Tea","amount":20}]' });
    const items = await sandbox.parseWithGemini('chai and samosa at the corner shop');
    assert.strictEqual(items.length, 1);
    const t = fetchCalls.find(c => c.body && c.body.action === 'logAITrace');
    assert.strictEqual(typeof t.body.latencyMs, 'number');
    assert.strictEqual(t.body.promptTokens, undefined);
  });
  await test('A JSON parse failure trace also carries the metadata (useful for diagnosing truncation)', async () => {
    const { sandbox, fetchCalls } = setupMetaSandbox({ success: true, result: 'not json', meta: { finishReason: 'MAX_TOKENS', totalTokens: 700 } });
    await assert.rejects(() => sandbox.parseWithGemini('some garbled input'));
    const t = fetchCalls.find(c => c.body && c.body.errorCategory === 'json_parse_error');
    assert.strictEqual(t.body.finishReason, 'MAX_TOKENS');
    assert.strictEqual(t.body.totalTokens, 700);
  });
  await test('Eval runs (skipTrace) still log nothing even though metadata is now captured', async () => {
    const { sandbox, fetchCalls } = setupMetaSandbox({ success: true, result: '[{"item":"Tea","amount":20}]', meta: { totalTokens: 50 } });
    await sandbox.parseWithGemini('chai and samosa at the corner shop', true);
    assert.strictEqual(fetchCalls.filter(c => c.body && c.body.action === 'logAITrace').length, 0);
  });
  await test('Photo path extracts metadata straight from the Gemini response', () => {
    const { sandbox } = setupMetaSandbox({});
    const m = sandbox.extractGeminiMeta({ candidates: [{ finishReason: 'STOP', safetyRatings: [{ category: 'C1', probability: 'MEDIUM' }] }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 120, totalTokenCount: 1020 }, modelVersion: 'gem-v' });
    assert.strictEqual(m.promptTokens, 900);
    assert.strictEqual(m.servedModel, 'gem-v');
    assert.strictEqual(m.safety, 'C1:MEDIUM');
    assert.doesNotThrow(() => sandbox.extractGeminiMeta({}));
  });
  await test('A photo parse trace carries the metadata too', async () => {
    const { sandbox, fetchCalls } = buildSandbox({
      elements: {},
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"items":[{"item":"Tea","amount":20}],"receiptTotal":20}' }] } }], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 40, totalTokenCount: 840 }, modelVersion: 'gem-v' }) }),
    });
    const cfg = { scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' };
    await sandbox.runVisionParse(cfg, 'AAAA', 'bill.jpg', 'T-photo-meta');
    const t = fetchCalls.find(c => c.body && c.body.action === 'logAITrace' && c.body.traceId === 'T-photo-meta');
    assert.ok(t);
    assert.strictEqual(t.body.totalTokens, 840);
    assert.strictEqual(t.body.finishReason, 'STOP');
    assert.strictEqual(t.body.servedModel, 'gem-v');
    assert.strictEqual(typeof t.body.latencyMs, 'number');
  });
}

// ══════════════════════════════════════════════════════════
section('19. Fast-path (local parser) entries are traced too, without raw text');
{
  function setupLocal(text) {
    const elements = {};
    setInput(elements, 'expenseInput', text);
    elements['expenseInput'].dataset.imageParsed = '';
    const { sandbox, fetchCalls } = buildSandbox({ elements, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }) });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', userName: 'RB' }));
    return { sandbox, fetchCalls };
  }
  await test('"chai 20" logs a type=local trace with the local-parser model and no Gemini call', async () => {
    const { sandbox, fetchCalls } = setupLocal('chai 20');
    await sandbox.submitExpense();
    assert.strictEqual(fetchCalls.filter(c => c.url && String(c.url).includes('action=geminiProxy')).length, 0);
    const t = fetchCalls.find(c => c.body && c.body.action === 'logAITrace' && c.body.type === 'local');
    assert.ok(t, 'a local trace should have been logged');
    assert.strictEqual(t.body.model, 'local-parser');
    assert.strictEqual(t.body.promptVersion, 'local-v1');
    assert.strictEqual(t.body.itemsCountFiltered, 1);
    assert.strictEqual(t.body.itemsSum, 20);
    assert.match(t.body.traceId, /^T-/);
  });
  await test('The local trace never contains the raw input text', async () => {
    const { sandbox, fetchCalls } = setupLocal('chai 20');
    await sandbox.submitExpense();
    const t = fetchCalls.find(c => c.body && c.body.action === 'logAITrace' && c.body.type === 'local');
    assert.strictEqual(t.body.rawResponse, undefined);
    assert.strictEqual(t.body.rawText, undefined);
    assert.ok(!JSON.stringify(t.body).includes('chai'));
  });
  await test('The pending Trace ID and type are set so the saved row links back to the trace', async () => {
    const { sandbox, fetchCalls } = setupLocal('chai 20');
    await sandbox.submitExpense();
    const t = fetchCalls.find(c => c.body && c.body.action === 'logAITrace' && c.body.type === 'local');
    assert.strictEqual(vm.runInContext('pendingTraceId', sandbox), t.body.traceId);
    assert.strictEqual(vm.runInContext('pendingTraceType', sandbox), 'local');
  });
  await test('Saving a local-parse entry logs a saved_as_is outcome tagged type=local, and the row carries the Trace ID', async () => {
    const elements = {};
    setInput(elements, 'expenseInput', 'chai 20'); elements['expenseInput'].dataset.imageParsed = '';
    setInput(elements, 'rv-date-0', '2026-09-04'); setInput(elements, 'rv-cat-0', 'Food'); setInput(elements, 'rv-tag-0', 'Regular');
    setInput(elements, 'rv-item-0', 'Tea'); setInput(elements, 'rv-shop-0', ''); setInput(elements, 'rv-comment-0', '');
    setInput(elements, 'rv-amount-0', '20'); setInput(elements, 'rv-pay-0', 'Cash');
    const { sandbox, fetchCalls } = buildSandbox({ elements, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }) });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', userName: 'RB' }));
    sandbox.__setState({ parsedItems: ([{ date: '04 Sep 2026', item: 'Tea', amount: 20, category: 'Food' }]), multiMode: ('separate'), pendingTraceId: ('T-local-x'), pendingTraceType: ('local') });
    await sandbox.confirmAndSave();
    const outcome = fetchCalls.find(c => c.body && c.body.action === 'logAITrace' && c.body.outcome);
    assert.ok(outcome);
    assert.strictEqual(outcome.body.type, 'local');
    assert.strictEqual(outcome.body.outcome, 'saved_as_is');
    const rowCall = fetchCalls.find(c => c.body && c.body.item === 'Tea');
    assert.strictEqual(rowCall.body.traceId, 'T-local-x');
  });
  await test('Abandoning a local-parse review logs an abandoned outcome', () => {
    const { sandbox, fetchCalls } = setupLocal('chai 20');
    sandbox.__setState({ pendingTraceId: ('T-local-ab'), pendingTraceType: ('local'), multiMode: ('separate'), reviewJustSaved: (false) });
    sandbox.closeReview();
    const t = fetchCalls.find(c => c.body && c.body.outcome === 'abandoned');
    assert.ok(t);
    assert.strictEqual(t.body.type, 'local');
  });
  await test('A complex input still goes to Gemini and gets a text trace, not a local one', async () => {
    const elements = {};
    setInput(elements, 'expenseInput', 'chai 20, samosa 15'); elements['expenseInput'].dataset.imageParsed = '';
    const { sandbox, fetchCalls } = buildSandbox({ elements, fetchImpl: async (url) => ({ ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Tea","amount":20},{"item":"Samosa","amount":15}]' }) }) });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' }));
    await sandbox.submitExpense();
    assert.strictEqual(fetchCalls.filter(c => c.body && c.body.type === 'local').length, 0);
    assert.ok(fetchCalls.find(c => c.body && c.body.action === 'logAITrace' && c.body.type === 'text'));
  });
}

// ══════════════════════════════════════════════════════════
section('19b. scoreEvalCase grades shop judgement in both directions');
{
  const { sandbox } = buildSandbox({ elements: {} });
  await test('A matching shop scores 100% (either string may contain the other)', () => {
    assert.strictEqual(sandbox.scoreEvalCase([{ item: 'Pen', amount: 100, shop: 'Sharma Stationers' }], [{ item: 'Pen', amount: 100, shop: 'Sharma' }]).shopScore, 100);
    assert.strictEqual(sandbox.scoreEvalCase([{ item: 'Pen', amount: 100, shop: 'sharma' }], [{ item: 'Pen', amount: 100, shop: 'Sharma Stationers' }]).shopScore, 100);
  });
  await test('A missed shop (Gemini returned none) scores 0%', () => {
    assert.strictEqual(sandbox.scoreEvalCase([{ item: 'Tea', amount: 20, shop: null }], [{ item: 'Tea', amount: 20, shop: 'Tapri' }]).shopScore, 0);
  });
  await test('A wrong shop scores 0%', () => {
    assert.strictEqual(sandbox.scoreEvalCase([{ item: 'Tea', amount: 20, shop: 'Cafe' }], [{ item: 'Tea', amount: 20, shop: 'Tapri' }]).shopScore, 0);
  });
  await test('Expected shop null: no shop invented = 100%, an invented shop = 0%', () => {
    assert.strictEqual(sandbox.scoreEvalCase([{ item: 'Pizza', amount: 500, shop: null }], [{ item: 'Pizza', amount: 500, shop: null }]).shopScore, 100);
    assert.strictEqual(sandbox.scoreEvalCase([{ item: 'Pizza', amount: 500, shop: '' }], [{ item: 'Pizza', amount: 500, shop: null }]).shopScore, 100);
    assert.strictEqual(sandbox.scoreEvalCase([{ item: 'Pizza', amount: 500, shop: 'Office Party' }], [{ item: 'Pizza', amount: 500, shop: null }]).shopScore, 0);
  });
  await test('A case with no shop expectation is not graded on shop (null = not applicable)', () => {
    assert.strictEqual(sandbox.scoreEvalCase([{ item: 'Tea', amount: 20, shop: 'Whatever' }], [{ item: 'Tea', amount: 20 }]).shopScore, null);
  });
  await test('Shop grading never changes the amount or item-name scores', () => {
    const r = sandbox.scoreEvalCase([{ item: 'Tea', amount: 20, shop: 'Cafe' }], [{ item: 'Tea', amount: 20, shop: 'Tapri' }]);
    assert.strictEqual(r.amountScore, 100);
    assert.strictEqual(r.itemNameScore, 100);
  });
}

// ══════════════════════════════════════════════════════════
section('20. Local parser hands space-separated multi-item input to Gemini');
{
  const { sandbox } = buildSandbox({ elements: {} });
  await test('"chai 20 samosa 15 at tapri" is NOT parsed locally (it used to save one mangled item for Rs.20)', () => {
    assert.strictEqual(sandbox.localParse('chai 20 samosa 15 at tapri'), null);
    assert.strictEqual(sandbox.needsGemini('chai 20 samosa 15 at tapri'), true);
  });
  await test('Three space-separated items also go to Gemini', () => {
    assert.strictEqual(sandbox.needsGemini('chai 20 samosa 15 pani puri 30'), true);
  });
  await test('Single-amount entries still take the fast path', () => {
    for (const t of ['chai 20', 'chai ₹20', 'rs 20 chai', 'chai rs20', 'kal chai 20']) {
      assert.strictEqual(sandbox.needsGemini(t), false, t);
      const r = sandbox.localParse(t);
      assert.ok(r && r.length === 1, t);
      assert.strictEqual(String(r[0].amount), '20', t);
    }
  });
  await test('Arithmetic amounts count as one amount and stay local', () => {
    const r = sandbox.localParse('chai 50+30');
    assert.ok(r && r.length === 1);
    assert.strictEqual(String(r[0].amount), '80');
  });
  await test('An explicit "date DD/MM" is not mistaken for a second amount', () => {
    assert.strictEqual(sandbox.needsGemini('chai 20 date 15/09'), false);
    assert.ok(sandbox.localParse('chai 20 date 15/09'));
  });
  await test('Existing comma and newline multi-item detection is unchanged', () => {
    assert.strictEqual(sandbox.needsGemini('chai 20, samosa 15'), true);
    assert.strictEqual(sandbox.needsGemini('chai 20\nsamosa 15'), true);
  });
}

// ══════════════════════════════════════════════════════════
section('21. Local parser: dash separators; shop judgement is left to Gemini');
{
  const { sandbox } = buildSandbox({ elements: {} });
  const parse = (t) => { const r = sandbox.localParse(t); return r && r[0]; };
  await test('"pen - 100" gives item Pen, amount 100, and no dash anywhere in the item', () => {
    for (const t of ['pen - 100', 'pen-100', 'pen: 100', '100 - pen', 'Pen – 100']) {
      const r = parse(t);
      assert.ok(r, t);
      assert.strictEqual(r.item, 'Pen', t);
      assert.strictEqual(String(r.amount), '100', t);
      assert.ok(!/[-–—]/.test(r.item), t);
    }
  });
  await test('Anything that mentions where it was bought is handed to Gemini, never split by a local rule', () => {
    for (const t of ['bought pen from sharma stationers 100', 'bought pen 100 from sharma', 'pen shop sharma 100', 'pen shop: sharma stores 100',
                     'pen from shop sharma 100', 'bought tape from big bazaar shop 50', 'chai 20 at tapri', 'dukan se doodh 60', 'from sharma 100']) {
      assert.strictEqual(sandbox.localParse(t), null, t);
    }
  });
  await test('Words that merely contain a hint ("shopping", "attar", "pencil") do not trigger the hand-off', () => {
    for (const t of ['shopping 500', 'attar 200', 'pencil 10', 'father 100']) {
      assert.ok(parse(t), t);
    }
  });
  await test('Plain entries still take the fast path with an empty shop, and arithmetic/hyphenated words survive', () => {
    assert.strictEqual(parse('chai 20').shop, '');
    assert.strictEqual(String(parse('chai 50-20').amount), '30');
    assert.strictEqual(String(parse('clothes-2000-20').amount), '1980');
    assert.strictEqual(parse('clothes-2000-20').item, 'Clothes');
    assert.strictEqual(parse('t-shirt 500').item, 'T-shirt');
  });
  await test('The Gemini prompt tells the model to use judgement on shops, not follow a fixed rule', () => {
    const p = sandbox.buildExpensePrompt('bought pen from sharma 100');
    assert.ok(p.includes('Use your own judgement'));
    assert.ok(p.includes('guidance, not rules'));
    assert.ok(p.includes('leave shop=null rather than guessing'));
    assert.ok(p.includes('"pen - 100"'));
    // definition of what is and is not a shop (an occasion/event or the premises a bill is for is not a shop)
    assert.ok(p.includes('a shop is a business or seller where the purchase was made'));
    assert.ok(p.includes('These are NOT shops'));
    assert.ok(p.includes('office party'));
    assert.ok(p.includes('electricity bill for shop'));
    assert.strictEqual(vm.runInContext('TEXT_EXPENSE_PROMPT_VERSION', sandbox), 'text-v4-shop-definition');
  });
}

// ══════════════════════════════════════════════════════════
section('22. Payment mode defaults to Online');
{
  await test('A review chip opens with the Online pill active and Cash inactive, whatever the text says', () => {
    const { sandbox } = buildSandbox({ elements: {} });
    for (const raw of ['chai 20', 'sabzi 120 cash', 'paid via upi 450']) {
      const html = sandbox.buildChip({ date: '04 Sep 2026', item: 'Tea', amount: 20, category: 'Food', rawText: raw }, 0, 1, 'Regular');
      assert.ok(/class="pay-pill active" data-pay="Online"/.test(html), raw);
      assert.ok(!/class="pay-pill active" data-pay="Cash"/.test(html), raw);
    }
  });
  await test('An explicit Cash choice on the chip is respected', () => {
    const { sandbox } = buildSandbox({ elements: {} });
    const html = sandbox.buildChip({ date: '04 Sep 2026', item: 'Tea', amount: 20, category: 'Food', _payMode: 'Cash' }, 0, 1, 'Regular');
    assert.ok(/class="pay-pill active" data-pay="Cash"/.test(html));
  });
  await test('Saving with an empty payment field falls back to Online, not Cash', async () => {
    const elements = {};
    setInput(elements, 'rv-date-0', '2026-09-04'); setInput(elements, 'rv-cat-0', 'Food'); setInput(elements, 'rv-tag-0', 'Regular');
    setInput(elements, 'rv-item-0', 'Tea'); setInput(elements, 'rv-shop-0', ''); setInput(elements, 'rv-comment-0', '');
    setInput(elements, 'rv-amount-0', '20'); setInput(elements, 'rv-pay-0', '');
    const { sandbox, fetchCalls } = buildSandbox({ elements, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }) });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', userName: 'RB' }));
    sandbox.__setState({ parsedItems: ([{ date: '04 Sep 2026', item: 'Tea', amount: 20, category: 'Food' }]), multiMode: ('separate') });
    await sandbox.confirmAndSave();
    const rowCall = fetchCalls.find(c => c.body && c.body.item === 'Tea');
    assert.ok(rowCall);
    assert.strictEqual(rowCall.body.payMode, 'Online');
  });
}

// ══════════════════════════════════════════════════════════
section('23. Eval tracking: per-case detail (what Gemini returned for shop, time, attempts), 404 backoff and call timeout');
{
  const cfgJson = JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' });
  await test('scoreEvalCase records the shop Gemini actually returned, and whether it matched', () => {
    const { sandbox } = buildSandbox({ elements: {} });
    const bad = sandbox.scoreEvalCase([{ item: 'Pizza', amount: 500, shop: 'Office Party' }], [{ item: 'Pizza', amount: 500, shop: null }]);
    assert.strictEqual(bad.details[0].expectedShop, null);
    assert.strictEqual(bad.details[0].matchedShop, 'Office Party');
    assert.strictEqual(bad.details[0].shopMatch, false);
    const good = sandbox.scoreEvalCase([{ item: 'Pen', amount: 100, shop: 'Sharma' }], [{ item: 'Pen', amount: 100, shop: 'Sharma Stationers' }]);
    assert.strictEqual(good.details[0].shopMatch, true);
    const none = sandbox.scoreEvalCase([{ item: 'Tea', amount: 20 }], [{ item: 'Tea', amount: 20 }]);
    assert.ok(!('expectedShop' in none.details[0]), 'ungraded cases carry no shop fields');
  });

  await test('runEvals logs input, expected, actual (incl. the shop returned), scores, time and attempts per case', async () => {
    const cases = [
      { caseId: 'EVAL-015', type: 'text', input: 'pizza at office party 500', expectedItems: [{ item: 'Pizza', amount: 500, shop: null }], expectedTotal: null, imageFileId: '', notes: '' },
      { caseId: 'EVAL-011', type: 'text', input: 'chai 20 at tapri', expectedItems: [{ item: 'Tea', amount: 20, shop: 'Tapri' }], expectedTotal: null, imageFileId: '', notes: '' },
    ];
    let proxyCalls = 0;
    const { sandbox, fetchCalls } = buildSandbox({
      elements: {},
      fetchImpl: async (url) => {
        if (typeof url === 'string' && url.includes('action=getEvalCases')) return { ok: true, json: async () => ({ success: true, cases }), text: async () => JSON.stringify({ success: true, cases }) };
        if (typeof url === 'string' && url.includes('action=geminiProxy')) {
          proxyCalls++;
          if (proxyCalls === 1) return { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Pizza","amount":500,"shop":"Office Party"}]' }) };
          if (proxyCalls === 2) return { ok: false, status: 404, json: async () => ({}) };          // second case: one 404 ...
          return { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Tea","amount":20,"shop":"Tapri"}]' }) }; // ... then success
        }
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', cfgJson);
    const out = await sandbox.runEvals();
    const log = fetchCalls.find(c => c.body && c.body.action === 'logEvalRun');
    assert.ok(log);
    const detail = JSON.parse(log.body.perCaseDetail);
    const d15 = detail.find(d => d.caseId === 'EVAL-015');
    assert.strictEqual(d15.input, 'pizza at office party 500');
    assert.strictEqual(d15.shopScore, 0);
    assert.strictEqual(d15.actual[0].shop, 'Office Party');      // exactly what Gemini shared for shop
    assert.strictEqual(d15.expected[0].shop, null);
    assert.strictEqual(typeof d15.timeMs, 'number');
    assert.strictEqual(d15.attempts, 1);
    assert.strictEqual(d15.attemptErrors, null);
    const d11 = detail.find(d => d.caseId === 'EVAL-011');
    assert.strictEqual(d11.attempts, 2);
    assert.deepStrictEqual(d11.attemptErrors, ['HTTP 404']);
    assert.strictEqual(d11.shopScore, 100);
    assert.strictEqual(typeof out.summary.totalTimeMs, 'number');
    assert.strictEqual(out.summary.retriedCases, 1);
    assert.ok(out.summary.slowestCase && out.summary.slowestCase.caseId);
  });

  await test('An errored case still records its timing, attempts and the reason for every failed attempt', async () => {
    const cases = [{ caseId: 'EVAL-010', type: 'text', input: 'pen - 100', expectedItems: [{ item: 'Pen', amount: 100, shop: null }], expectedTotal: null, imageFileId: '', notes: '' }];
    const { sandbox, fetchCalls } = buildSandbox({
      elements: {},
      fetchImpl: async (url) => {
        if (typeof url === 'string' && url.includes('action=getEvalCases')) return { ok: true, json: async () => ({ success: true, cases }), text: async () => JSON.stringify({ success: true, cases }) };
        if (typeof url === 'string' && url.includes('action=geminiProxy')) return { ok: false, status: 404, json: async () => ({}) };
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', cfgJson);
    const out = await sandbox.runEvals();
    assert.strictEqual(out.results[0].attempts, 3);
    const d = JSON.parse(fetchCalls.find(c => c.body && c.body.action === 'logEvalRun').body.perCaseDetail)[0];
    assert.ok(/404/.test(d.error));
    assert.deepStrictEqual(d.attemptErrors, ['HTTP 404', 'HTTP 404', 'HTTP 404']);
    assert.strictEqual(d.input, 'pen - 100');
    assert.strictEqual(d.attempts, 3);
  });

  await test('The results screen shows expected vs returned shop (red on a mismatch) plus time and retries', () => {
    const { sandbox } = buildSandbox({ elements: {} });
    const html = sandbox.renderEvalResultsHtml([{ caseId: 'EVAL-015', type: 'text', amountScore: 100, itemNameScore: 100, shopScore: 0, timeMs: 2300, attempts: 2, attemptErrors: ['HTTP 404'],
      details: [{ expectedItem: 'Pizza', expectedShop: null, matchedShop: 'Office Party', shopMatch: false }] }]);
    assert.ok(html.includes('expected none, Gemini returned'));
    assert.ok(html.includes('Office Party'));
    assert.ok(html.includes('#ff6b6b'));
    assert.ok(html.includes('2.3s'));
    assert.ok(html.includes('2 attempts (HTTP 404)'));
    const errHtml = sandbox.renderEvalResultsHtml([{ caseId: 'EVAL-002', type: 'text', error: 'Apps Script HTTP 404 after 3 attempts', timeMs: 31000, attempts: 3, attemptErrors: ['HTTP 404', 'HTTP 404', 'HTTP 404'] }]);
    assert.ok(errHtml.includes('3 attempts (HTTP 404, HTTP 404, HTTP 404)'));
  });

  await test('Apps Script 404s are retried with longer waits (5s then 15s), not the old 3s/6s', async () => {
    let n = 0;
    const { sandbox } = buildSandbox({
      elements: {},
      fetchImpl: async () => { n++; return n < 3 ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ success: true, result: '[]' }) }; },
    });
    sandbox.localStorage.setItem('kharcha_config', cfgJson);
    const delays = []; const orig = sandbox.setTimeout;
    sandbox.setTimeout = (fn, ms) => { delays.push(ms); return orig(fn, ms); };
    const out = await sandbox.callGeminiProxy('p', null);
    assert.strictEqual(out, '[]');
    assert.strictEqual(n, 3);
    const waits = [...new Set(delays.filter(d => d >= 1000))];
    assert.deepStrictEqual(waits, [5000, 15000]); // (toast timers reuse the same values, so compare the distinct set)
    assert.ok(!delays.includes(3000) && !delays.includes(6000), 'the old 3s/6s waits must be gone');
  });

  await test('A hung call is aborted after the timeout and retried instead of freezing', async () => {
    sandboxTimerFns = [];
    let n = 0;
    const { sandbox } = buildSandbox({
      elements: {},
      fetchImpl: async (url, opts) => {
        n++;
        if (n === 1) return new Promise((_, reject) => { opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))); }); // hangs until aborted
        return { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Tea","amount":20}]' }) };
      },
    });
    sandbox.AbortController = AbortController;
    sandbox.localStorage.setItem('kharcha_config', cfgJson);
    sandbox.setTimeout = (fn, ms) => { if (ms === 60000) { sandboxTimerFns.push(fn); return 1; } fn(); return 0; };
    const p = sandbox.callGeminiProxy('p', null);
    assert.strictEqual(sandboxTimerFns.length, 1, 'a 60s timeout should be armed on the call');
    sandboxTimerFns[0](); // simulate 60s passing
    const out = await p;
    assert.strictEqual(out, '[{"item":"Tea","amount":20}]');
    assert.strictEqual(n, 2);
  });
}
var sandboxTimerFns = [];

// ══════════════════════════════════════════════════════════
section('24. SMS prompt handles UPI-only payees; served model is recorded on every eval case');
{
  const cfgJson = JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' });
  await test('The SMS prompt says a bare UPI ID is never the item or the shop: item "UPI Payment", shop null, UPI ID in comment', () => {
    const { sandbox } = buildSandbox({ elements: {} });
    const p = sandbox.buildSmsPrompt('Rs.500.00 debited from A/c XX1234 to VPA merchant@ybl UPI Ref No 123456789012');
    assert.ok(p.includes('item="UPI Payment"'));
    assert.ok(p.includes('is NOT a shop'));
    assert.ok(p.includes('set shop=null, and put the UPI ID in comment'));
    assert.ok(p.includes('Never use a UPI ID as the item or the shop'));
    assert.ok(p.includes('use your judgement'), 'a business hidden in a UPI ID (swiggy@icici) is left to Gemini');
    assert.ok(p.includes('name the same as the item') || p.includes('use the same name as the item'), 'a real merchant is still used as both shop and item');
  });
  await test('The SMS prompt sends a non-business payee UPI ID to the comment field, along with the ref number', () => {
    const { sandbox } = buildSandbox({ elements: {} });
    const p = sandbox.buildSmsPrompt('x');
    assert.ok(!p.includes('goes in shop, not comment'), 'the previous rule (UPI ID as shop) is gone');
    assert.ok(p.includes('a payee UPI ID that is not a business'));
    assert.strictEqual(vm.runInContext('TEXT_SMS_PROMPT_VERSION', sandbox), 'sms-v3-upi-comment');
  });
  await test('A named merchant SMS is unchanged in intent: the prompt still tells Gemini to use AMAZON as shop and item', () => {
    const { sandbox } = buildSandbox({ elements: {} });
    const p = sandbox.buildSmsPrompt('INR 1,250.00 spent on your HDFC Bank Card XX5678 at AMAZON');
    assert.ok(p.includes('for example AMAZON, Swiggy'));
  });

  await test('runVisionParse exposes the served model so a photo eval case can report it', async () => {
    const { sandbox } = buildSandbox({
      elements: {},
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"items":[{"item":"Tea","amount":20}],"receiptTotal":20}' }] } }], modelVersion: 'gem-photo-v1', usageMetadata: { totalTokenCount: 900 } }) }),
    });
    await sandbox.runVisionParse({ scriptUrl: 'https://script.google.com/fake', apiKey: 'k', userName: 'RB' }, 'AAAA', 'bill.jpg', null);
    const meta = vm.runInContext('lastGeminiMeta', sandbox);
    assert.strictEqual(meta.servedModel, 'gem-photo-v1');
  });

  await test('runEvals records the served model on each case (text, SMS and photo) and in the run summary', async () => {
    const cases = [
      { caseId: 'EVAL-001', type: 'text', input: 'chai 20', expectedItems: [{ item: 'Tea', amount: 20 }], expectedTotal: null, imageFileId: '', notes: '' },
      { caseId: 'EVAL-006', type: 'sms', input: 'Rs.500.00 debited from A/c XX1234 to VPA merchant@ybl UPI Ref No 1', expectedItems: [{ item: 'UPI Payment', amount: 500, shop: null }], expectedTotal: null, imageFileId: '', notes: '' },
      { caseId: 'EVAL-008', type: 'photo', input: '', expectedItems: [{ item: 'Tea', amount: 20 }], expectedTotal: 20, imageFileId: 'FILE1', notes: '' },
    ];
    const { sandbox, fetchCalls } = buildSandbox({
      elements: {},
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes('action=getEvalCases')) return { ok: true, json: async () => ({ success: true, cases }), text: async () => JSON.stringify({ success: true, cases }) };
        if (u.includes('action=getEvalImage')) return { ok: true, json: async () => ({ success: true, base64Data: 'AAAA' }), text: async () => JSON.stringify({ success: true, base64Data: 'AAAA' }) };
        if (u.includes('action=geminiProxy')) {
          const isSms = decodeURIComponent(u.replace(/\+/g, ' ')).includes('bank/UPI transaction SMS'); // URLSearchParams encodes spaces as +
          return { ok: true, status: 200, json: async () => isSms
            ? ({ success: true, result: '[{"item":"UPI Payment","amount":500,"shop":null,"comment":"merchant@ybl, Ref 1"}]', meta: { servedModel: 'gem-text-v2' } })
            : ({ success: true, result: '[{"item":"Tea","amount":20}]', meta: { servedModel: 'gem-text-v1' } }) };
        }
        if (u.includes('generativelanguage.googleapis.com')) return { ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"items":[{"item":"Tea","amount":20}],"receiptTotal":20}' }] } }], modelVersion: 'gem-photo-v1' }) };
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', cfgJson);
    const out = await sandbox.runEvals();
    const byId = id => out.results.find(r => r.caseId === id);
    assert.strictEqual(byId('EVAL-001').servedModel, 'gem-text-v1');
    assert.strictEqual(byId('EVAL-006').servedModel, 'gem-text-v2');
    assert.strictEqual(byId('EVAL-008').servedModel, 'gem-photo-v1');
    assert.strictEqual(byId('EVAL-006').shopScore, 100, 'the UPI-only SMS case is graded on shop too');
    assert.deepStrictEqual([...out.summary.servedModels].sort(), ['gem-photo-v1', 'gem-text-v1', 'gem-text-v2']);
    assert.strictEqual(out.summary.requestedModel, vm.runInContext('GEMINI_MODEL', sandbox));
    const detail = JSON.parse(fetchCalls.find(c => c.body && c.body.action === 'logEvalRun').body.perCaseDetail);
    assert.strictEqual(detail.find(d => d.caseId === 'EVAL-001').servedModel, 'gem-text-v1');
    assert.strictEqual(detail.find(d => d.caseId === 'EVAL-008').servedModel, 'gem-photo-v1');
  });
  await test('A case whose call failed outright reports served model as null, not a stale value from the previous case', async () => {
    const cases = [
      { caseId: 'EVAL-001', type: 'text', input: 'chai 20', expectedItems: [{ item: 'Tea', amount: 20 }], expectedTotal: null, imageFileId: '', notes: '' },
      { caseId: 'EVAL-002', type: 'text', input: 'sabzi 120 kal', expectedItems: [{ item: 'Vegetables', amount: 120 }], expectedTotal: null, imageFileId: '', notes: '' },
    ];
    let n = 0;
    const { sandbox } = buildSandbox({
      elements: {},
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes('action=getEvalCases')) return { ok: true, json: async () => ({ success: true, cases }), text: async () => JSON.stringify({ success: true, cases }) };
        if (u.includes('action=geminiProxy')) { n++; return n === 1 ? { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Tea","amount":20}]', meta: { servedModel: 'gem-a' } }) } : { ok: false, status: 404, json: async () => ({}) }; }
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', cfgJson);
    const out = await sandbox.runEvals();
    assert.strictEqual(out.results[0].servedModel, 'gem-a');
    assert.ok(out.results[1].error);
    assert.strictEqual(out.results[1].servedModel, null);
  });
  await test('The results screen shows the model asked for, the model that answered, and the model on each case', () => {
    const { sandbox } = buildSandbox({ elements: {} });
    const summary = { casesRun: 1, casesErrored: 0, amountScore: 100, itemNameScore: 100, categoryScore: null, shopScore: null, overallScore: 100, totalTimeMs: 1000, slowestCase: null, retriedCases: 0, requestedModel: 'gemini-3.1-flash-lite-preview', servedModels: ['gemini-3.1-flash-lite'] };
    const results = [{ caseId: 'EVAL-001', type: 'text', amountScore: 100, itemNameScore: 100, timeMs: 1200, attempts: 1, servedModel: 'gemini-3.1-flash-lite', details: [] }];
    const html = (sandbox.renderEvalSummaryHtml ? sandbox.renderEvalSummaryHtml(summary) : '') + sandbox.renderEvalResultsHtml(results);
    assert.ok(html.includes('answered by gemini-3.1-flash-lite'));
  });
}

// ══════════════════════════════════════════════════════════
section('25. Shop names are capitalised; failed attempts are logged with timing, host and response text');
{
  const cfgJson = JSON.stringify({ scriptUrl: 'https://script.google.com/fake', apiKey: 'fake-key', userName: 'RB' });
  await test('titleCaseShop capitalises the first letter of each word and leaves the rest as typed', () => {
    const { sandbox } = buildSandbox({ elements: {} });
    assert.strictEqual(sandbox.titleCaseShop('tapri'), 'Tapri');
    assert.strictEqual(sandbox.titleCaseShop('sharma ji'), 'Sharma Ji');
    assert.strictEqual(sandbox.titleCaseShop('  big   bazaar '), 'Big   Bazaar');
    assert.strictEqual(sandbox.titleCaseShop('AMAZON'), 'AMAZON');
    assert.strictEqual(sandbox.titleCaseShop("mcDonald's"), "McDonald's");
    assert.strictEqual(sandbox.titleCaseShop(''), '');
    assert.strictEqual(sandbox.titleCaseShop(null), '');
  });
  await test('The review screen shows the shop already capitalised', () => {
    const { sandbox } = buildSandbox({ elements: {} });
    const html = sandbox.buildChip({ date: '04 Sep 2026', item: 'Tea', amount: 20, shop: 'tapri', category: 'Food' }, 0, 1, 'Regular');
    assert.ok(html.includes('value="Tapri"'));
  });
  await test('Saving sends the capitalised shop, even if the field was typed in lowercase', async () => {
    const elements = {};
    setInput(elements, 'rv-date-0', '2026-09-04'); setInput(elements, 'rv-cat-0', 'Food'); setInput(elements, 'rv-tag-0', 'Regular');
    setInput(elements, 'rv-item-0', 'Tea'); setInput(elements, 'rv-shop-0', 'sharma ji'); setInput(elements, 'rv-comment-0', '');
    setInput(elements, 'rv-amount-0', '20'); setInput(elements, 'rv-pay-0', 'Online');
    const { sandbox, fetchCalls } = buildSandbox({ elements, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }) });
    sandbox.localStorage.setItem('kharcha_config', JSON.stringify({ scriptUrl: 'https://script.google.com/fake', userName: 'RB' }));
    sandbox.__setState({ parsedItems: ([{ date: '04 Sep 2026', item: 'Tea', amount: 20, shop: 'sharma ji', category: 'Food' }]), multiMode: ('separate') });
    await sandbox.confirmAndSave();
    const rowCall = fetchCalls.find(c => c.body && c.body.item === 'Tea');
    assert.strictEqual(rowCall.body.shop, 'Sharma Ji');
  });
  await test('Capitalisation alone is not counted as a user edit of the shop', () => {
    const { sandbox } = buildSandbox({ elements: {} });
    const fields = sandbox.computeEditedFields({ item: 'Tea', amount: 20, shop: 'tapri' }, { item: 'Tea', amount: 20, shop: 'Tapri' });
    assert.ok(!fields.includes('shop'));
    const real = sandbox.computeEditedFields({ item: 'Tea', amount: 20, shop: 'tapri' }, { item: 'Tea', amount: 20, shop: 'Cafe' });
    assert.ok(real.includes('shop'));
  });
  await test('Editing an old entry capitalises a shop only if the user changed it', () => {
    const elements = {};
    setInput(elements, 'editShop', 'tapri');
    const { sandbox } = buildSandbox({ elements });
    sandbox.__setState({ editingRow: ({ shop: 'tapri' }) });
    assert.strictEqual(sandbox.editShopValue(), 'tapri', 'untouched old value is left alone');
    setInput(elements, 'editShop', 'new shop');
    assert.strictEqual(sandbox.editShopValue(), 'New Shop');
  });

  await test('responseSnippet turns an HTML error page into its title plus readable text, capped at 150 characters', () => {
    const { sandbox } = buildSandbox({ elements: {} });
    const html = '<html><head><title>Error</title><style>body{color:red}</style></head><body><script>var x=1;</script><div>Sorry, unable to open the file at present.</div></body></html>';
    const out = sandbox.responseSnippet(html);
    assert.ok(out.startsWith('Error '), 'the page title leads the snippet');
    assert.ok(out.includes('Sorry, unable to open the file at present.'));
    assert.ok(!out.includes('color:red') && !out.includes('var x'));
    assert.ok(sandbox.responseSnippet('x'.repeat(500)).length <= 150);
    assert.strictEqual(sandbox.responseSnippet('{}'), '');
  });

  await test('A failed real-use attempt logs the host that answered and what the response said, in the existing error message', async () => {
    let n = 0;
    const { sandbox, fetchCalls } = buildSandbox({
      elements: {},
      fetchImpl: async (url) => {
        if (String(url).includes('action=geminiProxy')) {
          n++;
          if (n === 1) return { ok: false, status: 404, url: 'https://script.googleusercontent.com/macros/echo?x=1', text: async () => '<html><head><title>Page Not Found</title></head><body>Sorry, unable to open the file at present.</body></html>' };
          return { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Tea","amount":20}]' }) };
        }
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', cfgJson);
    await sandbox.callGeminiProxy('p', { traceId: 'T-fail1', type: 'text', model: 'm', promptVersion: 'v' });
    const t = fetchCalls.find(c => c.body && c.body.action === 'logAITrace' && c.body.httpStatus === 404);
    assert.ok(t);
    assert.ok(t.body.errorMessage.startsWith('Apps Script HTTP 404 via script.googleusercontent.com: '));
    assert.ok(t.body.errorMessage.includes('Sorry, unable to open the file at present.'));
  });
  await test('A failed real-use attempt without a readable body still logs the plain status message', async () => {
    let n = 0;
    const { sandbox, fetchCalls } = buildSandbox({
      elements: {},
      fetchImpl: async (url) => {
        if (String(url).includes('action=geminiProxy')) { n++; return n === 1 ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ success: true, result: '[]' }) }; }
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', cfgJson);
    await sandbox.callGeminiProxy('p', { traceId: 'T-fail2', type: 'text', model: 'm', promptVersion: 'v' });
    const t = fetchCalls.find(c => c.body && c.body.action === 'logAITrace' && c.body.httpStatus === 404);
    assert.strictEqual(t.body.errorMessage, 'Apps Script HTTP 404');
  });

  await test('Eval cases record every attempt: clock time, duration, outcome, host and response text, plus the case start time', async () => {
    const cases = [{ caseId: 'EVAL-013', type: 'text', input: 'bought tape from big bazaar shop 50', expectedItems: [{ item: 'Tape', amount: 50, shop: 'Big Bazaar' }], expectedTotal: null, imageFileId: '', notes: '' }];
    let n = 0;
    const { sandbox, fetchCalls } = buildSandbox({
      elements: {},
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes('action=getEvalCases')) return { ok: true, json: async () => ({ success: true, cases }), text: async () => JSON.stringify({ success: true, cases }) };
        if (u.includes('action=geminiProxy')) {
          n++;
          if (n === 1) return { ok: false, status: 404, url: 'https://script.google.com/macros/s/abc/exec', text: async () => '<title>Not Found</title><p>Sorry, unable to open the file at present.</p>' };
          if (n === 2) return { ok: true, status: 200, json: async () => ({ success: true, error: 'x', result: '' }) , _skip: true };
          return { ok: true, status: 200, url: 'https://script.googleusercontent.com/echo', json: async () => ({ success: true, result: '[{"item":"Tape","amount":50,"shop":"Big Bazaar"}]', meta: { servedModel: 'gem-x' } }) };
        }
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', cfgJson);
    // second attempt: Gemini busy (503 surfaced through the proxy as success:false)
    const origFetch = sandbox.fetch;
    sandbox.fetch = async (url, opts) => { const r = await origFetch(url, opts); if (r._skip) return { ok: true, status: 200, json: async () => ({ success: false, error: 'Gemini API error 503: {"error":{"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}' }) }; return r; };
    const out = await sandbox.runEvals();
    const r = out.results[0];
    assert.strictEqual(r.attempts, 3);
    assert.ok(/^\d\d:\d\d:\d\d$/.test(r.startedAt), 'case start time looks like HH:MM:SS');
    assert.strictEqual(r.attemptLog.length, 3);
    assert.deepStrictEqual(Array.from(r.attemptLog.map(a => a.outcome)), ['HTTP 404', '503', 'ok']);
    assert.deepStrictEqual(Array.from(r.attemptLog.map(a => a.attempt)), [1, 2, 3]);
    assert.ok(r.attemptLog.every(a => /^\d\d:\d\d:\d\d$/.test(a.startedAt) && typeof a.ms === 'number'));
    assert.strictEqual(r.attemptLog[0].via, 'script.google.com');
    assert.ok(r.attemptLog[0].detail.includes('Sorry, unable to open the file at present.'));
    assert.ok(r.attemptLog[1].detail.includes('experiencing high demand'));
    const d = JSON.parse(fetchCalls.find(c => c.body && c.body.action === 'logEvalRun').body.perCaseDetail)[0];
    assert.strictEqual(d.attemptLog.length, 3);
    assert.strictEqual(d.startedAt, r.startedAt);
  });
  await test('A clean case stores no attempt log (keeps the sheet cell small); timing is still there', async () => {
    const cases = [{ caseId: 'EVAL-001', type: 'text', input: 'chai 20', expectedItems: [{ item: 'Tea', amount: 20 }], expectedTotal: null, imageFileId: '', notes: '' }];
    const { sandbox, fetchCalls } = buildSandbox({
      elements: {},
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes('action=getEvalCases')) return { ok: true, json: async () => ({ success: true, cases }), text: async () => JSON.stringify({ success: true, cases }) };
        if (u.includes('action=geminiProxy')) return { ok: true, status: 200, json: async () => ({ success: true, result: '[{"item":"Tea","amount":20}]' }) };
        return { json: async () => ({ success: true }) };
      },
    });
    sandbox.localStorage.setItem('kharcha_config', cfgJson);
    await sandbox.runEvals();
    const d = JSON.parse(fetchCalls.find(c => c.body && c.body.action === 'logEvalRun').body.perCaseDetail)[0];
    assert.strictEqual(d.attemptLog, null);
    assert.strictEqual(typeof d.timeMs, 'number');
    assert.ok(d.startedAt);
  });
  await test('The results screen lists each failed attempt with time, duration, outcome, host and response text', () => {
    const { sandbox } = buildSandbox({ elements: {} });
    const html = sandbox.renderEvalResultsHtml([{ caseId: 'EVAL-014', type: 'text', error: 'Apps Script HTTP 404 after 3 attempts', timeMs: 227050, startedAt: '12:01:05', attempts: 3, attemptErrors: ['timeout', 'HTTP 404'],
      attemptLog: [{ attempt: 1, startedAt: '12:01:05', ms: 60012, outcome: 'timeout', detail: 'AbortError: aborted' }, { attempt: 2, startedAt: '12:02:20', ms: 3100, outcome: 'HTTP 404', via: 'script.google.com', detail: '[Not Found] Sorry, unable to open the file' }] }]);
    assert.ok(html.includes('started 12:01:05'));
    assert.ok(html.includes('#1 12:01:05'));
    assert.ok(html.includes('timeout'));
    assert.ok(html.includes('#2 12:02:20'));
    assert.ok(html.includes('via script.google.com'));
    assert.ok(html.includes('Sorry, unable to open the file'));
  });
}

})().then(() => {
// ══════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(50));
console.log(`Frontend: ${testsPassed}/${testsRun} passed`);
if (failures.length) { console.log('FAILURES:', JSON.stringify(failures, null, 2)); process.exitCode = 1; }
});

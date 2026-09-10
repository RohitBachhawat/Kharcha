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
  await test('A local-parse entry (pendingTraceId never set) saves with an empty traceId, not undefined', () => {
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
  await test('No outcome trace at all for a local-parse entry (pendingTraceId never set)', async () => {
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
  await test('No abandonment log for a local-parse review (pendingTraceId never set)', () => {
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

})().then(() => {
// ══════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(50));
console.log(`Frontend: ${testsPassed}/${testsRun} passed`);
if (failures.length) { console.log('FAILURES:', JSON.stringify(failures, null, 2)); process.exitCode = 1; }
});

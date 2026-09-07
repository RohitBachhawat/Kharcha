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
    Date, JSON, Math, String, parseInt, parseFloat, isNaN, Array, Object, Function, RegExp,
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
  await test('The request is sent with mode:no-cors — it never depends on reading a response back', () => {
    const call = fetchCalls.find(c => c.body && c.body.action === 'addWithPhoto');
    assert.strictEqual(call.opts.mode, 'no-cors');
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
section('6. confirmAndSave() — validation still blocks bad input');
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

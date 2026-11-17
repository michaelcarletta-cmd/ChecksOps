/**
 * Mortgage Desk request panel (owner 2026-11-17: "Mortgage Desk is having issues constantly reloading the side panel").
 *
 * Cause: MortgageOpsRequestDetail's load() set loading on every call, and the panel renders its spinner in place of the
 * whole request while loading. load() runs on a 12 s timer on AWS (useAwsPollingFallback), on every new message and
 * after every action, so the panel was replaced by a spinner every 12 seconds: the scroll position and anything being
 * typed in it were thrown away each time.
 *
 * Fix: only the first load of a request shows the spinner; a refresh keeps the content and a failed refresh is silent.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isFirstPanelLoad, showPanelSpinner } from '../../src/lib/mortgageDeskPanelLoad.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

test('only the first load of a request counts as a first load; a refresh of the request on screen does not', () => {
  assert.equal(isFirstPanelLoad(null, A), true);
  assert.equal(isFirstPanelLoad(A, A), false);
  // Another request was on screen: the new one is a first load.
  assert.equal(isFirstPanelLoad(B, A), true);
  // No request asked for: nothing to load.
  assert.equal(isFirstPanelLoad(null, null), false);
  assert.equal(isFirstPanelLoad(A, null), false);
});

test('the spinner shows while a first load runs or before any request is loaded, never over a request already on screen', () => {
  // Opening: nothing loaded yet.
  assert.equal(showPanelSpinner({ loading: true, loadedRequestId: null, requestId: A }), true);
  assert.equal(showPanelSpinner({ loading: false, loadedRequestId: null, requestId: A }), true);
  // Loaded: the request shows, and stays through every background refresh (loading is not set by a refresh).
  assert.equal(showPanelSpinner({ loading: false, loadedRequestId: A, requestId: A }), false);
  // Switched to another request: never the previous request's data.
  assert.equal(showPanelSpinner({ loading: false, loadedRequestId: B, requestId: A }), true);
  assert.equal(showPanelSpinner({ loading: true, loadedRequestId: B, requestId: A }), true);
  // Closing: the panel keeps the request it shows until it is gone.
  assert.equal(showPanelSpinner({ loading: false, loadedRequestId: A, requestId: null }), false);
});

test('the panel wires it: loading is set and cleared only by a first load, a failed refresh is silent, and the timer still refreshes', () => {
  const page = read('src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx');
  assert.match(page, /import \{ isFirstPanelLoad, showPanelSpinner \} from "@\/lib\/mortgageDeskPanelLoad";/);
  assert.match(page, /const shownRequestId = useRef<string \| null>\(null\);/);
  assert.match(page, /const firstLoad = isFirstPanelLoad\(shownRequestId\.current, requestId\);\n\s+if \(firstLoad\) setLoading\(true\);/);
  // The request on screen is recorded as soon as it is read, for this request only.
  assert.match(page, /setReq\(r as RequestRow\);\n\s+shownRequestId\.current = requestId;/);
  assert.match(page, /if \(firstLoad\) toast\.error\(e\?\.message \|\| "Failed to load request"\);/);
  assert.match(page, /finally \{\n\s+if \(firstLoad\) setLoading\(false\);/);
  // No unconditional setLoading left in the panel.
  assert.deepEqual(page.match(/^\s*setLoading\((true|false)\);/gm), null);
  assert.match(page, /\{showPanelSpinner\(\{ loading, loadedRequestId: req\?\.id \?\? null, requestId \}\) \|\| !req \? \(/);
  assert.doesNotMatch(page, /\{loading \|\| !req \? \(/);
  // The refreshes themselves are unchanged: the 12 s timer, new messages, and the queue's own 15 s timer.
  assert.match(page, /useAwsPollingFallback\(!!open && !!check\?\.id, load, 12_000\);/);
  assert.match(read('src/pages/mortgage-ops/MortgageOpsQueue.tsx'), /useAwsPollingFallback\(!!user, fetchQueues, 15_000\);/);
});

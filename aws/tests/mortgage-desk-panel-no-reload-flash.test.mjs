/**
 * Mortgage Desk request panel (owner 2026-11-17: "Mortgage Desk is having issues constantly reloading the side panel").
 *
 * Cause: MortgageOpsRequestDetail's load() set loading on every call, and the panel renders its spinner in place of the
 * whole request while loading. load() runs on a 12 s timer on AWS (useAwsPollingFallback), on every new message and
 * after every action, so the panel was replaced by a spinner every 12 seconds: the scroll position and anything being
 * typed in it were thrown away each time.
 *
 * Fix: only the first load of a request shows the spinner; a refresh keeps the content and a failed refresh is silent.
 *
 * Second report (owner 2026-11-17, after that fix went live: "Mortgage Desk panel still reloading"). Watched in a browser
 * against a fake Desk API (40 s, three refreshes), the live panel on every refresh: redrew both check images through
 * "Loading…" (the API signs a new 60-second URL on every read), took the check card off the screen and put it back (the
 * check was set to none before the Desk API's copy arrived), did the same to the agent notes and the shared library
 * (emptied, then refilled), and overwrote the invoice, mail-to and shipping fields, wiping a typed tracking number.
 * With this fix the same watch shows none of it: 0 image reloads, 0 removed sections, the typed text still there.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isFirstPanelLoad, showPanelSpinner, stablePanelImages } from '../../src/lib/mortgageDeskPanelLoad.ts';

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
  assert.match(page, /import \{ isFirstPanelLoad, showPanelSpinner, stablePanelImages, type PanelCheckImages \} from "@\/lib\/mortgageDeskPanelLoad";/);
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

const SIGNED = (name, sig) => `https://files.example.invalid/checks/k1/${name}.jpg?X-Amz-Signature=${sig}&X-Amz-Expires=60`;

test('a new signature for a check image already drawn keeps the URL on screen; a different, first or failed image takes the fresh one', () => {
  const shown = { front: SIGNED('front', 'aaa'), back: SIGNED('back', 'bbb') };
  // The refresh: same two images, newly signed. Nothing changes, and it is the very same object (no re-render of images).
  const same = stablePanelImages(shown, { front: SIGNED('front', 'ccc'), back: SIGNED('back', 'ddd') });
  assert.equal(same, shown);
  // A replaced front image (another object) takes the fresh URL; the back keeps its own.
  const replaced = stablePanelImages(shown, { front: SIGNED('front-v2', 'eee'), back: SIGNED('back', 'fff') });
  assert.deepEqual(replaced, { front: SIGNED('front-v2', 'eee'), back: shown.back });
  // An image that failed to draw takes the fresh URL so it is tried again.
  assert.deepEqual(stablePanelImages(shown, { front: SIGNED('front', 'ggg'), back: SIGNED('back', 'hhh') }, { front: true }),
    { front: SIGNED('front', 'ggg'), back: shown.back });
  // First images, and a side the server no longer returns.
  assert.deepEqual(stablePanelImages({}, { front: SIGNED('front', 'iii') }), { front: SIGNED('front', 'iii') });
  assert.deepEqual(stablePanelImages(shown, { front: SIGNED('front', 'jjj') }), { front: shown.front });
  assert.deepEqual(stablePanelImages(shown, {}), {});
  // A fragment or no query at all compares by the object too.
  assert.equal(stablePanelImages({ front: '/a/b.jpg' }, { front: '/a/b.jpg?x=1#y' }).front, '/a/b.jpg');
});

test('a refresh no longer blinks the check card, the images, the agent notes or the shared library, and never overwrites what is being typed', () => {
  const page = read('src/pages/mortgage-ops/MortgageOpsRequestDetail.tsx');
  // The invoice, mail-to and shipping fields are filled from the saved values on the first load of a request only.
  const hydrate = page.slice(page.indexOf('if (firstLoad) {\n        const rr = r as any;'), page.indexOf('let freshImages: PanelCheckImages = {};'));
  for (const setter of ['setInvoiceServices', 'setInvoiceShipping', 'setInvoiceShippingDesc', 'setInvoiceRecipient', 'setInvoiceNotes',
    'setMailToName', 'setMailToAddress', 'setShipCarrier', 'setShipTracking']) {
    assert.equal(hydrate.split(`${setter}(`).length - 1, 1, setter);
    // ... and nowhere else inside load().
    const load = page.slice(page.indexOf('const load = useCallback(async () => {'), page.indexOf('}, [requestId, user?.id, user?.email]);'));
    assert.equal(load.split(`${setter}(`).length - 1, 1, setter);
  }
  const load = page.slice(page.indexOf('const load = useCallback(async () => {'), page.indexOf('}, [requestId, user?.id, user?.email]);'));
  // The check is set once per load, never to "none" while the Desk API's copy is still on its way.
  assert.equal(load.split('setCheck(').length - 1, 1);
  assert.match(load, /let nextCheck: CheckRow \| null = \(cRes\.data as CheckRow\) \|\| null;/);
  assert.match(load, /if \(!cRes\.data\) nextCheck = deskCheckToRow\(ws\.check, r\.tenant_id\);/);
  // The images are set once per load, through stablePanelImages on a refresh; never cleared in between.
  assert.equal(load.split('setImages(').length - 1, 1);
  assert.match(load, /setImages\(\(shown\) => \(firstLoad \? freshImages : stablePanelImages\(shown, freshImages, failed\)\)\);/);
  assert.doesNotMatch(load, /setImages\(\{\}\)/);
  // The agent notes and the shared library are not emptied before they are read again.
  assert.doesNotMatch(load, /setSharedLibrary\(null\);\n\s+if \(mortgageUsesAwsBackend/);
  assert.doesNotMatch(load, /setAgentNotes\(\[\]\);\n\s+if \(mortgageUsesAwsBackend/);
  assert.match(load, /if \(shared\) setSharedLibrary\(groupSharedLibraryDocuments\(shared\)\);\n\s+else if \(firstLoad\) setSharedLibrary\(null\);/);
  assert.match(load, /if \(notes\) setAgentNotes\(notes\);\n\s+else if \(firstLoad\) setAgentNotes\(\[\]\);/);
  // A workspace error is shown once, not on every refresh.
  assert.match(load, /if \(wsErr && firstLoad\) toast\.error\(wsErr\);/);
  // A check image that fails to draw is retried with the next refresh's URL.
  const image = read('src/components/mortgage-ops/VoidStampedCheckImage.tsx');
  assert.match(image, /export function VoidStampedCheckImage\(\{ src, label, onError \}: \{ src: string; label: string; onError\?: \(\) => void \}\)/);
  assert.match(image, /setState\("error"\);\n\s+\/\/ The panel then takes a freshly signed URL for this image on its next refresh\.\n\s+onError\?\.\(\);/);
  assert.match(image, /\}, \[src\]\);/);
});


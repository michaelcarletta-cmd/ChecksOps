// Smooth transitions on the Checks page (owner 2026-11-18: "When clicking Status Tabs such as Review,
// Endorsing, Ready for Deposit, ... it feels like the page is jumping"; "When we click a check, I want
// it to expand right side of the screen ... right now it seems to jump out quickly"; "nice smooth
// transitions and animations on every page and tab"). Website rules stay under html:not(.native-app).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  NATIVE_PANEL_TIMING, NATIVE_SECTION_ENTER, playPanelEntrance, playSectionEntrance, WEB_PANEL_OPEN_TIMING, WEB_PANEL_TIMING,
  WEB_SECTION_ENTER, WEB_SECTION_TIMING,
} from '../../src/lib/nativeApp.ts';
import { preloadWhenIdle } from '../../src/lib/preloadWhenIdle.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PAGE = read('src/pages/CheckCommandCenter.tsx');
const CSS = read('src/index.css');
const webBlock = () => CSS.slice(CSS.indexOf('/* ── Website only'), CSS.indexOf('/* ── iOS / Android app only'));

function fakeDoc(count) {
  const played = [];
  const els = Array.from({ length: count }, () => ({ animate: (k, t) => played.push({ k, t }) }));
  return { played, querySelectorAll: () => els };
}

test('a status tab\'s section settles in on the website and in the app; nothing with reduced motion', () => {
  const web = fakeDoc(1);
  assert.equal(playSectionEntrance('[data-lane-section]', web, {}), 1);
  assert.equal(web.played[0].k, WEB_SECTION_ENTER);
  assert.equal(web.played[0].t, WEB_SECTION_TIMING);
  assert.ok(WEB_SECTION_TIMING.duration >= 180 && WEB_SECTION_TIMING.duration <= 260);
  for (const frame of WEB_SECTION_ENTER) assert.equal(frame.transform, undefined, 'translate, never transform');
  const app = fakeDoc(1);
  assert.equal(playSectionEntrance('[data-lane-section]', app, { Capacitor: { isNativePlatform: () => true } }), 1);
  assert.equal(app.played[0].k, NATIVE_SECTION_ENTER);
  assert.equal(playSectionEntrance('[data-lane-section]', fakeDoc(1), { matchMedia: () => ({ matches: true }) }), 0);
  assert.equal(playSectionEntrance('[data-lane-section]', undefined, {}), 0);
});

test('the Checks page plays the section entrance on a tab change, on one wrapper that stays mounted', () => {
  assert.match(PAGE, /<div data-lane-section="">/);
  assert.equal(PAGE.match(/data-lane-section/g).length, 2, 'the wrapper and the selector that animates it');
  assert.match(PAGE, /useLayoutEffect\(\(\) => \{\s*if \(shownTabRef\.current === activeTab\) return;\s*shownTabRef\.current = activeTab;\s*playSectionEntrance\("\[data-lane-section\]"\);/);
  // The wrapper is not keyed: picking a tab must not remount every list.
  assert.doesNotMatch(PAGE, /<div key=\{activeTab\}/);
});

test('the check panel entrance plays before paint; opening waits for the column, switching does not', () => {
  assert.match(PAGE, /useLayoutEffect\(\(\) => \{\s*const current = selectedCheck \?\? reviewCheckId;\s*const opening = shownPanelRef\.current === null;[\s\S]{0,120}playPanelEntrance\("\.check-detail-panel", undefined, undefined, opening\);/);
  assert.doesNotMatch(PAGE, /requestAnimationFrame\(\(\) => play(Panel|Section)Entrance/);
  const opened = fakeDoc(1);
  assert.equal(playPanelEntrance('.check-detail-panel', opened, {}, true), 1);
  assert.equal(opened.played[0].t, WEB_PANEL_OPEN_TIMING);
  assert.equal(WEB_PANEL_OPEN_TIMING.fill, 'backwards', 'hidden during the delay, nothing left behind after');
  assert.ok(WEB_PANEL_OPEN_TIMING.delay > 0 && WEB_PANEL_OPEN_TIMING.delay <= 120);
  const switched = fakeDoc(1);
  playPanelEntrance('.check-detail-panel', switched, {}, false);
  assert.equal(switched.played[0].t, WEB_PANEL_TIMING);
  const app = fakeDoc(1);
  playPanelEntrance('.check-detail-panel', app, { Capacitor: { isNativePlatform: () => true } }, true);
  assert.equal(app.played[0].t, NATIVE_PANEL_TIMING, 'the app keeps its own panel timing');
});

test('every check panel column eases its width; panels that open from nothing grow from the right', () => {
  assert.equal(PAGE.match(/split-column split-panel-grow/g).length, 3, 'Funds Released, Outstanding, Funds Received');
  // Main lanes: the panel column is the element the check entrance plays on, once a check is open.
  assert.match(PAGE, /className=\{`split-column \$\{selectedCheck \? "check-detail-panel " : ""\}transition-all/);
  const block = webBlock();
  assert.match(block, /@media \(min-width: 768px\) \{\s*html:not\(\.native-app\) \.split-column \{\s*transition: width 320ms/);
  assert.match(block, /html:not\(\.native-app\) \.split-panel-grow \{\s*animation: web-panel-grow 320ms [^;]*backwards;/);
  assert.match(block, /@keyframes web-panel-grow \{\s*from \{ width: 0; \}\s*\}/);
});

test('the check panel keeps its shape while loading and the check fades in over it', () => {
  assert.doesNotMatch(PAGE, /if \(!check\) return null;/);
  assert.match(PAGE, /if \(!check\) \{\s*loadedAfterSkeletonRef\.current = true;\s*return <CheckDetailPanelSkeleton \/>;/);
  assert.match(PAGE, /<Card className=\{`check-panel-skeleton\$\{bare \? " border-0 shadow-none" : ""\}`\} aria-busy="true" aria-label="Loading check">/);
  assert.match(PAGE, /data-check-settle=\{loadedAfterSkeletonRef\.current \? "" : undefined\}/);
  assert.match(webBlock(), /html:not\(\.native-app\) \[data-check-settle\],\s*html:not\(\.native-app\) \[data-check-arrive\] \{\s*animation: web-enter 200ms [^;]*backwards;/);
});

test('workspace pages slide in on the website too, and a page-shell inside one does not move twice', () => {
  const block = webBlock();
  assert.match(block, /html:not\(\.native-app\) \.route-page \{\s*overflow-x: clip;\s*animation: web-page-in 220ms/);
  assert.match(block, /html:not\(\.native-app\) \.route-page \.page-shell \{\s*animation: none;/);
  assert.match(read('src/pages/WhiteLabelApp.tsx'), /<div key=\{location\.pathname\} className="route-page">/);
});

test('the picked status tile is marked for screen readers and styling', () => {
  assert.match(PAGE, /data-status-tile=""\s*data-active=\{isActive \? "true" : "false"\}\s*aria-pressed=\{isActive\}/);
  assert.match(webBlock(), /html:not\(\.native-app\) \[data-status-tile\]\[data-active="true"\] \{/);
});

test('every lazy section is preloaded in the background once the page is idle', () => {
  const lazies = [...PAGE.matchAll(/^const (\w+) = lazy\((load\w+)\);$/gm)];
  assert.equal(lazies.length, 18);
  for (const [, name, loader] of lazies) assert.equal(loader, `load${name}`);
  const list = PAGE.slice(PAGE.indexOf('const SECTION_LOADERS'), PAGE.indexOf('];', PAGE.indexOf('const SECTION_LOADERS')));
  for (const [, , loader] of lazies) assert.ok(list.includes(loader), loader);
  assert.doesNotMatch(PAGE.slice(0, PAGE.indexOf('const TabLoader')), /lazy\(\(\) =>/);
  assert.match(PAGE, /useEffect\(\(\) => preloadWhenIdle\(SECTION_LOADERS\), \[\]\);/);
});

test('preloadWhenIdle: one at a time, on idle, failures ignored, stops when cleaned up', async () => {
  const queue = [];
  const win = { requestIdleCallback: (fn) => { queue.push(fn); return queue.length; }, cancelIdleCallback: () => {} };
  const calls = [];
  const loader = (n, fail = false) => () => { calls.push(n); return fail ? Promise.reject(new Error('offline')) : Promise.resolve(); };
  const stop = preloadWhenIdle([loader(1), loader(2, true), loader(3)], win);
  assert.deepEqual(calls, [], 'nothing before the browser is idle');
  const drain = async () => { while (queue.length) { queue.shift()(); await new Promise((r) => setTimeout(r, 0)); } };
  await drain();
  assert.deepEqual(calls, [1, 2, 3], 'in order, and a failure does not stop the rest');
  const calls2 = [];
  const q2 = [];
  const win2 = { requestIdleCallback: (fn) => { q2.push(fn); return 1; }, cancelIdleCallback: () => { q2.length = 0; } };
  const stop2 = preloadWhenIdle([() => { calls2.push(1); return Promise.resolve(); }], win2);
  stop2();
  while (q2.length) q2.shift()();
  assert.deepEqual(calls2, [], 'a cleaned-up queue loads nothing');
  // Without requestIdleCallback it falls back to a timer.
  let timed = 0;
  preloadWhenIdle([() => Promise.resolve()], { setTimeout: (fn, ms) => { timed = ms; return 7; }, clearTimeout: () => {} });
  assert.equal(timed, 1500);
  assert.equal(typeof stop, 'function');
  assert.deepEqual(preloadWhenIdle([], undefined)(), undefined);
});

test('the check panel opens with its loading shape and builds the check once the column is wide', () => {
  // Owner 2026-11-18, after the first deploy: "once a check is selected the side bar jumps out fast".
  // With the processor slowed 4x, building the panel during the opening froze the page ~280ms and
  // the widening landed in 4 jumps; built after it, the column widens in 12-16 even frames.
  assert.match(PAGE, /const PANEL_OPEN_MS = 320;/);
  assert.match(CSS, /\.split-column \{\s*transition: width 320ms/, 'the wait matches the widening');
  assert.match(PAGE, /function BuildAfterOpening\(\{ children, bare = false \}/);
  assert.match(PAGE, /if \(!built\) return <CheckDetailPanelSkeleton bare=\{bare\} \/>;\s*return <div data-check-arrive="">\{children\}<\/div>;/);
  assert.match(PAGE, /prefers-reduced-motion: reduce\)"\)\.matches === true/, 'reduced motion builds at once');
  // Every place a check panel opens: four CheckDetailPanels and the Review & Decision panel.
  assert.equal(PAGE.match(/<BuildAfterOpening>\s*<CheckDetailPanel\n/g).length, 4);
  assert.equal(PAGE.match(/<CheckDetailPanel\n/g).length, 4);
  assert.match(PAGE, /<BuildAfterOpening bare>\s*<Tabs defaultValue="review" onValueChange=\{scrollReviewPanelToTop\}>/);
  assert.match(webBlock(), /html:not\(\.native-app\) \[data-check-settle\],\s*html:not\(\.native-app\) \[data-check-arrive\] \{\s*animation: web-enter/);
});

test('the Review queue skips laying out rows off screen while its column narrows', () => {
  assert.match(read('src/components/check-review/CheckReviewConsole.tsx'), /selected=\{selectedCheckId === check\.id\}\s*className="review-queue-row"/);
  assert.match(webBlock(), /@media \(min-width: 768px\) \{[\s\S]*?html:not\(\.native-app\) \.review-queue-row \{\s*content-visibility: auto;\s*contain-intrinsic-size: auto 129px;/);
});

// Messages: clicking a conversation opens it over the whole screen (app and website), with a Back
// button to all messages. The open conversation is in the URL (?thread=<check id>), so the browser's
// and Android's back also return to the list.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { closeThreadParams, MESSAGE_THREAD_PARAM, openThreadParams } from '../../src/lib/messageThreadRoute.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PANEL = 'src/components/check-messages/CheckMessagesPanel.tsx';

test('opening and closing a conversation only touches ?thread=, never the tab or filters', () => {
  assert.equal(MESSAGE_THREAD_PARAM, 'thread');
  const prev = new URLSearchParams('tab=messages&q=smith');
  const opened = openThreadParams(prev, 'check-1');
  assert.equal(opened.toString(), 'tab=messages&q=smith&thread=check-1');
  assert.equal(prev.toString(), 'tab=messages&q=smith', 'the previous params are not mutated');
  assert.equal(closeThreadParams(opened).toString(), 'tab=messages&q=smith');
  assert.equal(closeThreadParams(new URLSearchParams('tab=messages')).toString(), 'tab=messages');
});

test('the list is the whole Messages view; nothing opens until a conversation is clicked', () => {
  const src = read(PANEL);
  assert.doesNotMatch(src, /lg:grid-cols-\[360px_1fr\]/, 'no side-by-side list and thread');
  assert.doesNotMatch(src, /\?\? rows\[0\]/, 'the first conversation no longer opens by itself');
  assert.match(src, /const selectedId = searchParams\.get\(MESSAGE_THREAD_PARAM\);/);
  assert.match(src, /onClick=\{\(\) => openThread\(r\.check_id\)\}/);
  assert.match(src, /\{ state: \{ messageThreadPushed: true \} \}/);
});

test('an open conversation fills the screen, with Back to all messages', () => {
  const src = read(PANEL);
  assert.match(src, /createPortal\(\s*<div\s+role="dialog"/);
  assert.match(src, /className="message-thread-screen fixed inset-0 z-50 flex max-w-none flex-col bg-background text-foreground"/);
  assert.match(src, /paddingTop: "var\(--app-safe-top, 0px\)", paddingBottom: "var\(--app-safe-bottom, 0px\)"/);
  assert.match(src, /<Button variant="ghost" size="sm" onClick=\{closeThread\}[^>]*>\s*<ArrowLeft className="h-4 w-4" \/> All messages\s*<\/Button>/);
  // Back pops the history entry the click pushed; a deep link (no entry to pop) removes the param.
  assert.match(src, /messageThreadPushed\) navigate\(-1\);\s*else setSearchParams\(\(prev\) => closeThreadParams\(prev\), \{ replace: true \}\);/);
  assert.match(src, /if \(e\.key === "Escape"\) closeThread\(\);/);
  assert.match(src, /document\.body\.style\.overflow = "hidden";/);
  // Open check file leaves the conversation first, so returning to Messages shows the list.
  assert.match(src, /setSearchParams\(\(prev\) => closeThreadParams\(prev\), \{ replace: true \}\);\s*onOpenCheck\(checkId\);/);
});

test('the conversation screen slides in from the right: the app\'s push, a lighter one on the website', () => {
  const css = read('src/index.css');
  const web = css.slice(css.indexOf('/* ── Website only'), css.indexOf('/* ── iOS / Android app only'));
  const app = css.slice(css.indexOf('/* ── iOS / Android app only'));
  assert.match(web, /html:not\(\.native-app\) \.message-thread-screen \{\s*animation: web-page-in 220ms [^;]* backwards;/);
  assert.match(app, /html\.native-app \.message-thread-screen \{\s*animation: native-thread-in 240ms [^;]* backwards;/);
  assert.match(app, /@keyframes native-thread-in \{\s*from \{ opacity: 0; translate: 24px 0; \}/);
  // The website's slide stays the lighter one: a shorter distance, and no longer a duration.
  const px = (src, name) => Number(src.match(new RegExp(`@keyframes ${name} \\{\\s*from \\{ opacity: 0; translate: (\\d+)px 0;`))[1]);
  const ms = (src, sel) => Number(src.match(new RegExp(`${sel} \\{\\s*animation: [\\w-]+ (\\d+)ms`))[1]);
  assert.ok(px(web, 'web-page-in') < px(app, 'native-thread-in'));
  assert.ok(ms(web, 'html:not\\(\\.native-app\\) \\.message-thread-screen') <= ms(app, 'html\\.native-app \\.message-thread-screen'));
});

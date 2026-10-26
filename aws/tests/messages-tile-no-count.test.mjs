import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const page = fs.readFileSync(path.join(ROOT, 'src/pages/CheckCommandCenter.tsx'), 'utf8');

test('the Messages status tile shows no message count and no longer polls the unread total', () => {
  const tile = page.match(/\{ key: "messages",[^\n]*\}/);
  assert.ok(tile, 'Messages tile exists');
  assert.match(tile[0], /count: null as number \| null/);
  assert.doesNotMatch(page, /totalUnreadMessages/);
  assert.doesNotMatch(page, /get_total_unread_check_messages/);
  // Per-thread unread badges in the Messages tab are unchanged.
  const panel = fs.readFileSync(path.join(ROOT, 'src/components/check-messages/CheckMessagesPanel.tsx'), 'utf8');
  assert.match(panel, /unread/i);
});

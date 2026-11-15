/**
 * Owner 2026-11-15 (website only): "For loss draft, move these buttons out of the way or in a drop down. Only keep
 * share here." In the loss draft panel only Share stays in view; View Check Images, Replace Front, Replace Back and
 * Delete Check sit behind a "More" toggle (an in-place panel, so each button keeps its own dialog or file picker).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const src = fs.readFileSync(path.join(ROOT, 'src/components/loss-draft/LossDraftDetailPanel.tsx'), 'utf8');

test('loss draft panel: Share stays in view and the other check actions sit behind More', () => {
  const row = src.slice(src.indexOf('{draft.check_intake_item_id && ('), src.indexOf('<SendToMortgageDeskButton'));
  const share = row.indexOf('onClick={() => setShareDialogOpen(true)}');
  const more = row.indexOf('onClick={() => setCheckActionsOpen((open) => !open)}');
  const panel = row.indexOf('{checkActionsOpen && (');
  assert.ok(share > 0 && more > share && panel > more, 'Share, then More, then the collapsible panel');
  for (const action of ['<ViewCheckImageButton', 'side="front"', 'side="back"', '<AdminDeleteCheckButton']) {
    const at = row.indexOf(action);
    assert.ok(at > panel, `${action} is inside the More panel`);
  }
  assert.match(src, /const \[checkActionsOpen, setCheckActionsOpen\] = useState\(false\);/, 'More starts closed');
  assert.match(row, /aria-expanded=\{checkActionsOpen\}/);
  assert.match(row, /<MoreHorizontal className="h-3 w-3" \/> More/);
});

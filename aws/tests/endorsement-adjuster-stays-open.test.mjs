import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Adjust Received Endorsement: generating the deposit image writes back_image_deposit_path, and the
// check's live update refetches the check. The adjuster's source image must not be keyed on that
// column, or the image is re-resolved, the adjuster unmounts and the generated preview (step 3,
// Approve Deposit Image) is lost before it can be approved.
test('the adjuster source image is keyed on the clean original only and keeps its data while a key resolves', () => {
  const src = readFileSync('src/pages/CheckCommandCenter.tsx', 'utf8');
  const key = src.match(/queryKey: \["check-back-img-original-for-adjuster"[^\]]*\]/);
  assert.ok(key, 'adjuster query key present');
  assert.doesNotMatch(key[0], /back_image_deposit_path/);
  assert.match(key[0], /check\?\.id, check\?\.back_image_path, \(check as any\)\?\.back_image_original_path\]$/);
  const block = src.slice(src.indexOf(key[0]), src.indexOf('queryFn: async () => {', src.indexOf(key[0])));
  assert.match(block, /placeholderData: keepPreviousData,/);
  assert.match(src, /^import \{ keepPreviousData, useQuery, useQueryClient \} from "@tanstack\/react-query";$/m);
});

test('generating does not close the adjuster; only approve (or the user) does', () => {
  const adjuster = readFileSync('src/components/checks/EndorsementAdjuster.tsx', 'utf8');
  const generate = adjuster.slice(adjuster.indexOf('const handleGenerate = async'), adjuster.indexOf('const handleApprove = async'));
  assert.doesNotMatch(generate, /onClose\?\.\(|onClose\(/);
  assert.match(generate, /back_image_deposit_path: persist\.back_image_deposit_path/);
});

// Any server push (useLiveDataRefresh) refetches every active query. Refetching the adjuster's
// source returns a new signed URL for the same image; that used to reset the image dimensions,
// unmount the adjuster and drop the generated deposit image before Approve.
test('while the adjuster is open its source URL stays the same unless the clean original path changes', () => {
  const src = readFileSync('src/pages/CheckCommandCenter.tsx', 'utf8');
  assert.match(src, /if \(showEndorsementAdjuster && prev && prev\.path === next\.path\) return prev;/);
  assert.match(src, /const adjusterSource = pinnedAdjusterSource \?\? endorsementAdjusterImageSource \?\? null;/);
  assert.match(src, /: \(adjusterSource\?\.url \?\? null\);/);
  assert.doesNotMatch(src, /: \(endorsementAdjusterImageSource\?\.url \?\? null\);/);
  const retry = src.slice(src.indexOf('const retryEndorsementPrep = useCallback'), src.indexOf('}, [qc,', src.indexOf('const retryEndorsementPrep = useCallback')));
  assert.match(retry, /setPinnedAdjusterSource\(null\);/);
  const live = readFileSync('src/hooks/useLiveDataRefresh.ts', 'utf8');
  assert.match(live, /invalidateQueries\(\{ refetchType: "active" \}/, 'the live refresh still refetches every active query, which is why the pin is needed');
});

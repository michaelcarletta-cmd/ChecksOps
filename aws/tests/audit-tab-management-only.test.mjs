/**
 * Owner request 2026-11-04: the Audit tab is for management only. The platform owner sees it on a check
 * and a Loss Draft file, also when viewing a tenant; tenant users do not see the tab or its content.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const FILES = ['src/pages/CheckCommandCenter.tsx', 'src/components/loss-draft/LossDraftDetailPanel.tsx'];

for (const rel of FILES) {
  test(`${rel}: Audit tab and content render only for the platform owner`, () => {
    const src = read(rel);
    assert.match(src, /import \{ isPlatformOwner \} from "@\/lib\/masterMerchant";/);
    assert.match(src, /const showAuditTab = isPlatformOwner\(user\?\.email, user\?\.id\);/);
    const trigger = src.indexOf('<TabsTrigger value="audit"');
    const content = src.search(/<TabsContent\s+value="audit"/);
    assert.ok(trigger > 0 && content > 0, 'tab and content exist');
    // Each sits directly inside a {showAuditTab && ( ... )} guard.
    for (const at of [trigger, content]) {
      const before = src.slice(Math.max(0, at - 80), at);
      assert.match(before, /\{showAuditTab && \(\s*$/, `guarded at ${at}`);
    }
    assert.equal(src.split('value="audit"').length - 1, 2, 'one trigger and one content, both guarded');
  });
}

test('the platform owner check is the one other owner-only screens use', () => {
  const lib = read('src/lib/masterMerchant.ts');
  assert.match(lib, /export function isPlatformOwner\(/);
});

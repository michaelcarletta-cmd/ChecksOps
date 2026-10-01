/**
 * Delete Check production contract lock.
 *
 * Behavioral proof lives in aws/tests/api-workflow.test.mjs and
 * aws/tests/frontend-delete-check-bridge.test.mjs.
 *
 * This file is a thin contract test that pins the accepted capability markers
 * so future overlays cannot silently regress the Delete Check contract without
 * an intentional lock update.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  computeOwnershipHashes,
  loadJson,
  matchProtectedPath,
  validateReleaseLocks,
} from '../../../scripts/lib/release-locks.mjs';
import { loadReleaseLockInputs } from '../../../scripts/validate-release-locks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const DELETE_CHECK_FILES = Object.freeze([
  'aws/functions/api/workflow.mjs',
  'aws/tests/api-workflow.test.mjs',
  'aws/tests/frontend-admin-delete-check-dispatcher.test.mjs',
  'src/integrations/aws/deleteCheckBridge.ts',
  'src/integrations/aws/client.ts',
  'aws/tests/frontend-delete-check-bridge.test.mjs',
  'ops/release-locks/contracts/delete-check-contract.json',
  'ops/release-locks/proof/delete-check-production-acceptance-2026-09-26.md',
]);

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('delete-check-contract ownership group is narrowly scoped', () => {
  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const group = protectedPaths.ownership_groups['delete-check-contract'];
  assert.ok(group, 'delete-check-contract ownership group is required');
  assert.deepEqual([...group.paths].sort(), [...DELETE_CHECK_FILES].sort());

  const hashes = computeOwnershipHashes(ROOT, protectedPaths);
  assert.deepEqual(hashes.groups['delete-check-contract'].files, [...DELETE_CHECK_FILES].sort());
  assert.equal(hashes.groups['delete-check-contract'].missing.length, 0);

  for (const rel of DELETE_CHECK_FILES) {
    const matches = matchProtectedPath(rel, protectedPaths);
    assert.ok(
      matches.some((row) => row.groupId === 'delete-check-contract'),
      `${rel} must belong to delete-check-contract`,
    );
  }
});

test('delete-check-contract manifest component exists and pins the protected tree hash', () => {
  const manifest = loadJson(path.join(ROOT, 'ops/release-locks/locked-components.json'));
  const component = manifest.components['delete-check-contract'];
  assert.ok(component, 'delete-check-contract manifest component is required');
  assert.equal(component.id, 'delete-check-contract');
  assert.equal(component.ownership_group, 'delete-check-contract');
  assert.equal(component.classification, 'UNVERIFIED');
  assert.equal(component.production_active, false);
  assert.equal(component.environment, 'production');
  assert.equal(component.source.git_sha, 'f5d616431642ce5938827379c9221c822fea5bf3');
  assert.equal(component.source.merged, false);
  assert.equal(component.source.merged_pr, 501);
  assert.ok(Array.isArray(component.required_sql));
  assert.equal(component.required_sql.length, 0);
  assert.ok(
    (component.production_validation?.evidence_refs || [])
      .includes('ops/release-locks/proof/delete-check-production-acceptance-2026-09-26.md'),
  );

  const protectedPaths = loadJson(path.join(ROOT, 'ops/release-locks/protected-paths.json'));
  const hashes = computeOwnershipHashes(ROOT, protectedPaths);
  assert.equal(component.source.tree_hash, hashes.groups['delete-check-contract'].tree_hash);
});

test('delete-check-contract records accepted production provenance', () => {
  const contract = loadJson(path.join(ROOT, 'ops/release-locks/contracts/delete-check-contract.json'));
  assert.equal(contract.version, 1);
  assert.equal(contract.environment, 'production-prep');
  assert.equal(contract.lambda.function_name, 'checksops-production-prep-api');
  assert.equal(contract.lambda.accepted_code_sha256_base64, 'Hhij5GWW/GDBcRE+4wYomml96R+6IWwFJPczbz5YLZM=');
  assert.equal(contract.lambda.accepted_git_sha, 'f5d616431642ce5938827379c9221c822fea5bf3');
  assert.equal(contract.files.workflow_mjs.sha256_hex, '46747e79d9de56c754fe5342631d749ae335cf053c6c05c0f8e053c6424e4f81');
  assert.ok(Array.isArray(contract.invariants));
  assert.ok(contract.invariants.includes('bridge_forwards_trimmed_reason'));
  assert.ok(contract.invariants.includes('claim_linkage_not_blocker'));
});

test('Delete Check capability markers remain intact (workflow + bridge)', () => {
  const workflow = read('aws/functions/api/workflow.mjs');
  const bridge = read('src/integrations/aws/deleteCheckBridge.ts');
  const client = read('src/integrations/aws/client.ts');
  const workflowTests = read('aws/tests/api-workflow.test.mjs');
  const bridgeTests = read('aws/tests/frontend-delete-check-bridge.test.mjs');
  const dispatcherTests = read('aws/tests/frontend-admin-delete-check-dispatcher.test.mjs');

  // 1. Admin-only.
  assert.match(workflow, /Only admins can delete checks/);
  assert.match(workflow, /error:\s*'not_authorized'/);
  assert.match(workflow, /platformRolesOf\(/);
  assert.match(workflow, /roles\.has\('admin'\)/);
  assert.match(workflowTests, /test\('non-admin cannot delete check'/);

  // 2. Reason required, min 3 trimmed characters.
  assert.match(workflow, /const reason = clip\(body\.reason \|\| body\.p_reason \|\| body\.delete_reason, 2000\);/);
  assert.match(workflow, /error:\s*'missing_required_field'[\s\S]{0,120}min 3 characters/);
  assert.match(workflowTests, /reason:\s*'x'/);
  assert.match(workflowTests, /assert\.equal\(missingReason\.error, 'missing_required_field'\)/);

  // 3. Claim linkage alone is not a blocker (unit test asserts delete ok even with claim_id).
  assert.match(workflowTests, /test\('workflow delete allows claim-linked checks but denies partner-linked and deposited checks'/);
  assert.match(workflowTests, /claim_id:\s*'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'/);
  assert.match(workflowTests, /assert\.equal\(claimLinked\.data\.deleted, true\)/);

  // 4–6. Partner/shared, terminal financial, and dependent financial/provider activity are blocked with specific codes.
  assert.match(workflow, /error:\s*'check_shared_with_partner'/);
  assert.match(workflow, /error:\s*'check_terminal_financial_state'/);
  assert.match(workflow, /error:\s*'check_has_financial_activity'/);
  assert.match(workflow, /blocker:\s*blocker\.table/);
  assert.match(workflow, /table:\s*'claim_payments'/);
  assert.match(workflowTests, /assert\.equal\(partnerLinked\.error, 'check_shared_with_partner'\)/);
  assert.match(workflowTests, /assert\.equal\(deposited\.error, 'check_terminal_financial_state'\)/);
  assert.match(workflowTests, /assert\.equal\(result\.error, 'check_has_financial_activity'\)/);

  // 7. Tenant/RLS enforcement: handler must surface rls_denied when delete returns no rows.
  assert.match(workflow, /error:\s*'rls_denied'/);

  // 8. Non-financial dependent cleanup retry path exists (claim_checks/loss_draft_tracking) with SECURITY DEFINER fallback.
  assert.match(workflow, /SAVEPOINT delete_check_attempt/);
  assert.match(workflow, /error\?\.\s*code !== '23503'/);
  assert.match(workflow, /DELETE FROM public\.claim_checks WHERE check_intake_item_id/);
  assert.match(workflow, /UPDATE public\.loss_draft_tracking SET check_intake_item_id = NULL/);
  assert.match(workflow, /SELECT public\.admin_delete_check\(/);

  // 9–11. S3 cleanup is post-DB-delete and check-scoped only (never tenant-wide).
  assert.match(workflow, /After DB commit, attempt S3 deletion/);
  assert.match(workflow, /collectCheckOwnedStorageKeys\(/);
  assert.match(workflow, /checks\/\$\{checkIdText\}\//);
  assert.match(workflow, /checks\/reupload\/\$\{checkIdText\}\//);
  assert.match(workflow, /check-intake\/\$\{checkIdText\}\/files\//);
  assert.match(workflow, /isCheckScopedPathFor\(/);
  assert.match(workflowTests, /workflow delete performs S3 cleanup for check-owned keys/);

  // 12. Storage-cleanup failure is explicit and does not silently claim success.
  assert.match(workflow, /check_delete_storage_cleanup_failed/);
  assert.match(workflow, /result\.storageCleanup = \{\s*ok:\s*false/);
  assert.match(workflowTests, /workflow delete reports storage cleanup failure without rolling back DB delete/);

  // 13. Refusal/error codes remain specific (no generic "refusing to delete check" fallback).
  assert.match(workflow, /error:\s*'blocker_verification_denied'/);

  // 14. Frontend/RPC bridge forwards trimmed reason (and is tested).
  assert.match(bridge, /String\(reasonRaw\)\.trim\(\)/);
  assert.match(bridge, /if \(reason\.length\) body\.reason = reason;/);
  assert.match(bridgeTests, /bridge sends reason \+ actor_id[\s\S]{0,40}\(trimmed\)/);
  assert.match(bridgeTests, /assert\.equal\(body\.reason, "duplicate"\)/);

  // Dispatcher invariant: the actual runtime dispatch in client.ts must forward deleteBody (not {check_id} only).
  assert.match(client, /import \{ buildWorkflowDeleteCheckBody \} from "\.\/deleteCheckBridge";/);
  assert.match(client, /if \(name === "admin_delete_check"\) \{/);
  assert.match(client, /const \{ checkId, body: deleteBody \} = buildWorkflowDeleteCheckBody\(args\);/);
  assert.match(client, /body:\s*JSON\.stringify\(deleteBody\)/);
  assert.match(dispatcherTests, /dispatcher forwards delete body from shared helper/);
  assert.doesNotMatch(client, /JSON\.stringify\(\{\s*check_id\s*:\s*checkId\s*\}\)/);
});

test('delete-check lock introduces no new validator errors for this component', () => {
  const inputs = loadReleaseLockInputs(ROOT);
  const { errors } = validateReleaseLocks(inputs);
  const scoped = errors.filter((row) => /delete-check-contract|deleteCheckBridge|handleDeleteCheck|delete-check-production-acceptance/i.test(row));
  assert.deepEqual(scoped, []);
  assert.equal(
    errors.some((row) => /components\.production-release: protected source tree changed/.test(row)),
    false,
    'production-release tree_hash must be updated with this control-plane change',
  );
});

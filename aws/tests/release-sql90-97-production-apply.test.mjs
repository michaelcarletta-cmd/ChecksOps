/**
 * Production apply tools for SQL 90 to SQL 97
 * (scripts/deployment-guard/sql9x-*-production-apply.mjs; lib release-sql-production-apply.mjs
 * and release-sql-production-cli.mjs), mirroring the SQL 29 / 30 / 88 / 89 tool tests:
 *
 *   - the committed pins are pending (authorization "pending", execute false, no pre-state,
 *     no staging acceptance; SQL 103's is applied and retired (execute false, applied
 *     recorded), and its locked-state checks run on an explicit pre-authorization copy), bound to the staging pins, the predecessors and the production
 *     RDS, and name the built tooling; the tools are inventoried and registered in the one-shot;
 *   - evaluate / precheck / apply refuse before connecting (no pre-state, no approval, the
 *     staging acceptance, execute false, the phrase, the single-use id, replay, binding);
 *   - the CLI refuses credential flags and arbitrary SQL, and never spends a receipt or
 *     connects on a refusal; a staging receipt cannot authorize production;
 *   - on PostgreSQL 16: --inspect is BEGIN READ ONLY ... ROLLBACK, prints no row data and
 *     changes nothing; execute-authorized copies apply once each as checksops_admin in the
 *     release order; the superuser login is refused; a file that changes anything outside
 *     its scope rolls back.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CODES } from '../../scripts/deployment-guard/lib/errors.mjs';
import { acquireLease } from '../../scripts/deployment-guard/lib/lease.mjs';
import { issueReceipt } from '../../scripts/deployment-guard/lib/receipt.mjs';
import { ONE_SHOT_TOOLS } from '../../scripts/deployment-guard/lib/production-sql-one-shot.mjs';
import { refuseUnguardedDeploy } from '../../scripts/deployment-guard/require-guard.mjs';
import { RELEASE_2026_10_17_PENDING_SQL_PINS as STAGING } from '../../scripts/deployment-guard/lib/sql-executor-auth.mjs';
import { RELEASE_SQL_KEYS, RELEASE_SQL_SPECS } from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import {
  RELEASE_PRODUCTION,
  evaluateReleaseProductionApply,
  executeReleaseProductionApply,
  inspectReleaseProduction,
  loadReleaseProductionPin,
  precheckReleaseProductionApply,
  readPinnedReleaseSql,
} from '../../scripts/deployment-guard/lib/release-sql-production-apply.mjs';
import { pgSkipReason, releaseFixture } from './helpers/release-sql-pg.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLIS = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, path.join(ROOT, RELEASE_PRODUCTION[key].cli)])));
const MAINS = Object.freeze(Object.fromEntries(await Promise.all(RELEASE_SQL_KEYS.map(async (key) => [key, (await import(CLIS[key])).main]))));
const COMMITTED = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, loadReleaseProductionPin(key, ROOT)])));
// SQL 106's production pin was execute-authorized (owner-approved pin change of 2026-10-21, #1120, on
// owner-accepted substitute staging evidence, checked in release-sql106-production-apply.test.mjs)
// until its record-and-retire change after its 2026-10-21 apply.
// SQL 97's production pin was execute-authorized (owner approved 2026-10-21, #1112, "Everything else
// should be pushed live no exceptions") until its record-and-retire change: its first pre-apply
// inspect of 2026-10-21 reported other_write_grants [checksops DELETE, checksops UPDATE] on
// financial_stepup_log, so it was not applied then; it was applied later on 2026-10-21, after SQL 106
// (its one-shot inspect then reported other_write_grants []). SQL 95's and
// SQL 99's production pins were (owner approved 2026-10-21) until their record-and-retire change
// after their 2026-10-21 applies (SQL 99's own checks are in release-sql98-100-production-apply.test.mjs).
// SQL 105's production pin was (owner approved 2026-10-20
// on owner-accepted substitute staging evidence, checked in release-sql105-production-apply.test.mjs)
// until its record-and-retire change after its 2026-10-20 apply. SQL 102's production pin was (owner approved 2026-10-19,
// #1078, on its guarded staging apply from the same pre-state) until its record-and-retire change
// after its 2026-10-20 apply. SQL 90's, SQL 91's, SQL 92's, SQL 93's, SQL 94's, SQL 96's,
// SQL 101's, SQL 103's and SQL 104's production pins were (owner approved 2026-10-19) until their record-and-retire changes
// after their 2026-10-19 applies: they record the apply in applied and are execute false again
// (SQL 101's, SQL 103's and SQL 104's own checks are in release-sql101-production-apply.test.mjs,
// release-sql103-production-apply.test.mjs and release-sql104-production-apply.test.mjs). Every other release pin is pending. The
// locked-state checks below run on an explicit pre-authorization copy of an applied pin.
// SQL 98's production pin was execute-authorized (owner approved 2026-10-19, owner-accepted
// substitute staging evidence) until its record-and-retire change after its 2026-10-19 apply; its
// own checks are in release-sql98-100-production-apply.test.mjs.
// SQL 108's production pin was execute-authorized (owner-approved pin change of 2026-10-21, #1132,
// "apply SQL 108 in production then ...", on its guarded staging apply from the same pre-state,
// checked in release-sql108-production-apply.test.mjs) until its record-and-retire change after its
// 2026-10-21 apply.
// SQL 109's production pin was execute-authorized (owner-approved pin change of 2026-10-21, #1143,
// "apply SQL 109 in production", on its guarded staging apply from the same pre-state, checked in
// release-sql109-production-apply.test.mjs) until its record-and-retire change after its 2026-10-21
// apply.
// SQL 110's production pin was execute-authorized (owner-approved pin change of 2026-10-22, #1167,
// "apply SQL 110 in production", on its guarded staging apply from the same pre-state, checked in
// release-sql110-production-apply.test.mjs) until its record-and-retire change after its 2026-10-22
// apply.
// SQL 111's production pin was execute-authorized (owner-approved pin change of 2026-10-23, #1177,
// "Run production", on its guarded staging apply from the same pre-state, checked in
// release-sql111-production-apply.test.mjs) until its record-and-retire change after its 2026-10-23
// apply.
// SQL 112's production pin was execute-authorized (owner-approved pin change of 2026-10-23, #1190,
// "applying SQL 112 for parity.", on its guarded staging apply from a different pre-state,
// owner-accepted as substitute evidence, checked in release-sql112-production-apply.test.mjs) until
// its record-and-retire change after its 2026-10-23 apply.
// SQL 113's production pin was execute-authorized (owner-approved pin change of 2026-10-23, #1208,
// "Approve SQL 113 for production", on its guarded staging apply from the same pre-state, checked in
// release-sql113-production-apply.test.mjs) until its record-and-retire change after its 2026-10-23
// apply.
const EXECUTE_AUTHORIZED = Object.freeze([]);
// SQL 95's and SQL 97's recorded production pre-states (read-only inspect of 2026-10-21, SSM
// 43cb1d1f, main 69dbe9b01) and their staging references: the guarded staging read-live runs of
// 2026-10-21 that report the intended state (their wave 4 apply runs are not recorded), accepted as
// substitute evidence from a different pre-state. Both are applied (2026-10-21) and retired.
const SQL95_SQL97_PINNED = Object.freeze({
  sql95: Object.freeze({ pre: '48535b69b1a2f9b1ad69584f677dae78c830a482f58b9380c881205f91d8e05f', reference: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39616185934', staging_read_live: '39121392809' }),
  sql97: Object.freeze({ pre: '56b1f63192df1147fbbdd0206226129aeea35467d13c8bf0c8bc399316d06079', reference: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39618586101', staging_read_live: '39121540941' }),
});
// SQL 102's recorded production pre-state (read-only inspect of 2026-10-19 after SQL 98,
// SSM 3ff30ee9, main 96fb17821): the same pre-state staging recorded before its apply.
const SQL102_PRODUCTION_PRE = 'd3b2cd30d9b06347c4a08febac3fce49732bd0babcacfeea0a2b49dbdc9cb752';
const SQL102_STAGING_REFERENCE = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39162625974';
// SQL 94's recorded production pre-state (read-only inspect of 2026-10-19 after SQL 29 / SQL 90 / SQL 103,
// SSM 70abaca3, main fecb0b3af): the same pre-state staging recorded before its apply.
const SQL94_PRODUCTION_PRE = '724115983687d882d8240e8d06e4670bc6e24dbb16540d3134cc1ccc47d66af1';
const SQL94_STAGING_REFERENCE = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39082817752';
// SQL 96's recorded production pre-state (read-only inspect of 2026-10-19 after SQL 93, SSM
// 73b4bd93, main 36955c413): the same pre-state staging recorded before its apply.
const SQL96_PRODUCTION_PRE = '275400ff40caf1ff9d036e62f8bab687f82e9302622afef91f77a314c0f40f7f';
const SQL96_STAGING_REFERENCE = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39082957003';
// SQL 93's recorded production pre-state (read-only inspect of 2026-10-19 after SQL 90 / SQL 101,
// SSM d3753ba4, main ea8f3dc73): the same pre-state staging recorded before its apply.
const SQL93_PRODUCTION_PRE = 'ef2ce6baec304517f50b063a3d11048492ae69d34122e26020063f0c53413eb9';
const SQL93_STAGING_REFERENCE = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39080438659';
// SQL 90's recorded production pre-state (read-only inspect of 2026-10-19 after SQL 29 / SQL 30,
// SSM 9e68e829, main 45d6dbebd) and its staging reference (the guarded staging apply of
// 2026-10-17 from a different pre-state, accepted by the owner as substitute evidence).
const SQL90_PRODUCTION_PRE = 'b5a1998de14922c26b9d829909fada17d3994cf8d0757d410c3e04f6c1f5d9fe';
const SQL90_STAGING_REFERENCE = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39080157856';
const APPLIED_RETIRED = Object.freeze(['sql90', 'sql91', 'sql92', 'sql93', 'sql94', 'sql95', 'sql96', 'sql97', 'sql98', 'sql99', 'sql101', 'sql102', 'sql103', 'sql104', 'sql105', 'sql106', 'sql108', 'sql109', 'sql110', 'sql111', 'sql112', 'sql113']);
// SQL 90's and SQL 101's production applies of 2026-10-19, recorded in applied.
const SQL90_SQL101_APPLIED = Object.freeze({
  // SQL 113's production apply of 2026-10-23 (main 09425a013).
  sql113: Object.freeze({ ssm: '9f209788-6247-47ed-bc6e-838d5791a42e', run: '594619a2-671f-45f5-a260-7f991d5007ef', one_use_id: 'sql113-prod-86f11689-ab1d-4459-9f15-10ff2d135818', commit: '09425a01389ce92e703f34eb2bcc526d532f1c13', approval: 'apply SQL 113 in production and merge 1209 when green' }),
  // SQL 112's production apply of 2026-10-23 (main 4d2cf0c11).
  sql112: Object.freeze({ ssm: '654fb07f-7c95-4828-ad95-7fce135f1d27', run: '3f3f7d9d-51df-458f-b9fe-49b4bc91f841', one_use_id: 'sql112-prod-95240935-fac1-4d76-b727-7fd1f2f55bf4', commit: '4d2cf0c119280c12a360400be657d6e43f2b7a64', approval: 'apply SQL 112 in production' }),
  // SQL 111's production apply of 2026-10-23 (main 8f534384e).
  sql111: Object.freeze({ ssm: 'c006d74b-7c52-4e6f-972f-b17afcc448cf', run: '4bf98369-6fd4-477a-8d04-30a7952f977c', one_use_id: 'sql111-prod-761afdca-3fd7-4e7b-932a-bce2369faff6', commit: '8f534384e94090a5692ba38ccf97afea9dc148b3', approval: 'apply SQL 111 in production' }),
  // SQL 110's production apply of 2026-10-22 (main e29b971fb).
  sql110: Object.freeze({ ssm: 'dff74531-5a77-4f17-9027-e927f7f10644', run: '04f2dadf-1866-492e-a9e9-d301a2766b2b', one_use_id: 'sql110-prod-a04eae17-2564-42ba-87a1-51bc200582ff', commit: 'e29b971fbf9c33d89cdf133155853d0c5e9c9b26', approval: 'apply SQL 110 in production' }),
  // SQL 109's production apply of 2026-10-21 (main 513585432).
  sql109: Object.freeze({ ssm: '5da87122-dc6b-4e08-b799-1abc17ee14eb', run: '6a7ba5c9-98f6-44e8-958d-fd3292a3f96d', one_use_id: 'sql109-prod-40ec7c00-60a0-4825-9129-66f43914c3ba', commit: '513585432dcd15a19d404a3da715e928937d5ea7', approval: 'apply SQL 109 in production' }),
  // SQL 108's production apply of 2026-10-21 (main 970d514bc).
  sql108: Object.freeze({ ssm: '9b6a1df3-6146-464e-9f37-995faaf739e0', run: 'ee45c3a0-71d6-4821-952b-5c92c0e706b5', one_use_id: 'sql108-prod-aa304e1f-6e2d-4e90-900d-99207be30bd6', commit: '970d514bc2f697b58c86e23c319cb938c00ff558', approval: 'apply SQL 108 in production' }),
  // SQL 106's and SQL 97's production applies of 2026-10-21 (main 7124a160b), one owner statement for
  // both runs; both runs passed the SQL 106 workstream id.
  sql106: Object.freeze({ ssm: '43070c9e-2bb5-4e49-80f3-97fe6f35e3d0', run: '0ae3e5dc-a34f-4799-ba75-d79a9b2ade28', one_use_id: 'sql106-prod-c994fcc1-bbff-414b-bfad-3b864d96d4a6', commit: '7124a160b9848d6334bc4328d69e9404aebddff3', approval: 'apply SQL 106 and SQL 97 in production' }),
  sql97: Object.freeze({ ssm: '0a7a1b66-47c4-4fa8-8380-9b60296360f5', run: '9834d407-6758-486d-9f3f-bc85ec6e129f', one_use_id: 'sql97-prod-87263eb2-8523-4646-9a28-d7a4d22e38c8', commit: '7124a160b9848d6334bc4328d69e9404aebddff3', approval: 'apply SQL 106 and SQL 97 in production' }),
  // SQL 95's and SQL 99's production applies of 2026-10-21 (main dcd865256), one owner statement for both runs.
  sql95: Object.freeze({ ssm: '2f1530c2-0cf9-42a9-8fef-685b5e83589a', run: '3b4fe182-94bd-494f-b411-af75f4f3ce92', one_use_id: 'sql95-prod-d04849eb-31b3-4657-a622-d0ffa030207d', commit: 'dcd86525690e0732691ab7bf0723dc25167d89e9', approval: 'apply SQL 97, 95 and 99 in production' }),
  sql99: Object.freeze({ ssm: 'fa655042-6ae1-41e6-96cc-a5b3ed61f4a8', run: 'bfb0c630-87a6-46f8-819d-4155a7b54640', one_use_id: 'sql99-prod-56ce276e-16ea-49c5-9d44-7746a5a9c673', commit: 'dcd86525690e0732691ab7bf0723dc25167d89e9', approval: 'apply SQL 97, 95 and 99 in production' }),
  sql102: Object.freeze({ ssm: 'fdf84b2e-8f53-4e9f-b6a4-37a56054175b', run: 'f3f1d49f-9579-4b7b-a0de-731f05250158', one_use_id: 'sql102-prod-b4d3462c-ff00-463b-86df-58b711b4e141', commit: 'be79a819970dea9ac1f098bf185765b75f8b1d4f', approval: 'apply SQL 102 in production' }),
  sql98: Object.freeze({ ssm: '817865e7-2684-4f87-9f56-e57ed5386add', run: 'bef29dcf-c1fa-48d8-8c5f-0511b90e3403', one_use_id: 'sql98-prod-5a067c1d-8c6b-44b5-b646-2f7175d7b66e', commit: 'ce212b5aa296125bfde3fbab7617263a68539b34', approval: 'approve #1071 and apply SQL 98 in production' }),
  sql94: Object.freeze({ ssm: 'd2cf26f4-f240-497a-9293-5ca70c094d68', run: 'ca95e688-664e-43f3-97b1-9699bdab9a88', one_use_id: 'sql94-prod-a4968361-4a21-409d-9448-42ffe30f5274', commit: 'ef26f7357b19748a977eec668755d10319944373', approval: 'approve 1068, apply SQL 94 in production and apply SQL 104 in production' }),
  sql104: Object.freeze({ ssm: 'a97d4326-31b1-4aff-a6cb-206ff0d8e6f9', run: '32965a3e-f28d-4e53-914e-d1be902165a4', one_use_id: 'sql104-prod-7fb5b396-0420-433c-9088-3b1d7db42b19', commit: 'ef26f7357b19748a977eec668755d10319944373', approval: 'approve 1068, apply SQL 94 in production and apply SQL 104 in production' }),
  sql105: Object.freeze({ ssm: '5896b901-2b8d-44da-91cf-65b6038c2907', run: '7ee1ca20-c72c-4be6-891a-b618e869cd29', one_use_id: 'sql105-prod-841a42c3-2bcb-4709-bc31-64fe71b2a9cb', commit: '139600a45a47db32099240645ef6002e15b56fe3', approval: 'apply SQL 105 in production' }),
  sql96: Object.freeze({ ssm: 'df0acdce-9d1f-401c-a0f6-f6232e5d3f74', run: '6de41c7e-81c2-45a4-b92c-e4dc7f2950f9', one_use_id: 'sql96-prod-69b5b3c5-de65-4d63-8614-65a709b70950', commit: 'b9a1591f91a437101d4ca61e18437864e6ed1f9a', approval: 'approve 1063 and apply SQL 96 into production' }),
  sql93: Object.freeze({ ssm: 'a3696b55-52c2-4674-bd11-35153197191c', run: '885c6403-0a2e-482b-920e-05e917897bc7', one_use_id: 'sql93-prod-9956de5f-c4d5-4b14-9215-04ec7147f131', commit: '4864023611b1ff296ad23d6a589af42af49552a8', approval: 'approve #1060 and apply SQL 93 in production' }),
  sql90: Object.freeze({ ssm: '216d9a7e-8d5a-4c44-9d2f-e68370cc773a', run: '8a427f65-58bc-4a1b-8aac-f5161017df60', one_use_id: 'sql90-prod-840d729b-39a5-4dbf-8e66-7aec6f4a3555', commit: 'ba9ff4261411b4c24a856fac4a627841d0c61430', approval: 'apply SQL 90 in production' }),
  sql101: Object.freeze({ ssm: '680fd3f7-c586-4bb8-819e-cd4d7759d71b', run: '9fd22ea1-d936-44a0-b33b-049a2257f601', one_use_id: 'sql101-prod-9217d797-e85e-4d04-84d8-679f99aa6f00', commit: '20e3826da4f21cf84c7f28515da1a3bcb1902c73', approval: 'approve #1058 and apply SQL 101 in production' }),
});
// The staging acceptance SQL 91's and SQL 92's pins recorded (SQL 91: the guarded staging apply
// from the same pre-state; SQL 92: the owner-accepted substitute staging read-live).
const AUTHORIZED_STAGING_REFERENCE = Object.freeze({
  sql91: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39080306273',
  sql92: 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/39075498539',
});
const AUTHORIZED_PRODUCTION_PRE = Object.freeze({
  sql91: 'bdbc697f75e7a9c57c91c9ce12956800e92417a93acfbbaa0c2d1cf69542972e',
  sql92: '3cfbd32cde289775073221e99404b8b0ce82ff8d7e365cbf14d9e3e7fc6edb9f',
});
// SQL 91's and SQL 92's production applies of 2026-10-19 (main c62872827), recorded in applied.
const AUTHORIZED_APPLIED = Object.freeze({
  sql91: Object.freeze({ ssm: 'ed86d22d-d505-4479-b4ed-0402ab6ac349', run: 'd199f5d1-f17e-465e-a624-79564517bfb9', one_use_id: 'sql91-prod-8e792cdc-48e2-40ce-97f2-79baea22ae3b', manifest: '7c4fe52e3dfc8f2e8b9a381639f82c61213fd0ff7acfb5a9b27c4b1fb01c5553', unrelated: 'd7f9a115b839a8185dbad81450d6b6cea5f84ecfbaf89b685237f13d61ed77f8' }),
  sql92: Object.freeze({ ssm: 'bf59603e-3b45-4229-bfb2-89a9d219a5f6', run: 'ad1efd53-8fdc-485c-8f8f-10e8d63befd5', one_use_id: 'sql92-prod-eb132e5b-bfba-46e3-a3cc-52320cd64acf', manifest: '261bc3fd7806845c962023e0f0081e6d5e91e6dc6bef2084234f2617a6a878d4', unrelated: '79411e14d01351e3a3a851853f3e0f6327f43c09e9770a0ba00c29c9218e10b7' }),
});
/** SQL 90's / SQL 91's / SQL 92's execute-authorized state before the record-and-retire change (explicit copy of the retired pin). */
const unlocked = (key, extra = {}) => Object.freeze({ ...COMMITTED[key], authorization: 'Owner approved 2026-10-19 (test copy of the execute-authorized pin before its record-and-retire change)', execute: true, ...extra });
const LOCKED = Object.freeze(Object.fromEntries(RELEASE_SQL_KEYS.map((key) => [key, [...EXECUTE_AUTHORIZED, ...APPLIED_RETIRED].includes(key)
  ? Object.freeze({
    ...COMMITTED[key],
    authorization: 'pending',
    execute: false,
    expected_live_definition_sha256: null,
    staging_acceptance: { ok: false, reference: null, basis: 'Pending' },
    production_inspect: { ...COMMITTED[key].production_inspect, status: 'pending' },
  })
  : COMMITTED[key]])));
const ORDER = Object.freeze(['sql90', 'sql91', 'sql92', 'sql93', 'sql94', 'sql96', 'sql97', 'sql95']);
const STAGING_REF = 'https://github.com/michaelcarletta-cmd/ChecksOps/actions/runs/0000000000';
const COMMIT = 'a'.repeat(40);
const PRE = 'e'.repeat(64);
const READ_ONLY_STATEMENT_RE = /^\s*(SELECT|WITH|SAVEPOINT|RELEASE|ROLLBACK|BEGIN READ ONLY)\b/i;
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** An execute-authorized copy with a recorded pre-state and staging acceptance (test only). */
const authorized = (key, live = PRE, extra = {}) => Object.freeze({
  ...COMMITTED[key],
  authorization: 'Owner approved test fixture',
  execute: true,
  expected_live_definition_sha256: live,
  staging_acceptance: { ok: true, reference: STAGING_REF, basis: 'test fixture' },
  ...extra,
});

function manifest(key, pin, overrides = {}) {
  const live = pin.expected_live_definition_sha256;
  const fingerprint = { sql: live };
  const workstream = `prod-${key}-release-test`;
  return {
    workstream_id: workstream,
    branch: 'main',
    commit: COMMIT,
    operator: 'owner',
    target_environment: 'production',
    target_component: 'production-sql',
    deployment_type: 'sql-apply',
    owned_components: [pin.filename],
    filename: pin.filename,
    migration_id: pin.migration_id,
    source_sha256: pin.source_sha256,
    expected_live_definition_sha256: live,
    intended_replacement_sha256: pin.intended_replacement_sha256,
    live_definition_sha256: live,
    preflight_live_fingerprint: fingerprint,
    production_fingerprint: fingerprint,
    immediately_before_fingerprint: fingerprint,
    staging_acceptance: pin.staging_acceptance,
    approval: { approved: true, workstream_id: workstream },
    authorization_phrase: pin.authorization_phrase,
    one_use_id: `${key}-prod-${process.pid}-${Math.random().toString(16).slice(2)}`,
    build_timestamp: '2026-10-17T20:00:00.000Z',
    ...overrides,
  };
}
const consumedPath = () => path.join(os.tmpdir(), `sql9097-prod-consumed-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
const neverConnect = async () => { throw new Error('should-not-connect'); };

async function runCli(key, argv, { env = { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' }, input, deps = {} } = {}) {
  let file = null;
  if (input) {
    file = path.join(os.tmpdir(), `sql9097-prod-input-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify(input));
  }
  const writes = [];
  let spent = 0;
  const orig = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await MAINS[key](file ? [...argv, '--input', file] : argv, env, {
      root: ROOT,
      consumeReceiptOnce: () => { spent += 1; return { ok: true }; },
      connect: neverConnect,
      consumedPath: consumedPath(),
      ...deps,
    });
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
    if (file) fs.rmSync(file, { force: true });
  }
  return { out: writes.join(''), spent };
}

test('committed pins are pending (none execute-authorized; SQL 90, SQL 91, SQL 92, SQL 93, SQL 94, SQL 95, SQL 96, SQL 97, SQL 99, SQL 101, SQL 102, SQL 103, SQL 104, SQL 105, SQL 106, SQL 108, SQL 109, SQL 110, SQL 111, SQL 112 and SQL 113 applied and retired), bound to the staging pins, predecessors and the production RDS, and name the built tooling', () => {
  const inventory = JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'ops/deployment-guard/bypass-inventory.json'), 'utf8')));
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => COMMITTED[key].execute !== false), [...EXECUTE_AUTHORIZED]);
  assert.deepEqual(RELEASE_SQL_KEYS.filter((key) => COMMITTED[key].applied !== undefined), [...APPLIED_RETIRED]);
  for (const key of RELEASE_SQL_KEYS) {
    const pin = COMMITTED[key];
    const staging = STAGING[key];
    assert.equal(pin.migration, key);
    if (APPLIED_RETIRED.includes(key)) {
      // Applied to production and retired: execute false, the apply recorded in applied.
      assert.equal(pin.execute, false, key);
      assert.match(pin.authorization, /^Applied to production on \d{4}-\d{2}-\d{2}; execute is false again/, key);
      assert.match(pin.expected_live_definition_sha256, /^[0-9a-f]{64}$/, key);
      assert.equal(pin.staging_acceptance.ok, true, key);
      assert.equal(pin.production_inspect.status, 'recorded', key);
      assert.equal(pin.applied.result, 'applied', key);
      assert.equal(pin.applied.receipt.before_hash, pin.expected_live_definition_sha256, key);
      assert.equal(pin.applied.receipt.after_hash, pin.intended_replacement_sha256, key);
      assert.equal(pin.applied.post_apply_inspect.already_applied, true, key);
      if (AUTHORIZED_APPLIED[key]) {
        // SQL 91 / SQL 92: the owner approved the pin change (#1055) on the read-only production inspect of 2026-10-19 (main f51863bbd).
        // Owner approved 2026-10-19: the read-only production inspect of 2026-10-19 (main f51863bbd).
        assert.ok(pin.authorization.includes('"approve 1055, apply SQL 91 in production and apply SQL 92 in production"'), key);
        assert.doesNotMatch(pin.authorization, /^Owner approved/, key);
        assert.equal(pin.expected_live_definition_sha256, AUTHORIZED_PRODUCTION_PRE[key], key);
        assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256, key);
        assert.equal(pin.staging_acceptance.reference, AUTHORIZED_STAGING_REFERENCE[key], key);
        assert.ok(pin.staging_acceptance.production_differs.includes(pin.expected_live_definition_sha256), key);
        assert.equal(pin.production_inspect.ssm_command_id, '433d5e4e-51ec-4d82-8220-87ac9f04d8d7', key);
        assert.equal(pin.production_inspect.source_commit, 'f51863bbdc60b6d371bf2b28a1165fc00216b6fb', key);
        assert.equal(pin.production_inspect.source_tarball_sha256, '52e3f4aa3bcbd14c54fdcc9b92810312657fbcb6ca181158d4de0b2477c12cd9', key);
        assert.equal(pin.production_inspect.read_only, true, key);
        assert.equal(pin.production_inspect.already_applied, false, key);
        assert.deepEqual(pin.production_inspect.precondition_failures, [], key);
        if (key === 'sql91') {
          // The guarded staging apply started from the same pre-state production reports.
          assert.match(pin.staging_acceptance.basis, /run 39080306273/);
          assert.match(pin.staging_acceptance.basis, /read-live \(run 39075362413\)/);
          assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${pin.expected_live_definition_sha256}, after ${pin.intended_replacement_sha256}`));
        } else {
          // Owner-accepted substitute evidence: staging already had SQL 92.
          assert.ok(pin.staging_acceptance.basis.includes('"open the SQL 91/92 one-shot and pin PRs and accept that evidence for SQL 92"'));
          assert.match(pin.staging_acceptance.basis, /run 39075498539, already_applied true/);
          for (const file of ['aws/tests/release-sql90-97-executor.test.mjs', 'aws/tests/release-sql90-97-production-apply.test.mjs', 'aws/tests/signature-sql-source.test.mjs']) {
            assert.ok(pin.staging_acceptance.basis.includes(file), file);
            assert.ok(fs.existsSync(path.join(ROOT, file)), file);
          }
        }
        const run = AUTHORIZED_APPLIED[key];
        assert.equal(pin.applied.apply_ssm_command_id, run.ssm, key);
        assert.equal(pin.applied.one_shot_run_id, run.run, key);
        assert.equal(pin.applied.one_use_id, run.one_use_id, key);
        assert.equal(pin.applied.one_use_id_consumed, true, key);
        assert.equal(pin.applied.manifest_sha256, run.manifest, key);
        assert.equal(pin.applied.receipt.unrelated_catalog_sha256, run.unrelated, key);
        assert.equal(pin.applied.source_commit, 'c628728273f0d54c901e3526b46d23e7cef4f411', key);
        assert.equal(pin.applied.source_tarball.sha256, 'a1f6a7b93a311069a9e0f0b3fc80d8aa6b739d50f9bb31e72d8e8cad13b53244', key);
        assert.equal(pin.applied.migration_source_sha256, pin.source_sha256, key);
        assert.equal(pin.applied.receipt.staging_acceptance, AUTHORIZED_STAGING_REFERENCE[key], key);
        assert.equal(pin.applied.owner_approval, 'approve 1055, apply SQL 91 in production and apply SQL 92 in production', key);
        assert.equal(pin.applied.later_inspect, undefined, key);
      }
      if (SQL90_SQL101_APPLIED[key]) {
        const run = SQL90_SQL101_APPLIED[key];
        assert.ok(pin.authorization.includes(`"${run.approval}"`), key);
        assert.equal(pin.applied.apply_ssm_command_id, run.ssm, key);
        assert.equal(pin.applied.one_shot_run_id, run.run, key);
        assert.equal(pin.applied.one_use_id, run.one_use_id, key);
        assert.equal(pin.applied.one_use_id_consumed, true, key);
        assert.equal(pin.applied.source_commit, run.commit, key);
        assert.equal(pin.applied.owner_approval, run.approval, key);
        assert.equal(pin.applied.migration_source_sha256, pin.source_sha256, key);
        assert.equal(pin.applied.receipt.staging_acceptance, pin.staging_acceptance.reference, key);
        assert.equal(pin.applied.later_inspect, undefined, key);
      }
      if (key === 'sql95') {
        // SQL 95: the owner approved the pin (#1112) on substitute staging evidence; applied 2026-10-21
        // (before SQL 97, which was not applied: its pre-apply inspect stopped it).
        const want = SQL95_SQL97_PINNED.sql95;
        assert.ok(pin.authorization.includes('"Everything else should be pushed live no exceptions"'), key);
        assert.ok(pin.authorization.includes('#1112'), key);
        assert.equal(pin.expected_live_definition_sha256, want.pre, key);
        assert.notEqual(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256, key);
        assert.equal(pin.staging_acceptance.reference, want.reference, key);
        assert.match(pin.staging_acceptance.basis, /^Owner-accepted substitute evidence/, key);
        assert.ok(pin.staging_acceptance.basis.includes(`staging read-live run ${want.staging_read_live}`), key);
        assert.equal(pin.production_inspect.ssm_command_id, '43cb1d1f-f589-43b2-9315-7cad80fffb5c', key);
        assert.equal(pin.production_inspect.source_commit, '69dbe9b01cbcd8f04847cab248e243105c85f022', key);
        assert.match(pin.production_inspect.note, /Lambda gate \(runbook Apply order step 8\)/, key);
        assert.equal(pin.applied.source_tarball.sha256, '2c0c0fac5b042df8657cf553b630c572a1f9bb02f23541f9384b024a1f31487e', key);
        assert.equal(pin.applied.manifest_sha256, '6c7551a02c3ddea5d54e76446ffd2774924ec0375980f67ecd2c3cb26387e857', key);
        assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '8a56ccd66383f7551f612d70f220982c1e1297c29eeaad2446b57e6c29072df6', key);
        assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, want.pre, key);
        assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256, key);
        assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, [], key);
        assert.match(pin.applied.one_shot_note, /Not after SQL 97/, key);
        assert.ok(pin.applied.one_shot_note.includes('16bcba87-7ad4-48b1-a63b-a2de20d25eee'), key);
        assert.ok(pin.production_evidence['2026-10-21 apply'].includes(SQL90_SQL101_APPLIED.sql95.ssm), key);
        // SQL 97, named in the same owner statement, was not applied by it: it was applied later on
        // 2026-10-21 under its own statement, after SQL 106.
        assert.notEqual(COMMITTED.sql97.applied.owner_approval, SQL90_SQL101_APPLIED.sql95.approval);
      }
      if (key === 'sql97') {
        // SQL 97: the owner approved the pin (#1112) on substitute staging evidence; not applied at its
        // first inspect (other_write_grants), applied 2026-10-21 after SQL 106 (and after SQL 95).
        const want = SQL95_SQL97_PINNED.sql97;
        assert.ok(pin.authorization.includes('"Everything else should be pushed live no exceptions"'), key);
        assert.ok(pin.authorization.includes('#1112'), key);
        assert.equal(pin.expected_live_definition_sha256, want.pre, key);
        assert.notEqual(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256, key);
        assert.equal(pin.staging_acceptance.reference, want.reference, key);
        assert.match(pin.staging_acceptance.basis, /^Owner-accepted substitute evidence/, key);
        assert.ok(pin.staging_acceptance.basis.includes(`staging read-live run ${want.staging_read_live}`), key);
        assert.equal(pin.production_inspect.ssm_command_id, '43cb1d1f-f589-43b2-9315-7cad80fffb5c', key);
        assert.equal(pin.production_inspect.source_commit, '69dbe9b01cbcd8f04847cab248e243105c85f022', key);
        assert.match(pin.production_inspect.note, /Lambda gate \(runbook Apply order step 7\)/, key);
        assert.equal(pin.applied.source_tarball.sha256, '48713c464437e21c91dd63360fe33c27495918c332a32951ac8f3ec692089dde', key);
        assert.equal(pin.applied.manifest_sha256, 'db5b551f5e1ab0e7818e6204833c5a6bef5529de8415532c735b256b77d0f923', key);
        assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '22332dfcb6056258de39f047dd67ea32d65112ce93e14b744f18afbc33b208d3', key);
        // Recorded as passed: the SQL 106 run's workstream id.
        assert.equal(pin.applied.workstream_id, 'prod-sql106-financial-stepup-log-append-only-20261021', key);
        assert.equal(pin.applied.receipt.workstream, pin.applied.workstream_id, key);
        assert.equal(pin.applied.workstream_id, COMMITTED.sql106.applied.workstream_id, key);
        assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, want.pre, key);
        assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256, key);
        assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, [], key);
        // After SQL 106: the step 7 stop rule (other_write_grants not []) no longer applied.
        assert.ok(pin.applied.one_shot_note.includes(SQL90_SQL101_APPLIED.sql106.ssm), key);
        assert.ok(pin.applied.one_shot_note.includes('other_write_grants []'), key);
        assert.match(pin.applied.one_shot_note, /Not before SQL 95/, key);
        assert.ok(pin.production_evidence['2026-10-21 apply'].includes(SQL90_SQL101_APPLIED.sql97.ssm), key);
        assert.equal(COMMITTED.sql106.applied.result, 'applied');
      }
      if (key === 'sql94') {
        // SQL 94: the owner approved the pin (#1068) on its guarded staging apply from the same pre-state; applied 2026-10-19.
        assert.ok(pin.authorization.includes('"do the SQL 94 pin"'), key);
        assert.equal(pin.expected_live_definition_sha256, SQL94_PRODUCTION_PRE, key);
        assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256, key);
        assert.equal(pin.staging_acceptance.reference, SQL94_STAGING_REFERENCE, key);
        assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${SQL94_PRODUCTION_PRE}, after ${pin.intended_replacement_sha256}`), key);
        assert.match(pin.staging_acceptance.basis, /read-live \(run 39080904425\)/, key);
        assert.match(pin.staging_acceptance.basis, /Same pre-state/, key);
        assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference'], key);
        assert.equal(pin.production_inspect.ssm_command_id, '70abaca3-3ec3-4cbc-aae3-6542563080f2', key);
        assert.equal(pin.production_inspect.source_commit, 'fecb0b3af85b7a4a13d005a04fb42dd54c6172d1', key);
        assert.equal(pin.production_inspect.read_only, true, key);
        assert.deepEqual(pin.production_inspect.precondition_failures, [], key);
        assert.equal(pin.applied.manifest_sha256, '2f2603e9d23437bef8f7bc53049bcda5e1f3a3305f0f3ac64a4120dbd4300ca9', key);
        assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '1d547fe3b97a3449dec3e5dd07f17f9da723501d39258b4b5d77f95d8328b72d', key);
        assert.equal(pin.applied.source_tarball.sha256, '5dba0f6bf2ea274980857d6dfd9acb4ac0f3eb78b80207cd0c1270798e3e480a', key);
      }
      if (key === 'sql102') {
        // SQL 102: the owner approved the pin (#1078) on its guarded staging apply from the same pre-state; applied 2026-10-20.
        assert.ok(pin.authorization.includes('"approve the SQL 102 pin"'), key);
        assert.ok(pin.authorization.includes('#1078'), key);
        assert.equal(pin.expected_live_definition_sha256, SQL102_PRODUCTION_PRE, key);
        assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256, key);
        assert.equal(pin.staging_acceptance.reference, SQL102_STAGING_REFERENCE, key);
        assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${SQL102_PRODUCTION_PRE}, after ${pin.intended_replacement_sha256}`), key);
        assert.match(pin.staging_acceptance.basis, /read-live \(run 39161620576\)/, key);
        assert.match(pin.staging_acceptance.basis, /Same pre-state/, key);
        assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference'], key);
        assert.equal(pin.production_inspect.ssm_command_id, '3ff30ee9-031d-4122-9ee1-370a2645cbca', key);
        assert.equal(pin.production_inspect.source_commit, '96fb178215beff8d30c0adfebae27d62ad04de79', key);
        assert.equal(pin.production_inspect.read_only, true, key);
        assert.deepEqual(pin.production_inspect.precondition_failures, [], key);
        assert.ok(pin.production_inspect.note.includes('10092ef21749d0a9f298450129a2fd7359e63912853bf48edfd2c2f0093352fb'), key);
        assert.equal(pin.applied.pre_apply_inspect.live_definition_sha256, SQL102_PRODUCTION_PRE, key);
        assert.equal(pin.applied.manifest_sha256, '567944910178396e6177bc8d43b0e91ce58554fcaf34970a759b959397030bde', key);
        assert.equal(pin.applied.receipt.unrelated_catalog_sha256, 'ae8817ff71f77045a89d65da80a5c5328b61f4a4147aea9c40b618c85ab7d3bd', key);
        assert.equal(pin.applied.source_tarball.sha256, '97d98c51b3b1ce74da45cf01f38a4ea29ce3cc9bb82418cff1947765969744a5', key);
        assert.equal(pin.applied.post_apply_inspect.live_definition_sha256, pin.intended_replacement_sha256, key);
        assert.deepEqual(pin.applied.post_apply_inspect.precondition_failures, [], key);
        assert.ok(pin.production_evidence['2026-10-20 apply'].includes(SQL90_SQL101_APPLIED.sql102.ssm), key);
      }
      if (key === 'sql96') {
        // SQL 96: the owner approved the pin (#1063) on its guarded staging apply from the same pre-state; applied 2026-10-19.
        assert.ok(pin.authorization.includes('"do the SQL 96 pin"'), key);
        assert.equal(pin.expected_live_definition_sha256, SQL96_PRODUCTION_PRE, key);
        assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256, key);
        assert.equal(pin.staging_acceptance.reference, SQL96_STAGING_REFERENCE, key);
        assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${SQL96_PRODUCTION_PRE}, after ${pin.intended_replacement_sha256}`), key);
        assert.match(pin.staging_acceptance.basis, /read-live \(run 39081015501\)/, key);
        assert.match(pin.staging_acceptance.basis, /Same pre-state/, key);
        assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference'], key);
        assert.equal(pin.production_inspect.ssm_command_id, '73b4bd93-b91b-44c9-b18d-287625e5f4c6', key);
        assert.equal(pin.production_inspect.source_commit, '36955c413a013ca365357548d0ffae26f84b817b', key);
        assert.equal(pin.production_inspect.read_only, true, key);
        assert.deepEqual(pin.production_inspect.precondition_failures, [], key);
        assert.ok(pin.production_inspect.note.includes('b124732a87345daceb21207744e8b529bcae984b144aefc13e31e3cf7b066428'), key);
        assert.equal(pin.applied.manifest_sha256, 'ea6ea07ef3330887be19b721047aee35b5edad98141c61f751d64f136c865527', key);
        assert.equal(pin.applied.receipt.unrelated_catalog_sha256, '975cfaa9c526a28957d75e496b50f9a8c6a300fdb4d0c365c59af422872daff5', key);
        assert.equal(pin.applied.source_tarball.sha256, '6edc5ede45602410e56c5426268616499b6490606fee10aa6d46fe2f688a458d', key);
      }
      if (key === 'sql93') {
        // SQL 93: the owner approved the pin (#1060) on its guarded staging apply from the same pre-state; applied 2026-10-19.
        assert.equal(pin.expected_live_definition_sha256, SQL93_PRODUCTION_PRE, key);
        assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256, key);
        assert.equal(pin.staging_acceptance.reference, SQL93_STAGING_REFERENCE, key);
        assert.ok(pin.staging_acceptance.basis.includes(`receipt before ${SQL93_PRODUCTION_PRE}, after ${pin.intended_replacement_sha256}`), key);
        assert.match(pin.staging_acceptance.basis, /read-live \(run 39075623166\)/, key);
        assert.ok(pin.staging_acceptance.production_differs.includes(SQL93_PRODUCTION_PRE), key);
        assert.equal(pin.production_inspect.ssm_command_id, 'd3753ba4-0338-4649-8997-2135376b6743', key);
        assert.equal(pin.production_inspect.source_commit, 'ea8f3dc73a5e3f9c0ac9eb768a0e8f39f32fa430', key);
        assert.equal(pin.production_inspect.source_tarball_sha256, '59b78b27f22cfb026fdf327db333d710b1a0875daec2389584df72ed54d01d15', key);
        assert.equal(pin.production_inspect.read_only, true, key);
        assert.equal(pin.production_inspect.already_applied, false, key);
        assert.deepEqual(pin.production_inspect.precondition_failures, [], key);
        assert.deepEqual(pin.production_inspect.predecessors, { sql90: true }, key);
      }
      if (key === 'sql90') {
        // SQL 90: the owner approved the pin (#1057) with substitute staging evidence; applied 2026-10-19.
        assert.ok(pin.authorization.includes('accepted its substitute staging evidence'), key);
        assert.equal(pin.expected_live_definition_sha256, SQL90_PRODUCTION_PRE, key);
        assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256, key);
        assert.equal(pin.staging_acceptance.reference, SQL90_STAGING_REFERENCE, key);
        assert.ok(pin.staging_acceptance.basis.includes('"do the SQL 90 pin and accept that evidence for SQL 90"'), key);
        assert.ok(pin.staging_acceptance.basis.includes(`after ${pin.intended_replacement_sha256}`), key);
        for (const file of ['aws/tests/sql90-users-only-tenant-roles-pg.test.mjs', 'aws/tests/release-sql90-97-production-apply.test.mjs', 'aws/tests/users-only-role-gates.test.mjs']) {
          assert.ok(pin.staging_acceptance.basis.includes(file), file);
          assert.ok(fs.existsSync(path.join(ROOT, file)), file);
        }
        assert.ok(pin.staging_acceptance.production_differs.includes(SQL90_PRODUCTION_PRE), key);
        assert.equal(pin.production_inspect.ssm_command_id, '9e68e829-7ca0-4499-89ad-8cd691e3cdb8', key);
        assert.equal(pin.production_inspect.source_commit, '45d6dbebd73a5ca4804baeb70841e479788a00e5', key);
        assert.equal(pin.production_inspect.source_tarball_sha256, '19e5dbc434e83f034d2b06198211affe1436770a7cd18c2a521a8658392103d4', key);
        assert.equal(pin.production_inspect.read_only, true, key);
        assert.equal(pin.production_inspect.already_applied, false, key);
        assert.deepEqual(pin.production_inspect.precondition_failures, [], key);
        assert.deepEqual(pin.production_inspect.predecessors, { sql29: true, sql30: true }, key);
      }
    } else if (EXECUTE_AUTHORIZED.includes(key)) {
      assert.equal(pin.execute, true, key);
      assert.match(pin.authorization, /^Owner approved /, key);
      assert.match(pin.expected_live_definition_sha256, /^[0-9a-f]{64}$/, key);
      assert.equal(pin.staging_acceptance.ok, true, key);
      assert.match(pin.staging_acceptance.reference, /^https:\/\/github\.com\/michaelcarletta-cmd\/ChecksOps\/actions\/runs\/\d+$/, key);
      assert.equal(pin.production_inspect.status, 'recorded', key);
      assert.equal(pin.production_inspect.live_definition_sha256, pin.expected_live_definition_sha256, key);
      assert.match(pin.authorization, /^Owner approved 2026-10-(19|20|21|22|23) /, key);
      assert.match(pin.authorization, /each apply still needs the owner's run-time approval/, key);
      assert.deepEqual(Object.keys(pin.staging_acceptance).sort(), ['basis', 'ok', 'reference'], key);
      assert.deepEqual(pin.production_inspect.precondition_failures, [], key);
      assert.equal(pin.applied, undefined, key);
      if (SQL95_SQL97_PINNED[key]) {
        // SQL 95 / SQL 97: owner approved 2026-10-21; the read-only production inspect recorded as the
        // pre-state; substitute staging evidence (different pre-state); the Lambda gate recorded.
        const want = SQL95_SQL97_PINNED[key];
        assert.match(pin.authorization, /^Owner approved 2026-10-21 /, key);
        assert.ok(pin.authorization.includes('"Everything else should be pushed live no exceptions"'), key);
        assert.ok(pin.authorization.includes(`${want.pre} -> ${pin.intended_replacement_sha256}`), key);
        assert.equal(pin.expected_live_definition_sha256, want.pre, key);
        assert.notEqual(pin.expected_live_definition_sha256, pin.intended_replacement_sha256, key);
        assert.notEqual(pin.expected_live_definition_sha256, staging.expected_live_definition_sha256, key);
        assert.equal(pin.production_inspect.date, '2026-10-21', key);
        assert.equal(pin.production_inspect.ssm_command_id, '43cb1d1f-f589-43b2-9315-7cad80fffb5c', key);
        assert.equal(pin.production_inspect.source_commit, '69dbe9b01cbcd8f04847cab248e243105c85f022', key);
        assert.equal(pin.production_inspect.read_only, true, key);
        assert.ok(pin.production_inspect.note.includes('1424a8c418324c7c520b385c96dbdca79b869478a076a7802ec7ae2a560ff4b4'), key);
        assert.ok(pin.production_inspect.note.includes(' Earlier: Pending: '), key);
        // The Lambda gate evidence (runbook Apply order steps 7 and 8).
        assert.match(pin.production_inspect.note, /Lambda gate \(runbook Apply order step [78]\)/, key);
        assert.match(pin.production_inspect.note, /guarded production rebuild run 39588578627/, key);
        assert.equal(pin.staging_acceptance.reference, want.reference, key);
        assert.match(pin.staging_acceptance.basis, /^Owner-accepted substitute evidence/, key);
        assert.ok(pin.staging_acceptance.basis.includes(`staging read-live run ${want.staging_read_live}`), key);
        assert.ok(pin.staging_acceptance.basis.includes(`pre-state ${staging.expected_live_definition_sha256}`), key);
        assert.ok(pin.staging_acceptance.basis.includes(`equal to the intended ${pin.intended_replacement_sha256}`), key);
        assert.match(pin.staging_acceptance.basis, /The pre-states differ/, key);
        assert.match(pin.staging_acceptance.basis, /apply run of that wave is not recorded/, key);
      }
    } else {
      assert.equal(pin.authorization, 'pending', key);
      assert.equal(pin.execute, false, key);
      assert.equal(pin.expected_live_definition_sha256, null, key);
      assert.equal(pin.staging_acceptance.ok, false, key);
      assert.equal(pin.staging_acceptance.reference, null, key);
      assert.equal(pin.production_inspect.status, 'pending', key);
    }
    assert.notEqual(pin.verified_live, true, key);
    assert.equal(pin.filename, staging.filename);
    assert.equal(pin.migration_id, staging.migration_id);
    assert.equal(pin.source_sha256, staging.source_sha256);
    assert.equal(pin.staging_pin_commit, staging.commit);
    assert.equal(pin.intended_replacement_sha256, staging.intended_replacement_sha256);
    assert.deepEqual(pin.predecessors, RELEASE_SQL_SPECS[key].predecessors);
    assert.equal(pin.admin_login, 'checksops_admin');
    assert.equal(pin.rds_identifier, 'checksops-production');
    assert.match(pin.admin_secret_arn, /^arn:aws:secretsmanager:us-east-1:806168576068:secret:rds-db-credentials\/checksops-production\/checksops_admin\//);
    assert.equal(RELEASE_PRODUCTION[key].pin_rel, `ops/deployment-guard/${pin.id}.json`);
    assert.equal(pin.tooling.status, 'built');
    assert.equal(pin.tooling.production_tool, RELEASE_PRODUCTION[key].cli);
    assert.ok(fs.existsSync(path.join(ROOT, pin.tooling.production_tool)));
    for (const testFile of pin.tooling.tests) assert.ok(fs.existsSync(path.join(ROOT, testFile)), testFile);
    assert.equal(readPinnedReleaseSql(key, ROOT, pin).ok, true, key);
    assert.ok(inventory.includes(RELEASE_PRODUCTION[key].cli), key);
    assert.equal(ONE_SHOT_TOOLS[key].script, RELEASE_PRODUCTION[key].cli);
    assert.equal(ONE_SHOT_TOOLS[key].pin_rel, RELEASE_PRODUCTION[key].pin_rel);
  }
});

test('a tampered pin or file is refused', () => {
  for (const key of RELEASE_SQL_KEYS) {
    for (const field of ['filename', 'source_sha256', 'intended_replacement_sha256', 'target_environment', 'staging_pin_commit', 'migration']) {
      const bad = { ...COMMITTED[key], [field]: field === 'target_environment' ? 'staging' : 'x' };
      assert.equal(readPinnedReleaseSql(key, ROOT, bad).code, CODES.SQL_COLLISION, `${key} ${field}`);
    }
    // The pin's predecessors must be the tooling's.
    assert.equal(readPinnedReleaseSql(key, ROOT, { ...COMMITTED[key], predecessors: ['sql99'] }).code, CODES.SQL_COLLISION, key);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sql9097-tamper-'));
  try {
    for (const key of RELEASE_SQL_KEYS) {
      const pin = COMMITTED[key];
      fs.mkdirSync(path.join(tmp, path.dirname(pin.filename)), { recursive: true });
      fs.writeFileSync(path.join(tmp, pin.filename), `${fs.readFileSync(path.join(ROOT, pin.filename), 'utf8')}\nSELECT 1;\n`);
      assert.equal(readPinnedReleaseSql(key, tmp, pin).code, CODES.SOURCE_RECONCILIATION_REQUIRED, key);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('evaluate, precheck and apply refuse before connecting', async () => {
  for (const key of RELEASE_SQL_KEYS) {
    // The pending state (for an execute-authorized or applied pin, its explicit pre-authorization copy).
    const committed = await evaluateReleaseProductionApply(key, manifest(key, { ...LOCKED[key], expected_live_definition_sha256: PRE }), { root: ROOT, pin: LOCKED[key] });
    assert.equal(committed.code, CODES.SQL_COLLISION, key);
    assert.match(committed.message, /no recorded pre-apply live definition hash/);
    const pendingWithPre = { ...LOCKED[key], expected_live_definition_sha256: PRE };
    const notApproved = await evaluateReleaseProductionApply(key, manifest(key, pendingWithPre), { root: ROOT, pin: pendingWithPre });
    assert.equal(notApproved.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
    const pin = authorized(key);
    const good = await evaluateReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin });
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(good.details[RELEASE_PRODUCTION[key].allowed_key], true);
    const wrongLive = await evaluateReleaseProductionApply(key, manifest(key, pin, { live_definition_sha256: 'f'.repeat(64) }), { root: ROOT, pin });
    assert.equal(wrongLive.code, CODES.SQL_COLLISION);
    const wrongStaging = await evaluateReleaseProductionApply(key, manifest(key, pin, { staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } }), { root: ROOT, pin });
    assert.equal(wrongStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    const noApproval = await evaluateReleaseProductionApply(key, manifest(key, pin, { approval: null }), { root: ROOT, pin });
    assert.equal(noApproval.ok, false);

    const ctx = { root: ROOT, pin, consumedPath: consumedPath(), connect: neverConnect };
    const executeFalse = await executeReleaseProductionApply(key, manifest(key, pin), { ...ctx, pin: authorized(key, PRE, { execute: false }) });
    assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN);
    const wrongPhrase = await executeReleaseProductionApply(key, manifest(key, pin, { authorization_phrase: 'APPLY' }), ctx);
    assert.equal(wrongPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
    const noOneUse = await executeReleaseProductionApply(key, manifest(key, pin, { one_use_id: 'x' }), ctx);
    assert.equal(noOneUse.code, CODES.INVALID_MANIFEST);
    const spentPath = consumedPath();
    fs.writeFileSync(spentPath, JSON.stringify({ consumed: ['reused-id-0001'] }));
    const replay = await precheckReleaseProductionApply(key, manifest(key, pin, { one_use_id: 'reused-id-0001' }), { root: ROOT, pin, consumedPath: spentPath });
    assert.equal(replay.code, CODES.RECEIPT_REUSED);
  }
});

test('SQL 91\'s and SQL 92\'s execute-authorized copies (before the record-and-retire change) allow only the manifest bound to them; the cheap prechecks pass without connecting', async () => {
  for (const key of Object.keys(AUTHORIZED_APPLIED)) {
    const pin = unlocked(key);
    const bound = manifest(key, pin, { staging_acceptance: { ok: true, reference: AUTHORIZED_STAGING_REFERENCE[key] } });
    const allowed = await evaluateReleaseProductionApply(key, bound, { root: ROOT, pin });
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.equal(allowed.details[RELEASE_PRODUCTION[key].allowed_key], true, key);
    const prechecked = await precheckReleaseProductionApply(key, bound, { root: ROOT, pin, consumedPath: consumedPath() });
    assert.equal(prechecked.ok, true, JSON.stringify(prechecked));
    const wrongLive = await evaluateReleaseProductionApply(key, { ...bound, live_definition_sha256: 'f'.repeat(64) }, { root: ROOT, pin });
    assert.equal(wrongLive.code, CODES.SQL_COLLISION, key);
    const wrongStaging = await evaluateReleaseProductionApply(key, { ...bound, staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } }, { root: ROOT, pin });
    assert.equal(wrongStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
    const executeFalse = await executeReleaseProductionApply(key, bound, { root: ROOT, pin: { ...pin, execute: false }, consumedPath: consumedPath(), connect: neverConnect });
    assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN, key);
    const wrongPhrase = await executeReleaseProductionApply(key, { ...bound, authorization_phrase: 'APPLY' }, { root: ROOT, pin, consumedPath: consumedPath(), connect: neverConnect });
    assert.equal(wrongPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
    // The committed (retired) pin, read from disk, refuses: its authorization is no longer an owner approval.
    const retired = await evaluateReleaseProductionApply(key, bound, { root: ROOT });
    assert.equal(retired.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
    // The spent one_use_id is refused as a replay, even on the execute-authorized copy.
    const spentPath = consumedPath();
    fs.writeFileSync(spentPath, JSON.stringify({ consumed: [AUTHORIZED_APPLIED[key].one_use_id] }));
    const replay = await precheckReleaseProductionApply(key, { ...bound, one_use_id: AUTHORIZED_APPLIED[key].one_use_id }, { root: ROOT, pin, consumedPath: spentPath });
    assert.equal(replay.code, CODES.RECEIPT_REUSED, key);
  }
});

test('SQL 90\'s execute-authorized copy (before the record-and-retire change) allows only the manifest bound to it; the cheap prechecks pass without connecting', async () => {
  const pin = unlocked('sql90');
  const bound = manifest('sql90', pin);
  const allowed = await evaluateReleaseProductionApply('sql90', bound, { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details[RELEASE_PRODUCTION.sql90.allowed_key], true);
  const prechecked = await precheckReleaseProductionApply('sql90', bound, { root: ROOT, pin, consumedPath: consumedPath() });
  assert.equal(prechecked.ok, true, JSON.stringify(prechecked));
  const wrongLive = await evaluateReleaseProductionApply('sql90', { ...bound, live_definition_sha256: 'f'.repeat(64) }, { root: ROOT, pin });
  assert.equal(wrongLive.code, CODES.SQL_COLLISION);
  const wrongStaging = await evaluateReleaseProductionApply('sql90', { ...bound, staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } }, { root: ROOT, pin });
  assert.equal(wrongStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const executeFalse = await executeReleaseProductionApply('sql90', bound, { root: ROOT, pin: { ...pin, execute: false }, consumedPath: consumedPath(), connect: neverConnect });
  assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN);
  const wrongPhrase = await executeReleaseProductionApply('sql90', { ...bound, authorization_phrase: 'APPLY' }, { root: ROOT, pin, consumedPath: consumedPath(), connect: neverConnect });
  assert.equal(wrongPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // The committed (retired) pin, read from disk, refuses; the spent one_use_id is refused as a replay.
  const retired = await evaluateReleaseProductionApply('sql90', bound, { root: ROOT });
  assert.equal(retired.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const spentPath = consumedPath();
  fs.writeFileSync(spentPath, JSON.stringify({ consumed: [SQL90_SQL101_APPLIED.sql90.one_use_id] }));
  const replay = await precheckReleaseProductionApply('sql90', { ...bound, one_use_id: SQL90_SQL101_APPLIED.sql90.one_use_id }, { root: ROOT, pin, consumedPath: spentPath });
  assert.equal(replay.code, CODES.RECEIPT_REUSED);
});

test('SQL 93\'s execute-authorized copy (before the record-and-retire change) allows only the manifest bound to it; the cheap prechecks pass without connecting', async () => {
  const pin = unlocked('sql93');
  const bound = manifest('sql93', pin);
  const allowed = await evaluateReleaseProductionApply('sql93', bound, { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details[RELEASE_PRODUCTION.sql93.allowed_key], true);
  const prechecked = await precheckReleaseProductionApply('sql93', bound, { root: ROOT, pin, consumedPath: consumedPath() });
  assert.equal(prechecked.ok, true, JSON.stringify(prechecked));
  const wrongLive = await evaluateReleaseProductionApply('sql93', { ...bound, live_definition_sha256: 'f'.repeat(64) }, { root: ROOT, pin });
  assert.equal(wrongLive.code, CODES.SQL_COLLISION);
  const wrongStaging = await evaluateReleaseProductionApply('sql93', { ...bound, staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } }, { root: ROOT, pin });
  assert.equal(wrongStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const executeFalse = await executeReleaseProductionApply('sql93', bound, { root: ROOT, pin: { ...pin, execute: false }, consumedPath: consumedPath(), connect: neverConnect });
  assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN);
  const wrongPhrase = await executeReleaseProductionApply('sql93', { ...bound, authorization_phrase: 'APPLY' }, { root: ROOT, pin, consumedPath: consumedPath(), connect: neverConnect });
  assert.equal(wrongPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // The committed (retired) pin, read from disk, refuses; the spent one_use_id is refused as a replay.
  const retired = await evaluateReleaseProductionApply('sql93', bound, { root: ROOT });
  assert.equal(retired.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const spentPath = consumedPath();
  fs.writeFileSync(spentPath, JSON.stringify({ consumed: [SQL90_SQL101_APPLIED.sql93.one_use_id] }));
  const replay = await precheckReleaseProductionApply('sql93', { ...bound, one_use_id: SQL90_SQL101_APPLIED.sql93.one_use_id }, { root: ROOT, pin, consumedPath: spentPath });
  assert.equal(replay.code, CODES.RECEIPT_REUSED);
});

test('SQL 94\'s execute-authorized copy (before the record-and-retire change) allows only the manifest bound to it; the retired pin and the spent one_use_id refuse', async () => {
  const pin = unlocked('sql94');
  const bound = manifest('sql94', pin);
  const allowed = await evaluateReleaseProductionApply('sql94', bound, { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details[RELEASE_PRODUCTION.sql94.allowed_key], true);
  const prechecked = await precheckReleaseProductionApply('sql94', bound, { root: ROOT, pin, consumedPath: consumedPath() });
  assert.equal(prechecked.ok, true, JSON.stringify(prechecked));
  const wrongLive = await evaluateReleaseProductionApply('sql94', { ...bound, live_definition_sha256: 'f'.repeat(64) }, { root: ROOT, pin });
  assert.equal(wrongLive.code, CODES.SQL_COLLISION);
  const executeFalse = await executeReleaseProductionApply('sql94', bound, { root: ROOT, pin: { ...pin, execute: false }, consumedPath: consumedPath(), connect: neverConnect });
  assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN);
  // The committed (retired) pin, read from disk, refuses; the spent one_use_id is refused as a replay.
  const retired = await evaluateReleaseProductionApply('sql94', bound, { root: ROOT });
  assert.equal(retired.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const spentPath = consumedPath();
  fs.writeFileSync(spentPath, JSON.stringify({ consumed: [SQL90_SQL101_APPLIED.sql94.one_use_id] }));
  const replay = await precheckReleaseProductionApply('sql94', { ...bound, one_use_id: SQL90_SQL101_APPLIED.sql94.one_use_id }, { root: ROOT, pin, consumedPath: spentPath });
  assert.equal(replay.code, CODES.RECEIPT_REUSED);
});

test('SQL 102\'s execute-authorized copy (before the record-and-retire change) allows only the manifest bound to it; the retired pin and the spent one_use_id refuse', async () => {
  const pin = unlocked('sql102');
  const bound = manifest('sql102', pin);
  const allowed = await evaluateReleaseProductionApply('sql102', bound, { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details[RELEASE_PRODUCTION.sql102.allowed_key], true);
  const prechecked = await precheckReleaseProductionApply('sql102', bound, { root: ROOT, pin, consumedPath: consumedPath() });
  assert.equal(prechecked.ok, true, JSON.stringify(prechecked));
  const wrongLive = await evaluateReleaseProductionApply('sql102', { ...bound, live_definition_sha256: 'f'.repeat(64) }, { root: ROOT, pin });
  assert.equal(wrongLive.code, CODES.SQL_COLLISION);
  const executeFalse = await executeReleaseProductionApply('sql102', bound, { root: ROOT, pin: { ...pin, execute: false }, consumedPath: consumedPath(), connect: neverConnect });
  assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN);
  // The committed (retired) pin, read from disk, refuses; the spent one_use_id is refused as a replay.
  const retired = await evaluateReleaseProductionApply('sql102', bound, { root: ROOT });
  assert.equal(retired.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const spentPath = consumedPath();
  fs.writeFileSync(spentPath, JSON.stringify({ consumed: [SQL90_SQL101_APPLIED.sql102.one_use_id] }));
  const replay = await precheckReleaseProductionApply('sql102', { ...bound, one_use_id: SQL90_SQL101_APPLIED.sql102.one_use_id }, { root: ROOT, pin, consumedPath: spentPath });
  assert.equal(replay.code, CODES.RECEIPT_REUSED);
});

test('SQL 96\'s execute-authorized copy (before the record-and-retire change) allows only the manifest bound to it; the cheap prechecks pass without connecting', async () => {
  const pin = unlocked('sql96');
  const bound = manifest('sql96', pin);
  const allowed = await evaluateReleaseProductionApply('sql96', bound, { root: ROOT, pin });
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.equal(allowed.details[RELEASE_PRODUCTION.sql96.allowed_key], true);
  const prechecked = await precheckReleaseProductionApply('sql96', bound, { root: ROOT, pin, consumedPath: consumedPath() });
  assert.equal(prechecked.ok, true, JSON.stringify(prechecked));
  const wrongLive = await evaluateReleaseProductionApply('sql96', { ...bound, live_definition_sha256: 'f'.repeat(64) }, { root: ROOT, pin });
  assert.equal(wrongLive.code, CODES.SQL_COLLISION);
  const wrongStaging = await evaluateReleaseProductionApply('sql96', { ...bound, staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } }, { root: ROOT, pin });
  assert.equal(wrongStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const executeFalse = await executeReleaseProductionApply('sql96', bound, { root: ROOT, pin: { ...pin, execute: false }, consumedPath: consumedPath(), connect: neverConnect });
  assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN);
  const wrongPhrase = await executeReleaseProductionApply('sql96', { ...bound, authorization_phrase: 'APPLY' }, { root: ROOT, pin, consumedPath: consumedPath(), connect: neverConnect });
  assert.equal(wrongPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  // The committed (retired) pin, read from disk, refuses; the spent one_use_id is refused as a replay.
  const retired = await evaluateReleaseProductionApply('sql96', bound, { root: ROOT });
  assert.equal(retired.code, CODES.PRODUCTION_APPROVAL_REQUIRED);
  const spentPath = consumedPath();
  fs.writeFileSync(spentPath, JSON.stringify({ consumed: [SQL90_SQL101_APPLIED.sql96.one_use_id] }));
  const replay = await precheckReleaseProductionApply('sql96', { ...bound, one_use_id: SQL90_SQL101_APPLIED.sql96.one_use_id }, { root: ROOT, pin, consumedPath: spentPath });
  assert.equal(replay.code, CODES.RECEIPT_REUSED);
});

test('SQL 95\'s and SQL 97\'s execute-authorized copies (before their record-and-retire changes) allow only the manifest bound to them; the cheap prechecks pass without connecting; the retired pins refuse and their spent one_use_ids are replays', async () => {
  for (const key of Object.keys(SQL95_SQL97_PINNED)) {
    const retiredPin = APPLIED_RETIRED.includes(key);
    const pin = retiredPin ? unlocked(key, { authorization: 'Owner approved 2026-10-21 (test copy of the execute-authorized pin before its record-and-retire change)' }) : COMMITTED[key];
    const bound = manifest(key, pin);
    if (retiredPin) {
      // The committed (retired) pin, read from disk, refuses; the spent one_use_id is refused as a replay.
      const retired = await evaluateReleaseProductionApply(key, bound, { root: ROOT });
      assert.equal(retired.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
      const spentPath = consumedPath();
      fs.writeFileSync(spentPath, JSON.stringify({ consumed: [SQL90_SQL101_APPLIED[key].one_use_id] }));
      const replay = await precheckReleaseProductionApply(key, { ...bound, one_use_id: SQL90_SQL101_APPLIED[key].one_use_id }, { root: ROOT, pin, consumedPath: spentPath });
      assert.equal(replay.code, CODES.RECEIPT_REUSED, key);
    }
    const allowed = await evaluateReleaseProductionApply(key, bound, { root: ROOT, pin });
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.equal(allowed.details[RELEASE_PRODUCTION[key].allowed_key], true, key);
    const prechecked = await precheckReleaseProductionApply(key, bound, { root: ROOT, pin, consumedPath: consumedPath() });
    assert.equal(prechecked.ok, true, JSON.stringify(prechecked));
    const wrongLive = await evaluateReleaseProductionApply(key, { ...bound, live_definition_sha256: 'f'.repeat(64) }, { root: ROOT, pin });
    assert.equal(wrongLive.code, CODES.SQL_COLLISION, key);
    // The staging pre-state is not production's: a manifest built on it is refused.
    const stagingPre = STAGING[key].expected_live_definition_sha256;
    const onStagingPre = await evaluateReleaseProductionApply(key, { ...bound, live_definition_sha256: stagingPre, expected_live_definition_sha256: stagingPre }, { root: ROOT, pin });
    assert.equal(onStagingPre.ok, false, key);
    const wrongStaging = await evaluateReleaseProductionApply(key, { ...bound, staging_acceptance: { ok: true, reference: 'https://example.invalid/x' } }, { root: ROOT, pin });
    assert.equal(wrongStaging.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
    const executeFalse = await executeReleaseProductionApply(key, bound, { root: ROOT, pin: { ...pin, execute: false }, consumedPath: consumedPath(), connect: neverConnect });
    assert.equal(executeFalse.code, CODES.GUARD_APPLY_FORBIDDEN, key);
    const wrongPhrase = await executeReleaseProductionApply(key, { ...bound, authorization_phrase: 'APPLY' }, { root: ROOT, pin, consumedPath: consumedPath(), connect: neverConnect });
    assert.equal(wrongPhrase.code, CODES.PRODUCTION_APPROVAL_REQUIRED, key);
  }
});

test('CLI: credential flags and arbitrary SQL are refused; pending pins stop before the guard; no receipt is spent and nothing connects', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql9097-cli-'));
  try {
    for (const key of RELEASE_SQL_KEYS) {
      for (const flag of ['--password=x', '--database-url=postgresql://u:p@h/d', '--host=h', '--user=u', '--secret-arn=x']) {
        const result = spawnSync(process.execPath, [CLIS[key], '--inspect', flag], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
        assert.notEqual(result.status, 0, `${key} ${flag}`);
        assert.match(`${result.stdout}${result.stderr}`, /credential flags are refused/, flag);
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secretsmanager|ECONNREFUSED/i, flag);
      }
      const committed = await runCli(key, ['--apply'], { input: manifest(key, { ...COMMITTED[key], expected_live_definition_sha256: PRE }), deps: { enforceScriptGuard: () => { throw new Error('guard-called'); } } });
      assert.equal(committed.spent, 0);
      // A pending pin has no pre-state (SQL_COLLISION); an applied, retired pin's authorization
      // is no longer an owner approval (PRODUCTION_APPROVAL_REQUIRED).
      assert.match(committed.out, APPLIED_RETIRED.includes(key) ? /PRODUCTION_APPROVAL_REQUIRED/ : /SQL_COLLISION/, key);
      assert.doesNotMatch(committed.out, /guard-called|should-not-connect/);
      const sqlText = await runCli(key, ['--apply'], { input: { ...manifest(key, authorized(key)), sql_text: 'DROP TABLE x' }, deps: { pin: authorized(key) } });
      assert.match(sqlText.out, /arbitrary SQL text is forbidden/);
      const emptyRoot = fs.mkdtempSync(path.join(dir, 'noreceipt-'));
      const noReceipt = await runCli(key, ['--apply'], {
        input: manifest(key, authorized(key)),
        deps: { pin: authorized(key), enforceScriptGuard: (spec) => refuseUnguardedDeploy(spec, { root: emptyRoot, env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1' } }) },
      });
      assert.equal(noReceipt.spent, 0);
      assert.match(noReceipt.out, /DEPLOYMENT_GUARD_REQUIRED/);
      const noFlag = await runCli(key, ['--apply'], {
        env: {},
        input: manifest(key, authorized(key)),
        deps: { pin: authorized(key), enforceScriptGuard: () => ({ ok: true, details: { receipt: { owned_components: [COMMITTED[key].filename] } } }) },
      });
      assert.equal(noFlag.spent, 0);
      assert.match(noFlag.out, /GUARD_APPLY_FORBIDDEN/);
      const otherFile = await runCli(key, ['--apply'], {
        input: manifest(key, authorized(key)),
        deps: { pin: authorized(key), enforceScriptGuard: () => ({ ok: true, details: { receipt: { owned_components: ['aws/workflows/sql/89_check_intake_items_column_update.sql'] } } }) },
      });
      assert.equal(otherFile.spent, 0);
      assert.match(otherFile.out, /RECEIPT_MISMATCH/);
      const envBypass = await runCli(key, ['--apply'], {
        env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', CHECKSOPS_DEPLOYMENT_GUARD_BYPASS: '1', CHECKSOPS_SKIP_DEPLOYMENT_GUARD: '1' },
        input: manifest(key, authorized(key)),
        deps: { pin: authorized(key), enforceScriptGuard: (spec) => refuseUnguardedDeploy(spec, { root: emptyRoot, env: { CHECKSOPS_DEPLOYMENT_GUARD_APPLY: '1', CHECKSOPS_DEPLOYMENT_GUARD_BYPASS: '1' } }) },
      });
      assert.equal(envBypass.spent, 0);
      assert.match(envBypass.out, /DEPLOYMENT_GUARD_REQUIRED/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real guard: a staging receipt cannot authorize production; a production receipt is spent once and a refusing DB rolls back', async () => {
  const NOW = Date.parse('2026-10-17T20:00:00.000Z');
  for (const key of RELEASE_SQL_KEYS) {
    const pin = authorized(key);
    const issue = (root, overrides) => {
      const input = manifest(key, pin);
      const spec = {
        workstream_id: input.workstream_id,
        branch: 'main',
        commit: COMMIT,
        operator: 'owner',
        target_environment: 'production',
        target_component: 'production-sql',
        deployment_type: 'sql-apply',
        owned_components: [pin.filename],
        preflight_live_fingerprint: input.preflight_live_fingerprint,
        ...overrides,
      };
      const lease = acquireLease(root, {
        workstream_id: spec.workstream_id, component: spec.target_component, environment: spec.target_environment, commit: spec.commit, operator: spec.operator,
      }, NOW);
      assert.equal(lease.ok, true, lease.message);
      spec.lease = lease.details.lease;
      const issued = issueReceipt(root, spec, { now: NOW, ttlMs: 15 * 60 * 1000 });
      assert.equal(issued.ok, true, issued.message);
      return { input, receipt: issued.details.receipt };
    };
    const guardWith = (root, receipt) => (spec) => refuseUnguardedDeploy({ ...spec, receipt_path: undefined, receipt }, { root, now: NOW + 1000, env: {} });
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${key}-staging-receipt-`));
    const prodRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${key}-prod-receipt-`));
    try {
      const staging = issue(stagingRoot, { target_environment: 'staging', target_component: 'staging-sql' });
      const refused = await runCli(key, ['--apply'], { input: staging.input, deps: { pin, enforceScriptGuard: guardWith(stagingRoot, staging.receipt) } });
      assert.equal(refused.spent, 0);
      assert.match(refused.out, /RECEIPT_MISMATCH/);
      const prod = issue(prodRoot, {});
      const refusingDb = async () => ({ query: async () => { throw new Error('db-unavailable'); }, end: async () => {} });
      const valid = await runCli(key, ['--apply'], { input: prod.input, deps: { pin, enforceScriptGuard: guardWith(prodRoot, prod.receipt), connect: refusingDb } });
      assert.equal(valid.spent, 1);
      assert.match(valid.out, /rolled back/);
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      fs.rmSync(prodRoot, { recursive: true, force: true });
    }
  }
});

async function withPg(t, prefix, port, fn) {
  const reason = pgSkipReason();
  if (reason) {
    t.skip(reason);
    return;
  }
  let pg;
  try {
    pg = (await import('pg')).default;
  } catch {
    t.skip('pg module is not installed');
    return;
  }
  const fx = await releaseFixture(pg, prefix, port);
  try {
    await fn(fx);
  } finally {
    await fx.close();
  }
}

test('PostgreSQL 16: inspect is read-only with no row data; authorized copies apply once each as checksops_admin in order; the superuser is refused; out-of-scope changes roll back', { timeout: 600000 }, async (t) => withPg(t, 'pg-sql9097-prod-', 58700, async ({ admin, connectAs, applyPredecessors }) => {
  await applyPredecessors();
  const seen = [];
  const connectWith = (user) => async () => {
    const client = await connectAs(user);
    const query = client.query.bind(client);
    client.query = (sql, params) => { seen.push(String(sql)); return query(sql, params); };
    return client;
  };
  const connect = connectWith('checksops_admin');
  for (const key of ORDER) {
    seen.length = 0;
    const inspected = await inspectReleaseProduction(key, { connect, pin: LOCKED[key], root: ROOT });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const d = inspected.details;
    assert.equal(d.read_only, true);
    assert.equal(d.source_ok, true);
    assert.equal(d.pin_execute, false);
    assert.equal(d.apply_preconditions_met, false, 'no recorded pre-state');
    assert.deepEqual(d.precondition_failures, [], `${key}: ${JSON.stringify(d.release_sql_inspect)}`);
    assert.deepEqual(d.missing_dependencies, []);
    assert.equal(d.predecessors_applied, true);
    assert.equal(seen[0], 'BEGIN READ ONLY');
    assert.equal(seen.at(-1), 'ROLLBACK');
    assert.ok(seen.slice(1, -1).every((text) => READ_ONLY_STATEMENT_RE.test(text)), JSON.stringify(seen.filter((text) => !READ_ONLY_STATEMENT_RE.test(text))));
    assert.doesNotMatch(JSON.stringify(d), /Private|example\.invalid|checksopsadmin@|11111111-1111/, key);
    if (key === 'sql94') assert.deepEqual(d.counts, { rows_outside_sql94_rule: 0 });
    if (key === 'sql97') assert.deepEqual(d.release_sql_inspect.table_privileges[0].other_write_grants, []);

    const pin = authorized(key, d.live_definition_sha256);
    const asSuper = await executeReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect: connectWith('ubuntu'), consumedPath: consumedPath() });
    assert.equal(asSuper.code, CODES.DEPLOYMENT_COLLISION, key);
    assert.ok(asSuper.details.failed.includes('login_is_pinned_admin'));

    if (key === 'sql92') {
      // A file that changes anything outside its scope rolls back, before COMMIT.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sql92-prod-tampered-'));
      try {
        const tampered = `${fs.readFileSync(path.join(ROOT, pin.filename), 'utf8')}\nCREATE TABLE public.zz_unrelated (id int);\n`;
        fs.mkdirSync(path.join(tmp, path.dirname(pin.filename)), { recursive: true });
        fs.writeFileSync(path.join(tmp, pin.filename), tampered);
        const tamperedPin = { ...pin, source_sha256: sha(tampered) };
        // The committed staging pin binds the bytes, so the tool refuses before connecting ...
        assert.equal((await executeReleaseProductionApply(key, manifest(key, tamperedPin), { root: tmp, pin: tamperedPin, connect: neverConnect, consumedPath: consumedPath() })).code, CODES.SQL_COLLISION);
        // ... and the post-condition snapshot catches an out-of-scope change made inside the transaction.
        const sneaky = async () => {
          const client = await connectAs('checksops_admin');
          const query = client.query.bind(client);
          client.query = (sql, params) => (String(sql) === fs.readFileSync(path.join(ROOT, pin.filename), 'utf8')
            ? query(`${sql}\nCREATE TABLE public.zz_unrelated (id int);`, params)
            : query(sql, params));
          return client;
        };
        const rolledBack = await executeReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect: sneaky, consumedPath: consumedPath() });
        assert.equal(rolledBack.code, CODES.UNRELATED_MUTATION, JSON.stringify(rolledBack));
        assert.deepEqual(rolledBack.details.unrelated_changed, ['relations', 'columns']);
        assert.equal((await admin.query("SELECT to_regclass('public.zz_unrelated') IS NULL AS gone")).rows[0].gone, true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    const applied = await executeReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.details.receipt.after_hash, pin.intended_replacement_sha256);
    assert.doesNotMatch(JSON.stringify(applied.details.receipt), /Private|example\.invalid|checksopsadmin@/);
    const after = await inspectReleaseProduction(key, { connect, pin, root: ROOT });
    assert.equal(after.details.already_applied, true, key);
    const replay = await executeReleaseProductionApply(key, manifest(key, pin), { root: ROOT, pin, connect, consumedPath: consumedPath() });
    assert.equal(replay.code, CODES.UNRELATED_MUTATION, key);
  }
}));

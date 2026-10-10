import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateLambdaOverlay, memberDiff } from './lambda-overlay.mjs';

export const SQL53_OVERLAY_FUNCTION = 'checksops-production-prep-api';
export const SQL53_OVERLAY_LIVE_CODE_SHA256 = 'DMcCoF3dpIiULPe530F8DJ8vC1wL1BP7ayqr+e8SCyI=';
export const SQL53_OVERLAY_LIVE_REVISION_ID = 'fb17cb70-7b50-468d-a0a6-59a020c43f8c';
export const SQL53_OVERLAY_LIVE_INDEX_SHA256 = '24f13aa5ff4f3d72e7f5ff4dc45dd194796aa4e75958de5bc39c8c1dce3eb4da';
export const SQL53_OVERLAY_LIVE_VALIDATOR_SHA256 = 'ee58fd0a2ea5a4fd554012c1c331cdf369f12c82b64fb81dbc3e39e3b9161606';
export const SQL53_OVERLAY_LIVE_SECRETS_SHA256 = 'f8fa9ee63cb56bd0de49a746afbb18322c9376b0277aaf057a748f0c1ba0dba3';
export const SQL53_OVERLAY_LIVE_DB_HEALTH_SHA256 = '0eb66cecc0db49941a3d0a59789c7b16529d56794de739825b5577f51e3eac8b';
export const SQL53_OVERLAY_INSPECT_MEMBER = 'sql53-production-readonly-inspect.mjs';
export const SQL53_OVERLAY_OWNED_MEMBERS = Object.freeze(['index.mjs', SQL53_OVERLAY_INSPECT_MEMBER]);
export const SQL53_OVERLAY_ADD_MEMBERS = Object.freeze([SQL53_OVERLAY_INSPECT_MEMBER]);
export const SQL53_OVERLAY_DO_NOT_REPLACE = Object.freeze([
  'db-readonly-validate.mjs',
  'db-health.mjs',
  'secrets.mjs',
  'claim-settlement-rpc.mjs',
]);

const IMPORT_ANCHOR = "import { handleSandboxRequest } from './sandbox.mjs';\n";
const IMPORT_PATCH = `${IMPORT_ANCHOR}
import {
  handleSql53ProductionReadonlyInspect,
  isSql53ProductionReadonlyInspectEvent,
} from './sql53-production-readonly-inspect.mjs';
`;
const HANDLER_ANCHOR = `export const handler = async (event) => {
  const method = (event?.requestContext?.http?.method || event?.httpMethod || 'GET').toUpperCase();
  const path = requestPath(event);

  if (method === 'OPTIONS') {
`;
const HANDLER_PATCH = `export const handler = async (event) => {
  const method = (event?.requestContext?.http?.method || event?.httpMethod || 'GET').toUpperCase();
  const path = requestPath(event);

  if (isSql53ProductionReadonlyInspectEvent(event)) {
    const result = await handleSql53ProductionReadonlyInspect(event);
    return json(result.statusCode, result.body);
  }

  if (method === 'OPTIONS') {
`;

export function sha256Text(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

export function patchLiveProductionIndex(source) {
  const text = String(source || '');
  if (text.includes('sql53-production-readonly-inspect')) {
    throw new Error('live index.mjs already contains the SQL53 diagnostic');
  }
  if (sha256Text(text) !== SQL53_OVERLAY_LIVE_INDEX_SHA256) {
    throw new Error('live index.mjs drifted; refuse overlay');
  }
  if (!text.includes(IMPORT_ANCHOR) || text.split(IMPORT_ANCHOR).length !== 2) {
    throw new Error('live index.mjs import anchor is not unique');
  }
  if (!text.includes(HANDLER_ANCHOR) || text.split(HANDLER_ANCHOR).length !== 2) {
    throw new Error('live index.mjs handler anchor is not unique');
  }
  const patched = text.replace(IMPORT_ANCHOR, IMPORT_PATCH).replace(HANDLER_ANCHOR, HANDLER_PATCH);
  if (patched.includes("SQL53_READONLY_INSPECT_PATH") || patched.includes('GET /sql53-production-readonly-inspect')) {
    throw new Error('surgical patch must not add an HTTP route');
  }
  if (!patched.includes('isSql53ProductionReadonlyInspectEvent(event)')) {
    throw new Error('surgical patch missing direct-invoke hook');
  }
  return patched;
}

export function buildSql53OverlayCandidateMembers(liveMembers, {
  inspectSha256,
  patchedIndexSha256,
} = {}) {
  const candidate = { ...liveMembers };
  if (candidate[SQL53_OVERLAY_INSPECT_MEMBER]) {
    throw new Error('sql53 inspect member unexpectedly already live');
  }
  if (candidate['index.mjs'] !== SQL53_OVERLAY_LIVE_INDEX_SHA256) {
    throw new Error('live index.mjs hash is not the pinned production member');
  }
  if (candidate['db-readonly-validate.mjs'] !== SQL53_OVERLAY_LIVE_VALIDATOR_SHA256) {
    throw new Error('live db-readonly-validate.mjs drifted; do not replace it');
  }
  if (candidate['secrets.mjs'] !== SQL53_OVERLAY_LIVE_SECRETS_SHA256) {
    throw new Error('live secrets.mjs drifted; refuse overlay');
  }
  if (candidate['db-health.mjs'] !== SQL53_OVERLAY_LIVE_DB_HEALTH_SHA256) {
    throw new Error('live db-health.mjs drifted; refuse overlay');
  }
  candidate['index.mjs'] = patchedIndexSha256;
  candidate[SQL53_OVERLAY_INSPECT_MEMBER] = inspectSha256;
  return candidate;
}

export function evaluateSql53ProductionOverlay({
  liveMembers,
  inspectSha256,
  patchedIndexSha256,
  commit,
  branch,
  operator = 'cursor-agent',
  buildTimestamp,
  downloadedAt,
} = {}) {
  const candidateMembers = buildSql53OverlayCandidateMembers(liveMembers, {
    inspectSha256,
    patchedIndexSha256,
  });
  const now = buildTimestamp;
  const input = {
    workstream_id: 'prod-sql53-overlay-prep-3bc9',
    branch,
    commit,
    operator,
    target_environment: 'production',
    deployment_type: 'lambda-overlay',
    owned_members: [...SQL53_OVERLAY_OWNED_MEMBERS],
    owned_components: [...SQL53_OVERLAY_OWNED_MEMBERS],
    add_members: [...SQL53_OVERLAY_ADD_MEMBERS],
    preflight: {
      codeSha256: SQL53_OVERLAY_LIVE_CODE_SHA256,
      revisionId: SQL53_OVERLAY_LIVE_REVISION_ID,
    },
    preflight_live_fingerprint: {
      codeSha256: SQL53_OVERLAY_LIVE_CODE_SHA256,
      revisionId: SQL53_OVERLAY_LIVE_REVISION_ID,
    },
    immediately_before: {
      codeSha256: SQL53_OVERLAY_LIVE_CODE_SHA256,
      revisionId: SQL53_OVERLAY_LIVE_REVISION_ID,
    },
    build_timestamp: now,
    package: {
      origin: 'fresh-live-download',
      downloaded_at: downloadedAt || now,
      preflight_at: now,
    },
    live_members: liveMembers,
    candidate_members: candidateMembers,
  };
  const evaluation = evaluateLambdaOverlay(input);
  const diff = memberDiff(liveMembers, candidateMembers);
  return { input, evaluation, diff };
}

export function repoSql53InspectSha256(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')) {
  return createHash('sha256')
    .update(fs.readFileSync(path.join(root, 'aws/functions/api', SQL53_OVERLAY_INSPECT_MEMBER)))
    .digest('hex');
}

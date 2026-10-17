/**
 * RETIRED stub (release 2026-10-17). The Freedom Claims bridge is removed; the
 * ingest-shared-check route is gone from the new app-services.mjs. This module
 * stays only so a live app-services.mjs from before this release keeps loading
 * while the production overlay runs one file at a time. It exports the same
 * names as the old module, runs no SQL and touches no storage: the handler
 * answers 410, every helper throws. Delete it in a later release, once every
 * live app-services.mjs is the new one (and before SQL 95 is no longer needed).
 */
const retired = () => {
  throw new Error('ingest_shared_check_retired');
};

export const NATIVE_TENANT_MAP = Object.freeze({});
export const toStandardCaps = retired;
export const humanizeStatus = retired;
export const resolveSignedAt = retired;
export const normalizePayeeStatus = retired;
export const normalizePayeeType = retired;
export const normalizeEndorsementStatus = retired;
export const derivePartnerStatusFromPayees = retired;
export const derivePartnerStatus = retired;
export const expectedBridgeSecret = () => '';
export const bridgeSecretMatches = () => false;
export const copyRemoteImageLocally = retired;
export const buildIngestPlan = retired;
export const persistIngestInline = retired;
export const persistIngest = retired;

export const handleIngestSharedCheck = async () => ({
  ok: false,
  statusCode: 410,
  error: 'route_retired',
  message: 'ingest-shared-check is retired with the Freedom Claims bridge.',
});

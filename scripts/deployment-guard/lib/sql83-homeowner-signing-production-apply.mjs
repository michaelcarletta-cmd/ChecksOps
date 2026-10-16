/**
 * Production apply of SQL 83 (CREATE OR REPLACE of the homeowner endorse,
 * pending-signatures and document-sign doorways, REVOKE ALL FROM PUBLIC and
 * authenticated, GRANT EXECUTE TO checksops). The rules live in
 * ./homeowner-sql-production-apply.mjs, shared with SQL 82; this module binds
 * them to SQL 83's pin and names, in the shape of SQL 81's tool.
 */
import {
  HOMEOWNER_PRODUCTION,
  HOMEOWNER_PRODUCTION_COMPONENT,
  HOMEOWNER_PRODUCTION_DEPLOYMENT_TYPE,
  createProductionDatabaseConnect,
  evaluateHomeownerProductionApply,
  executeHomeownerProductionApply,
  homeownerFunctionOwner,
  homeownerIntendedFunctionAcl,
  homeownerProductionPostconditionFailures,
  homeownerProductionPreconditionFailures,
  inspectHomeownerProduction,
  loadHomeownerProductionPin,
  precheckHomeownerProductionApply,
  readHomeownerUnrelatedSnapshot,
  readPinnedHomeownerSql,
  resolveHomeownerDatabaseUrl,
} from './homeowner-sql-production-apply.mjs';
import { repoRootFrom } from './paths.mjs';

const KEY = 'sql83';
export const SQL83_PRODUCTION_COMPONENT = HOMEOWNER_PRODUCTION_COMPONENT;
export const SQL83_PRODUCTION_DEPLOYMENT_TYPE = HOMEOWNER_PRODUCTION_DEPLOYMENT_TYPE;
export const SQL83_PRODUCTION_PIN_REL = 'ops/deployment-guard/sql83-homeowner-signing-capabilities-production-apply.json';
export const SQL83_STAGING_PIN = HOMEOWNER_PRODUCTION[KEY].staging_pin;
if (HOMEOWNER_PRODUCTION[KEY].pin_rel !== SQL83_PRODUCTION_PIN_REL) throw new Error('SQL 83 pin path mismatch');

export const sql83FunctionOwner = homeownerFunctionOwner;
export const sql83IntendedFunctionAcl = homeownerIntendedFunctionAcl;
export const loadSql83ProductionPin = (root = repoRootFrom(import.meta.url)) => loadHomeownerProductionPin(KEY, root);
export const readPinnedSql83 = (root, pin) => readPinnedHomeownerSql(KEY, root, pin);
export const evaluateSql83ProductionApply = (input, opts = {}) => evaluateHomeownerProductionApply(KEY, input, { root: repoRootFrom(import.meta.url), ...opts });
export const inspectSql83Production = ({ root = repoRootFrom(import.meta.url), ...opts } = {}) => inspectHomeownerProduction(KEY, { root, ...opts });
export const precheckSql83ProductionApply = (input, ctx = {}) => precheckHomeownerProductionApply(KEY, input, ctx);
export const executeSql83ProductionApply = (input, ctx = {}) => executeHomeownerProductionApply(KEY, input, ctx);
export const sql83ProductionPreconditionFailures = (state, pin, executor) => homeownerProductionPreconditionFailures(KEY, state, pin, executor);
export const sql83ProductionPostconditionFailures = (after, pin, reviewed, executor) => homeownerProductionPostconditionFailures(KEY, after, pin, reviewed, executor);
export const readSql83UnrelatedSnapshot = (client) => readHomeownerUnrelatedSnapshot(client, KEY);
export const resolveSql83DatabaseUrl = resolveHomeownerDatabaseUrl;

export { createProductionDatabaseConnect };

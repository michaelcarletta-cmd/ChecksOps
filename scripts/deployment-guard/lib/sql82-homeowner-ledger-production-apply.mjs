/**
 * Production apply of SQL 82 (CREATE OR REPLACE of
 * public.aws_public_homeowner_ledger_by_token(text), REVOKE ALL FROM PUBLIC and
 * authenticated, GRANT EXECUTE TO checksops). The rules live in
 * ./homeowner-sql-production-apply.mjs, shared with SQL 83; this module binds
 * them to SQL 82's pin and names, in the shape of SQL 81's tool.
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

const KEY = 'sql82';
export const SQL82_PRODUCTION_COMPONENT = HOMEOWNER_PRODUCTION_COMPONENT;
export const SQL82_PRODUCTION_DEPLOYMENT_TYPE = HOMEOWNER_PRODUCTION_DEPLOYMENT_TYPE;
export const SQL82_PRODUCTION_PIN_REL = 'ops/deployment-guard/sql82-homeowner-ledger-view-production-apply.json';
export const SQL82_STAGING_PIN = HOMEOWNER_PRODUCTION[KEY].staging_pin;
if (HOMEOWNER_PRODUCTION[KEY].pin_rel !== SQL82_PRODUCTION_PIN_REL) throw new Error('SQL 82 pin path mismatch');

export const sql82FunctionOwner = homeownerFunctionOwner;
export const sql82IntendedFunctionAcl = homeownerIntendedFunctionAcl;
export const loadSql82ProductionPin = (root = repoRootFrom(import.meta.url)) => loadHomeownerProductionPin(KEY, root);
export const readPinnedSql82 = (root, pin) => readPinnedHomeownerSql(KEY, root, pin);
export const evaluateSql82ProductionApply = (input, opts = {}) => evaluateHomeownerProductionApply(KEY, input, { root: repoRootFrom(import.meta.url), ...opts });
export const inspectSql82Production = ({ root = repoRootFrom(import.meta.url), ...opts } = {}) => inspectHomeownerProduction(KEY, { root, ...opts });
export const precheckSql82ProductionApply = (input, ctx = {}) => precheckHomeownerProductionApply(KEY, input, ctx);
export const executeSql82ProductionApply = (input, ctx = {}) => executeHomeownerProductionApply(KEY, input, ctx);
export const sql82ProductionPreconditionFailures = (state, pin, executor) => homeownerProductionPreconditionFailures(KEY, state, pin, executor);
export const sql82ProductionPostconditionFailures = (after, pin, reviewed, executor) => homeownerProductionPostconditionFailures(KEY, after, pin, reviewed, executor);
export const readSql82UnrelatedSnapshot = (client) => readHomeownerUnrelatedSnapshot(client, KEY);
export const resolveSql82DatabaseUrl = resolveHomeownerDatabaseUrl;

export { createProductionDatabaseConnect };

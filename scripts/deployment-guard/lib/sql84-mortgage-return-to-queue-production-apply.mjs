/**
 * Production apply of SQL 84 (public.return_mortgage_handling_request_to_queue(uuid,
 * text), the public.mortgage_ops_request_audit table, its policy and grants, and SQL
 * 84's per-check unique gate on check_billing_events). The rules live in
 * ./mortgage-sql-production-apply.mjs, shared with the other two mortgage tools; this
 * module binds them to SQL 84's pin and names, in the shape of SQL 82's tool.
 */
import {
  MORTGAGE_PRODUCTION,
  MORTGAGE_PRODUCTION_COMPONENT,
  MORTGAGE_PRODUCTION_DEPLOYMENT_TYPE,
  createProductionDatabaseConnect,
  evaluateMortgageProductionApply,
  executeMortgageProductionApply,
  inspectMortgageProduction,
  loadMortgageProductionPin,
  mortgageIntendedFunctionAcl,
  mortgageObjectOwner,
  mortgageProductionPostconditionFailures,
  mortgageProductionPreconditionFailures,
  precheckMortgageProductionApply,
  readMortgageUnrelatedSnapshot,
  readPinnedMortgageSql,
  resolveMortgageDatabaseUrl,
} from './mortgage-sql-production-apply.mjs';
import { repoRootFrom } from './paths.mjs';

const KEY = 'sql84';
export const SQL84_PRODUCTION_COMPONENT = MORTGAGE_PRODUCTION_COMPONENT;
export const SQL84_PRODUCTION_DEPLOYMENT_TYPE = MORTGAGE_PRODUCTION_DEPLOYMENT_TYPE;
export const SQL84_PRODUCTION_PIN_REL = 'ops/deployment-guard/sql84-mortgage-return-to-queue-production-apply.json';
export const SQL84_STAGING_PIN = MORTGAGE_PRODUCTION[KEY].staging_pin;
if (MORTGAGE_PRODUCTION[KEY].pin_rel !== SQL84_PRODUCTION_PIN_REL) throw new Error('SQL 84 pin path mismatch');

export const sql84ObjectOwner = mortgageObjectOwner;
export const sql84IntendedFunctionAcl = mortgageIntendedFunctionAcl;
export const loadSql84ProductionPin = (root = repoRootFrom(import.meta.url)) => loadMortgageProductionPin(KEY, root);
export const readPinnedSql84 = (root, pin) => readPinnedMortgageSql(KEY, root, pin);
export const evaluateSql84ProductionApply = (input, opts = {}) => evaluateMortgageProductionApply(KEY, input, { root: repoRootFrom(import.meta.url), ...opts });
export const inspectSql84Production = ({ root = repoRootFrom(import.meta.url), ...opts } = {}) => inspectMortgageProduction(KEY, { root, ...opts });
export const precheckSql84ProductionApply = (input, ctx = {}) => precheckMortgageProductionApply(KEY, input, ctx);
export const executeSql84ProductionApply = (input, ctx = {}) => executeMortgageProductionApply(KEY, input, ctx);
export const sql84ProductionPreconditionFailures = (state, pin, executor) => mortgageProductionPreconditionFailures(KEY, state, pin, executor);
export const sql84ProductionPostconditionFailures = (after, pin, reviewed, executor, before) => mortgageProductionPostconditionFailures(KEY, after, pin, reviewed, executor, before);
export const readSql84UnrelatedSnapshot = (client, executor) => readMortgageUnrelatedSnapshot(client, KEY, executor);
export const resolveSql84DatabaseUrl = resolveMortgageDatabaseUrl;

export { createProductionDatabaseConnect };

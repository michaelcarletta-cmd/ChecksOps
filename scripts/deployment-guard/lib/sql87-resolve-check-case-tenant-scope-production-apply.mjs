/**
 * Production apply of SQL 87 (CREATE OR REPLACE of
 * public.resolve_check_case(uuid, uuid, uuid, text, text, text, text), scoped to its
 * tenant, with EXECUTE left to its owner: the SECURITY DEFINER trigger functions
 * tg_check_intake_assign_case() and tg_loss_draft_assign_case()). The rules live in
 * ./mortgage-sql-production-apply.mjs (SQL 86's shape, shared with SQL 84-86); this
 * module binds them to SQL 87's pin and names.
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

const KEY = 'sql87';
export const SQL87_PRODUCTION_COMPONENT = MORTGAGE_PRODUCTION_COMPONENT;
export const SQL87_PRODUCTION_DEPLOYMENT_TYPE = MORTGAGE_PRODUCTION_DEPLOYMENT_TYPE;
export const SQL87_PRODUCTION_PIN_REL = 'ops/deployment-guard/sql87-resolve-check-case-tenant-scope-production-apply.json';
export const SQL87_STAGING_PIN = MORTGAGE_PRODUCTION[KEY].staging_pin;
if (MORTGAGE_PRODUCTION[KEY].pin_rel !== SQL87_PRODUCTION_PIN_REL) throw new Error('SQL 87 pin path mismatch');

export const sql87ObjectOwner = mortgageObjectOwner;
export const sql87IntendedFunctionAcl = mortgageIntendedFunctionAcl;
export const loadSql87ProductionPin = (root = repoRootFrom(import.meta.url)) => loadMortgageProductionPin(KEY, root);
export const readPinnedSql87 = (root, pin) => readPinnedMortgageSql(KEY, root, pin);
export const evaluateSql87ProductionApply = (input, opts = {}) => evaluateMortgageProductionApply(KEY, input, { root: repoRootFrom(import.meta.url), ...opts });
export const inspectSql87Production = ({ root = repoRootFrom(import.meta.url), ...opts } = {}) => inspectMortgageProduction(KEY, { root, ...opts });
export const precheckSql87ProductionApply = (input, ctx = {}) => precheckMortgageProductionApply(KEY, input, ctx);
export const executeSql87ProductionApply = (input, ctx = {}) => executeMortgageProductionApply(KEY, input, ctx);
export const sql87ProductionPreconditionFailures = (state, pin, executor) => mortgageProductionPreconditionFailures(KEY, state, pin, executor);
export const sql87ProductionPostconditionFailures = (after, pin, reviewed, executor, before) => mortgageProductionPostconditionFailures(KEY, after, pin, reviewed, executor, before);
export const readSql87UnrelatedSnapshot = (client, executor) => readMortgageUnrelatedSnapshot(client, KEY, executor);
export const resolveSql87DatabaseUrl = resolveMortgageDatabaseUrl;

export { createProductionDatabaseConnect };

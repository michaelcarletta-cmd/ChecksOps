/**
 * Production apply of SQL 88 (CREATE OR REPLACE of the trigger function
 * public.tg_claim_id_assign_case(), scoped to the row's tenant, with EXECUTE left to its
 * owner, behind an owner guard over the SQL 87 case helper and the SECURITY DEFINER case
 * trigger functions). The rules live in ./mortgage-sql-production-apply.mjs (SQL 87's
 * shape, shared with SQL 84-87); this module binds them to SQL 88's pin and names.
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

const KEY = 'sql88';
export const SQL88_PRODUCTION_COMPONENT = MORTGAGE_PRODUCTION_COMPONENT;
export const SQL88_PRODUCTION_DEPLOYMENT_TYPE = MORTGAGE_PRODUCTION_DEPLOYMENT_TYPE;
export const SQL88_PRODUCTION_PIN_REL = 'ops/deployment-guard/sql88-claim-id-assign-case-tenant-scope-production-apply.json';
export const SQL88_STAGING_PIN = MORTGAGE_PRODUCTION[KEY].staging_pin;
if (MORTGAGE_PRODUCTION[KEY].pin_rel !== SQL88_PRODUCTION_PIN_REL) throw new Error('SQL 88 pin path mismatch');

export const sql88ObjectOwner = mortgageObjectOwner;
export const sql88IntendedFunctionAcl = mortgageIntendedFunctionAcl;
export const loadSql88ProductionPin = (root = repoRootFrom(import.meta.url)) => loadMortgageProductionPin(KEY, root);
export const readPinnedSql88 = (root, pin) => readPinnedMortgageSql(KEY, root, pin);
export const evaluateSql88ProductionApply = (input, opts = {}) => evaluateMortgageProductionApply(KEY, input, { root: repoRootFrom(import.meta.url), ...opts });
export const inspectSql88Production = ({ root = repoRootFrom(import.meta.url), ...opts } = {}) => inspectMortgageProduction(KEY, { root, ...opts });
export const precheckSql88ProductionApply = (input, ctx = {}) => precheckMortgageProductionApply(KEY, input, ctx);
export const executeSql88ProductionApply = (input, ctx = {}) => executeMortgageProductionApply(KEY, input, ctx);
export const sql88ProductionPreconditionFailures = (state, pin, executor) => mortgageProductionPreconditionFailures(KEY, state, pin, executor);
export const sql88ProductionPostconditionFailures = (after, pin, reviewed, executor, before) => mortgageProductionPostconditionFailures(KEY, after, pin, reviewed, executor, before);
export const readSql88UnrelatedSnapshot = (client, executor) => readMortgageUnrelatedSnapshot(client, KEY, executor);
export const resolveSql88DatabaseUrl = resolveMortgageDatabaseUrl;

export { createProductionDatabaseConnect };

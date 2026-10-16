/**
 * Production apply of SQL 85 (public.adjust_mortgage_agent_compensation(uuid, integer,
 * text, uuid, text, text), dropping the Cursor SQL 49 five-argument signature, the
 * adjustment_reason and idempotency_key columns, their indexes and the adjust
 * action CHECK). The rules live in
 * ./mortgage-sql-production-apply.mjs, shared with the other two mortgage tools; this
 * module binds them to SQL 85's pin and names, in the shape of SQL 82's tool.
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

const KEY = 'sql85';
export const SQL85_PRODUCTION_COMPONENT = MORTGAGE_PRODUCTION_COMPONENT;
export const SQL85_PRODUCTION_DEPLOYMENT_TYPE = MORTGAGE_PRODUCTION_DEPLOYMENT_TYPE;
export const SQL85_PRODUCTION_PIN_REL = 'ops/deployment-guard/sql85-mortgage-compensation-adjust-production-apply.json';
export const SQL85_STAGING_PIN = MORTGAGE_PRODUCTION[KEY].staging_pin;
if (MORTGAGE_PRODUCTION[KEY].pin_rel !== SQL85_PRODUCTION_PIN_REL) throw new Error('SQL 85 pin path mismatch');

export const sql85ObjectOwner = mortgageObjectOwner;
export const sql85IntendedFunctionAcl = mortgageIntendedFunctionAcl;
export const loadSql85ProductionPin = (root = repoRootFrom(import.meta.url)) => loadMortgageProductionPin(KEY, root);
export const readPinnedSql85 = (root, pin) => readPinnedMortgageSql(KEY, root, pin);
export const evaluateSql85ProductionApply = (input, opts = {}) => evaluateMortgageProductionApply(KEY, input, { root: repoRootFrom(import.meta.url), ...opts });
export const inspectSql85Production = ({ root = repoRootFrom(import.meta.url), ...opts } = {}) => inspectMortgageProduction(KEY, { root, ...opts });
export const precheckSql85ProductionApply = (input, ctx = {}) => precheckMortgageProductionApply(KEY, input, ctx);
export const executeSql85ProductionApply = (input, ctx = {}) => executeMortgageProductionApply(KEY, input, ctx);
export const sql85ProductionPreconditionFailures = (state, pin, executor) => mortgageProductionPreconditionFailures(KEY, state, pin, executor);
export const sql85ProductionPostconditionFailures = (after, pin, reviewed, executor, before) => mortgageProductionPostconditionFailures(KEY, after, pin, reviewed, executor, before);
export const readSql85UnrelatedSnapshot = (client, executor) => readMortgageUnrelatedSnapshot(client, KEY, executor);
export const resolveSql85DatabaseUrl = resolveMortgageDatabaseUrl;

export { createProductionDatabaseConnect };

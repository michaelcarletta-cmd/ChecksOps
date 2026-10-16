/**
 * Production apply of SQL 86 (CREATE OR REPLACE of
 * public.aws_can_admin_mortgage_agent_compensation() and
 * public.mortgage_agent_compensation_reconciliation(text), and EXECUTE on
 * public.earn_mortgage_agent_compensation(uuid) left to its owner). The rules live in
 * ./mortgage-sql-production-apply.mjs, shared with the other two mortgage tools; this
 * module binds them to SQL 86's pin and names, in the shape of SQL 82's tool.
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

const KEY = 'sql86';
export const SQL86_PRODUCTION_COMPONENT = MORTGAGE_PRODUCTION_COMPONENT;
export const SQL86_PRODUCTION_DEPLOYMENT_TYPE = MORTGAGE_PRODUCTION_DEPLOYMENT_TYPE;
export const SQL86_PRODUCTION_PIN_REL = 'ops/deployment-guard/sql86-mortgage-compensation-owner-only-production-apply.json';
export const SQL86_STAGING_PIN = MORTGAGE_PRODUCTION[KEY].staging_pin;
if (MORTGAGE_PRODUCTION[KEY].pin_rel !== SQL86_PRODUCTION_PIN_REL) throw new Error('SQL 86 pin path mismatch');

export const sql86ObjectOwner = mortgageObjectOwner;
export const sql86IntendedFunctionAcl = mortgageIntendedFunctionAcl;
export const loadSql86ProductionPin = (root = repoRootFrom(import.meta.url)) => loadMortgageProductionPin(KEY, root);
export const readPinnedSql86 = (root, pin) => readPinnedMortgageSql(KEY, root, pin);
export const evaluateSql86ProductionApply = (input, opts = {}) => evaluateMortgageProductionApply(KEY, input, { root: repoRootFrom(import.meta.url), ...opts });
export const inspectSql86Production = ({ root = repoRootFrom(import.meta.url), ...opts } = {}) => inspectMortgageProduction(KEY, { root, ...opts });
export const precheckSql86ProductionApply = (input, ctx = {}) => precheckMortgageProductionApply(KEY, input, ctx);
export const executeSql86ProductionApply = (input, ctx = {}) => executeMortgageProductionApply(KEY, input, ctx);
export const sql86ProductionPreconditionFailures = (state, pin, executor) => mortgageProductionPreconditionFailures(KEY, state, pin, executor);
export const sql86ProductionPostconditionFailures = (after, pin, reviewed, executor, before) => mortgageProductionPostconditionFailures(KEY, after, pin, reviewed, executor, before);
export const readSql86UnrelatedSnapshot = (client, executor) => readMortgageUnrelatedSnapshot(client, KEY, executor);
export const resolveSql86DatabaseUrl = resolveMortgageDatabaseUrl;

export { createProductionDatabaseConnect };

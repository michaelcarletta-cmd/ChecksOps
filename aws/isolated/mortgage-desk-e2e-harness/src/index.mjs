import { WRITE_ACTIONS } from './constants.mjs';
import { refuseWriteAction } from './fail-closed.mjs';
import { runReadOnlyInvestigate } from './investigate.mjs';
import { runReadOnlyPreflight } from './preflight.mjs';
import { captureApplicationShas, refuseOnShaDrift } from './sha-invariants.mjs';
import { getSecretStringFromAws } from './db.mjs';

const READONLY_ACTIONS = new Set(['preflight', 'investigate']);

const parseEvent = (event = {}) => {
  if (!event || typeof event !== 'object') return { action: 'preflight' };
  if (typeof event.body === 'string' && event.body.trim()) {
    try {
      const parsed = JSON.parse(event.body);
      return { action: parsed.action || event.action || 'preflight', ...parsed };
    } catch {
      return { action: event.action || 'preflight' };
    }
  }
  return { action: event.action || 'preflight', ...event };
};

export const handler = async (event = {}, deps = {}) => {
  const body = parseEvent(event);
  const action = String(body.action || 'preflight').trim();
  const captureShas = deps.captureApplicationShas || captureApplicationShas;
  const getSecretString = deps.getSecretString || getSecretStringFromAws;
  const fetchImpl = deps.fetchImpl || fetch;

  const shas = await captureShas();
  const drift = refuseOnShaDrift(shas);
  if (drift) {
    return { ...drift, action, rowsCreated: 0, rowsUpdated: 0, rowsDeleted: 0 };
  }

  if (WRITE_ACTIONS.has(action)) {
    return {
      ...refuseWriteAction(action),
      shas,
      authorization: 'READ-ONLY preflight only. Synthetic writes are not approved.',
    };
  }

  if (!READONLY_ACTIONS.has(action)) {
    return {
      ok: false,
      statusCode: 400,
      error: 'unknown_action',
      action,
      allowed: [...READONLY_ACTIONS],
      refused: [...WRITE_ACTIONS],
      shas,
    };
  }

  if (action === 'investigate') {
    return runReadOnlyInvestigate({
      shas,
      getSecretString,
      openClient: deps.openClient,
    });
  }

  return runReadOnlyPreflight({
    shas,
    getSecretString,
    fetchImpl,
    openClient: deps.openClient,
  });
};

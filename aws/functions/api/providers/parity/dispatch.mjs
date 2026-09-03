import { classifyFunction } from '../catalog.mjs';
import { MOOV_PARITY_HANDLERS } from './moov-functions.mjs';
import { CHECKALT_PARITY_HANDLERS } from './checkalt-functions.mjs';

export const PARITY_HANDLERS = {
  ...MOOV_PARITY_HANDLERS,
  ...CHECKALT_PARITY_HANDLERS,
};

export const hasParityHandler = (name) => Boolean(PARITY_HANDLERS[name]);

export const runParityHandler = (name, event, deps = {}) => {
  const spec = classifyFunction(name);
  const handler = PARITY_HANDLERS[name];
  if (!handler) return null;
  return handler(event, { ...deps, spec });
};

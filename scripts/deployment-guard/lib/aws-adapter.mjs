import { CODES, GuardError } from './errors.mjs';

const WRITE_METHODS = Object.freeze([
  'updateFunctionCode',
  'updateFunctionConfiguration',
  'putObject',
  'createInvalidation',
  'applySql',
  'createFunction',
  'publishVersion',
]);

const READ_METHODS = Object.freeze([
  'getFunction',
  'getFunctionConfiguration',
  'downloadFunctionCode',
  'getObject',
  'describeFunction',
  'readSqlDefinition',
]);

function forbidden(method, kind) {
  return () => {
    throw new GuardError(
      CODES.GUARD_NO_AWS,
      `Deployment guard ${kind} adapter refuses ${method}. Guard evaluation never calls live AWS.`,
      { method, kind },
    );
  };
}

export function createForbiddenAwsAdapter() {
  const adapter = {
    kind: 'forbidden',
    calls: [],
  };
  for (const method of [...READ_METHODS, ...WRITE_METHODS]) {
    adapter[method] = (...args) => {
      adapter.calls.push({ method, args, at: new Date().toISOString() });
      return forbidden(method, 'forbidden')();
    };
  }
  return adapter;
}

export function createRecordingAwsAdapter(impl = {}) {
  const calls = [];
  const adapter = { kind: 'recording', calls };
  for (const method of [...READ_METHODS, ...WRITE_METHODS]) {
    adapter[method] = (...args) => {
      calls.push({ method, args, at: new Date().toISOString() });
      if (typeof impl[method] === 'function') return impl[method](...args);
      throw new GuardError(
        CODES.GUARD_NO_AWS,
        `Recording adapter has no implementation for ${method}`,
        { method },
      );
    };
  }
  return adapter;
}

export function assertNoLiveAwsCalls(adapter) {
  const writes = (adapter?.calls || []).filter((row) => WRITE_METHODS.includes(row.method));
  if (writes.length) {
    throw new GuardError(
      CODES.GUARD_NO_AWS,
      `Guard test/default path recorded AWS write calls: ${writes.map((row) => row.method).join(', ')}`,
      { writes },
    );
  }
  return true;
}

export const AWS_WRITE_METHODS = WRITE_METHODS;
export const AWS_READ_METHODS = READ_METHODS;

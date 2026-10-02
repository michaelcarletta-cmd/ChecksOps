import { CODES, GuardError, fail, ok } from './errors.mjs';

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
  'headObject',
  'describeFunction',
  'readSqlDefinition',
]);

const DEFAULT_REGION = 'us-east-1';

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

function asResult(value) {
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'ok')) {
    return value;
  }
  return ok(value || {});
}

function wrapError(method, error) {
  return fail(
    CODES.DEPLOYMENT_COLLISION,
    `live AWS adapter ${method} failed`,
    { method, error: error?.name || error?.code || error?.message || String(error) },
  );
}

async function loadSdk(specifier) {
  return import(specifier);
}

/**
 * Live AWS SDK adapter. Importing this module does not construct clients or
 * call AWS. Mutation methods stay closed until authorizeWrites() after the
 * calling guarded writer has passed receipt/lease/preflight checks.
 *
 * Inject `clients` / `fetchImpl` in tests. Production use relies on the SDK
 * default credential provider chain (the same env/role model as existing
 * guarded writers).
 */
export function createLiveAwsAdapter({
  region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_REGION,
  clients = {},
  fetchImpl = null,
  authorized = false,
  loadSdkImpl = loadSdk,
} = {}) {
  const adapter = {
    kind: 'live',
    calls: [],
    writesAuthorized: authorized === true,
    region,
  };

  const injected = {
    lambda: Boolean(clients.lambda),
    s3: Boolean(clients.s3),
    cloudfront: Boolean(clients.cloudfront),
  };
  const lazy = {
    lambda: clients.lambda || null,
    s3: clients.s3 || null,
    cloudfront: clients.cloudfront || null,
  };

  adapter.authorizeWrites = (details = {}) => {
    adapter.writesAuthorized = true;
    adapter.calls.push({ method: 'authorizeWrites', args: [details], at: new Date().toISOString() });
    return ok({ authorized: true, ...details });
  };

  adapter.revokeWrites = () => {
    adapter.writesAuthorized = false;
    return ok({ authorized: false });
  };

  async function sendLambda(operation, params) {
    if (injected.lambda) {
      return lazy.lambda.send({ operation, input: params });
    }
    const mod = await loadSdkImpl('@aws-sdk/client-lambda');
    if (!lazy.lambda) lazy.lambda = new mod.LambdaClient({ region });
    const Command = {
      GetFunction: mod.GetFunctionCommand,
      GetFunctionConfiguration: mod.GetFunctionConfigurationCommand,
      UpdateFunctionCode: mod.UpdateFunctionCodeCommand,
    }[operation];
    if (!Command) throw new Error(`unsupported Lambda operation ${operation}`);
    return lazy.lambda.send(new Command(params));
  }

  async function sendS3(operation, params) {
    if (injected.s3) {
      return lazy.s3.send({ operation, input: params });
    }
    const mod = await loadSdkImpl('@aws-sdk/client-s3');
    if (!lazy.s3) lazy.s3 = new mod.S3Client({ region });
    const Command = {
      GetObject: mod.GetObjectCommand,
      HeadObject: mod.HeadObjectCommand,
      PutObject: mod.PutObjectCommand,
    }[operation];
    if (!Command) throw new Error(`unsupported S3 operation ${operation}`);
    return lazy.s3.send(new Command(params));
  }

  async function sendCloudFront(operation, params) {
    if (injected.cloudfront) {
      return lazy.cloudfront.send({ operation, input: params });
    }
    const mod = await loadSdkImpl('@aws-sdk/client-cloudfront');
    if (!lazy.cloudfront) lazy.cloudfront = new mod.CloudFrontClient({ region });
    return lazy.cloudfront.send(new mod.CreateInvalidationCommand(params));
  }

  function requireWriteAuth(method) {
    if (adapter.writesAuthorized) return null;
    return fail(
      CODES.GUARD_APPLY_FORBIDDEN,
      `live adapter refuses ${method} until the guarded writer authorizes writes after receipt/lease/preflight`,
      { method },
    );
  }

  function record(method, args) {
    adapter.calls.push({ method, args, at: new Date().toISOString() });
  }

  adapter.getFunction = async (input = {}) => {
    record('getFunction', [input]);
    try {
      const res = await sendLambda('GetFunction', { FunctionName: input.functionName });
      const configuration = res?.Configuration || {};
      return ok({
        function_name: input.functionName,
        codeSha256: configuration.CodeSha256 || null,
        revisionId: configuration.RevisionId || null,
        lastModified: configuration.LastModified || null,
        configuration,
        code_location: res?.Code?.Location || null,
      });
    } catch (error) {
      return wrapError('getFunction', error);
    }
  };

  adapter.getFunctionConfiguration = async (input = {}) => {
    record('getFunctionConfiguration', [input]);
    try {
      const res = await sendLambda('GetFunctionConfiguration', {
        FunctionName: input.functionName,
      });
      return ok({
        function_name: input.functionName,
        codeSha256: res?.CodeSha256 || null,
        revisionId: res?.RevisionId || null,
        lastUpdateStatus: res?.LastUpdateStatus || null,
        configuration: res || {},
        Role: res?.Role,
        Runtime: res?.Runtime,
        Handler: res?.Handler,
        MemorySize: res?.MemorySize,
        Timeout: res?.Timeout,
        Environment: res?.Environment,
        VpcConfig: res?.VpcConfig,
        LastModified: res?.LastModified,
      });
    } catch (error) {
      return wrapError('getFunctionConfiguration', error);
    }
  };

  adapter.describeFunction = async (input = {}) => adapter.getFunctionConfiguration(input);

  adapter.downloadFunctionCode = async (input = {}) => {
    record('downloadFunctionCode', [{ functionName: input.functionName, location: input.location || null }]);
    try {
      let location = input.location || null;
      if (!location) {
        const live = await adapter.getFunction({ functionName: input.functionName });
        if (!live.ok) return live;
        location = live.details.code_location;
      }
      if (!location) {
        return fail(CODES.DEPLOYMENT_COLLISION, 'live Lambda code location is missing');
      }
      const fetchFn = fetchImpl || (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);
      if (!fetchFn) {
        return fail(CODES.INVALID_MANIFEST, 'downloadFunctionCode requires fetchImpl');
      }
      const res = await fetchFn(location);
      if (!res?.ok) {
        return fail(CODES.DEPLOYMENT_COLLISION, 'failed to download current live Lambda ZIP', {
          status: res?.status || null,
        });
      }
      const zip = Buffer.from(await res.arrayBuffer());
      return ok({
        zip,
        bytes: zip.length,
        origin: 'fresh-live-download',
      });
    } catch (error) {
      return wrapError('downloadFunctionCode', error);
    }
  };

  adapter.updateFunctionCode = async (input = {}) => {
    record('updateFunctionCode', [{ functionName: input.functionName, revisionId: input.revisionId || null }]);
    const blocked = requireWriteAuth('updateFunctionCode');
    if (blocked) return blocked;
    if (!input.revisionId) {
      return fail(CODES.DEPLOYMENT_COLLISION, 'UpdateFunctionCode requires RevisionId CAS');
    }
    if (input.restore === true || input.reclaim === true) {
      return fail(CODES.STALE_PACKAGE, 'live adapter refuses restore/reclaim UpdateFunctionCode');
    }
    try {
      const res = await sendLambda('UpdateFunctionCode', {
        FunctionName: input.functionName,
        ZipFile: input.zip,
        RevisionId: input.revisionId,
      });
      return asResult({
        function_name: input.functionName,
        codeSha256: res?.CodeSha256 || null,
        revisionId: res?.RevisionId || null,
        lastUpdateStatus: res?.LastUpdateStatus || null,
      });
    } catch (error) {
      return wrapError('updateFunctionCode', error);
    }
  };

  adapter.updateFunctionConfiguration = async (input = {}) => {
    record('updateFunctionConfiguration', [input]);
    const blocked = requireWriteAuth('updateFunctionConfiguration');
    if (blocked) return blocked;
    return fail(
      CODES.UNRELATED_MUTATION,
      'live adapter refuses UpdateFunctionConfiguration; overlay apply must not replace environment/configuration',
      { functionName: input.functionName || null },
    );
  };

  adapter.createFunction = async (input = {}) => {
    record('createFunction', [input]);
    const blocked = requireWriteAuth('createFunction');
    if (blocked) return blocked;
    return fail(CODES.UNRELATED_MUTATION, 'live adapter refuses CreateFunction');
  };

  adapter.publishVersion = async (input = {}) => {
    record('publishVersion', [input]);
    const blocked = requireWriteAuth('publishVersion');
    if (blocked) return blocked;
    return fail(CODES.UNRELATED_MUTATION, 'live adapter refuses PublishVersion');
  };

  adapter.applySql = async (input = {}) => {
    record('applySql', [input]);
    const blocked = requireWriteAuth('applySql');
    if (blocked) return blocked;
    return fail(CODES.UNRELATED_MUTATION, 'live adapter refuses direct SQL; use the guarded SQL executor');
  };

  adapter.getObject = async (input = {}) => {
    record('getObject', [input]);
    try {
      const res = await sendS3('GetObject', {
        Bucket: input.bucket,
        Key: input.key,
      });
      const body = res?.Body?.transformToByteArray
        ? Buffer.from(await res.Body.transformToByteArray())
        : Buffer.from(await (res?.Body?.arrayBuffer?.() || Buffer.alloc(0)));
      return ok({
        bucket: input.bucket,
        key: input.key,
        body,
        etag: String(res?.ETag || '').replaceAll('"', ''),
        versionId: res?.VersionId || null,
      });
    } catch (error) {
      return wrapError('getObject', error);
    }
  };

  adapter.headObject = async (input = {}) => {
    record('headObject', [input]);
    try {
      const res = await sendS3('HeadObject', {
        Bucket: input.bucket,
        Key: input.key,
      });
      return ok({
        bucket: input.bucket,
        key: input.key,
        etag: String(res?.ETag || '').replaceAll('"', ''),
        lastModified: res?.LastModified || null,
        versionId: res?.VersionId || null,
        contentLength: res?.ContentLength || null,
      });
    } catch (error) {
      return wrapError('headObject', error);
    }
  };

  adapter.putObject = async (input = {}) => {
    record('putObject', [{ bucket: input.bucket, key: input.key }]);
    const blocked = requireWriteAuth('putObject');
    if (blocked) return blocked;
    try {
      const res = await sendS3('PutObject', {
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        CacheControl: input.cacheControl,
      });
      return ok({
        bucket: input.bucket,
        key: input.key,
        etag: String(res?.ETag || '').replaceAll('"', ''),
        versionId: res?.VersionId || null,
      });
    } catch (error) {
      return wrapError('putObject', error);
    }
  };

  adapter.createInvalidation = async (input = {}) => {
    record('createInvalidation', [input]);
    const blocked = requireWriteAuth('createInvalidation');
    if (blocked) return blocked;
    try {
      const res = await sendCloudFront('CreateInvalidation', {
        DistributionId: input.distributionId,
        InvalidationBatch: {
          CallerReference: input.callerReference || `checksops-${Date.now()}`,
          Paths: { Quantity: (input.paths || []).length, Items: input.paths || [] },
        },
      });
      return ok({
        distribution_id: input.distributionId,
        invalidation_id: res?.Invalidation?.Id || null,
      });
    } catch (error) {
      return wrapError('createInvalidation', error);
    }
  };

  adapter.readSqlDefinition = async () => {
    record('readSqlDefinition', []);
    return fail(CODES.UNRELATED_MUTATION, 'SQL definitions are read inside the VPC executor, not by the live AWS adapter');
  };

  return adapter;
}

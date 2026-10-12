import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  PREP_API_FUNCTION,
  PREP_SHA_BASELINE,
  STAGING_API_FUNCTION,
  STAGING_SHA_BASELINE,
} from './constants.mjs';

export const captureFunctionSha = async (functionName, client = new LambdaClient({})) => {
  const cfg = await client.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
  return {
    FunctionName: cfg.FunctionName,
    CodeSha256: cfg.CodeSha256,
    LastModified: cfg.LastModified,
    Version: cfg.Version,
  };
};

export const captureApplicationShas = async (client = new LambdaClient({})) => {
  const [staging, prep] = await Promise.all([
    captureFunctionSha(STAGING_API_FUNCTION, client),
    captureFunctionSha(PREP_API_FUNCTION, client),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    staging,
    prep,
    baselines: {
      [STAGING_API_FUNCTION]: STAGING_SHA_BASELINE,
      [PREP_API_FUNCTION]: PREP_SHA_BASELINE,
    },
    matches: {
      staging: staging.CodeSha256 === STAGING_SHA_BASELINE,
      prep: prep.CodeSha256 === PREP_SHA_BASELINE,
    },
    unchanged: staging.CodeSha256 === STAGING_SHA_BASELINE && prep.CodeSha256 === PREP_SHA_BASELINE,
  };
};

export const refuseOnShaDrift = (shas) => {
  if (shas?.unchanged) return null;
  return {
    ok: false,
    statusCode: 409,
    error: 'application_sha_drift',
    message: 'Application Lambda CodeSha256 drifted from accepted baselines. No write is permitted.',
    shas,
  };
};

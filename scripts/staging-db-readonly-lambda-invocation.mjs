import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { summarizeInvocation } from '../aws/functions/api/staging-db-readonly-diagnostic-output.mjs';

const readJson = (path) => JSON.parse(fs.readFileSync(path, 'utf8'));

export const main = ({
  metadataPath = process.argv[2],
  payloadPath = process.argv[3],
  expectedVersion = process.env.CHECKSOPS_STAGING_DIAGNOSTIC_VERSION,
  writeOutput = console.log,
} = {}) => {
  let summary;
  try {
    if (!metadataPath || !payloadPath || !/^[1-9]\d*$/.test(expectedVersion || '')) {
      throw new Error('invalid invocation configuration');
    }
    summary = summarizeInvocation({
      metadata: readJson(metadataPath),
      payload: fs.readFileSync(payloadPath, 'utf8'),
      expectedVersion,
    });
  } catch {
    summary = {
      schema: 'checksops-staging-db-readonly-diagnostic/v1',
      environment: 'staging',
      status: 'diagnostic_failed',
      classification: 'invocation_result_unavailable',
      readOnly: true,
      writesAttempted: false,
    };
  }
  writeOutput(JSON.stringify(summary));
  return summary.status === 'ok' ? 0 : summary.status === 'unhealthy' ? 1 : 2;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}

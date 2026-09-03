/**
 * Prove HTTPS reachability of Moov and CheckAlt UAT from this Lambda.
 * Does not send credentials. Any HTTP status (including 401) means the host
 * is reachable; connection failures mean NAT/egress is still missing.
 */
import { CHECKALT_UAT_HOST, MOOV_SANDBOX_HOST } from '../sandbox-credentials.mjs';

export const EGRESS_TARGETS = Object.freeze([
  { id: 'moov', url: `${MOOV_SANDBOX_HOST}/` },
  { id: 'checkalt_uat', url: `${CHECKALT_UAT_HOST}/` },
]);

const timeoutMs = () => {
  const raw = Number(process.env.PROVIDER_EGRESS_PROBE_TIMEOUT_MS || 4000);
  return Number.isFinite(raw) && raw > 0 ? raw : 4000;
};

export const classifyProbe = (result) => {
  if (result?.httpStatus) {
    return { reachable: true, reason: 'http_status' };
  }
  return { reachable: false, reason: result?.error || 'network_error' };
};

export async function probeHost(url, fetchImpl = fetch, now = Date.now) {
  const started = now();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json, text/plain, */*' },
      signal: AbortSignal.timeout(timeoutMs()),
    });
    return {
      url,
      reachable: true,
      httpStatus: response.status,
      elapsedMs: now() - started,
      error: null,
    };
  } catch (error) {
    const code = String(error?.cause?.code || error?.code || error?.name || 'fetch_failed');
    return {
      url,
      reachable: false,
      httpStatus: null,
      elapsedMs: now() - started,
      error: code.slice(0, 80),
    };
  }
}

export async function probeProviderEgress(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const results = [];
  for (const target of EGRESS_TARGETS) {
    const probed = await probeHost(target.url, fetchImpl, deps.now);
    results.push({
      id: target.id,
      ...probed,
      ...classifyProbe(probed),
    });
  }
  const moov = results.find((row) => row.id === 'moov');
  const checkalt = results.find((row) => row.id === 'checkalt_uat');
  const ok = Boolean(moov?.reachable && checkalt?.reachable);
  return {
    ok,
    statusCode: ok ? 200 : 503,
    service: 'checksops-api',
    probe: 'providers-egress',
    from: 'checksops-staging-api',
    message: ok
      ? 'Moov and CheckAlt UAT hosts are reachable from this Lambda.'
      : 'Lambda cannot reach one or more provider HTTPS hosts. NAT/egress is required. RDS was not made public.',
    moovReachable: Boolean(moov?.reachable),
    checkaltUatReachable: Boolean(checkalt?.reachable),
    targets: results,
    secretsUsed: false,
    liveProviderCalled: false,
    productionExecution: false,
    rdsMadePublic: false,
    lambdaPublicInbound: false,
  };
}

export const handleProviderEgress = (event, deps = {}) => probeProviderEgress(deps);

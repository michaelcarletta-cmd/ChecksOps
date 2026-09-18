/**
 * Azure Document Intelligence prebuilt-check.us client.
 * Transport and secret resolver are injected. Does not read Secrets Manager itself.
 */
export const AZURE_CHECK_MODEL = 'prebuilt-check.us';
export const AZURE_CHECK_API_VERSION = '2024-11-30';
export const AZURE_DI_SECRET_NAME_TEMPLATE = 'checksops/{environment}/providers/azure-document-intelligence';

const SENSITIVE_KEY = /account_number|routing_number|micr|secret|password|token|authorization|api_key|ocp-apim-subscription-key|operation-location|operation_location|base64|image_b64|imagebytes|document_bytes|payee|payer|raw_micr|content/i;
const SENSITIVE_VALUE = /(?:\b\d{6,17}\b)|(?:[A-Za-z0-9+/]{40,}={0,2})|operation-location|analyzeResults|documentintelligence|cognitiveservices|Ocp-Apim-Subscription-Key/i;

export const redactOcrLog = (value) => {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE.test(value) || value.length > 240) return '[redacted]';
    return value;
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactOcrLog(value.message) };
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactOcrLog(item));
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = redactOcrLog(nested);
  }
  return out;
};

export const safeOcrLog = (log, entry) => {
  const write = log || ((row) => console.log(JSON.stringify(row)));
  write(redactOcrLog({
    event: entry?.event || 'ocr_azure',
    ok: entry?.ok ?? null,
    code: entry?.code || null,
    status: entry?.status ?? null,
    ms: entry?.ms ?? null,
    deleteConfirmed: entry?.deleteConfirmed ?? null,
    attempts: entry?.attempts ?? null,
  }));
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const secretField = (obj, names) => {
  if (!obj || typeof obj !== 'object') return '';
  for (const name of names) {
    if (obj[name] != null && String(obj[name]).trim() !== '') return String(obj[name]).trim();
  }
  const lower = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof key === 'string') lower[key.trim().toLowerCase()] = value;
  }
  for (const name of names) {
    const value = lower[String(name).toLowerCase()];
    if (value != null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
};

const asSecretObject = (raw) => {
  if (raw == null) return null;
  let value = raw;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    value = value.toString('utf8');
  }
  if (typeof value === 'string') {
    let text = value.replace(/^\uFEFF/, '').trim();
    if (!text) return null;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value.replace(/^\uFEFF/, '').trim());
      } catch {
        return null;
      }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
};

export const parseAzureDiSecret = (raw) => {
  const obj = asSecretObject(raw);
  if (!obj) return null;
  // Existing isolated secret schema is { api_key, endpoint }. Also accept
  // the already-parsed { apiKey, endpoint } shape and case variants.
  let endpoint = secretField(obj, ['endpoint', 'Endpoint', 'url']);
  const apiKey = secretField(obj, ['api_key', 'apiKey', 'API_KEY', 'key']);
  if (!endpoint || !apiKey) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(endpoint)) endpoint = `https://${endpoint}`;
  endpoint = endpoint.replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  return { endpoint, apiKey, host: parsed.host };
};

export const loadAzureDiConfig = async (secretLoader) => {
  if (typeof secretLoader !== 'function') return null;
  const raw = await secretLoader();
  if (!raw) return null;
  return parseAzureDiSecret(raw);
};

const analyzeUrl = (endpoint) => (
  `${endpoint}/documentintelligence/documentModels/${AZURE_CHECK_MODEL}:analyze?api-version=${AZURE_CHECK_API_VERSION}&locale=en-US`
);

export const validateOperationLocation = (operationLocation, expectedHost) => {
  if (!operationLocation || typeof operationLocation !== 'string') {
    return { ok: false, code: 'malformed_operation_location' };
  }
  let loc;
  try {
    loc = new URL(operationLocation);
  } catch {
    return { ok: false, code: 'malformed_operation_location' };
  }
  if (loc.protocol !== 'https:') {
    return { ok: false, code: 'malformed_operation_location' };
  }
  if (!expectedHost || loc.host !== expectedHost) {
    return { ok: false, code: 'operation_location_wrong_host' };
  }
  if (!/\/documentintelligence\/documentModels\/prebuilt-check\.us\/analyzeResults\/[0-9a-fA-F-]{8,}/.test(loc.pathname)) {
    return { ok: false, code: 'malformed_operation_location' };
  }
  return { ok: true, url: loc.toString(), resultId: loc.pathname.split('/').pop() };
};

const readJsonSafe = async (res) => {
  const text = await res.text();
  if (!text) return { json: null, parseError: false };
  try {
    return { json: JSON.parse(text), parseError: false };
  } catch {
    return { json: null, parseError: true };
  }
};

const retryAfterMs = (res, fallback) => {
  const raw = res?.headers?.get?.('retry-after');
  if (!raw) return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(10_000, n * (n > 20 ? 1 : 1000));
  return fallback;
};

const requestJson = async ({
  fetchImpl,
  url,
  method,
  headers,
  body,
  sleep,
  log,
  maxRetries,
  retryOn,
}) => {
  let attempt = 0;
  let lastCode = 'azure_http_error';
  while (attempt <= maxRetries) {
    attempt += 1;
    let res;
    try {
      res = await fetchImpl(url, { method, headers, body });
    } catch {
      lastCode = 'azure_network_error';
      if (attempt <= maxRetries) {
        await sleep(200 * attempt);
        continue;
      }
      safeOcrLog(log, { event: 'azure_http', ok: false, code: lastCode, attempts: attempt });
      return { ok: false, code: lastCode, status: 0, json: null, headers: null, attempts: attempt };
    }
    const status = res.status;
    if (status === 429) {
      lastCode = 'azure_http_429';
      if (attempt <= maxRetries && retryOn.includes(429)) {
        await sleep(retryAfterMs(res, 1000 * attempt));
        continue;
      }
      safeOcrLog(log, { event: 'azure_http', ok: false, code: lastCode, status, attempts: attempt });
      return { ok: false, code: lastCode, status, json: null, headers: res.headers, attempts: attempt };
    }
    if (status >= 500 && attempt <= maxRetries && retryOn.includes(500)) {
      await sleep(200 * attempt);
      lastCode = `azure_http_${status}`;
      continue;
    }
    if (status >= 400 && status < 500 && status !== 429) {
      safeOcrLog(log, { event: 'azure_http', ok: false, code: `azure_http_${status}`, status, attempts: attempt });
      return { ok: false, code: `azure_http_${status}`, status, json: null, headers: res.headers, attempts: attempt };
    }
    if (status >= 500) {
      safeOcrLog(log, { event: 'azure_http', ok: false, code: `azure_http_${status}`, status, attempts: attempt });
      return { ok: false, code: `azure_http_${status}`, status, json: null, headers: res.headers, attempts: attempt };
    }
    const parsed = method === 'DELETE' ? { json: null, parseError: false } : await readJsonSafe(res);
    if (parsed.parseError && method !== 'DELETE') {
      safeOcrLog(log, { event: 'azure_http', ok: false, code: 'malformed_json', status, attempts: attempt });
      return { ok: false, code: 'malformed_json', status, json: null, headers: res.headers, attempts: attempt };
    }
    return {
      ok: true,
      status,
      json: parsed.json,
      headers: res.headers,
      attempts: attempt,
    };
  }
  safeOcrLog(log, { event: 'azure_http', ok: false, code: lastCode, attempts: attempt });
  return { ok: false, code: lastCode, status: 0, json: null, headers: null, attempts: attempt };
};

export const deleteAzureAnalyzeResult = async ({
  config,
  resultId,
  fetchImpl,
  log,
} = {}) => {
  if (!config || !resultId) return { confirmed: false, code: 'delete_skipped' };
  const url = `${config.endpoint}/documentintelligence/documentModels/${AZURE_CHECK_MODEL}/analyzeResults/${resultId}?api-version=${AZURE_CHECK_API_VERSION}`;
  try {
    const res = await fetchImpl(url, {
      method: 'DELETE',
      headers: { 'Ocp-Apim-Subscription-Key': config.apiKey },
    });
    if (res.status === 204) {
      safeOcrLog(log, { event: 'azure_delete', ok: true, code: 'delete_confirmed', status: 204, deleteConfirmed: true });
      return { confirmed: true, code: 'delete_confirmed' };
    }
    safeOcrLog(log, { event: 'azure_delete', ok: false, code: `delete_http_${res.status}`, status: res.status, deleteConfirmed: false });
    return { confirmed: false, code: `delete_http_${res.status}` };
  } catch {
    safeOcrLog(log, { event: 'azure_delete', ok: false, code: 'delete_failed', deleteConfirmed: false });
    return { confirmed: false, code: 'delete_failed' };
  }
};

export const analyzeAzureCheck = async ({
  imageBytes,
  secretLoader,
  fetchImpl,
  sleep = defaultSleep,
  now = () => Date.now(),
  log,
  pollTimeoutMs = 18_000,
} = {}) => {
  const started = now();
  if (!fetchImpl) {
    return { ok: false, code: 'missing_transport', deleteConfirmed: false };
  }
  const config = await loadAzureDiConfig(secretLoader);
  if (!config) {
    safeOcrLog(log, { event: 'azure_analyze', ok: false, code: 'azure_not_configured', ms: now() - started });
    return { ok: false, code: 'azure_not_configured', deleteConfirmed: false };
  }
  if (!imageBytes || !imageBytes.length) {
    return { ok: false, code: 'empty_image', deleteConfirmed: false };
  }

  const headers = {
    'Ocp-Apim-Subscription-Key': config.apiKey,
    'Content-Type': 'application/json',
  };
  const post = await requestJson({
    fetchImpl,
    url: analyzeUrl(config.endpoint),
    method: 'POST',
    headers,
    body: JSON.stringify({ base64Source: Buffer.from(imageBytes).toString('base64') }),
    sleep,
    log,
    maxRetries: 2,
    retryOn: [429, 500],
  });
  if (!post.ok) {
    return { ok: false, code: post.code, status: post.status, deleteConfirmed: false };
  }
  if (post.status !== 202) {
    safeOcrLog(log, { event: 'azure_analyze', ok: false, code: `azure_http_${post.status}`, status: post.status });
    return { ok: false, code: `azure_http_${post.status}`, status: post.status, deleteConfirmed: false };
  }
  const operationLocation = post.headers?.get?.('operation-location') || post.headers?.get?.('Operation-Location');
  const loc = validateOperationLocation(operationLocation, config.host);
  if (!loc.ok) {
    safeOcrLog(log, { event: 'azure_analyze', ok: false, code: loc.code });
    return { ok: false, code: loc.code, deleteConfirmed: false };
  }

  const deadline = now() + pollTimeoutMs;
  let resultJson = null;
  while (now() < deadline) {
    const poll = await requestJson({
      fetchImpl,
      url: loc.url,
      method: 'GET',
      headers: { 'Ocp-Apim-Subscription-Key': config.apiKey },
      sleep,
      log,
      maxRetries: 2,
      retryOn: [429, 500],
    });
    if (!poll.ok) {
      const del = await deleteAzureAnalyzeResult({ config, resultId: loc.resultId, fetchImpl, log });
      return { ok: false, code: poll.code, status: poll.status, deleteConfirmed: del.confirmed, resultId: loc.resultId };
    }
    const status = poll.json?.status;
    if (status === 'succeeded') {
      resultJson = poll.json;
      break;
    }
    if (status === 'failed' || status === 'skipped') {
      const del = await deleteAzureAnalyzeResult({ config, resultId: loc.resultId, fetchImpl, log });
      safeOcrLog(log, { event: 'azure_analyze', ok: false, code: 'azure_failed', ms: now() - started });
      return { ok: false, code: 'azure_failed', deleteConfirmed: del.confirmed, resultId: loc.resultId };
    }
    await sleep(400);
  }
  if (!resultJson) {
    const del = await deleteAzureAnalyzeResult({ config, resultId: loc.resultId, fetchImpl, log });
    safeOcrLog(log, { event: 'azure_analyze', ok: false, code: 'azure_timeout', ms: now() - started });
    return { ok: false, code: 'azure_timeout', deleteConfirmed: del.confirmed, resultId: loc.resultId };
  }

  const documents = resultJson?.analyzeResult?.documents;
  if (!Array.isArray(documents) || !documents.length) {
    const del = await deleteAzureAnalyzeResult({ config, resultId: loc.resultId, fetchImpl, log });
    safeOcrLog(log, { event: 'azure_analyze', ok: false, code: 'azure_missing_documents', ms: now() - started });
    return { ok: false, code: 'azure_missing_documents', deleteConfirmed: del.confirmed, resultId: loc.resultId };
  }

  const del = await deleteAzureAnalyzeResult({ config, resultId: loc.resultId, fetchImpl, log });
  safeOcrLog(log, { event: 'azure_analyze', ok: true, code: 'ok', ms: now() - started, deleteConfirmed: del.confirmed });
  return {
    ok: true,
    code: 'ok',
    document: documents[0],
    deleteConfirmed: del.confirmed,
    resultId: loc.resultId,
  };
};

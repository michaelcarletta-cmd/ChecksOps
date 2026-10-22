/**
 * Non-financial Class A scheduled jobs for AWS staging.
 * Invoked by EventBridge → API Gateway/Lambda with shared secret.
 * Financial crons (deposit automation, wallet fund-on-clear, CheckAlt approve) stay disabled.
 */
import { parseBody, ignoredSpoof } from './data.mjs';
import { handleProcessEmailQueue } from './email-queue.mjs';
import { handleTenantDomainRecheckCron } from './tenant-email-domain-handlers.mjs';
import { handleCheckOcrBacklog } from './ocr.mjs';
import { handleCheckAltStatusReconcileJob } from './providers/production/checkalt-status-reconcile.mjs';

const FINANCIAL_JOBS = new Set([
  'deposit-daily-automation',
  'wallet-fund-on-clear',
  'checkalt-approve-cron',
  'moov-sweep',
  'platform-treasury',
]);

export const CLASS_A_SCHEDULED_JOBS = new Set([
  'process-email-queue',
  'tenant-domain-recheck-cron',
  'check-ocr-backlog',
]);

/** Jobs an EventBridge Scheduler direct Lambda invocation may run. */
export const SCHEDULER_DIRECT_JOBS = new Set(['checkalt-poll-deposits']);
export const SCHEDULER_DIRECT_SOURCE = 'eventbridge-scheduler';

/**
 * EventBridge Scheduler invoking the Lambda directly (IAM-authorized
 * lambda:InvokeFunction, no shared secret). An HTTP API request can never
 * look like this: API Gateway always builds the event itself (version,
 * routeKey, headers, requestContext.apiId / requestId / domainName) and a
 * caller cannot add top-level fields. Only SCHEDULER_DIRECT_JOBS run this way.
 */
export const isSchedulerDirectInvocation = (event) => {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (event.checksops_scheduler !== SCHEDULER_DIRECT_SOURCE) return false;
  if (event.version !== undefined || event.routeKey !== undefined || event.headers !== undefined) return false;
  if (event.httpMethod !== undefined || event.body !== undefined || event.isBase64Encoded !== undefined) return false;
  const ctx = event.requestContext;
  if (ctx && (ctx.apiId !== undefined || ctx.requestId !== undefined || ctx.domainName !== undefined
    || ctx.accountId !== undefined || ctx.stage !== undefined)) return false;
  return SCHEDULER_DIRECT_JOBS.has(String(event.job || ''));
};

const authorized = (event) => {
  const expected = process.env.AWS_SCHEDULED_JOB_SECRET || '';
  if (!expected) return false;
  const got = event.headers?.['x-scheduled-job-secret']
    || event.headers?.['X-Scheduled-Job-Secret']
    || parseBody(event).secret;
  return Boolean(got && got === expected);
};

export const handleScheduledRequest = async (event, path, deps = {}) => {
  if (!path.startsWith('/scheduled')) return null;
  const spoof = ignoredSpoof(event, parseBody(event));
  if (isSchedulerDirectInvocation(event)) {
    return handleCheckAltStatusReconcileJob(event, deps);
  }
  if (!authorized(event)) {
    return {
      ok: false,
      statusCode: 401,
      error: 'unauthorized_scheduled_job',
      spoofFieldsIgnored: spoof,
    };
  }

  const body = parseBody(event);
  const job = body.job || path.replace(/^\/scheduled\/?/, '') || 'class-a';

  if (job === 'checkalt-poll-deposits' || job === 'checkalt-status-reconcile') {
    return handleCheckAltStatusReconcileJob(event, deps);
  }

  if (FINANCIAL_JOBS.has(job)) {
    return {
      ok: false,
      statusCode: 403,
      error: 'financial_job_disabled',
      message: `${job} remains disabled until financial activation`,
      spoofFieldsIgnored: spoof,
    };
  }

  if (job === 'class-a' || job === 'all-safe') {
    const results = {};
    results.emailQueue = await handleProcessEmailQueue({
      ...event,
      headers: { ...(event.headers || {}), 'x-scheduled-job-secret': process.env.AWS_SCHEDULED_JOB_SECRET },
      body: JSON.stringify({ batchSize: 10 }),
    });
    results.domainRecheck = await handleTenantDomainRecheckCron(event);
    return {
      ok: true,
      statusCode: 200,
      job: 'class-a',
      results,
      financialJobsSkipped: [...FINANCIAL_JOBS],
      statusReconcileSkipped: ['checkalt-poll-deposits'],
      spoofFieldsIgnored: spoof,
    };
  }

  if (job === 'process-email-queue') {
    return handleProcessEmailQueue({
      ...event,
      headers: { ...(event.headers || {}), 'x-scheduled-job-secret': process.env.AWS_SCHEDULED_JOB_SECRET },
      body: JSON.stringify({ batchSize: body.batchSize || 10 }),
    });
  }
  if (job === 'tenant-domain-recheck-cron') return handleTenantDomainRecheckCron(event);
  if (job === 'check-ocr-backlog') {
    // OCR backlog requires Cognito identity in current handler — return deferred for schedule
    return {
      ok: true,
      statusCode: 200,
      deferred: true,
      message: 'check-ocr-backlog remains staff-invoked under Cognito identity for RLS',
      spoofFieldsIgnored: spoof,
    };
  }

  return {
    ok: false,
    statusCode: 404,
    error: 'unknown_scheduled_job',
    job,
    spoofFieldsIgnored: spoof,
  };
};

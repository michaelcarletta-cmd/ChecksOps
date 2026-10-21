export const SHARED_LAMBDAS = Object.freeze({
  'checksops-staging-api': {
    target_environment: 'staging',
    target_component: 'checksops-staging-api',
    deployment_type: 'lambda-overlay',
  },
  'checksops-production-prep-api': {
    target_environment: 'production',
    target_component: 'checksops-production-prep-api',
    deployment_type: 'lambda-overlay',
  },
  'checksops-production-origin-verify': {
    target_environment: 'production',
    target_component: 'checksops-production-origin-verify',
    deployment_type: 'lambda-overlay',
  },
});

export const SHARED_SPA_BUCKETS = Object.freeze({
  'checksops-staging-frontend-c48b': {
    target_environment: 'staging',
    target_component: 'staging-frontend',
    deployment_type: 'spa-promote',
  },
  'checksops-production-frontend-806168576068': {
    target_environment: 'production',
    target_component: 'production-spa',
    deployment_type: 'spa-promote',
  },
});

export const SHARED_FILE_BUCKETS = Object.freeze({
  'checksops-staging-privatefilesbucket-erzqsolpucjp': {
    target_environment: 'staging',
    target_component: 'staging-private-files',
    deployment_type: 's3-object-write',
  },
});

export const SHARED_CLOUDFRONT = Object.freeze({
  E1CG52WRQZI7X1: {
    target_environment: 'staging',
    target_component: 'staging-frontend',
    deployment_type: 'cloudfront-invalidation',
  },
  E1B0ZWWO5559U5: {
    target_environment: 'production',
    target_component: 'production-spa',
    deployment_type: 'cloudfront-update',
  },
});

export const SHARED_STACKS = Object.freeze({
  'checksops-staging-db-readonly-diagnostic': {
    target_environment: 'staging',
    target_component: 'checksops-staging-db-readonly-diagnostic',
    deployment_type: 'cloudformation',
  },
  'checksops-production-cloudtrail': {
    target_environment: 'production',
    target_component: 'production-cloudtrail',
    deployment_type: 'cloudformation',
  },
});

// Stacks whose templates are retired: live state has diverged on purpose and a stack update
// would overwrite it. They are refused even if someone later adds them to SHARED_STACKS.
export const RETIRED_STACKS = Object.freeze({
  'checksops-production-prep-api': {
    templates: ['aws/production/api-cfn.yaml', 'aws/production/api-template.yaml'],
    reason: 'templates are a retired flags-off baseline; live production (role, VPC, timeout, 50 variables) changes only through the guarded overlay, rebuild and configuration workflows',
  },
});

export function lookupRetiredStack(name) {
  return RETIRED_STACKS[String(name || '').trim()] || null;
}

export function lookupSharedLambda(name) {
  return SHARED_LAMBDAS[String(name || '').trim()] || null;
}

export function lookupSharedBucket(name) {
  const key = String(name || '').trim();
  return SHARED_SPA_BUCKETS[key] || SHARED_FILE_BUCKETS[key] || null;
}

export function lookupSharedCloudFront(distributionId) {
  const key = String(distributionId || '').trim();
  return SHARED_CLOUDFRONT[key] || null;
}

export function lookupSharedStack(name) {
  return SHARED_STACKS[String(name || '').trim()] || null;
}

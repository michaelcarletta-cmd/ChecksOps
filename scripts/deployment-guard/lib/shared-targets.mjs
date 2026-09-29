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
  E1B0ZWWO5559U5: {
    target_environment: 'production',
    target_component: 'production-spa',
    deployment_type: 'cloudfront-update',
  },
});

export const SHARED_STACKS = Object.freeze({
  'checksops-production-cloudtrail': {
    target_environment: 'production',
    target_component: 'production-cloudtrail',
    deployment_type: 'cloudformation',
  },
});

export function lookupSharedLambda(name) {
  return SHARED_LAMBDAS[String(name || '').trim()] || null;
}

export function lookupSharedBucket(name) {
  const key = String(name || '').trim();
  return SHARED_SPA_BUCKETS[key] || SHARED_FILE_BUCKETS[key] || null;
}

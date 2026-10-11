/**
 * Module hook that redirects `pg` to the CI stub. Used only by
 * sql53-production-readonly-inspect.test.mjs so Deployment Guard can load
 * the diagnostic without installing Lambda runtime dependencies.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'pg') {
    return {
      shortCircuit: true,
      url: new URL('./pg-ci-stub.mjs', import.meta.url).href,
    };
  }
  return nextResolve(specifier, context);
}

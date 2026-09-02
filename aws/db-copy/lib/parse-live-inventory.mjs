import fs from 'node:fs';

const num = (text, pattern) => {
  const match = text.match(pattern);
  if (!match) throw new Error(`LIVE_SOURCE_INVENTORY.md missing ${pattern}`);
  return Number(match[1].replace(/,/g, ''));
};

export const parseLiveSourceInventory = (filePath) => {
  const text = fs.readFileSync(filePath, 'utf8');
  return {
    source: 'live Lovable/Supabase ChecksOps (authoritative)',
    public: {
      baseTables: num(text, /^- Base tables:\s*(\d+)/m),
      views: num(text, /^- Views:\s*(\d+)/m),
      materializedViews: num(text, /^- Materialized views:\s*(\d+)/m),
      sequences: num(text, /^- Sequences reported through information_schema:\s*(\d+)/m),
      functions: num(text, /^- Public functions\/routines:\s*(\d+)/m),
      triggers: num(text, /^- Public triggers:\s*(\d+)/m),
      rlsPolicies: num(text, /^- Public RLS policies:\s*(\d+)/m),
    },
    authUsers: num(text, /^- auth\.users:\s*(\d+)/m),
    storageObjects: num(text, /^- storage\.objects:\s*([\d,]+)/m),
    supabaseFunctionDependencies: {
      authUid: num(text, /(\d+) functions reference auth\.uid\(\)/i),
      authJwt: num(text, /(\d+) functions reference auth\.jwt\(\)/i),
      net: num(text, /(\d+) functions reference net\.\*/i),
      cron: num(text, /(\d+) functions reference cron\.\*/i),
      vault: num(text, /(\d+) functions reference vault\/decrypted_secrets/i),
      pgmq: num(text, /(\d+) functions reference pgmq\.\*/i),
    },
    publicForeignKeysToAuthUsers: 0,
    noTableGapVsViews: /166 base tables \+ 20 views/.test(text),
  };
};

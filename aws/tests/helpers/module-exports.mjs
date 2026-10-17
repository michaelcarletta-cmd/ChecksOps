/**
 * Static ES-module import/export scan for aws/functions/api (no evaluation).
 * Used by the reverse-import test and the production overlay guard: it reads
 * `import { a, b as c } from './x.mjs'`, `export * from` is not used by these
 * sources, and destructured dynamic imports
 * (`const { a } = await import('./x.mjs')`).
 */
const namesOf = (list) => list.split(',')
  .map((part) => part.trim().split(/\s+as\s+|\s*:\s*/)[0].trim())
  .filter((name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name));

/** Relative imports of a module: [{ spec, names }]. */
export function importsOf(src) {
  const text = String(src);
  const out = [];
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) out.push({ spec: m[2], names: namesOf(m[1]) });
  for (const m of text.matchAll(/import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,\s*\{([^}]*)\})?\s*from\s*['"](\.[^'"]+)['"]/g)) {
    out.push({ spec: m[3], names: ['default', ...(m[2] ? namesOf(m[2]) : [])] });
  }
  for (const m of text.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) out.push({ spec: m[2], names: namesOf(m[1]) });
  return out;
}

/** Names a module exports. */
export function exportsOf(src) {
  const text = String(src);
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const pieces = t.split(/\s+as\s+/);
      names.add((pieces[1] || pieces[0]).trim());
    }
  }
  if (/export\s+default\b/.test(text)) names.add('default');
  return names;
}

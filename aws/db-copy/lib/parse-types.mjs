import fs from 'node:fs';

const SKIP_KEYS = new Set([
  'Row',
  'Insert',
  'Update',
  'Relationships',
  'Args',
  'Returns',
]);

export const extractNamedBlock = (source, label, fromIndex = 0) => {
  const start = source.indexOf(`    ${label}: {`, fromIndex);
  if (start < 0) {
    throw new Error(`types.ts is missing public.${label}`);
  }
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    else if (source[end] === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  const block = source.slice(open + 1, end - 1);
  const names = [];
  let currentDepth = 0;
  for (const line of block.split('\n')) {
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    if (currentDepth === 0) {
      const match = line.match(/^\s{6}([A-Za-z0-9_]+)\s*:/);
      if (match && !SKIP_KEYS.has(match[1])) names.push(match[1]);
    }
    currentDepth += opens - closes;
  }
  return { names, end };
};

export const extractTableRowColumns = (source, tableName) => {
  const marker = `      ${tableName}: {`;
  const tableStart = source.indexOf(marker);
  if (tableStart < 0) return [];
  const rowStart = source.indexOf('        Row: {', tableStart);
  if (rowStart < 0) return [];
  const open = source.indexOf('{', rowStart);
  let depth = 0;
  let end = open;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    else if (source[end] === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  return source
    .slice(open + 1, end - 1)
    .split('\n')
    .map((line) => line.match(/^\s{10}([A-Za-z0-9_]+):/)?.[1])
    .filter(Boolean);
};

export const parseGeneratedDatabaseTypes = (typesPath) => {
  const source = fs.readFileSync(typesPath, 'utf8');
  const tables = extractNamedBlock(source, 'Tables');
  const views = extractNamedBlock(source, 'Views', tables.end);
  const functions = extractNamedBlock(source, 'Functions', views.end);
  const enums = extractNamedBlock(source, 'Enums', functions.end);
  return {
    tables: tables.names,
    views: views.names,
    functions: functions.names,
    enums: enums.names,
    tableColumns: Object.fromEntries(
      tables.names.map((name) => [name, extractTableRowColumns(source, name)]),
    ),
  };
};

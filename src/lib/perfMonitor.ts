export function markStart(name: string) {
  performance.mark(`${name}-start`);
}

export function markEnd(name: string) {
  performance.mark(`${name}-end`);
  performance.measure(name, `${name}-start`, `${name}-end`);
}

export function logMeasures(filter?: string) {
  const measures = performance.getEntriesByType("measure");
  const rows = measures
    .filter((m) => (filter ? m.name.includes(filter) : true))
    .map((m) => ({
      name: m.name,
      duration: `${m.duration.toFixed(2)}ms`,
    }));

  console.table(rows);
}

export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const end = performance.now();
    console.log(`[perf] ${name}: ${(end - start).toFixed(2)}ms`);
  }
}

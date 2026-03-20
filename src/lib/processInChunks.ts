export async function processInChunks<T>(
  items: T[],
  chunkSize: number,
  worker: (item: T) => Promise<void>
) {
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    await Promise.all(chunk.map(worker));
  }
}

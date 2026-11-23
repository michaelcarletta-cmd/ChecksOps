/**
 * Some browsers refuse `window.localStorage` / `window.sessionStorage` outright: the getter throws a
 * SecurityError ("Failed to read the 'localStorage' property from 'Window': Access is denied for this
 * document") when site data is blocked, in some in-app browsers (mail and social apps), and in some
 * privacy modes. Every bare `localStorage.getItem(...)` in the app then throws, and public pages such as
 * /endorse (payees signing checks) crash into the error boundary.
 *
 * installSafeWebStorage() runs once, before the app loads. When a storage is usable it changes nothing.
 * When reading it throws, it puts an in-memory Storage in its place on `window`, so the page works for that
 * visit: signing in or a dismissed banner simply is not remembered after the tab closes.
 */

export function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      const k = String(key);
      return data.has(k) ? (data.get(k) as string) : null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(String(key));
    },
    setItem(key: string, value: string) {
      data.set(String(key), String(value));
    },
  };
  return storage as Storage;
}

export type StorageName = "localStorage" | "sessionStorage";

/** True when `target[name]` can be read and used without throwing. */
export function isStorageUsable(target: Record<string, unknown>, name: StorageName): boolean {
  try {
    const storage = target[name] as Storage | undefined | null;
    if (!storage) return false;
    const probe = "__checksops_storage_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace each unusable storage on `target` (default: window) with an in-memory one.
 * Returns the names that were replaced.
 */
export function installSafeWebStorage(target?: Record<string, unknown>): StorageName[] {
  const host =
    target ?? (typeof window !== "undefined" ? (window as unknown as Record<string, unknown>) : undefined);
  if (!host) return [];
  const replaced: StorageName[] = [];
  for (const name of ["localStorage", "sessionStorage"] as const) {
    if (isStorageUsable(host, name)) continue;
    try {
      Object.defineProperty(host, name, {
        configurable: true,
        enumerable: true,
        value: createMemoryStorage(),
        writable: false,
      });
      replaced.push(name);
    } catch {
      /* the browser would not let us replace it; nothing more we can do */
    }
  }
  return replaced;
}

installSafeWebStorage();

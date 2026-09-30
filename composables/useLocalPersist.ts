export function readLocal<T>(key: string, fallback: T): T {
  if (!import.meta.client) return fallback;
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) as T : fallback;
}

export function writeLocal<T>(key: string, value: T) {
  if (import.meta.client) localStorage.setItem(key, JSON.stringify(value));
}

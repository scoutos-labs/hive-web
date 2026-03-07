// Server connection management
// Handles current server URL, localStorage history, and runtime switching
// The Vite dev server dynamically proxies /api/* to the configured target.

declare const __HIVE_DEFAULT_SERVER__: string;

const STORAGE_KEY = 'hive-server-url';
const HISTORY_KEY = 'hive-server-history';
const MAX_HISTORY = 10;

/** Get the default server URL injected at build time */
export function getDefaultServer(): string {
  try {
    return __HIVE_DEFAULT_SERVER__;
  } catch {
    return 'http://localhost:3000';
  }
}

/** Get the currently active server URL */
export function getCurrentServer(): string {
  return localStorage.getItem(STORAGE_KEY) || getDefaultServer();
}

/** Set the current server URL and add to history */
export function setCurrentServer(url: string): void {
  const normalized = url.replace(/\/+$/, '');
  localStorage.setItem(STORAGE_KEY, normalized);
  addToHistory(normalized);
}

/** Clear the override, reverting to the default server */
export function clearServerOverride(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Check if a custom server is set (not using default) */
export function isCustomServer(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

/** Get the history of previously used servers */
export function getServerHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Add a server URL to history */
function addToHistory(url: string): void {
  const history = getServerHistory().filter(h => h !== url);
  history.unshift(url);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

/** Remove a server from history */
export function removeFromHistory(url: string): void {
  const history = getServerHistory().filter(h => h !== url);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

/**
 * Switch to a new server.
 * 1. Tells the Vite dynamic proxy to route /api/* to the new target
 * 2. Saves the URL in localStorage for persistence across reloads
 * 3. Reloads the page to reconnect SSE and refetch all data
 */
export async function switchServer(url: string): Promise<void> {
  const normalized = url.replace(/\/+$/, '');

  // Update the Vite proxy target at runtime
  try {
    await fetch('/__hive__/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: normalized }),
    });
  } catch (err) {
    console.error('Failed to update proxy target:', err);
    // Still save locally — on next dev server restart it'll use the env var
  }

  setCurrentServer(normalized);
  window.location.reload();
}

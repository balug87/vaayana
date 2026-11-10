export interface NetworkPreferences { onlineLookup: boolean; covers: boolean }
let preferences: NetworkPreferences = { onlineLookup: false, covers: false };
const listeners = new Set<(value: NetworkPreferences) => void>();

export function getNetworkPreferences(): NetworkPreferences { return { ...preferences }; }
export function setNetworkPreferences(value: NetworkPreferences): void {
  preferences = { onlineLookup: value.onlineLookup === true, covers: value.covers === true };
  for (const listener of listeners) listener(getNetworkPreferences());
}
export function subscribeNetworkPreferences(listener: (value: NetworkPreferences) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function canUseNetwork(): boolean {
  return preferences.onlineLookup && (typeof navigator === 'undefined' || navigator.onLine !== false);
}
export function abortError(): DOMException { return new DOMException('Request cancelled.', 'AbortError'); }
export function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw abortError(); }
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, Math.max(0, ms));
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(abortError()); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

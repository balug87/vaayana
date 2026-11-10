import type { Recommendation } from './recommendations';
import { abortError, getNetworkPreferences, subscribeNetworkPreferences, throwIfAborted } from './network';
import { SEMANTIC_CACHE, SEMANTIC_CACHE_PREFIX, SEMANTIC_MODEL } from './semantic-info';
import type { SemanticProgress, WorkerReply, WorkerRequest } from './semantic-info';
export { SEMANTIC_MODEL, SEMANTIC_CACHE };
export type SemanticMode = 'rule-based' | 'downloading' | 'semantic-ready' | 'basic-fallback';
export interface SemanticState { mode: SemanticMode; progress: number; loadedBytes: number; totalBytes?: number; message: string; error?: string }
let state: SemanticState = { mode: 'rule-based', progress: 0, loadedBytes: 0, message: 'Rule-based matching. No model has been loaded.' };
const listeners = new Set<(value: SemanticState) => void>();
const pending = new Map<number, { resolve(value: WorkerReply): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> }>();
const files = new Map<string, SemanticProgress>();
let worker: Worker | undefined;
let sequence = 0;
let enabling: Promise<SemanticState> | undefined;
let removing = false;
export function getSemanticState(): SemanticState { return { ...state }; }
function update(patch: Partial<SemanticState>) { state = { ...state, ...patch }; for (const listener of listeners) listener(getSemanticState()); }
export function subscribeSemantic(listener: (value: SemanticState) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
function terminate(error: Error): void {
  worker?.terminate(); worker = undefined;
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
  pending.clear(); files.clear(); enabling = undefined;
}
export function cancelSemantic(): void {
  terminate(abortError());
  update({ mode: 'basic-fallback', progress: 0, loadedBytes: 0, totalBytes: undefined, error: undefined, message: 'Local model cancelled. Basic matching remains available; partial downloaded assets may be cached until removal.' });
}
subscribeNetworkPreferences(value => { if (!value.onlineLookup && worker) cancelSemantic(); });
function createWorker(): Worker {
  const result = new Worker(new URL('./semantic.worker.ts', import.meta.url), { type: 'module', name: 'vaayana-local-semantic' });
  result.onmessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data;
    if (reply.type === 'progress') {
      files.set(reply.progress.file, reply.progress);
      const loadedBytes = [...files.values()].reduce((sum, file) => sum + file.loaded, 0);
      const totalBytes = [...files.values()].reduce((sum, file) => sum + file.total, 0);
      update({ loadedBytes, totalBytes, progress: totalBytes ? Math.min(0.99, loadedBytes / totalBytes) : 0, message: `Loading ${reply.progress.file}. Basic recommendations still work.` });
      return;
    }
    const request = pending.get(reply.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(reply.id);
    if (reply.type === 'error') request.reject(new Error(reply.error));
    else request.resolve(reply);
  };
  result.onerror = event => {
    event.preventDefault();
    const error = new Error('The local model worker is unavailable. Basic matching still works.');
    terminate(error); update({ mode: 'basic-fallback', error: error.message, message: error.message });
  };
  return result;
}
function send(request: WorkerRequest, timeout: number): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('Local model timed out. Try again or continue with basic matching.');
      terminate(error); update({ mode: 'basic-fallback', error: error.message, message: error.message });
    }, timeout);
    pending.set(request.id, { resolve, reject, timer });
    worker!.postMessage(request);
  });
}
export async function enableSemantic(options: { consent: true; onProgress?: (value: SemanticState) => void; signal?: AbortSignal }): Promise<SemanticState> {
  if (options?.consent !== true) throw new Error('Explicit download consent is required.');
  throwIfAborted(options.signal);
  if (removing) throw new Error('Wait for model removal to finish.');
  if (!SEMANTIC_MODEL.licenseGatePassed) throw new Error('Model licenses have not been verified for this build.');
  if (!getNetworkPreferences().onlineLookup) throw new Error('Enable online access to initialize the optional model. No private notes are sent.');
  if (state.mode === 'semantic-ready' && worker) return getSemanticState();
  if (enabling) return enabling;
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
    update({ mode: 'basic-fallback', message: 'Local workers or WebAssembly are unavailable. Use basic matching.' });
    return getSemanticState();
  }
  const unsubscribe = options.onProgress ? subscribeSemantic(options.onProgress) : () => undefined;
  const cancel = () => cancelSemantic();
  options.signal?.addEventListener('abort', cancel, { once: true });
  let operation!: Promise<SemanticState>;
  operation = (async () => {
    try {
      terminate(new Error('Reinitializing local model.'));
      update({ mode: 'downloading', progress: 0, loadedBytes: 0, totalBytes: undefined, error: undefined, message: typeof navigator !== 'undefined' && navigator.onLine === false ? 'Loading the cached local model offline. Basic matching remains available.' : 'Downloading the optional local model. Basic matching remains available.' });
      worker = createWorker();
      const reply = await send({ id: ++sequence, type: 'initialize' }, 180000);
      if (reply.type !== 'ready') throw new Error('The model did not finish initialization.');
      update({ mode: 'semantic-ready', progress: 1, error: undefined, message: 'Semantic ready. Real MiniLM inference runs on this device, not a server.' });
      return getSemanticState();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        terminate(error instanceof Error ? error : new Error('Local inference failed.'));
        update({ mode: 'basic-fallback', error: error instanceof Error ? error.message : 'Local inference failed.', message: 'The local model failed. Basic matching remains available.' });
      }
      throw error;
    } finally { unsubscribe(); options.signal?.removeEventListener('abort', cancel); if (enabling === operation) enabling = undefined; }
  })();
  enabling = operation;
  return operation;
}
export async function embedTexts(texts: string[], options: { signal?: AbortSignal } = {}): Promise<number[][]> {
  throwIfAborted(options.signal);
  if (state.mode !== 'semantic-ready' || !worker) throw new Error('The semantic model is not ready. Enable it with consent first.');
  if (texts.length > 48 || texts.some(value => typeof value !== 'string' || value.length > 3000)) throw new Error('Use at most 48 short texts (3,000 characters each).');
  if (!texts.length) return [];
  const cancel = () => cancelSemantic();
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const reply = await send({ id: ++sequence, type: 'embed', texts }, 60000);
    if (reply.type !== 'vectors') throw new Error('No embedding vectors were returned.');
    return reply.vectors;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      terminate(error instanceof Error ? error : new Error('Local inference failed.'));
      update({ mode: 'basic-fallback', message: 'Local inference failed. Basic matching remains available.' });
    }
    throw error;
  } finally { options.signal?.removeEventListener('abort', cancel); }
}
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length || [...a, ...b].some(value => !Number.isFinite(value))) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; normA += a[i] ** 2; normB += b[i] ** 2; }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}
export async function rerankSemantically(items: Recommendation[], interests: string[] | string, options: { signal?: AbortSignal } = {}): Promise<Recommendation[]> {
  throwIfAborted(options.signal);
  if (state.mode !== 'semantic-ready' || !items.length) return items;
  const query = (Array.isArray(interests) ? interests.join(', ') : interests).trim().slice(0, 1500);
  if (!query) return items;
  try {
    const selected = items.slice(0, 40);
    const texts = selected.map(item => [item.book.title, ...item.book.subjects.slice(0, 20), item.book.description?.slice(0, 800)].filter(Boolean).join('. ').slice(0, 1800));
    const vectors = await embedTexts([query, ...texts], options);
    return selected.map((item, index) => ({ item, score: cosineSimilarity(vectors[0], vectors[index + 1]) - index * 0.003 }))
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => ({ ...item, mode: 'semantic' as const, reason: `${item.reason} Reranked by on-device semantic similarity; this is not a quality or accuracy guarantee.` }));
  } catch (error) {
    if (options.signal?.aborted) throw error;
    return items; // State already records the failure; never silently use remote inference.
  }
}
export async function removeSemanticModel(): Promise<void> {
  removing = true; cancelSemantic();
  try {
    if (typeof caches !== 'undefined') for (const name of await caches.keys()) if (name.startsWith(SEMANTIC_CACHE_PREFIX)) await caches.delete(name);
    update({ mode: 'rule-based', progress: 0, loadedBytes: 0, totalBytes: undefined, error: undefined, message: 'Model cache and local vectors removed. Browser HTTP cache may still retain application runtime assets.' });
  } finally { removing = false; }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { setNetworkPreferences } from './network';
import { cancelSemantic, cosineSimilarity, embedTexts, enableSemantic, getSemanticState, removeSemanticModel, rerankSemantically, SEMANTIC_MODEL, subscribeSemantic } from './semantic';
import type { WorkerReply, WorkerRequest } from './semantic-info';
import type { Recommendation } from './recommendations';
class TestWorker {
  static instances: TestWorker[] = [];
  static autoReply = true;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  requests: WorkerRequest[] = [];
  constructor() { TestWorker.instances.push(this); }
  postMessage(request: WorkerRequest) {
    this.requests.push(request);
    if (!TestWorker.autoReply) return;
    queueMicrotask(() => {
      if (this.terminated) return;
      this.onmessage?.({ data: request.type === 'initialize' ? { id: request.id, type: 'ready' } : { id: request.id, type: 'vectors', vectors: request.texts.map((_, i) => [i === 2 ? 0 : 1, i === 2 ? 1 : 0]) } } as MessageEvent<WorkerReply>);
    });
  }
  terminate() { this.terminated = true; }
}
afterEach(async () => { await removeSemanticModel(); vi.unstubAllGlobals(); TestWorker.instances = []; TestWorker.autoReply = true; setNetworkPreferences({ onlineLookup: false, covers: false }); });
function setup() { vi.stubGlobal('Worker', TestWorker); setNetworkPreferences({ onlineLookup: true, covers: false }); }
describe('semantic consent, lifecycle and truthful modes (controller unit tests)', () => {
  it('does not create a worker without explicit consent', async () => {
    setup();
    await expect(enableSemantic({ consent: false } as unknown as { consent: true })).rejects.toThrow('consent');
    expect(TestWorker.instances).toHaveLength(0);
  });
  it('does not start downloads with online access off', async () => {
    vi.stubGlobal('Worker', TestWorker);
    await expect(enableSemantic({ consent: true })).rejects.toThrow('online access');
    expect(TestWorker.instances).toHaveLength(0);
  });
  it('allows cached initialization while the browser is offline, without phantom readiness', async () => {
    setup(); vi.stubGlobal('navigator', { onLine: false }); TestWorker.autoReply = false;
    const operation = enableSemantic({ consent: true });
    expect(getSemanticState()).toMatchObject({ mode: 'downloading', progress: 0 });
    expect(getSemanticState().message).toContain('cached');
    const instance = TestWorker.instances[0];
    instance.onmessage?.({ data: { id: instance.requests[0].id, type: 'ready' } } as MessageEvent<WorkerReply>);
    expect((await operation).mode).toBe('semantic-ready');
  });
  it('still denies offline initialization when the user explicitly disables access', async () => {
    setup(); vi.stubGlobal('navigator', { onLine: false });
    setNetworkPreferences({ onlineLookup: false, covers: false });
    await expect(enableSemantic({ consent: true })).rejects.toThrow('online access');
    expect(TestWorker.instances).toHaveLength(0);
  });
  it('falls back honestly if offline cached initialization fails', async () => {
    setup(); vi.stubGlobal('navigator', { onLine: false }); TestWorker.autoReply = false;
    const changes: string[] = [];
    const unsubscribe = subscribeSemantic(value => changes.push(value.mode));
    const operation = enableSemantic({ consent: true });
    const rejected = expect(operation).rejects.toThrow('not cached');
    const instance = TestWorker.instances[0];
    instance.onmessage?.({ data: { id: instance.requests[0].id, type: 'error', error: 'Model not cached.' } } as MessageEvent<WorkerReply>);
    await rejected;
    expect(getSemanticState()).toMatchObject({ mode: 'basic-fallback', error: 'Model not cached.' });
    expect(instance.terminated).toBe(true);
    expect(changes).not.toContain('semantic-ready');
    await expect(embedTexts(['Book'])).rejects.toThrow('not ready');
    unsubscribe();
  });
  it('keeps ready local inference running when only browser connectivity changes', async () => {
    setup(); await enableSemantic({ consent: true });
    vi.stubGlobal('navigator', { onLine: false });
    setNetworkPreferences({ onlineLookup: true, covers: false });
    expect((await enableSemantic({ consent: true })).mode).toBe('semantic-ready');
    expect(await embedTexts(['Book'])).toEqual([[1, 0]]);
    expect(TestWorker.instances).toHaveLength(1);
    expect(TestWorker.instances[0].terminated).toBe(false);
  });
  it('honors explicit opt-out even after the local model becomes ready', async () => {
    setup(); await enableSemantic({ consent: true });
    setNetworkPreferences({ onlineLookup: false, covers: false });
    expect(TestWorker.instances[0].terminated).toBe(true);
    expect(getSemanticState().mode).toBe('basic-fallback');
    await expect(enableSemantic({ consent: true })).rejects.toThrow('online access');
    await expect(embedTexts(['Book'])).rejects.toThrow('not ready');
  });
  it('only marks semantic ready after the worker readiness result', async () => {
    setup(); const changes: string[] = [];
    const unsubscribe = subscribeSemantic(value => changes.push(value.mode));
    const state = await enableSemantic({ consent: true });
    expect(state.mode).toBe('semantic-ready');
    expect(changes).toEqual(expect.arrayContaining(['downloading', 'semantic-ready']));
    expect(await embedTexts(['Book'])).toEqual([[1, 0]]);
    unsubscribe();
  });
  it('cancels initialization, stops the worker and rejects pending work', async () => {
    setup(); TestWorker.autoReply = false;
    const operation = enableSemantic({ consent: true });
    const settled = operation.catch(error => error);
    cancelSemantic();
    expect((await settled).name).toBe('AbortError');
    expect(TestWorker.instances[0].terminated).toBe(true);
    expect(getSemanticState().mode).toBe('basic-fallback');
  });
  it('stops pending model downloads when privacy setting changes', async () => {
    setup(); TestWorker.autoReply = false;
    const pending = enableSemantic({ consent: true }).catch(error => error);
    setNetworkPreferences({ onlineLookup: false, covers: false });
    expect((await pending).name).toBe('AbortError');
    expect(TestWorker.instances[0].terminated).toBe(true);
  });
  it('removes only Vaayana semantic caches, never diary or unrelated caches', async () => {
    const deleted: string[] = [];
    vi.stubGlobal('caches', { keys: async () => ['vaayana-semantic-old', 'vaayana-metadata-v1', 'other-app'], delete: async (name: string) => { deleted.push(name); return true; } });
    await removeSemanticModel();
    expect(deleted).toEqual(['vaayana-semantic-old']);
    expect(getSemanticState().mode).toBe('rule-based');
  });
  it('reranks existing candidates only and labels actual controller inference', async () => {
    setup(); await enableSemantic({ consent: true });
    const items: Recommendation[] = [1, 2].map(i => ({ book: { workId: `/works/OL${i}W`, title: `Book ${i}`, authors: [], subjects: [], isbn: [], fetchedAt: '2026-11-10', sourceUrl: 'https://openlibrary.org' }, mode: 'rule-based', reason: 'Topic match.', matchedTopics: [] }));
    const result = await rerankSemantically(items, ['cooking']);
    expect(result).toHaveLength(2);
    expect(result.every(value => value.mode === 'semantic')).toBe(true);
    expect(result[0].book.workId).toBe('/works/OL1W');
    expect(TestWorker.instances[0].requests.at(-1)).toMatchObject({ type: 'embed' });
  });
  it('leaves basic results untouched when model is not ready', async () => {
    const input: Recommendation[] = [];
    expect(await rerankSemantically(input, ['topic'])).toBe(input);
    expect(TestWorker.instances).toHaveLength(0);
  });
  it('publishes honest pinned weight and non-total download sizes', () => {
    expect(SEMANTIC_MODEL.revision).toHaveLength(40);
    expect(SEMANTIC_MODEL.weightsBytes).toBeLessThan(SEMANTIC_MODEL.estimatedTotalBytes);
    expect(SEMANTIC_MODEL.downloadNotice).toContain('weights only');
  });
  it('computes bounded valid cosine similarities and handles zero/invalid vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([NaN], [1])).toBe(0);
  });
});

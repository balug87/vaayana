import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });
describe('deployment-scoped disposable caches', () => {
  it('preserves all existing root cache names', async () => {
    vi.stubEnv('BASE_URL', '/'); vi.resetModules();
    const info = await import('./semantic-info');
    const { METADATA_CACHE } = await import('./books');
    expect(info.SEMANTIC_CACHE).toBe(`vaayana-semantic-${info.SEMANTIC_MODEL.revision}`);
    expect(info.SEMANTIC_RUNTIME_CACHE).toBe('vaayana-semantic-runtime-v1');
    expect(METADATA_CACHE).toBe('vaayana-metadata-v1');
  });
  it.each(['/', '/vaayana/'])('removes only %s model/runtime caches, not another deployment', async base => {
    vi.stubEnv('BASE_URL', base); vi.resetModules();
    const info = await import('./semantic-info');
    const own = [info.SEMANTIC_CACHE, info.SEMANTIC_RUNTIME_CACHE];
    const other = base === '/' ? 'vaayana@%2Fvaayana%2F-semantic-old' : 'vaayana-semantic-old';
    const deleted: string[] = [];
    vi.stubGlobal('caches', { keys: async () => [...own, other, 'other-app', 'vaayana-metadata-v1'], delete: async (name: string) => { deleted.push(name); return true; } });
    await (await import('./semantic')).removeSemanticModel();
    expect(deleted).toEqual(own);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEMANTIC_MODEL } from './semantic-info';
import type { WorkerReply, WorkerRequest } from './semantic-info';

const mocks = vi.hoisted(() => ({
  pipeline: vi.fn(),
  env: { version: '3.8.1', allowLocalModels: false, allowRemoteModels: true, useBrowserCache: false, useFSCache: false, useCustomCache: false, customCache: undefined as unknown, backends: { onnx: { wasm: {} } } },
}));
vi.mock('@huggingface/transformers', () => mocks);
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); mocks.pipeline.mockReset(); mocks.env.useCustomCache = false; mocks.env.customCache = undefined; });

async function initialize(cached: boolean, missingFile = 'config.json') {
  const match = vi.fn(async (url: string) => cached || !url.endsWith(`/${missingFile}`) ? new Response('cached') : undefined);
  const fetcher = vi.fn();
  vi.stubGlobal('navigator', { onLine: false });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('caches', { open: async () => ({ match }) });
  let complete!: (reply: WorkerReply) => void;
  const result = new Promise<WorkerReply>(resolve => { complete = resolve; });
  const scope: { postMessage: typeof complete; onmessage?: (event: MessageEvent<WorkerRequest>) => void } = { postMessage: reply => complete(reply) };
  vi.stubGlobal('self', scope);
  const extractor = Object.assign(vi.fn(async () => ({ tolist: () => [Array(384).fill(0.1)] })), { tokenizer: { model_max_length: 512 } });
  mocks.pipeline.mockResolvedValue(extractor);
  await import('./semantic.worker');
  scope.onmessage!({ data: { id: 1, type: 'initialize' } } as MessageEvent<WorkerRequest>);
  return { reply: await result, match, fetcher, extractor };
}
describe('offline worker cache preflight (mocked inference)', () => {
  it('checks all four pinned artifacts before actual readiness inference', async () => {
    const result = await initialize(true);
    expect(result.reply.type).toBe('ready');
    expect(result.match).toHaveBeenCalledTimes(4);
    expect(result.match).toHaveBeenCalledWith(`https://huggingface.co/${SEMANTIC_MODEL.id}/resolve/${SEMANTIC_MODEL.revision}/onnx/model_quantized.onnx`);
    expect(result.extractor).toHaveBeenCalledOnce();
    expect(result.fetcher).not.toHaveBeenCalled();
  });
  it.each(['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'])('fails before pipeline loading or any download if offline %s is missing', async missingFile => {
    const result = await initialize(false, missingFile);
    expect(result.reply.type).toBe('error');
    expect(mocks.pipeline).not.toHaveBeenCalled();
    expect(result.extractor).not.toHaveBeenCalled();
    expect(result.fetcher).not.toHaveBeenCalled();
  });
});

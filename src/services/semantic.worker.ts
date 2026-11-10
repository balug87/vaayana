import { pipeline, env } from '@huggingface/transformers';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import ortWasmUrl from '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import ortModuleUrl from '../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import { SEMANTIC_CACHE, SEMANTIC_MODEL } from './semantic-info';
import type { WorkerReply, WorkerRequest } from './semantic-info';

const scope = self as unknown as { postMessage(value: WorkerReply): void; onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null };
let extractor: FeatureExtractionPipeline | undefined;
let queue: Promise<void> = Promise.resolve();
const cacheVectors = new Map<string, number[]>();
const post = (value: WorkerReply) => scope.postMessage(value);

async function initialize(id: number): Promise<void> {
  if (env.version !== SEMANTIC_MODEL.runtimeVersion || !SEMANTIC_MODEL.licenseGatePassed) throw new Error('The pinned model/runtime license gate does not match this build.');
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = false;
  env.useFSCache = false;
  if (typeof caches !== 'undefined') {
    env.useCustomCache = true;
    env.customCache = await caches.open(SEMANTIC_CACHE);
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (!env.useCustomCache) throw new Error('The model has not been cached for offline use.');
    const base = `https://huggingface.co/${SEMANTIC_MODEL.id}/resolve/${SEMANTIC_MODEL.revision}/`;
    for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) {
      if (!(await env.customCache.match(base + file))?.ok) throw new Error('The complete model has not been cached for offline use.');
    }
  }
  const wasm = env.backends.onnx.wasm;
  if (!wasm) throw new Error('The local WASM runtime is unavailable.');
  wasm.numThreads = 1; // No SharedArrayBuffer/cross-origin isolation requirement.
  wasm.proxy = false; // Already inside a dedicated worker.
  wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortModuleUrl };
  // A task-specific signature avoids the library's enormous generic pipeline union.
  const loadExtractor = pipeline as (task: 'feature-extraction', model: string, options: unknown) => Promise<FeatureExtractionPipeline>;
  extractor = await loadExtractor('feature-extraction', SEMANTIC_MODEL.id, {
    dtype: 'q8', device: 'wasm', revision: SEMANTIC_MODEL.revision,
    progress_callback: (info: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (info.status === 'progress' && info.file && info.loaded !== undefined && info.total !== undefined) post({ id, type: 'progress', progress: { file: info.file, loaded: info.loaded, total: info.total } });
    },
  });
  extractor.tokenizer.model_max_length = SEMANTIC_MODEL.maxTokens;
  const result = await extractor(['Local semantic matching initialization.'], { pooling: 'mean', normalize: true });
  const vectors = result.tolist() as number[][];
  if (vectors[0]?.length !== SEMANTIC_MODEL.dimensions || vectors[0].some(value => !Number.isFinite(value))) {
    throw new Error('Local inference did not return valid embeddings.');
  }
}
async function embed(texts: string[]): Promise<number[][]> {
  if (!extractor) throw new Error('Enable the semantic model first.');
  if (texts.length > 48 || texts.some(value => typeof value !== 'string' || value.length > 3000)) throw new Error('Please embed at most 48 short texts at once.');
  const results: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += 3) {
    const batch = texts.slice(offset, offset + 3).map(text => text.trim());
    const missing = [...new Set(batch.filter(text => !cacheVectors.has(text)))];
    if (missing.length) {
      const tensor = await extractor(missing, { pooling: 'mean', normalize: true });
      const vectors = tensor.tolist() as number[][];
      for (let i = 0; i < missing.length; i++) {
        if (vectors[i]?.length !== SEMANTIC_MODEL.dimensions || vectors[i].some(value => !Number.isFinite(value))) throw new Error('Invalid local embedding output.');
        cacheVectors.set(missing[i], vectors[i]);
      }
    }
    for (const text of batch) results.push(cacheVectors.get(text)!);
    while (cacheVectors.size > 128) cacheVectors.delete(cacheVectors.keys().next().value!);
  }
  return results;
}
scope.onmessage = event => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      if (request.type === 'initialize') { await initialize(request.id); post({ id: request.id, type: 'ready' }); }
      else post({ id: request.id, type: 'vectors', vectors: await embed(request.texts) });
    } catch {
      // No book text, interests, or diary content in errors/logs.
      post({ id: request.id, type: 'error', error: 'The local semantic model could not run. Basic matching remains available. Check storage/network support and retry.' });
    }
  });
};

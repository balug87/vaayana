import { DEPLOYMENT_CACHE_PREFIX } from './cache-scope';
export const SEMANTIC_MODEL = {
  id: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  runtimeVersion: '3.8.1',
  dtype: 'q8',
  dimensions: 384,
  maxTokens: 256,
  weightsBytes: 22_972_370,
  tokenizerAndConfigBytes: 712_802,
  wasmBytes: 21_596_019,
  wasmModuleBytes: 44_484,
  estimatedTotalBytes: 46_000_000,
  downloadNotice: 'About 46 MB for weights, tokenizer and WASM runtime, plus application worker code. The 23 MB figure is weights only. Download size is not runtime memory; mobile support must be measured.',
  license: 'Apache-2.0 model/conversion/tokenizer and Transformers.js; MIT ONNX Runtime',
  licensesVerifiedOn: '2026-11-10',
  licenseGatePassed: true,
} as const;
export const SEMANTIC_CACHE_PREFIX = `${DEPLOYMENT_CACHE_PREFIX}semantic-`;
export const SEMANTIC_CACHE = `${SEMANTIC_CACHE_PREFIX}${SEMANTIC_MODEL.revision}`;
export const SEMANTIC_RUNTIME_CACHE = `${SEMANTIC_CACHE_PREFIX}runtime-v1`;
export interface SemanticProgress { file: string; loaded: number; total: number }
export type WorkerRequest = { id: number; type: 'initialize' } | { id: number; type: 'embed'; texts: string[] };
export type WorkerReply =
  | { id: number; type: 'ready' }
  | { id: number; type: 'progress'; progress: SemanticProgress }
  | { id: number; type: 'vectors'; vectors: number[][] }
  | { id: number; type: 'error'; error: string };

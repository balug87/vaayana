# Optional local semantic matching: third-party notices

Verified 10 November 2026 against the primary files below and installed package metadata. No model weights were downloaded during this source/license inspection. The application starts model requests only after explicit consent and online-access permission.

## Pinned components

| Component | Version/revision | Verified license declaration |
| --- | --- | --- |
| `Xenova/all-MiniLM-L6-v2` ONNX conversion and tokenizer files | `751bff37182d3f1213fa05d7196b954e230abad9` | Pinned model repository README declares `license: apache-2.0`; applies to the repository artifacts. |
| Upstream `sentence-transformers/all-MiniLM-L6-v2` | Identified upstream by conversion README | Upstream model README declares `license: apache-2.0`, language English. |
| Transformers.js | `@huggingface/transformers@3.8.1` | Published versioned LICENSE is Apache-2.0. Runtime checks this exact wrapper version. |
| ONNX Runtime Web | `1.22.0-dev.20250409-89f8206ba4` | Exact upstream revision LICENSE is MIT; published package metadata agrees. |
| `@huggingface/jinja` | Installed `0.5.11`, lockfile records exact resolution | Published package LICENSE is MIT. Retained because the wrapper bundle can include tokenizer/chat-template support even though this app has no chatbot. |

Tokenizer/configuration assets (`tokenizer.json`, `tokenizer_config.json`, `special_tokens_map.json`) come from the same pinned conversion repository; no separate tokenizer LICENSE file is advertised there. The repository's explicit Apache-2.0 designation is the evidence, not an invented per-file license. Its tokenizer configuration identifies `BertTokenizer`. Retain the model/repository attribution and Apache license when redistributing these files.

The Apache-2.0 model designation and runtime MIT grant do not certify model quality, provenance of all training examples, recommendation accuracy, or suitability for medical decisions. No blanket legal warranty is made.

## Primary evidence

- Conversion model card at pinned revision: https://huggingface.co/Xenova/all-MiniLM-L6-v2/raw/751bff37182d3f1213fa05d7196b954e230abad9/README.md
- Pinned tokenizer configuration: https://huggingface.co/Xenova/all-MiniLM-L6-v2/raw/751bff37182d3f1213fa05d7196b954e230abad9/tokenizer_config.json
- Artifact inventory and hashes (inspect the pinned revision for future builds): https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2?blobs=true
- Upstream model card: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/raw/main/README.md
- Wrapper versioned LICENSE: https://raw.githubusercontent.com/huggingface/transformers.js/3.8.1/LICENSE
- Wrapper package version/dependency metadata: https://registry.npmjs.org/@huggingface/transformers/3.8.1
- Runtime exact-revision LICENSE: https://raw.githubusercontent.com/microsoft/onnxruntime/89f8206ba4/LICENSE
- Runtime exact-revision third-party notices: https://raw.githubusercontent.com/microsoft/onnxruntime/89f8206ba4/ThirdPartyNotices.txt
- Jinja primary published LICENSE: `node_modules/@huggingface/jinja/LICENSE` (copied alongside these notices).

## Copies retained for distribution

- `licenses/APACHE-2.0.txt`: full license copied unchanged from the installed pinned Transformers.js package; also supplies the license text for the Apache-designated model artifacts.
- `licenses/ONNX_RUNTIME_MIT.txt`: exact upstream runtime MIT license text and Microsoft copyright.
- `licenses/ONNX_RUNTIME_THIRD_PARTY_NOTICES.txt`: full upstream notice pack for the pinned runtime revision, deliberately retained without pruning. It describes the upstream product broadly; inclusion is not a claim that every listed component is compiled into Vaayana's browser WASM artifact.
- `licenses/HUGGINGFACE_JINJA_MIT.txt`: unchanged published Jinja package license.

Include these notices/license copies with redistributed source and built assets, retaining upstream copyright/attribution and any additional notices supplied by the exact packages. No upstream files are modified. If model/runtime artifacts or package versions change, repeat the check, update copies and preserve any required modification notices. A future distribution review must cover additional dependencies/binaries introduced by changes; this document is not a clearance for arbitrary future models or packages.

## Actual execution and footprint boundary

The app uses a dedicated browser worker, CPU WebAssembly, q8 ONNX weights, mean pooling, normalized 384-dimensional vectors, and a 256-wordpiece token limit. It does not generate prose or use a remote inference service. It reads only supplied metadata/interests for reranking; the service never transmits them for inference.

The selected ONNX weight file is **22,972,370 bytes**. Tokenizer/configuration files are approximately **712,802 bytes**. The selected pinned wrapper's local WASM runtime is **21,596,019 bytes**, with **44,484 bytes** of module glue, plus application worker code. These are inspected artifact sizes, not a measured complete network transfer or peak memory requirement. The interface must say approximately 46 MB plus worker overhead unless a specific built release is measured. Cache/HTTP compression and browser caching affect actual transfer.

WASM/module assets are bundled as local build assets, not loaded from an unpinned runtime CDN. The model is requested from Hugging Face at the pinned commit only after consent. The site host sees runtime asset requests; the model host sees model downloads/IP information. No diary text is sent.

Model removal terminates the worker, drops in-memory vectors and deletes only `vaayana-semantic-*` Cache Storage entries. Browser-managed HTTP caches may retain application/runtime assets; do not claim that browser-wide network caches or third-party server logs are wiped. Books, notes, tags, goals and backups are not removed by this control.

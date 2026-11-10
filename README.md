# Vaayana

A warm, private reading library for physical and digital books. Catalog your collection, keep a reading journal, set gentle goals, and discover something worth your time.

Originally described as a reading-list application that catalogs physical and digital libraries, finds and refreshes book metadata, maintains reading goals, and suggests books based on reading history.

## Open the live app

**https://balug87.github.io/vaayana/**

GitHub Pages serves the static application, not your library. Books and notes remain in your browser. The hosted app and a local copy have separate storage; export and import a backup to transfer intentionally. Opening a new address does not move or erase the old library.

## Open it on this computer

Node.js 22.12 or later and Git are required.

1. Open **Terminal** on your Mac.
2. Copy these commands, paste them into Terminal, and press Return:

   ```sh
   git clone https://github.com/balug87/vaayana.git
   cd vaayana
   npm ci
   npm start
   ```

3. Once Terminal says the app is ready, open **http://127.0.0.1:4173** in your browser.
4. Keep that Terminal window open while the local preview runs. Press **Control+C** there when you want to stop it.

`npm start` builds a production copy, including its offline service worker, and serves it only on this computer. It does not deploy anything or create a paid resource. If port 4173 is occupied, stop the existing Vaayana preview rather than changing ports casually.

**Keep using the same address.** `127.0.0.1:4173`, `localhost:4173`, another port, a different browser/profile, and the hosted URL can each have separate local libraries. Export and import to move a library intentionally.

For later launches, open Terminal in the existing project folder and run `npm start`. For development only, `npm run dev` opens a local Vite server, normally at http://127.0.0.1:5173. Offline installation is tested against a production build, not the development server.

## Start with one book

- Click **Add a book → Enter manually**, or explicitly enable online lookup to search by title, author, or ISBN and choose an edition.
- Pick physical, digital, or both. A wishlist book need not have an owned copy. Missing ISBNs, covers, or page counts are fine.
- Open a book journal to change its status, organize it with a primary/secondary Layer, edit tags, log pages/minutes or a bookmark, and keep private notes.
- In **Reading**, set an optional goal. Sessions supply pages/minutes; finishing does not count pages twice. Digital percentage is never invented into a page count.
- **Discover** retrieves actual Open Library candidates for two lanes: interest-aligned and interest-expanding. Your explicit interests lead. Consented history signals are broad, visible, removable topics, not raw private purpose text or sensitive labels.
- **Settings & backup → Export backup** downloads a portable JSON file. Keep it somewhere safe and verify it saved.

## Import a book catalog or backup

In **Settings & backup → Import backup or catalog**, choose one of these two JSON formats:

- **Vaayana backup:** an unedited file made by **Export backup**, identified by `"format": "vaayana"` and `"formatVersion": 1`. It carries library records, notes, history, settings, and deletion information.
- **Book catalog:** a JSON object with a `books` array. Every entry needs a non-blank `title` string and an `author` string or `null` when unknown. Optional root fields are `total_unique_titles` and `notes`; optional entry fields are `source_images` (whole-number references, not uploads) and `notes`. A bare array is not accepted.

[Read the full format guide](https://balug87.github.io/vaayana/import-formats/index.html), or see the repository copy at [`public/import-formats/index.html`](public/import-formats/index.html). It includes invented downloadable examples and JSON Schemas for both formats. Exact catalog rules are also in [`src/data/IMPORT_FORMAT.md`](src/data/IMPORT_FORMAT.md).

The catalog preview shows the **actual** entry count, declared total, unknown authors, warnings, and source notes. A mismatched declared total never truncates the list. Choose **To read** or **Wishlist** and unknown/physical/digital/both holdings for **new books only**. Defaults are To read and unknown holdings. No read history, finished dates, tags, Layers, or online facts are invented.

Once **Offline ready** appears, the format guide, examples, and schemas are cached with the app. The inline example and local file import also work without a network connection. Optional model assets remain excluded from this app-shell download.

Similar titles are skipped by default or explicitly added as separate books, never merged over your saved edits. Imported source text stays **unverified**, separate from your personal diary; entry provenance is visible in the book's **Sources** tab. Repeating the same catalog does not duplicate its books. Changing defaults or downloading a pre-import backup refreshes the preview and requires review again. Cancel saves nothing. Import does not upload the list, look up every title, or start a model download.

All files are limited to **20 MiB of UTF-8 bytes**. Catalogs support up to **10,000 entries**. Unknown fields and unsupported formats are rejected, not silently discarded. The format guide explains field limits and common errors. Use the app exporter for complete backups, rather than hand-writing their internal IDs and records.

**Update before transferring a new backup.** On the receiving device, open Vaayana online and reload the latest app before importing a backup made by this version. Older app copies may reject the new optional catalog-source and starting-shelf fields, even though the backup format/schema labels have not changed. The current app still reads older backups. Keep your original backup if you cannot update yet.

## Privacy and backups

There is no account, telemetry, application backend, remote diary database, or automatic cross-device synchronization. Books, reading history, notes, personal ratings, tags, and Layer decisions live in IndexedDB, the browser's local database.

Online lookup and cover loading start **off**. If enabled, Open Library sees the title/author/ISBN/topic query or cover request plus normal network information such as your IP address. External review sites see visits when you open their links. Optional model downloads contact Hugging Face and its asset hosts; local inference does not send the text to a remote AI service. All fonts and interface artwork are local/system assets.

Local does **not** mean encrypted, backed up, or protected from someone sharing your unlocked browser profile. Browser eviction, storage clearing, private browsing, device loss, or origin changes can lose data. Installation and persistent-storage permission are not backups.

Exports contain private notes in plaintext. Imports validate version, structure, relationships, identifiers, URLs, and size **before writing**, then show a merge preview and manual conflicts. Local edits/deletions win by default; restore decisions are explicit. Stable identities, deletion records, and import lineage prevent accidental duplication or resurrection from older snapshots. A pre-import export prompts a fresh preview. Limits are 20 MiB total, 50,000 user records, and 100,000 deletion/import-provenance records, with per-field/nesting caps. See `src/data/README.md` for exact behavior.

## Installation and offline use

On supported Chrome/Edge browsers, use the browser's Install action. Safari may offer Add to Dock on Mac or Share → Add to Home Screen on iPhone/iPad. There is no universal install prompt.

**Offline ready** means all required app-shell assets are cached and an active service worker controls the page, not merely that a web page loaded once. Partial/failed setup is labeled Not ready/Error. Once ready, saved books, local search, journal edits, goals, and manual entry work offline. Fresh metadata/recommendations, external reviews, uncached covers, and missing model assets need internet. First-ever offline access cannot install the app.

The local address above is reachable only on this computer. Open the HTTPS live-app link on a phone for hosted access and supported installation. Production builds are static files in `dist/`. Hosting quotas and future pricing are controlled by GitHub, not guaranteed by this app.

The Pages workflow builds with `VAAYANA_BASE_PATH=/vaayana/`. Ordinary `npm start` leaves that variable unset and keeps the local root address unchanged. The app manifest, service-worker scope, assets, notices, and optional runtime URLs follow the selected base path.

## Optional local semantic matching

The app works without AI. In Settings, enable online lookup, read the model notice, check explicit download consent, and choose **Download optional model**. Once real initialization and inference succeed, **Discover → Use semantic matching** reranks retrieved candidates locally.

- Pinned runtime: `@huggingface/transformers@3.8.1`, CPU WebAssembly in a dedicated worker.
- Model: `Xenova/all-MiniLM-L6-v2`, revision `751bff37182d3f1213fa05d7196b954e230abad9`, q8, 384 dimensions, 256-wordpiece input limit.
- Approximately **46 MB plus worker assets** before compression/caching: about 23 MB weights, 0.71 MB tokenizer/config, and 21.64 MB local WASM/glue. This is not a peak-memory guarantee.
- Optional worker/WASM assets are excluded from baseline shell precaching and are not fetched before consent. Modes are **Rule-based**, **Downloading**, **Semantic ready**, and **Basic fallback**, never a simulated inference success.
- No chatbot or review generation. It cannot find books outside its supplied candidate corpus. Mobile capability, performance, recommendation quality, and Malayalam/multilingual semantic quality are not guaranteed.
- Removal clears app-owned model caches and vectors, not browser-wide HTTP caches or third-party logs.

License/attribution sources and full copies are in `docs/THIRD_PARTY_NOTICES.md` and `docs/licenses/`. The prebuild step copies them unchanged into `public/notices/`, then `dist/notices/`; Settings links to the bundled notices.

## Reviews and metadata limits

Open Library supplies low-volume public metadata and available **Open Library reader rating** averages/counts with source dates. API requests are cached, throttled, and human-directed. Coverage and cover-image rights are not guaranteed.

Professional reviews, reader reviews, source rating aggregates, and your notes are separate. Save a review link only after checking it. **Search Goodreads** and **Find a Kirkus review** are search actions, not verified reviews. No scraping, fake snippets, invented consensus, or new Goodreads API-key promise. Full-text review aggregation remains a permission/licensing-gated extension, not a delivered free feature. Google Books is not used.

## Developer checks

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

The end-to-end suite uses Playwright with a production preview on `127.0.0.1:4173`, fresh browser contexts, deterministic provider fixtures for regressions, and separately labeled opt-in live provider/model checks. A Chromium browser installation may be required: `npx playwright install chromium`.

Source ownership/layout:

- `src/App.tsx`, `src/components/`, `src/hooks/`, `src/ui/`: responsive interface and input integration.
- `src/domain/`, `src/data/`: identities, local database, migrations, goals, protected metadata, safe backup/import.
- `src/services/`: provider lookup/discovery, privacy controls, rule suggestions, optional local model worker.
- `src/sw.ts`, `vite.config.ts`: verified app-shell cache and PWA manifest.
- `tests/e2e/`, `docs/VALIDATION.md`: browser checks and the portable validation summary.

## Verification limits

The build, TypeScript checks, and 160 unit tests pass. The final local-root Chromium run passed 33 checks and intentionally skipped 2 opt-in live provider/model checks. All 11 scoped Pages import checks passed. Earlier baseline runs exercised live metadata and actual local-model inference. See `docs/VALIDATION.md` for coverage and limits rather than treating this README as a universal compatibility claim.

The intended broader matrix is Mac Safari/Chrome, Windows Edge/Chrome/Firefox, iPhone Safari, and midrange Android Chrome. Desktop Chromium and emulated mobile checks do not establish results on actual iPhones, low-memory Android devices, Safari, or Windows hardware. GitHub Pages hosts only static files; no paid backend, app-store packaging, or automatic sync is included.

The current `npm audit` reports **4 low-severity findings**, all in the PWA build-tool chain (`deepmerge`, Rollup's resolver, Workbox build, and the PWA plugin), with **zero moderate, high, or critical findings**. The registry's proposed force-fix is an incompatible old PWA-plugin downgrade, so it was not applied. This is a dated dependency check, not a promise that software is vulnerability-free; recheck advisories as dependencies evolve.

# Validation summary

The final application passed **160 unit tests** across **18 files**, TypeScript checks, and both root and GitHub Pages builds. The final local-root Chromium run passed **33 checks**, with **2 intentional opt-in live provider/model skips** and **0 failures**. All **11 scoped Pages import checks** passed. Six settled earlier-baseline screens had no detected WCAG 2 A/AA or 2.1 AA violations in the automated accessibility scan. These are scoped checks, not a complete accessibility or device certification.

Browser checks covered catalog/edition entry, protected metadata refresh, local notes, reading sessions and goals, safe backup merge, privacy controls, cancellation, and offline relaunch. The separate earlier-baseline live Open Library check retrieved 12 real results in each recommendation lane, including an explicitly explained broader bridge when the narrow query was empty.

The earlier-baseline optional MiniLM check used actual local inference, including cached offline initialization and reranking. Candidate retrieval for that model-only case was synthetic. It established finite 384-dimensional vectors and one plain-language similarity sanity check, not general quality, multilingual accuracy, peak memory, or slow-device performance. The final catalog-fix regression run did not repeat that opt-in model download.

Optional cached assets occupied about **46.2 MB** in that check. This is cache payload, not a measured complete wire-transfer size.

The four example-library screenshots in `docs/qa/` show isolated test data made from public titles, not a personal library. Raw logs, browser traces, environment-specific reports, and measurements are intentionally not published.

The dependency audit reported **4 low-severity build-tool-chain findings**, with no moderate, high, or critical findings. A force-fix that downgraded the PWA plugin was not applied.

Actual iPhone, Android, Safari, Windows hardware, and installed-PWA behavior remain outside these Chromium checks. Run the checks again after dependency or application changes.

## GitHub Pages project path

The final **11-check** import run passed under `/vaayana/`. It exercised format detection, actual/declared counts, unknown authors, cancellation, explicit new-book defaults, review reset, repeated imports, canonical backup round trips, similar-title skip/add-separate decisions, and an older changed-source catalog retaining an imported deletion unless explicitly restored. The guide, examples, and schemas returned valid responses and remained available offline. Catalog operations did not start metadata lookup or optional model downloads.

The final root and scoped import checks use invented test data. Separate local-only checks confirmed supplied-catalog provenance, unknown authors, offline import, repetition, and backup round trips without adding personal catalog data to this repository.

Two earlier-baseline production-preview checks also passed under `/vaayana/`: scoped HTML/assets/manifest/icons/notices/service worker, saved books and notes after offline reload, actual 384-dimensional local inference online and after cached offline initialization, and model removal preserving the diary, app shell, and three root-cache sentinels. Neither saw a missing asset, root-path request leak, browser exception, or CSP error.

The earlier deployment/model checks use `tests/e2e/pages/playwright.pages.config.ts` with an explicit `PAGES_QA_URL`. They are distinct from the final catalog import regression checks. Preview evidence is not a substitute for checking the final published HTTPS site.

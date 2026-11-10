# Validation summary

The application passed **129 unit tests**, including deployment-cache isolation, and the local-root production build passed **28 Chromium browser checks**, with no browser failures or skipped cases. Six settled screens had no detected WCAG 2 A/AA or 2.1 AA violations in the automated accessibility scan. These are scoped checks, not a complete accessibility or device certification.

Browser checks covered catalog/edition entry, protected metadata refresh, local notes, reading sessions and goals, safe backup merge, privacy controls, cancellation, and offline relaunch. The separate live Open Library check retrieved 12 real results in each recommendation lane, including an explicitly explained broader bridge when the narrow query was empty.

The optional MiniLM check used actual local inference, including cached offline initialization and reranking. Candidate retrieval for that model-only case was synthetic. It established finite 384-dimensional vectors and one plain-language similarity sanity check, not general quality, multilingual accuracy, peak memory, or slow-device performance.

Optional cached assets occupied about **46.2 MB** in that check. This is cache payload, not a measured complete wire-transfer size.

The four example-library screenshots in `docs/qa/` show isolated test data made from public titles, not a personal library. Raw logs, browser traces, environment-specific reports, and measurements are intentionally not published.

The dependency audit reported **4 low-severity build-tool-chain findings**, with no moderate, high, or critical findings. A force-fix that downgraded the PWA plugin was not applied.

Actual iPhone, Android, Safari, Windows hardware, and installed-PWA behavior remain outside these Chromium checks. Run the checks again after dependency or application changes.

## GitHub Pages project path

Two additional production-preview checks passed under `/vaayana/`: scoped HTML/assets/manifest/icons/notices/service worker, saved books and notes after offline reload, actual 384-dimensional local inference online and after cached offline initialization, and model removal preserving the diary, app shell, and three root-cache sentinels. Neither check saw a missing asset, root-path request leak, browser exception, or CSP error. Separate default-root manual-entry/offline checks also passed.

The Pages checks use `tests/e2e/pages/playwright.pages.config.ts` with an explicit `PAGES_QA_URL`. They are separate from the normal 28-case root suite and include an actual consented model download. This preview evidence is not a substitute for checking the final published HTTPS site.

# Local library contract and safety

Import application actions from `repository.ts`, and types from `../domain/types`.
Await `initializeLibrary()` during app bootstrap **before rendering** a child that
calls the reactive hook. Initialization uses one transaction to create a stable
library identity, including simultaneous tabs. Do not initialize inside a querier.
`getSnapshot()` is strictly read-only and returns effective metadata and user fields. It works inside Dexie's
`liveQuery(getSnapshot)` / `useLiveQuery(getSnapshot)`. The library is empty initially.
The `db` export is available for read subscriptions; application edits must use actions
so the content revision and deletion history remain correct.
Before initialization, a standalone read returns an empty/default snapshot with
`libraryId: ''` and revision 0; it does not silently create records. Write actions
and exports can still initialize their root identity inside a write transaction.

## Identity and metadata

Local work, edition, session and other entity IDs are UUIDs (random for manual
entries, content-derived for repeatable external-catalog imports). Open Library
`MetadataCandidate.workId` / `editionId` are external aliases, not local primary keys.
Equivalent ISBN-10/13 values normalize to checksum-validated ISBN-13. Work aliases and
ISBNs reconcile authoritative identities; similar titles never silently merge.
`addBook` returns the local work ID. It warns about duplicate editions and similar
titles; explicit `allowDuplicate` permits a reviewed addition. A selected `workId`
can add another edition. Existing work purpose, Layers, tags and reading status are
preserved on edition additions, including empty/default form values. An explicit
`updateExistingOrganization` opt-in is required to change them through `addBook`.

Each work has a stable preferred edition. `updateBook` defaults to that edition;
its optional `editionId` targets another edition's metadata and holdings. Provider
snapshots never write personal overrides. Form corrections relative to a chosen
candidate become field overrides. Refresh validates identity and preserves missing
provider facts. `resetFieldOverride` explicitly returns a field to provider facts.

Tags keep stable IDs, aliases, origin/version evidence, pinned acceptance/rejection
and archive state. Subject matching consults renamed aliases and merge redirects.
A merge preserves individual assignment provenance rather than combining it away.
Rejections and archives are not silently undone by refreshing subjects.
Imports reconcile these decisions by the resolved **work/tag pair**, including
renamed aliases and merge redirects, not just by an assignment's UUID. A pinned
rejection hides acceptance until an explicit import restoration updates the pair.
Distinct imported note records remain visible together. Saving the single notes
textarea consolidates them atomically and tombstones superseded note identities.
Saving an unchanged bibliographic field does not create a new override; existing
intentional overrides still require the explicit reset action.

## Reading counting rules

Pages and minutes are **session amounts**. Current page and percentage are
**bookmarks**, not inferred page amounts. This matches the reading form, including
unknown page totals. Bookmarks never count towards page goals. Finishing a cycle
adds one book, never extra pages. Repeating Finished does not count twice.
After a finish, `setStatus(id, 'reading', { reread: true })` explicitly starts a
separate cycle. Session edits/deletions immediately recalculate goals over inclusive
calendar dates without removing unrelated events or cycles.

## Backups and imports

For accepted JSON schemas, examples, defaults, errors and catalog provenance, read
[`IMPORT_FORMAT.md`](./IMPORT_FORMAT.md). External catalogs are validated and staged
separately from canonical backups. `previewImport(text, options?)` reports the
detected `format`; neither format is guessed by discarding fields.

Backups contain sensitive, unencrypted diary text. Save them privately. Export
includes every owned store, provenance, settings and deletions, but no candidate
cache, embeddings, cover bytes, or copied third-party review assets.

Published limits (`BACKUP_LIMITS`):

- 20 MiB **UTF-8 bytes** per file (not JavaScript character count).
- 50,000 user-data records across stores.
- Separately, 100,000 deletion/import-provenance records across `tombstones`,
  `mergeLineage`, and `importReceipts`; these do not consume the user-data allowance.
- 20,000 characters per text value; narrower limits apply to names and identifiers.
- 10,000 items per nested array, maximum nesting depth 16.
- Up to four staged previews, expiring after 30 minutes.

Each generated export passes the **same parser used by import**, including byte,
field, key, date, enum, checksum, relation, URL and count validation. The export
timestamp changes only after generation succeeds. Backup bookkeeping does not
invalidate content previews. Export failure does not silently remove any records.

`previewImport(text)` has no library-content writes. Review its counts and conflicts.
`commitImport(token, decisions)` takes optional conflict-ID decisions (`keep-local`
or `use-import`). Omitted decisions preserve local records/deletions/archives.
`cancelImport(token)` discards the staged representation.

All accepted entities, receipts and mappings commit in one IndexedDB transaction.
Content changes after preview produce `StaleImportPreviewError`; preview the same
file again rather than retrying an old token. Interrupted/quota-failed transactions
roll back completely and the token remains available for retry. Overlapping
previews serialize and the later stale one cannot commit unnoticed.

Same-file receipts avoid repeated imports. Revision ancestry handles descendant,
older, and divergent snapshots without trusting device timestamps. Stable UUIDs
keep identity across libraries; merge mappings are stored when authoritative
aliases actually change IDs. Deletions retain content-free tombstones permanently.
Multiple delete/restore/delete events all remain effective. Explicit restoration
records the deletion revisions as resolved ancestors. An older different export
cannot silently resurrect deleted notes/sessions or unarchive/reaccept tags.
Contradictory selective conflict choices that break relations reject the whole
commit; no partial merge is written.

## Migration recovery

Schema version 1 is upgraded transactionally to version 2 (tag lifecycle defaults
and deletion/import lineage stores). Never delete/reset the database after an
upgrade failure. `exportRecoveryBackup()` uses a read-only native IndexedDB open
without requesting an upgrade, bypassing the failed migration. It produces a
private `vaayana-recovery` file containing original owned stores and metadata,
not replaceable caches. This is deliberately not presented as a validated normal
backup. Retain it for repair before a supported import. Close other app tabs if
the browser reports a blocked database operation.

## Verification

`npx vitest run src/data/library.test.ts src/data/backup-boundaries.test.ts src/data/live-query.test.ts`
uses actual Dexie transactions over `fake-indexeddb`. Fixtures cover version 1,
failed upgrade rollback and native recovery extraction. Boundary tests run the
real export/parser/preview/commit/re-export paths for 10,001 sessions and the
50,000-user-record cap, plus exact 20 MiB and multibyte UTF-8 file boundaries.
These are Node/IndexedDB data tests, not a claim of cross-browser device QA.
The live-query tests additionally mount the real React `useLiveQuery` hook in
jsdom against fresh IndexedDB, covering initial empty load and reactive edits.

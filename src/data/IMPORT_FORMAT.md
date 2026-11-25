# JSON import formats

Vaayana accepts **two different JSON formats** through **Settings → Import**:

1. **Vaayana backup**, created by the app's Export action. It contains saved
   catalog data, personal edits, diary, settings and deletion history.
2. **Book catalog**, a simple external list of titles and authors. It does not
   need Vaayana IDs, reading history, ISBNs or provider metadata.

Import reads the file locally. It never uploads the list or automatically searches
for every book. Previewing does not save books. Review the format, actual count,
warnings, defaults and conflicts, then confirm. Cancel leaves the library alone.

## Book catalog example

These are invented example books, not a reading list:

```json
{
  "total_unique_titles": 2,
  "notes": "An example inventory. Reconstructed text is unverified.",
  "books": [
    {
      "title": "The Lantern Atlas",
      "author": "A. Example",
      "source_images": [1, 2]
    },
    {
      "title": "A Quiet Orchard",
      "author": null,
      "source_images": [3],
      "notes": "The partly visible spine needs checking."
    }
  ]
}
```

### Exact catalog schema

The root must be a JSON **object**, not a bare array. Its only allowed fields are:

| Field | Required | Value |
| --- | --- | --- |
| `books` | Yes | Array of book objects, including an empty array. |
| `total_unique_titles` | No | Non-negative whole number. This is a declared count, not a truncation limit. |
| `notes` | No | Global source/provenance text. |

Each `books` entry has only these allowed fields:

| Field | Required | Value |
| --- | --- | --- |
| `title` | Yes | Non-blank string, at most 1,000 characters. Full title and Unicode are retained. |
| `author` | Yes | String, at most 500 characters, or **`null`** for unknown. Do not invent an author. |
| `source_images` | No | Array of non-negative integer image references. These are indices, not URLs or image uploads. |
| `notes` | No | Entry-specific source/provenance text, including uncertainty. |

An empty/whitespace author string is also treated as unknown while preserving its
original source value. Author strings are not split or guessed.

Global and per-entry notes have a 20,000-character limit. Image arrays have at most
10,000 integer items, each between 0 and 1,000,000,000. A catalog can contain at most
10,000 entries. Every input file is limited to **20 MiB of UTF-8 bytes**, not character
count. The merged library must also remain within the canonical backup limits.
Unknown fields are rejected rather than silently discarded.

If `total_unique_titles` differs from `books.length`, the preview warns explicitly.
**The actual array is authoritative:** no rows are silently truncated, padded,
deduplicated, or rewritten to match the declared number.

### Catalog defaults and uncertainty

The preview lets you choose the initial status (**To read** or **Wishlist**) and
holdings (**unknown**, physical, digital, or both). The data API defaults to To read
and unknown holdings. Choices affect **new entries only**. Existing reading status,
holdings, corrected metadata, notes and personal organization remain unchanged.

A catalog does not establish that a book was read. Import creates no reading
cycles, finish dates, status events or sessions. No ISBN, language, page count,
rating, tag, Layer or online metadata is inferred. Reconstructed spines and notes
remain labeled **unverified**, even when the file itself says “deduplicated.”

Edition-, translation-, revision- and volume-specific titles remain intact.
Different rows are not collapsed because they share an author. Even identical
repeated rows remain separate, with a preview warning.

Exact source-row identities make repeated imports idempotent, even when JSON
whitespace or object-key order changes. Overlapping/reordered source entries keep
their identities; new source provenance may be appended without replacing edits.
Changing bibliographic/source row fields is a different source row, not evidence
that an existing edition should be overwritten.

If a catalog entry has the same normalized saved title, the preview conservatively
asks for confirmation even when authors are combined or written differently. It offers:

- **Keep local** (default): skip that catalog entry.
- **Use import**: add the entry as a **separate book**, not a merge or replacement.

A previously deleted catalog entry requires an explicit restore decision for a
different older snapshot. Reimporting an already recorded file does not resurrect
it. Import choices never automatically combine similarly titled books or editions.
An opaque, title-family deletion hint also catches older variants with different
photo indices or entry notes. This is an ambiguity warning, never proof of edition
identity or an automatic merge. The deletion hint retains no old title or note text.

### Where source information goes

Original title, author (including `null`), image indices, per-entry notes and an
unverified marker are stored as edition import provenance. Global notes, the
declared/actual count and unknown-author count are retained once in the source's
import receipt. Source notes are **not** silently put into private reading notes
or treated as verified publisher facts. A normal Vaayana export/import round trip
preserves all these source fields.

## Vaayana backup

Create backups using **Export**. Do not rename external catalog fields to imitate a
backup or manually invent UUIDs/revisions.

A canonical backup has these root fields:

- `format: "vaayana"`
- `formatVersion: 1`
- `schemaVersion: 1`, `2` or `3` (current exports use `3`)
- `exportId`, `sourceLibraryId`, `exportedAt`
- `entities`, containing the supported named stores and typed records

Canonical backups retain their stricter field, version, relationship, HTTPS URL,
UUID, checksum, revision and tombstone checks. A malformed backup is **not**
reinterpreted as a catalog to bypass those checks. Unknown versions/fields do not
silently import. Exported files contain sensitive diary data and are not encrypted.

### Uploaded and fetched covers in schema 3

Version 3 adds the portable `coverStates` store, keyed by a stable UUID and related
to one work. A chosen provider cover contains only an Open Library cover ID,
source and retrieval date. A local uploaded cover contains a prepared JPEG,
dimensions and byte count. Original source filenames and EXIF metadata are not
retained. Uploaded photos take precedence; removing one preserves the record's
revision history and reveals any provider/bibliographic fallback.

The UI accepts JPEG, PNG or WebP input up to **10 MiB / 24 million pixels**, then
decodes and re-encodes it as JPEG with at most **512 pixels on the longest edge**.
It targets **32 KiB** with a hard **64 KiB** normalized-photo limit. Only that
prepared raster is saved. SVG, GIF, HEIC, arbitrary image/data URLs, EXIF-bearing
JPEGs and malformed/incomplete JPEG headers are not portable upload formats.
Import validates bounded JPEG segments, real quantization/Huffman definitions,
component/table references, supported scan structure, actual dimensions and bytes.
The canonical base64 exception applies only to
`entities.coverStates[].uploaded.jpegBase64`, with a maximum of 87,384 characters;
it does not relax text limits or accept other image strings.

All normalized photos share an **8 MiB total** budget, while the entire portable
backup still must fit **20 MiB of UTF-8**. Base64 adds about one third: 128 photos at
the maximum 64 KiB consume approximately 10.67 MiB of JSON image strings, before
records and diary. The exact whole-library serializer is checked before each
cover save or import commit. An over-limit or quota-failed operation retains the
previous photo and library. No image data is silently dropped to meet a limit.

Photos are sensitive and unencrypted in exported backups. Image bytes are never
sent to bibliographic services. Shelf snapshots expose a descriptor, not base64;
local photos are retrieved as Blob objects and can render offline with all online
cover settings disabled.

Database upgrades from versions 1/2 add the stores transactionally without deleting
or rebuilding the existing library. Backups from versions 1/2 remain importable,
with an empty cover store added during staging. **Older Vaayana releases cannot
import a version-3 backup**; update the receiving app first. New cover fields are
not disguised as version 2. Public schemas and the exported fictional example
reflect the actual version-3 format.

`coverJobs` and device pause state are operational, **not** portable user data:
claims, attempts, leases, failures and pause controls are not exported or imported.
The automatic-fetch setting is receiver consent. Import never enables it:
a fresh receiver remains off and an existing receiver keeps its own choice,
regardless of settings/conflict choices in the file. With prior explicit opt-in,
newly imported catalog entries may become eligible for the local cover queue.
Catalog import itself creates no reading events or inferred bibliographic facts.

Queue claims are atomic across books/tabs; only one unexpired job may run. Checks
before each request and before saving results use current saved query fields,
attempt ID, lease, device generation, consent and expected cover revision. Pausing,
uploading, deleting or editing the book prevents a stale result from being saved.
Pause survives unrelated edits/reloads/imports. Terminal failed/no-match/cancelled
jobs do not automatically repeat for the same query; use explicit retry/resume.
Expired leases become interrupted/cancelled, never silently reclaimed.

## Common errors

- **“Supported formats…”**: the root is neither a Vaayana backup nor an object
  containing `books`. A bare array, CSV, arbitrary JSON or another app's backup is
  not automatically guessed.
- **“Catalog root/entry contains unsupported fields…”**: use only the documented
  fields. The error gives allowed field names, not the contents of your book list.
- **“Requires author…”**: add `"author": null` when the author is unknown.
- **“Invalid JSON…”**: check commas, double quotes and closing brackets. Private
  book text is not quoted in parsing errors.
- **“Declared count differs…”**: a preview warning; all actual entries remain
  eligible for import.
- **“Library changed after this preview…”**: preview the file again so new edits
  and conflicts are included.

Malformed/oversized files, cancelled previews, stale previews and failed storage
writes leave the saved library unchanged. Accepted records and their provenance
commit atomically; retrying a failed commit cannot leave half the catalog saved.
Compact catalogs can expand into several records per book. Preview rejects a
determinably oversized default catalog merge. Both catalog and backup commits check
the exact serialized merged backup, including receipts, mappings, tombstones and
export bookkeeping, before saving anything. Two individually valid files are not
permission to exceed the combined portable-backup limits.

## Application API

`previewImport(text, { status?, formats? })` returns a discriminated preview:

- `format: "vaayana-backup"` or `"book-catalog"`
- `counts`, `warnings`, `conflicts`, `alreadyImported`, `libraryRevision`, `token`
- Catalog only: `source` (actual/declared/unknown-author counts, notes, unverified)
  and `defaults` (status/holdings)
- Catalog conflict entries include a one-based `catalogEntryIndex`.

For catalog previews, counts describe books, not internal work/edition rows.
`commitImport(token, decisions)` is additive for catalogs; omitted decisions preserve
local state. `cancelImport(token)` discards the staged preview.

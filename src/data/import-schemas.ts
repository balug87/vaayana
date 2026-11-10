/** Public, portable structural schemas. Import additionally checks semantic invariants. */
type Schema = Record<string, unknown>;
const text = (maxLength = 20_000): Schema => ({ type: 'string', maxLength });
const num = (maximum = 1_000_000_000): Schema => ({ type: 'number', minimum: 0, maximum });
const int = (maximum = 1_000_000_000): Schema => ({ ...num(maximum), type: 'integer' });
const enumeration = (...values: (string | boolean)[]): Schema => ({ enum: values });
const ref = (name: string): Schema => ({ $ref: `#/definitions/${name}` });
const list = (items: Schema, maxItems = 500): Schema => ({ type: 'array', items, maxItems });
const object = (required: Record<string, Schema>, optional: Record<string, Schema> = {}): Schema => ({
  type: 'object', additionalProperties: false, required: Object.keys(required), properties: { ...required, ...optional },
});
const optionalNotes = { notes: text() };
export const CATALOG_SCHEMA: Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'urn:vaayana:import:catalog',
  title: 'Vaayana external book catalog',
  description: 'A local, unverified external inventory, not a Vaayana backup. The actual books array is authoritative; a declared-count mismatch is a warning. Maximum input size: 20 MiB UTF-8. The app also checks hostile keys, depth and merged-library limits.',
  ...object({ books: list(object({
    title: { ...text(1_000), pattern: '\\S' }, author: { anyOf: [text(500), { type: 'null' }] },
  }, { source_images: list(int(), 10_000), ...optionalNotes }), 10_000) }, {
    total_unique_titles: int(), ...optionalNotes,
  }),
};
const uuid: Schema = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' };
const date: Schema = { ...text(), pattern: '^\\d{4}-\\d{2}-\\d{2}(T[\\d:.]+Z)?$', description: 'An actual calendar date or UTC timestamp. Calendar validity is also checked by the application.' };
const url: Schema = { ...text(), pattern: '^[hH][tT][tT][pP][sS]:', description: 'HTTPS only. The application additionally parses the URL and rejects embedded credentials and prohibited local/private hosts.' };
const layers = enumeration('operating-system', 'fuel', 'hardware', 'mind-expanding', 'software-applications', 'screensaver-sandbox');
const origin = enumeration('user', 'provider', 'rule', 'model');
const statuses = enumeration('wishlist', 'to-read', 'reading', 'paused', 'finished', 'abandoned');
const metadataRequired = { title: text(), authors: list(text(500)) };
const metadataOptional = {
  subtitle: text(), description: text(), publisher: text(500), publishedDate: text(500), language: text(500),
  pageCount: { ...int(), minimum: 1 }, coverId: int(), subjects: list(text(500)),
};
const metadataFields = Object.keys({ ...metadataRequired, ...metadataOptional });
const base = { id: ref('uuid'), revision: ref('uuid'), ancestors: list(ref('uuid'), 10_000), createdAt: ref('date'), updatedAt: ref('date') };
const row = (required: Record<string, Schema>, optional: Record<string, Schema> = {}) => object({ ...base, ...required }, optional);
const preferencesId = { anyOf: [ref('uuid'), { const: 'preferences' }] };
const catalogSource = object({ actualCount: int(), unknownAuthorCount: int(), unverified: { const: true } }, { declaredCount: int(), notes: text() });
const catalogProvenance = object({
  catalogId: ref('uuid'), entryId: ref('uuid'), originalTitle: text(),
  originalAuthor: { anyOf: [text(500), { type: 'null' }] }, sourceImages: list(int(), 10_000), unverified: { const: true },
}, optionalNotes);
const candidate = object({
  ...metadataRequired, workId: { type: 'string', pattern: '^/works/OL\\d+W$' },
  isbn: list({ type: 'string', maxLength: 500, pattern: '^(?:[0-9Xx\\s-]{10,}|[0-9]{13})$', description: 'Normalized and checksum-validated by the application.' }),
  subjects: list(text(500)), sourceUrl: ref('httpsUrl'), fetchedAt: ref('date'),
}, {
  ...metadataOptional, editionId: { type: 'string', pattern: '^/books/OL\\d+M$' }, firstPublishYear: int(),
  rating: object({ source: { const: 'Open Library reader rating' }, average: num(5), count: int(), fetchedAt: ref('date') }),
});
const entityDefinitions: Record<string, Schema> = {
  works: row({ title: text(), authors: list(text(500)) }, { preferredEditionId: ref('uuid'), initialStatus: enumeration('to-read', 'wishlist'), catalogFamilyId: ref('uuid') }),
  editions: row({ workId: ref('uuid'), metadata: ref('metadata') }, { catalogProvenance: list(ref('catalogProvenance'), 10_000) }),
  identifiers: {
    ...row({ entityId: ref('uuid'), entityType: enumeration('work', 'edition'), scheme: enumeration('isbn', 'open-library-work', 'open-library-edition'), value: text(500) }),
    allOf: [
      { if: { properties: { scheme: { const: 'isbn' } } }, then: { properties: { entityType: { const: 'edition' }, value: { pattern: '^(978|979)[0-9]{10}$' } } } },
      { if: { properties: { scheme: { const: 'open-library-work' } } }, then: { properties: { entityType: { const: 'work' }, value: { pattern: '^/works/OL[0-9]+W$' } } } },
      { if: { properties: { scheme: { const: 'open-library-edition' } } }, then: { properties: { entityType: { const: 'edition' }, value: { pattern: '^/books/OL[0-9]+M$' } } } },
    ],
  },
  holdings: row({ workId: ref('uuid'), editionId: ref('uuid'), format: enumeration('physical', 'digital') }, { sourceUrl: ref('httpsUrl') }),
  metadataSnapshots: row({ workId: ref('uuid'), editionId: ref('uuid'), candidate: ref('candidate'), acceptedAt: ref('date') }),
  fieldOverrides: {
    ...row({ workId: ref('uuid'), editionId: ref('uuid'), field: enumeration(...metadataFields), value: { anyOf: [text(), num(), list(text(500))] } }),
    allOf: metadataFields.map((field) => ({
      if: { properties: { field: { const: field } } },
      then: { properties: { value: ({ ...metadataRequired, ...metadataOptional } as Record<string, Schema>)[field] } },
    })),
  },
  readingCycles: row({ workId: ref('uuid'), editionId: ref('uuid'), startedAt: ref('date'), status: statuses }, { finishedAt: ref('date') }),
  statusEvents: row({ workId: ref('uuid'), cycleId: ref('uuid'), status: statuses, occurredAt: ref('date') }),
  sessions: row({ workId: ref('uuid'), editionId: ref('uuid'), cycleId: ref('uuid'), occurredAt: ref('date'), pages: num(), minutes: num() }, { page: num(), percent: num(100) }),
  goals: row({ metric: enumeration('books', 'pages', 'minutes'), target: { ...num(), exclusiveMinimum: 0 }, startDate: ref('date'), endDate: ref('date') }),
  notes: row({ workId: ref('uuid'), text: text() }),
  personalRatings: row({ workId: ref('uuid'), value: num(5) }),
  layerAssignments: row({
    workId: ref('uuid'), secondary: list(layers, 6), purpose: text(), origin, label: enumeration('user-selected', 'tentative', 'needs-review'),
    evidence: text(), pinned: { type: 'boolean' },
  }, { primary: layers, version: text(500) }),
  tags: row({
    name: text(100), normalizedName: text(500), kind: enumeration('topic', 'purpose', 'mood', 'context'), aliases: list(text(500)),
    archived: { type: 'boolean' }, pinned: { type: 'boolean' },
  }),
  tagAssignments: row({
    workId: ref('uuid'), tagId: ref('uuid'), origin, state: enumeration('suggested', 'accepted', 'rejected'), pinned: { type: 'boolean' },
  }, { sourceRef: ref('httpsUrl'), version: text(500), confidence: num(1) }),
  tagRedirects: row({ fromTagId: ref('uuid'), toTagId: ref('uuid') }),
  reviewLinks: row({ workId: ref('uuid'), url: ref('httpsUrl'), title: text(500), source: text(500), kind: enumeration('professional', 'reader'), verified: { const: true }, verifiedAt: ref('date') }),
  ratingSnapshots: row({ workId: ref('uuid'), source: { const: 'open-library' }, average: num(5), count: int(), fetchedAt: ref('date') }),
  interests: row({ name: text(500) }),
  recommendationFeedback: row({ workKey: text(500), action: enumeration('dismiss', 'less-like-this'), topics: list(text(500)) }),
  settings: row({ id: { const: 'preferences' }, value: object({
    onlineAccess: { type: 'boolean' }, loadCovers: { type: 'boolean' }, useLibraryInterests: { type: 'boolean' },
    interests: list(text(500), 100), modelConsent: { type: 'boolean' }, reducedMotion: { type: 'boolean' },
    view: enumeration('shelf', 'list'), onboardingComplete: { type: 'boolean' },
  }, { modelVersion: text(500), lastExportAt: ref('date') }) }),
  tombstones: row({ table: {}, entityId: preferencesId, deletedRevision: ref('uuid') }, { catalogFamilyId: ref('uuid') }),
  mergeLineage: row({ sourceLibraryId: ref('uuid'), sourceEntityId: preferencesId, localEntityId: preferencesId, sourceRevision: ref('uuid') }),
  importReceipts: row({ exportId: ref('uuid'), sourceLibraryId: ref('uuid') }, { catalog: ref('catalogSource') }),
};
const provenance = ['tombstones', 'mergeLineage', 'importReceipts'];
(entityDefinitions.tombstones.properties as Record<string, Schema>).table = enumeration(...Object.keys(entityDefinitions).filter((table) => !provenance.includes(table)));
const stores = Object.fromEntries(Object.keys(entityDefinitions).map((name) => [name, list(ref(name), provenance.includes(name) ? 100_000 : 50_000)]));
const requiredStores = Object.fromEntries(Object.entries(stores).filter(([name]) => !provenance.includes(name)));
const optionalStores = Object.fromEntries(Object.entries(stores).filter(([name]) => provenance.includes(name)));
export const BACKUP_SCHEMA: Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#', $id: 'urn:vaayana:import:backup',
  title: 'Vaayana canonical backup, format 1 / schema 1 or 2',
  description: 'Export this format from Vaayana rather than constructing it manually. This schema defines allowed fields and local shapes. Import additionally enforces 20 MiB UTF-8, 50000 total owned records, 100000 total provenance records, UTF-16 text lengths/depth/hostile-key rules, UUID/ISBN semantics, unique identities, normalized tags, relationships, goal/calendar validity, revision ancestry and safe URL parsing. Canonical backups are never reinterpreted as external catalogs.',
  ...object({
    format: { const: 'vaayana' }, formatVersion: { const: 1 }, schemaVersion: { enum: [1, 2] },
    exportId: ref('uuid'), sourceLibraryId: ref('uuid'), exportedAt: ref('date'),
    entities: object(requiredStores, optionalStores),
  }),
  allOf: [{ if: { properties: { schemaVersion: { const: 2 } } }, then: { properties: { entities: { required: provenance } } } }],
  definitions: { uuid, date, httpsUrl: url, metadata: object(metadataRequired, metadataOptional), candidate, catalogSource, catalogProvenance, ...entityDefinitions },
};

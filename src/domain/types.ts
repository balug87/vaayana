export type ID = string;
export type ReadingStatus = 'wishlist' | 'to-read' | 'reading' | 'paused' | 'finished' | 'abandoned';
export type BookFormat = 'physical' | 'digital';
export type LayerId = 'operating-system' | 'fuel' | 'hardware' | 'mind-expanding' | 'software-applications' | 'screensaver-sandbox';
export type TagKind = 'topic' | 'purpose' | 'mood' | 'context';
export type Origin = 'user' | 'provider' | 'rule' | 'model';
export interface Revision {
  id: ID;
  revision: ID;
  ancestors: ID[];
  createdAt: string;
  updatedAt: string;
}
export interface MetadataFields {
  title: string;
  authors: string[];
  subtitle?: string;
  description?: string;
  publisher?: string;
  publishedDate?: string;
  language?: string;
  pageCount?: number;
  coverId?: number;
  subjects?: string[];
}
/** Provider facts only. Never include diary, notes, purpose, or personal ratings. */
export interface MetadataCandidate extends MetadataFields {
  workId: string;
  editionId?: string;
  isbn: string[];
  subjects: string[];
  firstPublishYear?: number;
  sourceUrl: string;
  fetchedAt: string;
  rating?: { source: 'Open Library reader rating'; average: number; count: number; fetchedAt: string };
}
export interface Work extends Revision { title: string; authors: string[]; preferredEditionId?: ID; }
export interface Edition extends Revision { workId: ID; metadata: MetadataFields; }
export interface Identifier extends Revision { entityId: ID; entityType: 'work' | 'edition'; scheme: 'isbn' | 'open-library-work' | 'open-library-edition'; value: string; }
export interface Holding extends Revision { workId: ID; editionId: ID; format: BookFormat; sourceUrl?: string; }
export interface MetadataSnapshot extends Revision { workId: ID; editionId: ID; candidate: MetadataCandidate; acceptedAt: string; }
export interface FieldOverride extends Revision { workId: ID; editionId: ID; field: keyof MetadataFields; value: string | string[] | number; }
export interface ReadingCycle extends Revision { workId: ID; editionId: ID; startedAt: string; finishedAt?: string; status: ReadingStatus; }
export interface StatusEvent extends Revision { workId: ID; cycleId: ID; status: ReadingStatus; occurredAt: string; }
export interface ReadingSession extends Revision { workId: ID; editionId: ID; cycleId: ID; occurredAt: string; pages: number; minutes: number; percent?: number; page?: number; }
export interface Goal extends Revision { metric: 'books' | 'pages' | 'minutes'; target: number; startDate: string; endDate: string; }
export interface Note extends Revision { workId: ID; text: string; }
export interface PersonalRating extends Revision { workId: ID; value: number; }
export interface LayerAssignment extends Revision { workId: ID; primary?: LayerId; secondary: LayerId[]; purpose: string; origin: Origin; label: 'user-selected' | 'tentative' | 'needs-review'; evidence: string; version?: string; pinned: boolean; }
export interface Tag extends Revision { name: string; normalizedName: string; kind: TagKind; aliases: string[]; archived: boolean; pinned: boolean; }
export interface TagAssignment extends Revision { workId: ID; tagId: ID; origin: Origin; sourceRef?: string; version?: string; confidence?: number; state: 'suggested' | 'accepted' | 'rejected'; pinned: boolean; }
export interface TagRedirect extends Revision { fromTagId: ID; toTagId: ID; }
export interface ReviewLink extends Revision { workId: ID; url: string; title: string; source: string; kind: 'professional' | 'reader'; verified: true; verifiedAt: string; }
export interface Interest extends Revision { name: string; }
export interface RecommendationFeedback extends Revision { workKey: string; action: 'dismiss' | 'less-like-this'; topics: string[]; }
export interface RatingSnapshot extends Revision { workId: ID; source: 'open-library'; average: number; count: number; fetchedAt: string; }
export interface Settings {
  onlineAccess: boolean;
  loadCovers: boolean;
  useLibraryInterests: boolean;
  interests: string[];
  modelConsent: boolean;
  modelVersion?: string;
  reducedMotion: boolean;
  view: 'shelf' | 'list';
  onboardingComplete: boolean;
  lastExportAt?: string;
}
export interface SettingsRecord extends Revision { value: Settings; }
export interface Tombstone extends Revision { table: EntityTable; entityId: ID; deletedRevision: ID; }
export interface MergeLineage extends Revision { sourceLibraryId: ID; sourceEntityId: ID; localEntityId: ID; sourceRevision: ID; }
export interface ImportReceipt extends Revision { exportId: ID; sourceLibraryId: ID; }
export interface EntityMap {
  works: Work; editions: Edition; identifiers: Identifier; holdings: Holding;
  metadataSnapshots: MetadataSnapshot; fieldOverrides: FieldOverride;
  readingCycles: ReadingCycle; statusEvents: StatusEvent; sessions: ReadingSession;
  goals: Goal; notes: Note; personalRatings: PersonalRating; layerAssignments: LayerAssignment;
  tags: Tag; tagAssignments: TagAssignment; tagRedirects: TagRedirect;
  reviewLinks: ReviewLink; ratingSnapshots: RatingSnapshot; interests: Interest;
  recommendationFeedback: RecommendationFeedback; settings: SettingsRecord;
  tombstones: Tombstone; mergeLineage: MergeLineage; importReceipts: ImportReceipt;
}
export type EntityTable = keyof EntityMap;
export interface Book extends MetadataFields {
  id: ID;
  workId: ID;
  editionId: ID;
  editions: Edition[];
  holdings: Holding[];
  formats: BookFormat[];
  isbn?: string;
  workKey?: string;
  editionKey?: string;
  status: ReadingStatus;
  cycleId?: ID;
  progress: { page?: number; percent?: number; pagesRead: number; minutesRead: number };
  purpose: string;
  primaryLayer?: LayerId;
  secondaryLayers: LayerId[];
  layerAssignment?: LayerAssignment;
  tags: Tag[];
  tagSuggestions: (TagAssignment & { tag: Tag })[];
  notes: string;
  personalRating?: number;
  reviewLinks: ReviewLink[];
  readerRating?: RatingSnapshot;
  metadataSnapshot?: MetadataSnapshot;
  overrides: FieldOverride[];
  createdAt: string;
  updatedAt: string;
}
export interface LibrarySnapshot {
  books: Book[];
  tags: Tag[];
  sessions: ReadingSession[];
  statusEvents: StatusEvent[];
  readingCycles: ReadingCycle[];
  recommendationFeedback: RecommendationFeedback[];
  goals: (Goal & { progress: number })[];
  settings: Settings;
  libraryId: ID;
  revision: number;
}
export interface AddBookInput {
  title: string;
  authors?: string[];
  isbn?: string;
  formats?: BookFormat[];
  status?: ReadingStatus;
  pageCount?: number;
  language?: string;
  publisher?: string;
  publishedDate?: string;
  description?: string;
  sourceUrl?: string;
  purpose?: string;
  primaryLayer?: LayerId;
  secondaryLayers?: LayerId[];
  tagIds?: ID[];
  candidate?: MetadataCandidate;
  workId?: ID;
  allowDuplicate?: boolean;
  updateExistingOrganization?: boolean;
}
export interface UpdateBookInput extends Partial<MetadataFields> {
  editionId?: ID;
  layerLabel?: LayerAssignment['label'];
  layerEvidence?: string;
  notes?: string;
  personalRating?: number | null;
  formats?: BookFormat[];
  purpose?: string;
  primaryLayer?: LayerId | null;
  secondaryLayers?: LayerId[];
  tagIds?: ID[];
}
export interface LogSessionInput {
  workId: ID;
  editionId?: ID;
  occurredAt?: string;
  pages?: number;
  minutes?: number;
  page?: number;
  percent?: number;
}
export interface MetadataDiff { field: keyof MetadataFields; previous: unknown; incoming: unknown; effective: unknown; overridden: boolean; }
export interface BackupDocument {
  format: 'vaayana';
  formatVersion: 1;
  schemaVersion: number;
  exportId: ID;
  sourceLibraryId: ID;
  exportedAt: string;
  entities: { [K in EntityTable]: EntityMap[K][] };
}
export interface ImportConflict {
  id: string;
  table: EntityTable;
  entityId: ID;
  kind: 'changed' | 'deleted' | 'archived' | 'identity';
  description: string;
  defaultDecision: 'keep-local';
}
export interface ImportPreview {
  token: string;
  sourceLibraryId: ID;
  exportId: ID;
  counts: { added: number; updated: number; unchanged: number; deleted: number };
  conflicts: ImportConflict[];
  alreadyImported: boolean;
  libraryRevision: number;
}
export type ImportDecisions = Record<string, 'keep-local' | 'use-import'>;

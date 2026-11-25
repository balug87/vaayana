import type { CoverDescriptor, CoverJob, CoverLookupClaim, CoverLookupResult, CoverLookupTarget, CoverQueueSnapshot, CoverState, ID } from '../domain/types';
import { db, DEFAULT_SETTINGS, getMeta, mutate, newId, readEntities, stamp } from './db';
import { COVER_LIMITS, base64ToCoverBytes, bytesToBase64, validateCoverJpeg } from './cover-validation';
import { serializePortableBackup } from './portable-backup';
import { assert } from './validation';
export { COVER_LIMITS } from './cover-validation';

const jobs = () => db.table<CoverJob, string>('coverJobs');
interface QueueControl { key: string; paused: boolean; generation: number; }
const controls = () => db.table<QueueControl, string>('meta');
async function control(): Promise<QueueControl> {
  return (await controls().get('cover-queue')) ?? { key: 'cover-queue', paused: false, generation: 0 };
}
async function preferences() {
  return { ...DEFAULT_SETTINGS, ...(await db.entity('settings').get('preferences'))?.value };
}
const coverRevision = (state?: CoverState) => state?.revision ?? null;
export function describeCover(state?: CoverState, bibliographicCoverId?: number): CoverDescriptor {
  if (state?.uploaded) {
    const { mime, width, height, byteLength } = state.uploaded;
    return { kind: 'uploaded', revision: state.revision, mime, width, height, byteLength };
  }
  const coverId = state?.provider?.coverId ?? bibliographicCoverId;
  return coverId ? { kind: 'provider', coverId, ...(state ? { revision: state.revision } : {}) } :
    { kind: 'none', ...(state ? { revision: state.revision } : {}) };
}
/** Recompute from saved effective bibliography, never trust a service-supplied fingerprint. */
async function target(workId: ID): Promise<CoverLookupTarget | undefined> {
  const work = await db.entity('works').get(workId);
  if (!work) return;
  const editions = await db.entity('editions').where('workId').equals(workId).toArray();
  const edition = editions.find((row) => row.id === work.preferredEditionId) ??
    editions.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  if (!edition) return;
  const provider = await db.entity('metadataSnapshots').where('editionId').equals(edition.id).first();
  const overrides = await db.entity('fieldOverrides').where('workId').equals(workId).toArray();
  const metadata = { ...edition.metadata, ...provider?.candidate };
  for (const row of overrides) if (row.editionId === edition.id) Object.assign(metadata, { [row.field]: row.value });
  const identifiers = await db.entity('identifiers').where('entityId').anyOf([workId, edition.id]).toArray();
  const isbn = identifiers.find((row) => row.scheme === 'isbn')?.value;
  const workKey = identifiers.find((row) => row.scheme === 'open-library-work')?.value;
  const editionKey = identifiers.find((row) => row.scheme === 'open-library-edition')?.value;
  const state = await db.entity('coverStates').where('workId').equals(workId).first();
  const queryFingerprint = JSON.stringify([edition.id, metadata.title, metadata.authors, isbn ?? null, workKey ?? null, editionKey ?? null]);
  return { workId, editionId: edition.id, title: metadata.title, authors: metadata.authors,
    ...(isbn ? { isbn } : {}), ...(workKey ? { workKey } : {}), ...(editionKey ? { editionKey } : {}),
    queryFingerprint, coverRevision: coverRevision(state), cover: describeCover(state, metadata.coverId) };
}
export async function getCoverTargets(): Promise<CoverLookupTarget[]> {
  return db.transaction('r', db.tables, async () => {
    const result: CoverLookupTarget[] = [];
    for (const work of await db.entity('works').toArray()) { const current = await target(work.id); if (current) result.push(current); }
    return result;
  });
}
export async function getCoverQueueSnapshot(): Promise<CoverQueueSnapshot> {
  return db.transaction('r', db.table('coverJobs'), db.meta, async () => {
    const { paused, generation } = await control();
    return { paused, generation, jobs: await jobs().toArray() };
  });
}
export async function setCoverQueuePaused(paused: boolean): Promise<void> {
  assert(typeof paused === 'boolean', 'Invalid cover queue setting.');
  await db.transaction('rw', db.table('coverJobs'), db.meta, async () => {
    const current = await control();
    if (current.paused === paused) return;
    await controls().put({ ...current, paused, generation: current.generation + 1 });
    if (paused) for (const job of await jobs().where('status').equals('running').toArray()) {
      await jobs().put({ ...job, status: 'cancelled', failureCode: 'cancelled', completedAt: new Date().toISOString() });
    }
  });
}
async function cancelJob(workId: ID): Promise<void> {
  const job = await jobs().get(workId);
  if (job?.status === 'running') await jobs().put({ ...job, status: 'cancelled', failureCode: 'cancelled', completedAt: new Date().toISOString() });
}
async function putPortableCover(state: CoverState): Promise<void> {
  const entities = await readEntities();
  entities.coverStates = [...entities.coverStates.filter((row) => row.workId !== state.workId), state];
  serializePortableBackup((await getMeta()).libraryId, entities, 'The cover change');
  await db.entity('coverStates').put(state);
}
export async function saveUploadedCover(workId: ID, input: { jpeg: Blob }, options: { expectedCoverRevision: string | null }): Promise<void> {
  assert(input.jpeg instanceof Blob && input.jpeg.type === 'image/jpeg', 'Choose a JPEG, PNG, or WebP photo and let Vaayana prepare it first.');
  assert(input.jpeg.size <= COVER_LIMITS.photoBytes, 'Prepared cover must be at most 64 KiB. Try a smaller photo.');
  const bytes = new Uint8Array(await input.jpeg.arrayBuffer());
  const { width, height } = validateCoverJpeg(bytes);
  const uploaded = { mime: 'image/jpeg' as const, width, height, byteLength: bytes.length, jpegBase64: bytesToBase64(bytes) };
  await mutate(async () => {
    assert(await db.entity('works').get(workId), 'This book no longer exists.');
    const previous = await db.entity('coverStates').where('workId').equals(workId).first();
    assert(options.expectedCoverRevision === coverRevision(previous), 'The cover changed while preparing the photo. Review it and try again.');
    await putPortableCover(stamp({ workId, ...(previous?.provider ? { provider: previous.provider } : {}), uploaded }, previous));
    await cancelJob(workId);
  });
}
export async function revertUploadedCover(workId: ID, options: { expectedCoverRevision?: string | null } = {}): Promise<void> {
  await mutate(async () => {
    assert(await db.entity('works').get(workId), 'This book no longer exists.');
    const previous = await db.entity('coverStates').where('workId').equals(workId).first();
    if (options.expectedCoverRevision !== undefined) assert(options.expectedCoverRevision === coverRevision(previous), 'The cover changed. Review it before removing the photo.');
    if (!previous?.uploaded) return;
    // Preserve the record/revision after removal so older backups cannot reinstate bytes.
    await putPortableCover(stamp({ workId, ...(previous.provider ? { provider: previous.provider } : {}) }, previous));
    await cancelJob(workId);
  });
}
export async function getUploadedCoverBlob(workId: ID, expectedCoverRevision?: string): Promise<Blob | undefined> {
  const state = await db.entity('coverStates').where('workId').equals(workId).first();
  if (!state?.uploaded || (expectedCoverRevision !== undefined && expectedCoverRevision !== state.revision)) return;
  const bytes = base64ToCoverBytes(state.uploaded.jpegBase64);
  return new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' });
}
export async function beginCoverLookup(workId: ID, options: { queryFingerprint: string; manual?: boolean; retry?: boolean }): Promise<CoverLookupClaim | undefined> {
  return db.transaction('rw', db.tables, async () => {
    const settings = await preferences(), queue = await control(), current = await target(workId);
    if (!current || current.queryFingerprint !== options.queryFingerprint || !settings.onlineAccess || !settings.loadCovers ||
      (!options.manual && (!settings.autoFetchCovers || queue.paused)) || current.cover.kind === 'uploaded') return;
    const previous = await jobs().get(workId);
    if (previous?.status === 'running' && previous.leaseUntil > Date.now()) return;
    // WebLocks are service-side leadership; this atomic fallback also works without them.
    if ((await jobs().where('status').equals('running').toArray()).some((job) => job.leaseUntil > Date.now())) return;
    if (previous && previous.queryFingerprint === current.queryFingerprint && !options.retry) return;
    if (current.cover.kind === 'provider' && !options.manual) return;
    const attemptId = newId();
    await jobs().put({ workId, queryFingerprint: current.queryFingerprint, attemptId, generation: queue.generation,
      expectedCoverRevision: current.coverRevision, manual: Boolean(options.manual), status: 'running',
      startedAt: new Date().toISOString(), leaseUntil: Date.now() + COVER_LIMITS.leaseMs });
    return { attemptId, target: current };
  });
}
async function activeClaim(workId: ID, input: { attemptId: string; queryFingerprint: string }): Promise<CoverJob | undefined> {
  const job = await jobs().get(workId);
  if (!job || job.status !== 'running' || job.attemptId !== input.attemptId || job.queryFingerprint !== input.queryFingerprint) return;
  const settings = await preferences(), queue = await control(), current = await target(workId);
  if (current && current.queryFingerprint === job.queryFingerprint && current.coverRevision === job.expectedCoverRevision &&
    current.cover.kind !== 'uploaded' && settings.onlineAccess && settings.loadCovers && job.leaseUntil > Date.now() &&
    queue.generation === job.generation && (job.manual || (settings.autoFetchCovers && !queue.paused))) return job;
}
export async function isCoverLookupClaimActive(workId: ID, input: { attemptId: string; queryFingerprint: string }): Promise<boolean> {
  return db.transaction('r', db.tables, async () => Boolean(await activeClaim(workId, input)));
}
export async function completeCoverLookup(workId: ID, input: { attemptId: string; queryFingerprint: string; result: CoverLookupResult }): Promise<{ applied: boolean }> {
  return db.transaction('rw', db.tables, async () => {
    const job = await jobs().get(workId);
    if (!job || job.status !== 'running' || job.attemptId !== input.attemptId || job.queryFingerprint !== input.queryFingerprint) return { applied: false };
    if (!(await activeClaim(workId, input))) {
      await jobs().put({ ...job, status: 'cancelled', completedAt: new Date().toISOString(), failureCode: 'cancelled' });
      return { applied: false };
    }
    const { result } = input;
    assert(['found', 'no-match', 'failed', 'cancelled'].includes(result.status), 'Invalid cover result.');
    if (result.status === 'found') {
      assert(Number.isSafeInteger(result.coverId) && result.coverId > 0 && result.coverId <= 1_000_000_000, 'Invalid provider cover ID.');
      const previous = await db.entity('coverStates').where('workId').equals(workId).first();
      await putPortableCover(stamp({ workId, provider: { coverId: result.coverId, source: 'open-library', fetchedAt: new Date().toISOString() } }, previous));
      const meta = await getMeta();
      await db.meta.put({ ...meta, revision: meta.revision + 1 });
    } else if (result.failureCode !== undefined) {
      assert(['network', 'no-match', 'ambiguous', 'cancelled', 'interrupted', 'storage', 'invalid-result'].includes(result.failureCode), 'Invalid cover failure code.');
    }
    await jobs().put({ ...job, status: result.status, completedAt: new Date().toISOString(),
      ...(result.status !== 'found' && result.failureCode ? { failureCode: result.failureCode } : {}) });
    return { applied: true };
  });
}
export async function recoverInterruptedCoverLookups(): Promise<void> {
  await db.transaction('rw', db.table('coverJobs'), async () => {
    for (const job of await jobs().where('status').equals('running').toArray()) if (job.leaseUntil <= Date.now()) {
      await jobs().put({ ...job, status: 'cancelled', failureCode: 'interrupted', completedAt: new Date().toISOString() });
    }
  });
}

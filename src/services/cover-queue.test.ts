import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoverJob, CoverLookupTarget, CoverQueueSnapshot } from '../domain/types';
import { CoverQueueController } from './cover-queue';
import type { resolveCover } from './covers';
import { setNetworkPreferences } from './network';
const enabled = () => setNetworkPreferences({ onlineLookup: true, covers: true, autoFetchCovers: true });
const controllers: (() => void)[] = [];
afterEach(() => { controllers.splice(0).forEach(stop => stop()); setNetworkPreferences({ onlineLookup: false, covers: false }); vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture(count: number, resolver: typeof resolveCover) {
  const targets: CoverLookupTarget[] = Array.from({ length: count }, (_, index) => ({ workId: `work-${index}`, editionId: `edition-${index}`, title: `Invented orchard ${index}`, authors: ['Fictional Author'], queryFingerprint: `query-${index}`, coverRevision: null, cover: { kind: 'none' } }));
  const control: CoverQueueSnapshot = { paused: false, generation: 0, jobs: [] };
  let queue!: CoverQueueController; let sequence = 0;
  const synchronize = () => queue.synchronize(structuredClone(targets), structuredClone(control));
  const data: ConstructorParameters<typeof CoverQueueController>[0] = {
    getCoverTargets: async () => structuredClone(targets),
    getCoverQueueSnapshot: async () => structuredClone(control),
    setCoverQueuePaused: async paused => { if (control.paused !== paused) { control.paused = paused; control.generation++; for (const job of control.jobs) if (paused && job.status === 'running') { job.status = 'cancelled'; job.failureCode = 'cancelled'; } synchronize(); } },
    recoverInterruptedCoverLookups: async () => { let changed = false; for (const job of control.jobs) if (job.status === 'running' && job.leaseUntil <= Date.now()) { job.status = 'cancelled'; job.failureCode = 'interrupted'; changed = true; } if (changed) synchronize(); },
    beginCoverLookup: async (workId, options) => {
      const target = targets.find(value => value.workId === workId)!;
      const previous = control.jobs.find(value => value.workId === workId);
      if (control.paused || target.cover.kind !== 'none' || control.jobs.some(job => job.status === 'running') || previous && previous.queryFingerprint === target.queryFingerprint && !options.retry) return;
      const job: CoverJob = { workId, queryFingerprint: target.queryFingerprint, attemptId: `attempt-${++sequence}`, expectedCoverRevision: target.coverRevision, manual: false, generation: control.generation, status: 'running', startedAt: new Date().toISOString(), leaseUntil: Date.now() + 300000 };
      control.jobs = [...control.jobs.filter(value => value.workId !== workId), job]; synchronize();
      return { attemptId: job.attemptId, target: structuredClone(target) };
    },
    isCoverLookupClaimActive: async (workId, input) => {
      const target = targets.find(value => value.workId === workId);
      return !control.paused && !!target && target.cover.kind === 'none' && control.jobs.some(job => job.workId === workId && job.attemptId === input.attemptId && job.status === 'running' && job.queryFingerprint === target.queryFingerprint && job.expectedCoverRevision === target.coverRevision && job.generation === control.generation);
    },
    completeCoverLookup: async (workId, input) => {
      const active = await data.isCoverLookupClaimActive(workId, input);
      const job = control.jobs.find(value => value.workId === workId && value.attemptId === input.attemptId);
      if (!job || job.status !== 'running') return { applied: false };
      job.status = active ? input.result.status : 'cancelled';
      if (active && input.result.status === 'found') {
        const target = targets.find(value => value.workId === workId)!;
        target.cover = { kind: 'provider', coverId: input.result.coverId, revision: input.attemptId }; target.coverRevision = input.attemptId;
      } else if (input.result.status !== 'found') job.failureCode = input.result.failureCode;
      synchronize(); return { applied: active };
    },
  };
  queue = new CoverQueueController(data, resolver);
  const mount = () => { const stop = queue.mount(); controllers.push(stop); synchronize(); return () => { controllers.splice(controllers.indexOf(stop), 1); stop(); }; };
  return { queue, data, targets, control, synchronize, mount };
}
const found = { status: 'found' as const, coverId: 123, sourceUrl: 'https://openlibrary.org/works/OL123W', fetchedAt: '2026-11-24', matchedBy: 'title-author' as const };
describe('persistent cover queue controller (invented library only)', () => {
  it('processes325 invented targets exactly once with fake1050ms requests, including repeated snapshots and remounts', async () => {
    vi.useFakeTimers(); enabled();
    const starts: number[] = [];
    const resolver = vi.fn<typeof resolveCover>().mockImplementation(async (_target, options) => {
      await options?.beforeRequest?.(); starts.push(Date.now());
      await new Promise(resolve => setTimeout(resolve, 1050)); return found;
    });
    const value = fixture(325, resolver);
    const stop = value.mount();
    await vi.advanceTimersByTimeAsync(0); await vi.runAllTimersAsync();
    expect(resolver).toHaveBeenCalledTimes(325);
    expect(starts.slice(1).every((time, index) => time - starts[index] >= 1050)).toBe(true);
    expect(value.control.jobs.every(job => job.status === 'found')).toBe(true);
    expect(value.queue.getState()).toMatchObject({ total: 325, found: 325, remaining: 0, failed: 0, noMatch: 0 });
    for (let i = 0; i < 20; i++) value.synchronize();
    await vi.runAllTimersAsync(); stop(); value.mount(); await vi.runAllTimersAsync();
    expect(resolver).toHaveBeenCalledTimes(325);
  });
  it('persists cancellation without restarting on snapshots, and resumes cancelled plus unattempted work', async () => {
    enabled();
    const resolver = vi.fn<typeof resolveCover>().mockImplementationOnce((_target, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError'))))).mockResolvedValue(found);
    const value = fixture(3, resolver); value.mount();
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce());
    await value.queue.cancel();
    for (let i = 0; i < 5; i++) value.synchronize();
    await Promise.resolve(); await Promise.resolve();
    expect(resolver).toHaveBeenCalledOnce(); expect(value.control.paused).toBe(true);
    await value.queue.resume();
    await vi.waitFor(() => expect(value.queue.getState()).toMatchObject({ found: 3, remaining: 0 }));
    expect(resolver).toHaveBeenCalledTimes(4);
  });
  it('does not automatically retry no-match/ambiguous outcomes across repeated mounts or snapshots', async () => {
    enabled();
    const resolver = vi.fn<typeof resolveCover>().mockResolvedValue({ status: 'ambiguous', reason: 'More than one record.' });
    const value = fixture(1, resolver); const stop = value.mount();
    await vi.waitFor(() => expect(value.queue.getState().noMatch).toBe(1));
    stop(); value.mount(); value.synchronize();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(resolver).toHaveBeenCalledOnce();
    await value.queue.resume('all');
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(2));
  });
  it('keeps new/imported work automatic, and skips existing provider or local-photo covers', async () => {
    enabled(); const resolver = vi.fn<typeof resolveCover>().mockResolvedValue(found);
    const value = fixture(2, resolver);
    value.targets[0].cover = { kind: 'provider', coverId: 99 };
    value.targets[1].cover = { kind: 'uploaded', revision: 'local', mime: 'image/jpeg', width: 1, height: 1, byteLength: 600 };
    value.mount(); await new Promise(resolve => setTimeout(resolve, 10)); expect(resolver).not.toHaveBeenCalled();
    value.targets.push({ ...value.targets[0], workId: 'new-import', editionId: 'new-edition', queryFingerprint: 'new-query', cover: { kind: 'none' } }); value.synchronize();
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce());
    expect(value.targets[0].cover).toEqual({ kind: 'provider', coverId: 99 });
    expect(value.targets[1].cover.kind).toBe('uploaded');
  });
  it('ignores a late provider result after a local photo or title edit, and honors opt-out', async () => {
    enabled();
    let finish!: (value: typeof found) => void;
    const resolver = vi.fn<typeof resolveCover>().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const value = fixture(1, resolver); value.mount();
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce());
    value.targets[0].cover = { kind: 'uploaded', revision: 'new-photo', mime: 'image/jpeg', width: 1, height: 1, byteLength: 600 }; value.targets[0].coverRevision = 'new-photo';
    value.synchronize(); setNetworkPreferences({ onlineLookup: true, covers: false, autoFetchCovers: false });
    finish(found);
    await vi.waitFor(() => expect(value.control.jobs[0].status).toBe('cancelled'));
    expect(value.targets[0].cover.kind).toBe('uploaded');
    expect(value.queue.getState().mode).toBe('off');
  });
  it('pauses an interrupted offline request without consuming the claim and resumes on reconnect', async () => {
    enabled();
    const events = new EventTarget(); const navigatorState = { onLine: true };
    vi.stubGlobal('window', events); vi.stubGlobal('navigator', navigatorState);
    const resolver = vi.fn<typeof resolveCover>().mockImplementationOnce(async () => {
      navigatorState.onLine = false;
      throw new TypeError('Network disconnected');
    }).mockResolvedValue(found);
    const value = fixture(1, resolver); value.mount();
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce());
    value.queue.preferencesChanged();
    expect(value.control.jobs[0].status).toBe('running');
    expect(value.queue.getState().mode).toBe('offline');
    navigatorState.onLine = true; events.dispatchEvent(new Event('online')); value.queue.preferencesChanged();
    await vi.waitFor(() => expect(value.queue.getState().found).toBe(1));
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(value.control.jobs).toHaveLength(1);
    expect(value.control.jobs[0].attemptId).toBe('attempt-1');
  });
  it('safely reclaims only its own offline attempt after a disconnect longer than the five-minute lease', async () => {
    vi.useFakeTimers(); enabled();
    const events = new EventTarget(); const navigatorState = { onLine: true };
    vi.stubGlobal('window', events); vi.stubGlobal('navigator', navigatorState);
    const resolver = vi.fn<typeof resolveCover>().mockImplementationOnce(async () => { navigatorState.onLine = false; throw new TypeError('Offline'); }).mockResolvedValue(found);
    const value = fixture(1, resolver); value.mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolver).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(value.control.jobs[0]).toMatchObject({ status: 'cancelled', failureCode: 'interrupted' });
    expect(resolver).toHaveBeenCalledOnce();
    navigatorState.onLine = true; events.dispatchEvent(new Event('online')); value.queue.preferencesChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(value.control.jobs[0]).toMatchObject({ status: 'found', attemptId: 'attempt-2' });
    expect(value.queue.getState()).toMatchObject({ found: 1, remaining: 0, cancelled: 0 });
  });
  it.each(['cancel', 'opt-out'] as const)('promptly stops an offline wait on %s and never resumes a request on reconnect', async action => {
    vi.useFakeTimers(); enabled();
    const events = new EventTarget(); const navigatorState = { onLine: true };
    vi.stubGlobal('window', events); vi.stubGlobal('navigator', navigatorState);
    const resolver = vi.fn<typeof resolveCover>().mockImplementation(async () => { navigatorState.onLine = false; throw new TypeError('Offline'); });
    const value = fixture(1, resolver); value.mount(); await vi.advanceTimersByTimeAsync(0);
    if (action === 'cancel') await value.queue.cancel(); else setNetworkPreferences({ onlineLookup: true, covers: false, autoFetchCovers: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(value.control.jobs[0].status).toBe('cancelled');
    navigatorState.onLine = true; events.dispatchEvent(new Event('online')); value.queue.preferencesChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolver).toHaveBeenCalledOnce();
  });
  it.each(['getCoverTargets', 'beginCoverLookup'] as const)('halts persistent %s storage failures until explicit retry, even across snapshots and remounts', async method => {
    vi.useFakeTimers(); enabled();
    const resolver = vi.fn<typeof resolveCover>().mockResolvedValue(found);
    const value = fixture(1, resolver);
    const failure = vi.spyOn(value.data, method).mockRejectedValue(new DOMException('Private storage detail', 'QuotaExceededError'));
    const stop = value.mount(); await vi.advanceTimersByTimeAsync(0);
    expect(failure).toHaveBeenCalledOnce();
    expect(value.queue.getState()).toMatchObject({ mode: 'error', failed: 0, remaining: 1 });
    expect(value.queue.getState().error).not.toContain('Private storage detail');
    for (let i = 0; i < 5; i++) { value.synchronize(); value.queue.preferencesChanged(); }
    stop(); value.mount(); await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(failure).toHaveBeenCalledOnce();
    expect(resolver).not.toHaveBeenCalled();
    await value.queue.resume('all').catch(() => undefined); await vi.advanceTimersByTimeAsync(0);
    expect(failure).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 5; i++) value.synchronize();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(failure).toHaveBeenCalledTimes(2);
    failure.mockRestore();
    await value.queue.resume('all'); await vi.advanceTimersByTimeAsync(0);
    expect(resolver).toHaveBeenCalledOnce();
    expect(value.queue.getState()).toMatchObject({ found: 1, remaining: 0, mode: 'idle', error: undefined });
  });
});

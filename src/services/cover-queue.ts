import type { CoverFailureCode, CoverJob, CoverLookupClaim, CoverLookupTarget, CoverQueueSnapshot } from '../domain/types';
import type * as repository from '../data/repository';
import { canFetchCovers, hasCoverConsent, resolveCover } from './covers';
import { abortError, subscribeNetworkPreferences } from './network';
import { DEPLOYMENT_CACHE_PREFIX } from './cache-scope';

type CoverRepository = Pick<typeof repository, 'getCoverTargets' | 'getCoverQueueSnapshot' | 'setCoverQueuePaused' | 'beginCoverLookup' | 'completeCoverLookup' | 'recoverInterruptedCoverLookups' | 'isCoverLookupClaimActive'>;
export interface CoverQueueState {
  mode: 'off' | 'offline' | 'paused' | 'working' | 'idle' | 'error';
  total: number; found: number; alreadyCovered: number; noMatch: number; failed: number; cancelled: number; remaining: number;
  activeTitle?: string; error?: string;
  issues: { workId: string; title: string; status: CoverJob['status']; failureCode?: CoverFailureCode }[];
}
const emptyState: CoverQueueState = { mode: 'off', total: 0, found: 0, alreadyCovered: 0, noMatch: 0, failed: 0, cancelled: 0, remaining: 0, issues: [] };
function waitForConnection(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => { window.removeEventListener('online', online); signal.removeEventListener('abort', cancel); error ? reject(error) : resolve(); };
    const online = () => { if (navigator.onLine !== false) finish(); };
    const cancel = () => finish(abortError());
    window.addEventListener('online', online); signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel(); else online();
  });
}
/** One app-mounted controller. Durable data claims, not React renders, decide who may do work. */
export class CoverQueueController {
  private listeners = new Set<() => void>();
  private state: CoverQueueState = emptyState;
  private targets: CoverLookupTarget[] = [];
  private queue: CoverQueueSnapshot = { paused: false, generation: 0, jobs: [] };
  private retries = new Set<string>();
  private refs = 0;
  private work?: Promise<void>;
  private abort?: AbortController;
  private dirty = false;
  private halted = false;
  private unsubscribe?: () => void;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  constructor(private data: CoverRepository, private resolve = resolveCover) {}
  getState = (): CoverQueueState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<CoverQueueState> = {}): void {
    const jobs = new Map(this.queue.jobs.map(job => [job.workId, job]));
    const next = { ...emptyState, total: this.targets.length, mode: this.state.mode, activeTitle: this.state.activeTitle, error: this.state.error, issues: [] } as CoverQueueState;
    for (const target of this.targets) {
      const job = jobs.get(target.workId);
      const current = job?.queryFingerprint === target.queryFingerprint ? job : undefined;
      if (current?.status === 'found' && target.cover.kind !== 'none') next.found++;
      else if (target.cover.kind !== 'none') next.alreadyCovered++;
      else if (current?.status === 'no-match') next.noMatch++;
      else if (current?.status === 'failed') next.failed++;
      else if (current?.status === 'cancelled') next.cancelled++;
      else next.remaining++;
      if (target.cover.kind === 'none' && current && ['no-match', 'failed', 'cancelled'].includes(current.status)) next.issues.push({ workId: target.workId, title: target.title, status: current.status, failureCode: current.failureCode });
    }
    if (!canFetchCovers()) {
      next.mode = typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'off'; next.activeTitle = undefined;
    } else if (this.halted) { next.mode = 'error'; next.activeTitle = undefined; }
    else if (this.queue.paused) { next.mode = 'paused'; next.activeTitle = undefined; }
    else next.mode = this.work ? 'working' : 'idle';
    this.state = { ...next, ...patch };
    for (const listener of this.listeners) listener();
  }
  mount(): () => void {
    if (++this.refs === 1) {
      this.unsubscribe = subscribeNetworkPreferences(() => this.preferencesChanged());
      if (!this.halted) void this.data.recoverInterruptedCoverLookups().catch(() => this.fail());
      this.preferencesChanged();
    }
    return () => {
      if (--this.refs === 0) {
        this.abort?.abort(); this.unsubscribe?.(); clearTimeout(this.expiryTimer);
      }
    };
  }
  preferencesChanged(): void {
    if (!hasCoverConsent()) this.abort?.abort();
    this.publish(); this.wake();
  }
  synchronize(targets: CoverLookupTarget[], queue: CoverQueueSnapshot): void {
    if (queue.generation !== this.queue.generation || queue.paused) this.abort?.abort();
    this.targets = targets; this.queue = queue;
    this.publish();
    clearTimeout(this.expiryTimer);
    const nextLease = queue.jobs.filter(job => job.status === 'running').reduce((time, job) => Math.min(time, job.leaseUntil), Infinity);
    if (this.refs && !this.halted && Number.isFinite(nextLease)) this.expiryTimer = setTimeout(() => { void this.data.recoverInterruptedCoverLookups().catch(() => this.fail()); }, Math.max(10, nextLease - Date.now() + 10));
    this.wake();
  }
  fail(): void {
    this.halted = true; clearTimeout(this.expiryTimer);
    this.abort?.abort();
    this.publish({ error: 'Cover processing could not access local storage. Your existing covers are unchanged. Retry when storage is available.' });
  }
  async cancel(): Promise<void> {
    this.abort?.abort(); this.retries.clear();
    await this.data.setCoverQueuePaused(true);
    const queue = await this.data.getCoverQueueSnapshot();
    this.synchronize(this.targets, queue);
  }
  async resume(retry: 'cancelled' | 'all' = 'cancelled'): Promise<void> {
    try {
      const targets = await this.data.getCoverTargets();
      const queue = await this.data.getCoverQueueSnapshot();
      for (const target of targets) {
        const job = queue.jobs.find(value => value.workId === target.workId && value.queryFingerprint === target.queryFingerprint);
        if (target.cover.kind === 'none' && (retry === 'all' || job?.status === 'cancelled')) this.retries.add(target.workId);
      }
      await this.data.setCoverQueuePaused(false);
      const latest = await this.data.getCoverQueueSnapshot();
      this.halted = false;
      this.publish({ error: undefined });
      this.synchronize(targets, latest);
    } catch {
      this.fail();
      throw new Error('Cover fetching could not restart. Check local storage, then try again. Your saved covers are unchanged.');
    }
  }
  private wake(): void {
    if (this.halted || !this.refs || !canFetchCovers() || this.queue.paused) return;
    this.dirty = true;
    if (this.work) return;
    const controller = new AbortController(); this.abort = controller;
    const run = async () => {
      this.dirty = false;
      await this.drain(controller.signal);
    };
    const operation = typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request(`${DEPLOYMENT_CACHE_PREFIX}cover-queue`, { signal: controller.signal }, run).then(() => undefined)
      : run();
    this.work = operation;
    this.publish();
    void operation.catch(error => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) this.fail();
    }).finally(() => {
      if (this.work !== operation) return;
      this.work = undefined;
      this.publish({ activeTitle: undefined });
      if (this.halted) return;
      if (this.dirty && !controller.signal.aborted) this.wake();
      else if (controller.signal.aborted && this.refs && canFetchCovers() && !this.queue.paused) this.wake();
    });
  }
  private async drain(signal: AbortSignal): Promise<void> {
    const targets = await this.data.getCoverTargets();
    for (const target of targets) {
      if (signal.aborted || !canFetchCovers() || !this.refs) return;
      const queue = await this.data.getCoverQueueSnapshot();
      this.queue = queue;
      if (queue.paused) return;
      if (target.cover.kind !== 'none') continue;
      const retry = this.retries.delete(target.workId);
      const claim = await this.data.beginCoverLookup(target.workId, { queryFingerprint: target.queryFingerprint, retry });
      if (!claim) continue;
      this.publish({ activeTitle: target.title, error: undefined });
      await this.lookup(claim, signal);
    }
  }
  private async lookup(claim: CoverLookupClaim, signal: AbortSignal): Promise<void> {
    for (;;) {
      const { target, attemptId } = claim;
      const identity = { attemptId, queryFingerprint: target.queryFingerprint };
      let storageFailure = false;
      const stored = async <T,>(operation: () => Promise<T>): Promise<T> => {
        try { return await operation(); } catch (error) { storageFailure = true; throw error; }
      };
      const guard = async () => {
        if (signal.aborted || !canFetchCovers() || !(await stored(() => this.data.isCoverLookupClaimActive(target.workId, identity)))) throw abortError();
      };
      let saving = false;
      try {
        await guard();
        const result = await this.resolve(target, { signal, beforeRequest: guard });
        await guard();
        saving = true;
        await stored(() => this.data.completeCoverLookup(target.workId, { ...identity, result: result.status === 'found' ? { status: 'found', coverId: result.coverId } : { status: 'no-match', failureCode: result.status === 'ambiguous' ? 'ambiguous' : 'no-match' } }));
      } catch (error) {
        if (!saving && !storageFailure && !signal.aborted && hasCoverConsent() && typeof window !== 'undefined' && navigator.onLine === false) {
          try {
            await waitForConnection(signal);
            if (signal.aborted || !hasCoverConsent()) throw abortError();
            await stored(() => this.data.recoverInterruptedCoverLookups());
            if (!(await stored(() => this.data.isCoverLookupClaimActive(target.workId, identity)))) {
              const [targets, queue] = await stored(() => Promise.all([this.data.getCoverTargets(), this.data.getCoverQueueSnapshot()]));
              const current = targets.find(value => value.workId === target.workId);
              const job = queue.jobs.find(value => value.workId === target.workId);
              // Only our own offline-interrupted attempt may be reclaimed. Never a user cancellation,
              // another tab's attempt, changed bibliography, new cover, or changed queue generation.
              if (!current || current.cover.kind !== 'none' || current.queryFingerprint !== target.queryFingerprint || current.coverRevision !== target.coverRevision ||
                !job || job.attemptId !== attemptId || job.status !== 'cancelled' || job.failureCode !== 'interrupted' || job.leaseUntil > Date.now() || queue.paused || queue.generation !== job.generation) return;
              const replacement = await stored(() => this.data.beginCoverLookup(target.workId, { queryFingerprint: target.queryFingerprint, retry: true }));
              if (!replacement) return;
              claim = replacement;
            }
            continue;
          } catch (interruption) { error = interruption; }
        }
        const cancelled = signal.aborted || !canFetchCovers() || error instanceof DOMException && error.name === 'AbortError';
        try {
          await this.data.completeCoverLookup(target.workId, { ...identity, result: { status: cancelled ? 'cancelled' : 'failed', failureCode: cancelled ? 'cancelled' : storageFailure ? 'storage' : 'network' } });
        } catch { this.fail(); }
        if (storageFailure) this.fail();
      }
      return;
    }
  }
}

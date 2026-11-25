import { useState } from 'react';
import type { Settings } from '../domain/types';
import { saveSettings } from '../data/repository';
import { coverQueue, useCoverQueue } from '../hooks/useCoverQueue';
import { setNetworkPreferences } from '../services/network';
import { ErrorMessage } from './ui';

export function BookCoverSettings({ settings, notify, onSelectBook }: {
  settings: Settings; notify: (message: string) => void; onSelectBook?: (id: string) => void;
}) {
  const state = useCoverQueue();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shown, setShown] = useState(20);
  const permitted = settings.autoFetchCovers === true && settings.onlineAccess && settings.loadCovers;
  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch { setError('Cover fetching could not start. Check local storage and try again. Your saved covers are unchanged.'); }
    finally { setBusy(false); }
  }
  async function consent(enabled: boolean) {
    if (!enabled) setNetworkPreferences({ onlineLookup: settings.onlineAccess, covers: false, autoFetchCovers: false });
    await saveSettings(enabled ? { autoFetchCovers: true, onlineAccess: true, loadCovers: true } : { autoFetchCovers: false, loadCovers: false });
    setNetworkPreferences({ onlineLookup: enabled || settings.onlineAccess, covers: enabled, autoFetchCovers: enabled });
    if (enabled) await coverQueue.resume();
    notify(enabled ? 'Automatic cover fetching is on. Matching runs gradually while Vaayana is open; your diary and photos stay private.' : 'Automatic cover fetching and online cover images are off. Local photos remain available.');
  }
  return <section className="settings-card" id="book-covers">
    <div className="settings-title"><div><h2>Book covers</h2><p>Find missing covers together. Keep your own photos, too.</p></div></div>
    <label className="setting-toggle"><span><strong>Automatically fetch book covers</strong><small>One opt-in enables Online lookup and Load book covers. Sends titles/authors or ISBNs to Open Library for existing and newly added/imported books. Cover requests reveal your IP address. Never sends notes, history, or your photos. No AI download.</small></span><span className="toggle-control"><input aria-label="Automatically fetch book covers" type="checkbox" disabled={busy} checked={settings.autoFetchCovers === true} onChange={event => void run(() => consent(event.target.checked))} /><span aria-hidden="true" /></span></label>
    <ErrorMessage message={error || state.error} />
    <p className="small-print">Only unambiguous title-and-author or identifier matches are saved, and only the cover changes. Existing covers and your uploaded photos are never replaced automatically. At most one provider request per second; a large shelf can take several minutes. Keep Vaayana open.</p>
    <div className="cover-fetch-status" role="status" aria-live="polite" aria-label="Cover fetching status">
      <strong>{!permitted ? 'Automatic lookup is off or paused by your online settings.' : state.error ? 'Cover fetching stopped. Check available storage, then choose Fetch missing covers to retry.' : !online ? 'Offline. Cover fetching will continue when you reconnect.' : state.mode === 'paused' ? 'Cover fetching is cancelled. Resume when you are ready.' : state.mode === 'working' ? state.activeTitle ? `Finding a cover for ${state.activeTitle}…` : 'Checking missing covers…' : 'Cover checks are up to date.'}</strong>
      <p>{state.found} found · {state.alreadyCovered} already covered · {state.noMatch} unmatched · {state.failed} failed · {state.cancelled} cancelled · {state.remaining} remaining</p>
      {state.total > 0 && <progress aria-label="Cover lookup progress" max={state.total} value={state.total - state.remaining} />}
    </div>
    <div className="inline-actions cover-actions">
      <button className="secondary-button" disabled={busy || !permitted || !online} onClick={() => void run(() => coverQueue.resume('all'))}>Fetch missing covers</button>
      {state.mode === 'paused' ? <button className="secondary-button" disabled={busy || !permitted || !online} onClick={() => void run(() => coverQueue.resume())}>Resume cover fetching</button> : <button className="text-button" disabled={busy || !permitted} onClick={() => void run(() => coverQueue.cancel())}>Cancel cover fetching</button>}
      {(state.issues.length > 0 || state.error) && <button className="text-button" disabled={busy || !permitted || !online} onClick={() => void run(() => coverQueue.resume('all'))}>Retry unmatched and failed</button>}
    </div>
    <p className="small-print">“Found” counts saved cover references, not downloaded images. Images load near the screen; not every cover is available offline. No-match/ambiguous/failed entries are not retried automatically. Fetch missing covers explicitly checks them again. Cancelling stays paused across reloads.</p>
    {state.issues.length > 0 && <details className="cover-issues"><summary>Covers needing attention ({state.issues.length})</summary><p className="small-print">No confident match? Open the book and choose Details → Upload photo. Your local photo takes priority.</p><ul>{state.issues.slice(0, shown).map(issue => <li key={issue.workId}>{onSelectBook ? <button className="text-button" onClick={() => onSelectBook(issue.workId)}>{issue.title}</button> : <strong>{issue.title}</strong>}<span>{issue.failureCode === 'ambiguous' ? 'Ambiguous match, skipped' : issue.failureCode === 'interrupted' ? 'Interrupted; retry when ready' : issue.status === 'no-match' ? 'No available confident match' : issue.status === 'cancelled' ? 'Cancelled' : 'Could not fetch or save'}</span></li>)}</ul>{shown < state.issues.length && <button className="text-button" onClick={() => setShown(value => value + 20)}>Show more unmatched books</button>}</details>}
  </section>;
}

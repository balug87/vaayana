import { useEffect, useState } from 'react';
import { Download, Upload, ShieldCheck, Globe, HardDrive, Sparkles, Check, Trash2, Plus, LoaderCircle } from 'lucide-react';
import type { CatalogImportOptions, ImportDecisions, ImportPreview, LibrarySnapshot, Settings as Preferences, TagKind } from '../domain/types';
import * as repository from '../data/repository';
import { enableSemantic, cancelSemantic, removeSemanticModel, clearMetadataCache, SEMANTIC_MODEL } from '../services';
import { useSemantic } from '../hooks/useSemantic';
import { ErrorMessage } from './ui';
import { ImportFormats } from './ImportFormats';
import { ImportReview } from './ImportReview';
import type { useOffline } from '../hooks/useOffline';

type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
export default function Settings({ snapshot, offline, notify }: { snapshot: LibrarySnapshot; offline: ReturnType<typeof useOffline>; notify: (text: string) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ImportPreview>();
  const [importText, setImportText] = useState('');
  const [decisions, setDecisions] = useState<ImportDecisions>({});
  const [reviewed, setReviewed] = useState(false);
  const [modelConsent, setModelConsent] = useState(false);
  const [persisted, setPersisted] = useState<boolean>();
  const [storage, setStorage] = useState<{ usage?: number; quota?: number }>({});
  const [tagName, setTagName] = useState('');
  const [tagKind, setTagKind] = useState<TagKind>('topic');
  const [renameId, setRenameId] = useState('');
  const [renameText, setRenameText] = useState('');
  const [mergeFrom, setMergeFrom] = useState('');
  const [mergeTo, setMergeTo] = useState('');
  const [install, setInstall] = useState<InstallPrompt>();
  const semantic = useSemantic();
  const settings = snapshot.settings;
  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted).catch(() => {});
    void navigator.storage?.estimate?.().then(setStorage).catch(() => {});
    const prompt = (event: Event) => { event.preventDefault(); setInstall(event as InstallPrompt); };
    window.addEventListener('beforeinstallprompt', prompt);
    return () => window.removeEventListener('beforeinstallprompt', prompt);
  }, []);
  async function run(action: () => Promise<unknown>, message?: string) {
    setBusy(true); setError('');
    try { await action(); if (message) notify(message); } catch (e) { setError(e instanceof Error ? e.message : 'That action could not finish. Your library has not been replaced.'); }
    finally { setBusy(false); }
  }
  async function save(patch: Partial<Preferences>) { await run(() => repository.saveSettings(patch)); }
  async function downloadModel() {
    await repository.saveSettings({ modelConsent: true, modelVersion: SEMANTIC_MODEL.revision });
    try {
      const result = await enableSemantic({ consent: true });
      notify(result.mode === 'semantic-ready' ? 'The local semantic model is ready. Use semantic matching in Discover.' : result.message);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        notify('Optional model download cancelled. Basic matching remains available.');
        return;
      }
      throw error;
    }
  }
  function clearImport() {
    if (preview) repository.cancelImport(preview.token);
    setPreview(undefined); setImportText(''); setDecisions({}); setReviewed(false);
  }
  async function stageImport(text: string, options?: CatalogImportOptions) {
    clearImport();
    const next = await repository.previewImport(text, options);
    setImportText(text); setPreview(next);
  }
  async function exportFile() {
    const text = await repository.exportBackup();
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `vaayana-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (preview && importText) await stageImport(importText, preview.format === 'book-catalog' ? preview.defaults : undefined);
    notify('Backup download prepared. Check that the file was saved.');
  }
  async function readImport(file?: File) {
    if (!file) return;
    await run(async () => {
      clearImport();
      if (file.size > repository.BACKUP_LIMITS.bytes) throw new Error('This file exceeds the supported 20 MiB import limit.');
      await stageImport(await file.text());
    });
  }
  const activeTags = snapshot.tags.filter(t => !t.archived);
  return <>
    <div className="page-heading"><div><div className="eyebrow"><span /> A FEW THINGS, JUST SO</div><h1>Make it yours<span className="heading-dot">.</span></h1><p>A private library. Thoughtful choices. Nothing hidden.</p></div></div>
    <ErrorMessage message={error} />
    <div className="settings-layout"><div className="settings-main">
      <section className="settings-card" id="backup"><div className="settings-title"><Download size={22} /><div><h2>Keep a little copy</h2><p>Back up your library, or bring it to another device.</p></div></div><div className="notice subtle"><ShieldCheck size={20} /><p>Your library lives in this browser. Storage clearing, eviction, private browsing, or device loss can remove it. Installation isn't a backup. Export a copy you can keep.</p></div><p className="small-print">Last prepared export: {settings.lastExportAt ? new Date(settings.lastExportAt).toLocaleString() : 'Not yet'}. Your downloaded file includes private notes and is not encrypted. Verify that it saved successfully.</p><div className="inline-actions"><button className="primary-button" disabled={busy} onClick={() => void run(exportFile)}><Download size={17} /> Export backup</button><label className="secondary-button file-button"><Upload size={17} /> Import backup or catalog<input aria-label="Import backup or catalog" disabled={busy} type="file" accept=".json,application/json" onChange={e => { void readImport(e.target.files?.[0]); e.target.value = ''; }} /></label></div><p className="small-print">JSON imports · backups use format version 1 · {repository.BACKUP_LIMITS.bytes / 1024 / 1024} MiB total · {repository.BACKUP_LIMITS.records.toLocaleString()} user records plus {repository.BACKUP_LIMITS.provenanceRecords.toLocaleString()} deletion/import records maximum. Backups merge; catalogs add books. Both validate before writing and never replace your library blindly.</p>
        <ImportFormats />
        {preview && <ImportReview preview={preview} decisions={decisions} reviewed={reviewed} busy={busy}
          onDefaultsChange={options => void run(() => stageImport(importText, options))}
          onDecision={(id, decision) => { setDecisions({ ...decisions, [id]: decision }); setReviewed(false); }}
          onReviewed={setReviewed}
          onBackup={() => void run(exportFile)}
          onCancel={clearImport}
          onCommit={() => void run(async () => {
            const result = await repository.commitImport(preview.token, decisions);
            clearImport();
            notify(`Import complete: ${result.added} added, ${result.updated} updated, ${result.deleted} deleted.`);
          })}
        />}

      </section>
      <section className="settings-card"><div className="settings-title"><Globe size={22} /><div><h2>Online, on your terms</h2><p>Your diary stays local. Some book information comes from outside.</p></div></div><Toggle label="Online lookup" description="Sends a book title, author, ISBN, or selected discovery topic and network information to Open Library. No private notes or reading history are sent." checked={settings.onlineAccess} onChange={v => void save({ onlineAccess: v })} /><Toggle label="Load book covers" description="Requests images from the Open Library cover host, which can see the requested image and your IP address. Cover rights are not guaranteed." checked={settings.loadCovers} onChange={v => void save({ loadCovers: v })} /><Toggle label="Use my accepted library topics for recommendations" description="Your chosen tags may influence broad discovery searches. Private notes are never used or sent." checked={settings.useLibraryInterests} onChange={v => void save({ useLibraryInterests: v })} /><p className="small-print">External review links open at their own sites. Model downloads contact Hugging Face and its asset hosts. No telemetry, accounts, remote diary database, or silent cloud-AI fallback.</p><button className="text-button" onClick={() => void run(clearMetadataCache, 'Replaceable metadata cache cleared. Your library is untouched.')}>Clear metadata cache only</button></section>
      <section className="settings-card" id="semantic"><div className="settings-title"><Sparkles size={22} /><div><h2>A little more meaning</h2><p>Optional semantic matching, entirely on your device after download.</p></div></div><span className="mode-badge">{semantic.mode === 'semantic-ready' ? 'Semantic ready' : semantic.mode === 'downloading' ? 'Downloading' : semantic.mode === 'basic-fallback' ? 'Basic fallback' : 'Rule-based'}</span><p className="model-description">The small MiniLM model helps match related ideas. It isn't a chatbot, review writer, or a source of new books. Basic recommendations always work without it.</p><div className="model-spec"><span><strong>~46 MB</strong> estimated initial assets</span><span><strong>23 MB</strong> weights only</span><span><strong>384</strong> dimensions</span></div><p className="small-print">{SEMANTIC_MODEL.downloadNotice} Additional worker code, caching, and browser behavior affect actual transfer. First use can take time. Mobile support and multilingual quality are not guaranteed. The model reads short book metadata, not your notes.</p><p role="status" className="semantic-message">{semantic.message}</p>{semantic.mode === 'downloading' && <><progress aria-label="Model download progress" max={1} value={semantic.progress} /><p className="small-print">{(semantic.loadedBytes / 1_000_000).toFixed(1)} MB received{semantic.totalBytes ? ` / ${(semantic.totalBytes / 1_000_000).toFixed(1)} MB reported` : ''}. Reported totals can grow as more assets are discovered.</p></>}
        {semantic.mode !== 'semantic-ready' && semantic.mode !== 'downloading' && <label className="inline-check model-consent"><input type="checkbox" checked={modelConsent} onChange={e => setModelConsent(e.target.checked)} />I agree to download the optional model and runtime (about 46 MB plus worker assets).</label>}
        <div className="inline-actions">{semantic.mode === 'downloading' ? <button className="secondary-button" onClick={() => { cancelSemantic(); void repository.saveSettings({ modelConsent: false }); }}>Cancel model download</button> : semantic.mode !== 'semantic-ready' ? <button className="primary-button" disabled={!modelConsent || !settings.onlineAccess || busy} onClick={() => void run(downloadModel)}><Download size={17} /> Download optional model</button> : <p className="text-link"><Check size={16} /> Real local inference is available in Discover</p>}<button className="text-button danger-text" onClick={() => { if (confirm('Remove optional model assets? Your library and basic recommendations will stay.')) void run(async () => { await removeSemanticModel(); await repository.saveSettings({ modelConsent: false, modelVersion: undefined }); }, 'Optional model removed. Your library is untouched.'); }}><Trash2 size={14} /> Remove model</button></div>{!settings.onlineAccess && <p className="small-print">Enable online lookup above before downloading. We never start this download automatically.</p>}<p className="small-print">Removal clears this app's model cache and in-memory vectors, not browser-wide HTTP caches or provider logs. <a href={`${import.meta.env.BASE_URL}notices/`} target="_blank" rel="noopener noreferrer">Read bundled third-party notices and licenses</a>.</p>
      </section>
      <section className="settings-card"><div className="settings-title"><Plus size={22} /><div><h2>A vocabulary of your own</h2><p>Stable tags. Editable names. Your decisions, kept.</p></div></div><form className="inline-form" onSubmit={e => { e.preventDefault(); void run(async () => { await repository.createTag(tagName, tagKind); setTagName(''); }, 'Tag created. Attach it in a book journal.'); }}><input aria-label="Tag name" placeholder="A new tag…" required value={tagName} onChange={e => setTagName(e.target.value)} /><select aria-label="Tag kind" value={tagKind} onChange={e => setTagKind(e.target.value as TagKind)}>{['topic', 'purpose', 'mood', 'context'].map(kind => <option key={kind}>{kind}</option>)}</select><button className="secondary-button"><Plus size={16} /> Create tag</button></form><div className="tag-manager">{snapshot.tags.map(tag => <div className="suggestion-row" key={tag.id}>{renameId === tag.id ? <form className="inline-form" onSubmit={e => { e.preventDefault(); void run(async () => { await repository.renameTag(tag.id, renameText); setRenameId(''); }); }}><input aria-label="Rename tag" value={renameText} onChange={e => setRenameText(e.target.value)} /><button className="text-button">Save</button><button type="button" className="text-button" onClick={() => setRenameId('')}>Cancel</button></form> : <><span><strong>{tag.name}{tag.archived ? ' (archived)' : ''}</strong><small>{tag.kind} · {tag.aliases.length ? `Aliases: ${tag.aliases.join(', ')}` : 'Stable identity across edits'}</small></span><button className="text-button" onClick={() => { setRenameId(tag.id); setRenameText(tag.name); }}>Rename</button><button className="text-button muted" onClick={() => void run(() => repository.archiveTag(tag.id, !tag.archived), tag.archived ? 'Tag restored.' : 'Tag archived. Books and history preserved.')}>{tag.archived ? 'Restore' : 'Archive'}</button></>}</div>)}</div>{activeTags.length > 1 && <form className="merge-tags" onSubmit={e => { e.preventDefault(); if (confirm('Merge these tags? Associations and aliases are retained, but the source tag will redirect to the destination.')) void run(async () => { await repository.mergeTags(mergeFrom, mergeTo); setMergeFrom(''); setMergeTo(''); }, 'Tags merged with provenance preserved.'); }}><h4>Merge tags</h4><div className="form-grid"><label>Merge from<select required value={mergeFrom} onChange={e => setMergeFrom(e.target.value)}><option value="">Choose source</option>{activeTags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label>Keep name<select required value={mergeTo} onChange={e => setMergeTo(e.target.value)}><option value="">Choose destination</option>{activeTags.filter(t => t.id !== mergeFrom).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label></div><button className="secondary-button" disabled={!mergeFrom || !mergeTo || mergeFrom === mergeTo}>Merge with review</button></form>}</section>
    </div><aside className="settings-aside"><section className="settings-card"><HardDrive size={23} /><h3>A home on this device</h3><p className={`offline-status ${offline.state}`}><span className="status-dot" />{offline.state === 'ready' ? 'Offline ready' : offline.state === 'checking' ? 'Checking offline readiness' : offline.state === 'error' ? 'Offline setup error' : 'Offline not ready'}</p><p className="small-print">Ready means every required app-shell asset is cached and the service worker controls this page. It doesn't include fresh searches, external reviews, uncached covers, or a missing model.{import.meta.env.DEV && ' Development mode: use a production build to test offline installation.'}</p><button className="text-button" onClick={() => void run(offline.retry)}>Recheck offline setup</button><hr /><p className="small-print">Storage: {storage.usage !== undefined ? `${(storage.usage / 1_000_000).toFixed(1)} MB used` : 'Estimate unavailable'}<br />Persistence: {persisted === undefined ? 'Unknown/unsupported' : persisted ? 'Granted (still not a backup)' : 'Best-effort storage'}</p><button className="secondary-button compact" onClick={() => void run(async () => { if (!navigator.storage?.persist) throw new Error('Persistent storage is not supported here. Export backups instead.'); const granted = await navigator.storage.persist(); setPersisted(granted); notify(granted ? 'Persistence granted. Still keep backups.' : 'Persistence was not granted. Your library is still usable; keep backups.'); })}>Request persistent storage</button></section><section className="settings-card"><h3>Make room on your home screen</h3>{install && <button className="primary-button" onClick={() => void run(async () => { await install.prompt(); await install.userChoice; setInstall(undefined); })}>Install Vaayana</button>}<p className="small-print">Chrome/Edge may offer Install. On iPhone or iPad, use Safari's Share → Add to Home Screen. On Mac, Safari may offer Add to Dock. Availability varies; browser use is fully supported.</p></section><section className="settings-card"><h3>A quieter experience</h3><Toggle label="Reduce motion" description="Remove nonessential movement. Your system's reduced-motion preference is always respected." checked={settings.reducedMotion} onChange={v => void save({ reducedMotion: v })} /></section><section className="settings-card about-card"><span className="brand-word">vaayana<span>·</span></span><p className="small-print">A life in books.<br />Free, local-first, no account.</p><p className="small-print">Metadata: Open Library<br />No Goodreads API or scraped reviews.<br />Full-text reviews require permission.<br />No automatic cross-device sync.</p><p className="small-print">Tested browser details and model/license notices are in the project README. Real-device support is not universal.</p></section></aside></div>
  </>;
}
function Toggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="setting-toggle"><span><strong>{label}</strong><small>{description}</small></span><span className="toggle-control"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /><span aria-hidden="true" /></span></label>;
}

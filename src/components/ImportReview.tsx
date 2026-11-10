import type { CatalogImportOptions, ImportDecisions, ImportPreview } from '../domain/types';

export function ImportReview({ preview, decisions, reviewed, busy, onDefaultsChange, onDecision, onReviewed, onBackup, onCancel, onCommit }: {
  preview: ImportPreview;
  decisions: ImportDecisions;
  reviewed: boolean;
  busy: boolean;
  onDefaultsChange: (options: CatalogImportOptions) => void;
  onDecision: (id: string, decision: 'keep-local' | 'use-import') => void;
  onReviewed: (reviewed: boolean) => void;
  onBackup: () => void;
  onCancel: () => void;
  onCommit: () => void;
}) {
  const catalog = preview.format === 'book-catalog';
  const labels = catalog ? { added: 'new books', updated: 'source updates', unchanged: 'unchanged books', deleted: 'deleted books' } : undefined;
  return <div className="import-preview">
    <h3>Review import before writing</h3>
    <p><strong>Detected format: {catalog ? 'Book catalog' : 'Vaayana backup'}</strong></p>
    <p>{preview.alreadyImported ? 'This file has already been imported. Repeating it will not duplicate books or history.' : `Your current library is unchanged. Review this proposed ${catalog ? 'catalog import' : 'merge'}.`}</p>
    {catalog && <>
      <p><strong>{preview.source.actualCount.toLocaleString()} actual entries</strong> · {preview.source.declaredCount === undefined ? 'No declared total' : `${preview.source.declaredCount.toLocaleString()} declared total`} · {preview.source.unknownAuthorCount.toLocaleString()} unknown authors</p>
      <p className="small-print">All catalog text is unverified. Image references are preserved, not downloaded. No reading history, tags, Layers, ISBNs, or online facts are inferred.</p>
      {preview.source.notes !== undefined && <div className="catalog-source-note"><strong>Catalog source notes (not your reading notes)</strong><p>{preview.source.notes}</p></div>}
      <div className="form-grid">
        <label>Starting shelf for new catalog books<select disabled={busy} value={preview.defaults.status} onChange={e => onDefaultsChange({ ...preview.defaults, status: e.target.value as 'to-read' | 'wishlist' })}><option value="to-read">To read</option><option value="wishlist">Wishlist</option></select></label>
        <label>Owned formats for new catalog books<select disabled={busy} value={preview.defaults.formats.length === 2 ? 'both' : preview.defaults.formats[0] ?? 'unknown'} onChange={e => onDefaultsChange({ ...preview.defaults, formats: e.target.value === 'both' ? ['physical', 'digital'] : e.target.value === 'unknown' ? [] : [e.target.value as 'physical' | 'digital'] })}><option value="unknown">Unknown / no copy specified</option><option value="physical">Physical</option><option value="digital">Digital</option><option value="both">Physical + digital</option></select></label>
      </div>
      <p className="small-print">These choices apply only to new books. Existing edits, holdings, notes, and reading history stay unchanged. Changing a choice creates a fresh preview and resets your review.</p>
    </>}
    {preview.warnings.length > 0 && <div className="notice subtle"><div><strong>Import warnings</strong><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div></div>}
    <div className="import-counts">{Object.entries(preview.counts).map(([name, count]) => <div key={name}><strong>{count}</strong><span>{labels?.[name as keyof typeof labels] ?? name}</span></div>)}</div>
    {preview.conflicts.length > 0 && <p className="small-print">Counts above exclude entries awaiting a decision. Local data is preserved by default.</p>}
    {preview.conflicts.map(conflict => <label className="import-conflict" key={conflict.id}>
      <strong>{catalog ? `Catalog entry ${conflict.catalogEntryIndex}: ${conflict.kind === 'deleted' ? 'keep deleted or restore?' : 'possible duplicate'}` : conflict.kind === 'deleted' ? 'Restore or keep deleted?' : conflict.kind === 'archived' ? 'Restore or keep archived?' : 'Choose which revision to keep'}</strong>
      <span>{conflict.description}</span>
      {!catalog && <small>{conflict.table} · {conflict.entityId}</small>}
      <select disabled={busy} aria-label={catalog ? `Resolve catalog entry ${conflict.catalogEntryIndex}` : `Resolve ${conflict.id}`} value={decisions[conflict.id] ?? 'keep-local'} onChange={e => onDecision(conflict.id, e.target.value as 'keep-local' | 'use-import')}>
        <option value="keep-local">{catalog ? 'Skip entry (keep local book or deletion)' : 'Keep local (preserve current deletion/edits)'}</option>
        <option value="use-import">{catalog ? conflict.kind === 'deleted' ? 'Explicitly restore this catalog entry' : 'Add as a separate book (never replace local)' : 'Use import (explicitly restore/replace this record)'}</option>
      </select>
    </label>)}
    <p className="small-print">{catalog ? 'Similar titles are never automatically merged. Source notes and image references remain unverified provenance, separate from your personal diary.' : 'Deleting/archive decisions and identity mappings are preserved between snapshots. Unknown ancestry requires review. Your existing edits win by default, not the newest device clock.'}</p>
    <button className="text-button" disabled={busy} onClick={onBackup}>Download a pre-import backup (then review again)</button>
    <label className="inline-check"><input disabled={busy} type="checkbox" checked={reviewed} onChange={e => onReviewed(e.target.checked)} />{catalog ? 'I reviewed the catalog, defaults, warnings, and any add or restore decisions.' : 'I reviewed the merge and any restore decisions.'}</label>
    <div className="inline-actions"><button className="secondary-button" disabled={busy} onClick={onCancel}>Cancel import</button><button className="primary-button" disabled={busy || !reviewed} onClick={onCommit}>{catalog ? 'Import reviewed catalog' : 'Commit safe merge'}</button></div>
  </div>;
}

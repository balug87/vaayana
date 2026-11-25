import { useState } from 'react';
import type { Book } from '../domain/types';
import { revertUploadedCover, saveUploadedCover } from '../data/repository';
import { normalizeCoverPhoto } from '../services/cover-photo';
import { ErrorMessage } from './ui';

export function BookCoverPhoto({ book, notify }: { book: Book; notify: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const uploaded = book.cover?.kind === 'uploaded';
  async function upload(file: File) {
    // Capture BEFORE decoding. A later cover/photo change must never be overwritten by stale work.
    const expectedCoverRevision = book.cover?.revision ?? null;
    setBusy(true); setError('');
    try {
      const photo = await normalizeCoverPhoto(file);
      await saveUploadedCover(book.id, { jpeg: photo.blob }, { expectedCoverRevision });
      notify('Photo saved locally. It was not sent to a server.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'This photo could not be saved. Your current cover has not changed.'); }
    finally { setBusy(false); }
  }
  async function remove() {
    const expectedCoverRevision = book.cover?.kind === 'uploaded' ? book.cover.revision : undefined;
    setBusy(true); setError('');
    try { await revertUploadedCover(book.id, { expectedCoverRevision }); notify('Custom cover removed. The saved provider cover or local placeholder is shown again.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The cover could not be changed.'); }
    finally { setBusy(false); }
  }
  return <section className="detail-section cover-photo-controls">
    <h3>Your cover</h3>
    <p className="small-print">A photo you choose stays on this device and in your exported backup. It is never sent to Open Library or an AI service, and it always wins over fetched covers. Remove it to return to the saved provider cover or placeholder.</p>
    <div className="inline-actions"><label className="secondary-button file-button">{busy ? 'Preparing photo…' : uploaded ? 'Replace photo' : 'Upload photo'}<input aria-label="Upload cover photo" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }} /></label>{uploaded && <button className="text-button danger-text" type="button" disabled={busy} onClick={() => void remove()}>Remove custom cover</button>}</div>
    <p className="small-print">JPEG, PNG or WebP · up to 10 MiB / 24 megapixels. Saved as a metadata-free JPEG, up to 512 pixels and 64 KiB (target 32 KiB). HEIC/SVG are not supported. Normalized photos share an 8 MiB limit and must fit the 20 MiB backup limit.</p>
    <ErrorMessage message={error} />
  </section>;
}

import { useState, type FormEvent } from 'react';
import { Search, PenLine, ArrowLeft, LoaderCircle, Globe, Check } from 'lucide-react';
import type { AddBookInput, Book, BookFormat, LayerId, MetadataCandidate, Settings } from '../domain/types';
import { LAYERS } from '../domain/layers';
import { addBook } from '../data/repository';
import { searchBooks, getEditions } from '../services';
import { BookCover, ErrorMessage, Modal, STATUS_NAMES } from './ui';

export default function AddBook({ books, settings, onClose, onSaved, onOnline }: { books: Book[]; settings: Settings; onClose: () => void; onSaved: (id: string) => void; onOnline: () => Promise<void> }) {
  const [tab, setTab] = useState<'search' | 'manual'>(settings.onlineAccess ? 'search' : 'manual');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MetadataCandidate[]>([]);
  const [candidate, setCandidate] = useState<MetadataCandidate>();
  const [editions, setEditions] = useState<MetadataCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const [fields, setFields] = useState({ title: '', author: '', isbn: '', pageCount: '', purpose: '', primaryLayer: '', sourceUrl: '' });
  const [formats, setFormats] = useState<BookFormat[]>(['physical']);
  const [status, setStatus] = useState<AddBookInput['status']>('to-read');
  const [mergeWork, setMergeWork] = useState('');
  const duplicate = books.find(b => candidate?.workId && b.workKey === candidate.workId || fields.isbn && b.isbn?.replace(/[- ]/g, '') === fields.isbn.replace(/[- ]/g, ''));
  const form = tab === 'manual' || Boolean(candidate);
  async function lookup(event: FormEvent) {
    event.preventDefault(); setError(''); setBusy(true); setSearched(true);
    try { setResults(await searchBooks(query)); } catch (e) { setError(e instanceof Error ? e.message : 'Lookup unavailable. You can still enter the book manually.'); }
    finally { setBusy(false); }
  }
  function choose(book: MetadataCandidate) {
    setCandidate(book); setFields(f => ({ ...f, title: book.title, author: book.authors.join(', '), isbn: book.isbn[0] ?? '', pageCount: book.pageCount?.toString() ?? '' })); setEditions([]); setMergeWork('');
  }
  async function editionsFor() {
    if (!candidate) return; setBusy(true); setError('');
    try { setEditions(await getEditions(candidate)); } catch (e) { setError(String(e instanceof Error ? e.message : e)); } finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const id = await addBook({
        title: fields.title.trim(), authors: fields.author.split(',').map(a => a.trim()).filter(Boolean), isbn: fields.isbn || undefined,
        pageCount: fields.pageCount ? Number(fields.pageCount) : undefined, formats, status, purpose: fields.purpose,
        primaryLayer: fields.primaryLayer as LayerId || undefined, sourceUrl: fields.sourceUrl || undefined, candidate,
        workId: mergeWork || undefined,
      }); onSaved(id);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save. Your existing books are unchanged.'); }
    finally { setBusy(false); }
  }
  return <Modal title="Add a book" onClose={onClose} wide>
    <p className="dialog-intro">A well-loved copy or your next great read. There's room for both.</p>
    <div className="tabs" role="tablist" aria-label="Add book method"><button role="tab" aria-selected={tab === 'search'} onClick={() => { setTab('search'); setCandidate(undefined); setError(''); }}><Search size={16} /> Search online</button><button role="tab" aria-selected={tab === 'manual'} onClick={() => { setTab('manual'); setCandidate(undefined); setError(''); }}><PenLine size={16} /> Enter manually</button></div>
    {tab === 'search' && !candidate && <>
      {!settings.onlineAccess ? <div className="notice"><Globe size={20} /><div><strong>Online lookup is off</strong><p>Search sends your title, author, or ISBN and network information to Open Library. Your diary stays here.</p><button className="secondary-button compact" onClick={() => void onOnline()}>Enable online lookup</button></div></div> : <form onSubmit={lookup} className="lookup-form"><div className="search-input"><Search size={17} /><input required minLength={2} aria-label="Search title, author or ISBN" placeholder="A title, author, or ISBN…" value={query} onChange={e => setQuery(e.target.value)} /></div><button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : 'Search'}</button></form>}
      <div className="search-results">{results.map((book, i) => <button key={`${book.workId}-${i}`} className="search-result" onClick={() => choose(book)}><BookCover book={book} covers={settings.onlineAccess && settings.loadCovers} small /><span><strong>{book.title}</strong><span>{book.authors.join(', ') || 'Unknown author'}</span><small>{book.firstPublishYear || book.publishedDate || 'Publication date unknown'} · {book.language || 'Choose edition for details'}</small></span><span className="text-link">Select</span></button>)}</div>
      {searched && !busy && !results.length && !error && <p className="muted center">No matches found. Try another search or enter the book manually.</p>}
      <p className="small-print">Metadata from Open Library. Missing or incorrect records can always be edited.</p>
    </>}
    {form && <form onSubmit={save} className="book-form">
      {candidate && <div className="selected-candidate"><button type="button" className="text-button" onClick={() => setCandidate(undefined)}><ArrowLeft size={15} /> Back to results</button><div className="notice subtle"><BookCover book={candidate} covers={settings.onlineAccess && settings.loadCovers} small /><div><strong>Check your edition</strong><p>Page counts and ISBNs can differ between editions.</p><button type="button" className="text-button" onClick={() => void editionsFor()} disabled={busy}>Find editions</button></div></div>{editions.length > 0 && <label>Choose edition<select aria-label="Choose edition" value={candidate.editionId ?? ''} onChange={e => { const choice = editions.find(b => b.editionId === e.target.value); if (choice) { const all = editions; choose(choice); setEditions(all); } }}><option value="">Select a specific edition</option>{editions.map((ed, i) => <option key={ed.editionId ?? i} value={ed.editionId}>{ed.publishedDate || 'Unknown date'} · {ed.publisher || 'Unknown publisher'} · {ed.language || 'Unknown language'} · {ed.isbn[0] || 'No ISBN'}</option>)}</select></label>}</div>}
      <div className="form-grid"><label className="full">Title<input required maxLength={500} value={fields.title} onChange={e => setFields({ ...fields, title: e.target.value })} /></label><label className="full">Author<input maxLength={500} placeholder="Separate multiple authors with commas" value={fields.author} onChange={e => setFields({ ...fields, author: e.target.value })} /></label><label>ISBN<input value={fields.isbn} placeholder="Optional, ISBN-10 or ISBN-13" onChange={e => setFields({ ...fields, isbn: e.target.value })} /></label><label>Page count<input type="number" min="1" max="1000000" value={fields.pageCount} placeholder="Unknown is okay" onChange={e => setFields({ ...fields, pageCount: e.target.value })} /></label></div>
      <fieldset><legend>Your copy</legend><div className="choice-row">{(['physical', 'digital'] as BookFormat[]).map(format => <label className={`choice-chip ${formats.includes(format) ? 'selected' : ''}`} key={format}><input type="checkbox" checked={formats.includes(format)} onChange={e => setFormats(e.target.checked ? [...formats, format] : formats.filter(f => f !== format))} />{format === 'physical' ? 'Physical' : 'Digital'}{formats.includes(format) && <Check size={14} />}</label>)}</div><p className="small-print">Select both for two formats. Leave unselected for a wishlist book you don't own.</p></fieldset>
      <div className="form-grid"><label>Reading status<select value={status} onChange={e => setStatus(e.target.value as AddBookInput['status'])}>{Object.entries(STATUS_NAMES).map(([value, name]) => <option value={value} key={value}>{name}</option>)}</select></label><label>Primary Layer<select value={fields.primaryLayer} onChange={e => setFields({ ...fields, primaryLayer: e.target.value })}><option value="">Unknown / unassigned</option>{LAYERS.map(l => <option value={l.id} key={l.id}>{l.name}</option>)}</select></label><label className="full">What are you reading this for?<input maxLength={1000} value={fields.purpose} placeholder="A new perspective, a practical answer, a little escape…" onChange={e => setFields({ ...fields, purpose: e.target.value })} /></label>{formats.includes('digital') && <label className="full">Digital source link<input type="url" placeholder="https://… (optional, no file upload)" value={fields.sourceUrl} onChange={e => setFields({ ...fields, sourceUrl: e.target.value })} /></label>}</div>
      {duplicate && <div className="notice warning"><div><strong>This may already be in your library: {duplicate.title}</strong><p>Keep the same work identity when adding another edition, or cancel to review the existing book.</p><label className="inline-check"><input type="checkbox" checked={mergeWork === duplicate.id} onChange={e => setMergeWork(e.target.checked ? duplicate.id : '')} />Add this edition to the existing work</label></div></div>}
      <ErrorMessage message={error} /><div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !fields.title.trim() || Boolean(duplicate && !mergeWork)}>{busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />} Save book</button></div>
    </form>}
    {!form && <ErrorMessage message={error} />}
  </Modal>;
}

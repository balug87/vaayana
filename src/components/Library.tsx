import { useState } from 'react';
import { motion } from 'motion/react';
import { Plus, Search, LayoutGrid, List, ArrowUpRight, SlidersHorizontal, BookOpen, Leaf } from 'lucide-react';
import type { Book, LayerId, LibrarySnapshot, ReadingStatus } from '../domain/types';
import { LAYERS } from '../domain/layers';
import { BookCover, Progress, STATUS_NAMES } from './ui';

export default function Library({ snapshot, onAdd, onSelect, onView }: { snapshot: LibrarySnapshot; onAdd: () => void; onSelect: (id: string) => void; onView: (view: 'shelf' | 'list') => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [layer, setLayer] = useState('');
  const [format, setFormat] = useState('');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState('recent');
  const [filters, setFilters] = useState(false);
  const { books, settings } = snapshot;
  const filtered = books.filter(book => (!query || `${book.title} ${book.authors.join(' ')} ${book.isbn ?? ''} ${book.tags.map(t => t.name).join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (!status || book.status === status) && (!format || book.formats.includes(format as 'physical' | 'digital')) && (!layer || book.primaryLayer === layer || book.secondaryLayers.includes(layer as LayerId)) && (!tag || book.tags.some(t => t.id === tag)))
    .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'author' ? (a.authors[0] ?? '').localeCompare(b.authors[0] ?? '') : b.createdAt.localeCompare(a.createdAt));
  const reading = books.filter(b => b.status === 'reading');
  const covers = settings.onlineAccess && settings.loadCovers;
  return <>
    <div className="page-heading"><div><div className="eyebrow"><span /> YOUR PERSONAL READING ROOM</div><h1>A life in books<span className="heading-dot">.</span></h1><p>A place for what you love. Room for what comes next.</p></div><button className="primary-button" onClick={onAdd}><Plus size={18} /> Add a book</button></div>
    <div className="library-summary">
      <div><BookOpen size={17} /><strong>{books.length}</strong><span>in your library</span></div>
      <span className="summary-divider" />
      <div><span className="status-dot" /><strong>{reading.length}</strong><span>currently reading</span></div>
      <span className="summary-divider" />
      <div><Leaf size={17} /><strong>{books.filter(b => b.status === 'finished').length}</strong><span>stories lived</span></div>
      <span className="summary-note">One book at a time.</span>
    </div>
    {!books.length && <motion.section className="welcome-card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="welcome-copy"><span className="eyebrow">MAKE YOURSELF AT HOME</span><h2>Every good library<br />starts with one book.</h2><p>The dog-eared favorite. The next big idea.<br className="desktop-only" /> The story you keep meaning to begin.</p><button className="text-button" onClick={onAdd}>Make room for your first book <ArrowUpRight size={17} /></button></div>
      <div className="welcome-art" aria-hidden="true"><div className="art-sun" /><div className="art-book art-book-one"><span>stories<br />&amp; other<br />possibilities</span><i /></div><div className="art-book art-book-two"><span>THE<br />QUIET<br />HOURS</span><i /></div><div className="art-book art-book-three"><span>A LITTLE<br />WONDER</span><i /></div><div className="art-ground" /><span className="art-caption">a little curiosity goes a long way</span></div>
    </motion.section>}
    <div className="collection-heading"><div><h2>Your collection <span>{filtered.length}</span></h2><p>Good company, always within reach.</p></div><div className="view-switch" aria-label="Library view"><button aria-label="Shelf view" aria-pressed={settings.view === 'shelf'} onClick={() => onView('shelf')}><LayoutGrid size={17} /></button><button aria-label="List view" aria-pressed={settings.view === 'list'} onClick={() => onView('list')}><List size={19} /></button></div></div>
    <div className="collection-tools"><div className="search-input"><Search size={17} /><input aria-label="Search your library" placeholder="Find a title, author, ISBN, or tag…" value={query} onChange={e => setQuery(e.target.value)} /></div><select aria-label="Filter by reading status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All books</option>{Object.entries(STATUS_NAMES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><button className={`secondary-button compact ${filters ? 'active' : ''}`} aria-expanded={filters} onClick={() => setFilters(!filters)}><SlidersHorizontal size={16} /> Filters</button></div>
    {filters && <div className="filter-row"><label>Layer<select value={layer} onChange={e => setLayer(e.target.value)}><option value="">All Layers</option>{LAYERS.map(l => <option value={l.id} key={l.id}>{l.name}</option>)}</select></label><label>Format<select value={format} onChange={e => setFormat(e.target.value)}><option value="">All formats</option><option value="physical">Physical</option><option value="digital">Digital</option></select></label><label>Tag<select value={tag} onChange={e => setTag(e.target.value)}><option value="">All tags</option>{snapshot.tags.filter(t => !t.archived).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label>Sort<select value={sort} onChange={e => setSort(e.target.value)}><option value="recent">Recently added</option><option value="title">Title A–Z</option><option value="author">Author A–Z</option></select></label></div>}
    {settings.view === 'shelf' ? <div className="shelf-room">
      {filtered.length ? <div className="bookshelf">{filtered.map((book, i) => <BookTile key={book.id} book={book} covers={covers} index={i} onSelect={onSelect} />)}<div className="shelf-add"><button onClick={onAdd} aria-label="Add another book"><Plus size={24} /></button><span>A little more room</span></div></div> : <div className="empty-shelf"><div className="empty-shelf-label"><span>{books.length ? 'No books match these filters.' : 'A shelf full of possibility.'}</span><span>{books.length ? 'Try a different search.' : 'Your books will feel right at home here.'}</span></div><button className="empty-book-outline" onClick={onAdd} aria-label="Add your first book"><Plus size={24} /><span>Add a book</span></button></div>}
      <div className="wood-shelf" /><div className="shelf-shadow" />
    </div> : <div className="list-collection">{filtered.length ? filtered.map(book => <button className="book-list-row" key={book.id} onClick={() => onSelect(book.id)}><BookCover book={book} covers={covers} small /><span className="list-book-name"><strong>{book.title}</strong><span>{book.authors.join(', ') || 'Unknown author'}</span></span><span className="list-book-format">{book.formats.join(' + ') || 'Wishlist'}</span><span className={`status-pill ${book.status}`}>{STATUS_NAMES[book.status]}</span><ArrowUpRight size={17} /></button>) : <div className="list-empty">No books here yet. Add one when you're ready.</div>}</div>}
    <div className="library-bottom-note"><span className="tiny-flower">✳</span><p>Your library lives on this device. <strong>Export a backup</strong> in Settings to keep it safe.</p><span className="serif-note">Read at your own pace.</span></div>
  </>;
}
function BookTile({ book, covers, index, onSelect }: { book: Book; covers: boolean; index: number; onSelect: (id: string) => void }) {
  return <motion.button className="book-tile" onClick={() => onSelect(book.id)} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index * 0.035, 0.3) }} whileHover={{ y: -5 }} aria-label={`Open ${book.title}`}>
    <BookCover book={book} covers={covers} /><div className="book-tile-info"><strong>{book.title}</strong><span>{book.authors.join(', ') || 'Unknown author'}</span><Progress book={book} /></div>
  </motion.button>;
}

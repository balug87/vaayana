import { useEffect, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X, BookOpen, ArrowUpRight } from 'lucide-react';
import type { Book, MetadataFields, ReadingStatus } from '../domain/types';
import { CoverImage } from './CoverImage';

export const STATUS_NAMES: Record<ReadingStatus, string> = {
  wishlist: 'Wishlist', 'to-read': 'To read', reading: 'Reading', paused: 'Paused', finished: 'Finished', abandoned: 'Abandoned',
};
export const COLORS = ['#315a48', '#935638', '#415b77', '#87523d', '#70683f', '#755065', '#355e61'];
export function bookColor(title: string) {
  return COLORS[Array.from(title).reduce((sum, c) => sum + c.charCodeAt(0), 0) % COLORS.length];
}
export function BookCover({ book, covers = false, small = false }: { book: Pick<MetadataFields, 'title' | 'authors' | 'coverId'>; covers?: boolean; small?: boolean }) {
  const image = covers && book.coverId ? `https://covers.openlibrary.org/b/id/${book.coverId}-M.jpg?default=false` : undefined;
  return <div className={`book-cover ${small ? 'small' : ''}`} style={{ '--book-color': bookColor(book.title) } as React.CSSProperties}>
    <div className="cover-type"><span className="cover-ornament">V</span><strong>{book.title}</strong><span className="cover-rule" /><span>{book.authors.join(' · ') || 'Author unknown'}</span></div>
    {image && <CoverImage key={image} src={image} />}
    <span className="book-binding" />
  </div>;
}
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`dialog ${wide ? 'wide' : ''}`} aria-labelledby="dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <motion.div className="dialog-inner" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
      <div className="dialog-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>
      {children}
    </motion.div>
  </dialog>;
}
export function EmptyState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon"><BookOpen size={28} strokeWidth={1.3} /></div><h3>{title}</h3><p>{children}</p>{action}</div>;
}
export function ErrorMessage({ message }: { message?: string }) {
  return message ? <p className="error-message" role="alert">{message}</p> : null;
}
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  let safe = false;
  try { safe = new URL(href).protocol === 'https:'; } catch { /* Invalid imported URLs never become links. */ }
  return safe ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="external-link">{children}<ArrowUpRight size={14} /></a> : <span>{children}</span>;
}
export function Progress({ book }: { book: Book }) {
  const percent = book.progress.percent ?? (book.pageCount && book.progress.page ? Math.min(100, book.progress.page / book.pageCount * 100) : book.status === 'finished' ? 100 : 0);
  return <div className="book-progress"><div className="progress-track"><span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div><span>{book.progress.percent !== undefined ? `${book.progress.percent}%` : book.progress.page !== undefined ? `p. ${book.progress.page}${book.pageCount ? ` / ${book.pageCount}` : ''}` : STATUS_NAMES[book.status]}</span></div>;
}
export function Toast({ message }: { message: string }) {
  return <AnimatePresence>{message && <motion.div className="toast" role="status" initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ opacity: 0 }}>{message}</motion.div>}</AnimatePresence>;
}

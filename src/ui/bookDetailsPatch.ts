import type { Book, BookFormat, LayerAssignment, LayerId, UpdateBookInput } from '../domain/types';
export interface BookDetailsDraft {
  title: string; author: string; pages: string; formats: BookFormat[];
  purpose: string; primary: string; secondary: LayerId[];
  layerLabel: LayerAssignment['label']; layerEvidence: string;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function metadataLookupQuery(book: Pick<Book, 'isbn' | 'title' | 'authors'>): string {
  return book.isbn || `${book.title} ${book.authors[0] ?? ''}`.trim();
}
export function bookDetailsPatch(book: Book, draft: BookDetailsDraft): UpdateBookInput {
  const patch: UpdateBookInput = {};
  const authors = draft.author.split(',').map(a => a.trim()).filter(Boolean);
  if (draft.title !== book.title) patch.title = draft.title;
  if (!same(authors, book.authors)) patch.authors = authors;
  if (draft.pages !== (book.pageCount?.toString() ?? '')) {
    if (!draft.pages && book.pageCount !== undefined) throw new Error('Keep the known page count, enter a corrected number, or reset its override in Sources.');
    if (draft.pages) patch.pageCount = Number(draft.pages);
  }
  if (!same([...draft.formats].sort(), [...book.formats].sort())) patch.formats = draft.formats;
  if (draft.purpose !== book.purpose) patch.purpose = draft.purpose;
  if (draft.primary !== (book.primaryLayer ?? '')) patch.primaryLayer = draft.primary as LayerId || null;
  const secondary = draft.secondary.filter(l => l !== draft.primary);
  if (!same([...secondary].sort(), [...book.secondaryLayers].sort())) patch.secondaryLayers = secondary;
  if (draft.layerLabel !== (book.layerAssignment?.label ?? 'user-selected')) patch.layerLabel = draft.layerLabel;
  if (draft.layerEvidence !== (book.layerAssignment?.evidence ?? '')) patch.layerEvidence = draft.layerEvidence;
  return patch;
}

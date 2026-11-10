import type { MetadataCandidate, ReviewLink } from '../domain/types';
export interface ReviewAction { title: string; url: string; kind: 'professional' | 'reader'; verified: boolean; source: string; verifiedAt?: string }
export function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 2048) return undefined;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.includes(':') || /^[\d.]+$/.test(host) || !host.includes('.')) return undefined;
    return url.href;
  } catch { return undefined; }
}
export function getReviewSources(book: MetadataCandidate, savedLinks: Pick<ReviewLink, 'url' | 'title' | 'kind' | 'source' | 'verified' | 'verifiedAt'>[] = []) {
  const query = [book.title, ...book.authors].join(' ').slice(0, 600);
  const reviews: ReviewAction[] = savedLinks.flatMap(link => {
    const url = safeExternalUrl(link.url);
    return url && link.verified === true ? [{ title: link.title, url, kind: link.kind, source: link.source, verified: true, verifiedAt: link.verifiedAt }] : [];
  });
  const searchActions: ReviewAction[] = [
    { title: 'Search Goodreads', source: 'Goodreads', kind: 'reader', verified: false, url: `https://www.goodreads.com/search?q=${encodeURIComponent(query)}` },
    { title: 'Find a Kirkus review', source: 'Kirkus', kind: 'professional', verified: false, url: `https://www.kirkusreviews.com/search/?q=${encodeURIComponent(query)}` },
  ];
  return { rating: book.rating, reviews, searchActions, notice: 'Ratings are not review texts. Search actions do not confirm that a review exists. Full-text review aggregation requires source permission.' };
}

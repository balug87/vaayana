import type { MetadataCandidate } from '../domain/types';
import { normalizeLanguage, searchBooks, toIsbn13 } from './books';
import type { LookupOptions } from './books';
import { canUseNetwork, throwIfAborted } from './network';
import { normalizeTag } from './suggestions';
export type RecommendationLane = 'deepen' | 'expand';
export interface TopicBridge { from: string; to: string; broaderThan?: string }
export interface Recommendation {
  book: MetadataCandidate; reason: string; matchedTopics: string[];
  bridge?: TopicBridge; mode: 'rule-based' | 'semantic';
}
export interface DiscoveryRequest {
  interests: string[]; excludedWorkIds?: string[]; excludedIsbns?: string[]; dislikedTopics?: string[];
  language?: string; lane: RecommendationLane; limit?: number;
}
export interface DiscoveryResult { items: Recommendation[]; status: 'ready' | 'needs-interests' | 'offline' | 'partial'; errors: string[] }
export const BRIDGE_VERSION = 'topic-bridges-2';
const BRIDGE_FALLBACKS: Readonly<Record<string, string>> = { 'cognitive anthropology': 'anthropology' };
const MAX_LANE_QUERIES = 2;
export const TOPIC_BRIDGES = [
  { anchors: ['decision making', 'psychology', 'thinking'], to: 'cognitive anthropology' },
  { anchors: ['programming', 'computers', 'software', 'technology', 'computer science'], to: 'history of computing' },
  { anchors: ['business', 'management', 'leadership', 'negotiation'], to: 'organizational culture' },
  { anchors: ['finance', 'economics', 'investing', 'money'], to: 'economic history' },
  { anchors: ['cooking', 'cookbooks', 'food', 'recipes'], to: 'food history' },
  { anchors: ['health', 'sleep', 'fitness', 'nutrition'], to: 'public health' },
  { anchors: ['fiction', 'novels', 'literature', 'stories'], to: 'world literature' },
  { anchors: ['history', 'biography', 'politics'], to: 'cultural anthropology' },
  { anchors: ['science', 'physics', 'astronomy'], to: 'philosophy of science' },
  { anchors: ['design', 'architecture', 'art'], to: 'urban sociology' },
  { anchors: ['philosophy', 'logic', 'ethics'], to: 'comparative religion' },
  { anchors: ['nature', 'environment', 'ecology', 'gardening'], to: 'environmental history' },
  { anchors: ['music', 'creativity', 'poetry'], to: 'cultural history' },
] as const;
const tokens = (value: string) => normalizeTag(value).match(/[\p{L}\p{N}]+/gu)?.filter(t => !['the', 'of', 'and', 'a', 'an', 'in', 'to', 'for'].includes(t)) ?? [];
function topicMatch(book: MetadataCandidate, topic: string): number {
  const haystack = normalizeTag([book.title, ...book.subjects].join(' '));
  const phrase = normalizeTag(topic);
  if (haystack.includes(phrase)) return 1;
  const terms = tokens(topic);
  if (!terms.length) return 0;
  const available = new Set(tokens(haystack));
  return terms.filter(term => available.has(term)).length / terms.length;
}
const key = (value: string) => value.split('/').filter(Boolean).pop() ?? value;
const escapeQuery = (value: string) => value.replace(/[\\"]/g, '\\$&');
function allowed(book: MetadataCandidate, request: DiscoveryRequest): boolean {
  if ((request.excludedWorkIds ?? []).some(id => key(id) === key(book.workId))) return false;
  const excluded = new Set((request.excludedIsbns ?? []).map(toIsbn13).filter(Boolean));
  if (book.isbn.some(isbn => excluded.has(toIsbn13(isbn)))) return false;
  if ((request.dislikedTopics ?? []).some(topic => topicMatch(book, topic) >= 0.8)) return false;
  return !request.language || normalizeLanguage(book.language) === request.language;
}
function diverse(items: { item: Recommendation; score: number }[], limit: number): Recommendation[] {
  const selected: Recommendation[] = [];
  const pool = [...items].sort((a, b) => b.score - a.score || a.item.book.title.localeCompare(b.item.book.title));
  while (pool.length && selected.length < limit) {
    pool.sort((a, b) => {
      const penalty = (entry: typeof a) => selected.filter(other => other.book.authors.some(author => entry.item.book.authors.includes(author))).length * 0.45;
      return (b.score - penalty(b)) - (a.score - penalty(a));
    });
    const next = pool.shift()!;
    if (selected.filter(other => other.book.authors.some(author => next.item.book.authors.includes(author))).length >= 2) continue;
    selected.push(next.item);
  }
  return selected;
}
/** Pure ranking is also useful for already-cached candidates; it never invents new records. */
export function rankCandidates(books: MetadataCandidate[], request: DiscoveryRequest, bridges: TopicBridge[] = []): Recommendation[] {
  request = { ...request, language: normalizeLanguage(request.language) ?? request.language };
  const seen = new Set<string>();
  const interests = request.interests.map(normalizeTag).filter(Boolean);
  const ranked: { item: Recommendation; score: number }[] = [];
  for (const book of books) {
    const id = key(book.workId);
    if (seen.has(id) || !allowed(book, request)) continue;
    seen.add(id);
    const matches = interests.filter(topic => topicMatch(book, topic) >= 0.5);
    const relevance = interests.reduce((best, topic) => Math.max(best, topicMatch(book, topic)), 0);
    if (request.lane === 'deepen') {
      if (!matches.length) continue;
      ranked.push({ item: { book, matchedTopics: matches, reason: `Matches your ${matches.slice(0, 2).join(' and ')} interest${matches.length > 1 ? 's' : ''}.`, mode: 'rule-based' }, score: relevance + Math.min(book.subjects.length, 10) * 0.005 });
    } else {
      const bridge = bridges.find(value => topicMatch(book, value.to) >= 0.75 && !interests.some(interest => normalizeTag(interest) === normalizeTag(value.to)));
      if (!bridge) continue;
      ranked.push({
        item: { book, matchedTopics: [bridge.to], bridge, mode: 'rule-based', reason: `From ${bridge.from} to ${bridge.to}: ${bridge.broaderThan ? `a broader curated bridge because ${bridge.broaderThan} returned no eligible candidates` : 'a related field with a different perspective'}. Curated topic bridge, not an AI claim.` },
        score: topicMatch(book, bridge.to) + (1 - relevance) * 0.3,
      });
    }
  }
  return diverse(ranked, Math.max(1, Math.min(request.limit ?? 8, 20)));
}
export function bridgesFor(interests: string[]): TopicBridge[] {
  return interests.flatMap(interest => {
    const normalized = normalizeTag(interest);
    const entry = TOPIC_BRIDGES.find(bridge => bridge.anchors.some(anchor => normalized.includes(anchor) || anchor.includes(normalized)));
    return entry && normalized !== normalizeTag(entry.to) ? [{ from: interest, to: entry.to }] : [];
  }).filter((value, i, values) => values.findIndex(other => other.to === value.to) === i).slice(0, 2);
}
export async function discover(request: DiscoveryRequest, options: LookupOptions = {}): Promise<DiscoveryResult> {
  const language = normalizeLanguage(request.language);
  if (request.language && !language) return { items: [], status: 'partial', errors: ['Choose a supported two- or three-letter language code. The language filter has not been removed.'] };
  request = { ...request, language };
  const interests = [...new Set(request.interests.map(normalizeTag).filter(value => value && value.length <= 80))].slice(0, 3);
  if (!interests.length) return { items: [], status: 'needs-interests', errors: ['Choose an interest to find real book candidates.'] };
  const bridges = bridgesFor(interests);
  const topics = request.lane === 'deepen' ? interests.slice(0, 2) : bridges.map(value => value.to);
  if (!topics.length) return { items: [], status: 'partial', errors: ['No curated bridge is available for this interest yet. Try a broader interest such as science, history, cooking, or programming.'] };
  const candidates: MetadataCandidate[] = [];
  const errors: string[] = [];
  let queries = 0;
  for (const topic of topics) {
    if (queries >= MAX_LANE_QUERIES) break;
    throwIfAborted(options.signal);
    try {
      queries++;
      const found = await searchBooks(`subject:"${escapeQuery(topic)}"`, { ...options, language: request.language, limit: 24 });
      candidates.push(...found);
      const bridge = request.lane === 'expand' ? bridges.find(value => value.to === topic) : undefined;
      const fallback = BRIDGE_FALLBACKS[topic];
      if (bridge && fallback && canUseNetwork() && queries < MAX_LANE_QUERIES && !rankCandidates(found, { ...request, interests }, [bridge]).length) {
        throwIfAborted(options.signal);
        queries++;
        const broader = await searchBooks(`subject:"${escapeQuery(fallback)}"`, { ...options, language: request.language, limit: 24 });
        bridges.push({ from: bridge.from, to: fallback, broaderThan: topic });
        candidates.push(...broader);
      }
    }
    catch (error) {
      if (options.signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw error;
      errors.push(error instanceof Error ? error.message : 'Candidate search failed.');
    }
  }
  const items = rankCandidates(candidates, { ...request, interests }, bridges);
  return { items, status: !canUseNetwork() ? 'offline' : errors.length || !items.length ? 'partial' : 'ready', errors };
}
export async function getRecommendations(request: Omit<DiscoveryRequest, 'lane'>, options: LookupOptions = {}) {
  const deepen = await discover({ ...request, lane: 'deepen' }, options);
  const expand = await discover({ ...request, lane: 'expand' }, options);
  return { deepen: deepen.items, expand: expand.items, status: deepen.status === 'needs-interests' ? 'needs-interests' : deepen.status === 'offline' ? 'offline' : deepen.status === 'partial' || expand.status === 'partial' ? 'partial' : 'ready', errors: [...new Set([...deepen.errors, ...expand.errors])] };
}

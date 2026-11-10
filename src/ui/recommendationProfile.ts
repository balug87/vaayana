import type { Book, LibrarySnapshot } from '../domain/types';

const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
// Only this finite broad vocabulary can be inferred. Raw tags/purpose/subjects never
// become provider queries, including unknown condition, identity, or belief labels.
const BROAD_TOPICS: [RegExp, string][] = [
  [/histor|big history/i, 'History'], [/system/i, 'Systems thinking'], [/design|architect/i, 'Design'],
  [/cook|recipe|baking/i, 'Cooking'], [/program|coding|software/i, 'Programming'],
  [/financ|invest|account/i, 'Finance'], [/psycholog|decision|reasoning|thinking/i, 'Psychology'],
  [/scien|physics|chemistry|biology/i, 'Science'], [/fiction|novel|stories|narrative/i, 'Fiction'],
  [/manag|business|leadership/i, 'Management'], [/\bart\b|\barts\b|creativ/i, 'Art'], [/philosoph/i, 'Philosophy'],
  [/\bhealth\b|\bsleep\b|\bnutrition\b|\bexercise\b|\bwellbeing\b|\blongevity\b/i, 'Health'],
  [/anthropolog/i, 'Anthropology'], [/garden|botany/i, 'Gardening'],
];
function topicsFor(book: Book): string[] {
  const tags = book.tags.filter(t => ['topic', 'purpose'].includes(t.kind)).map(t => t.name);
  const evidence = [...tags, book.purpose, ...(book.subjects ?? []).slice(0, 20)].join(' ');
  return BROAD_TOPICS.filter(([pattern]) => pattern.test(evidence)).map(([, topic]) => topic);
}
export function buildRecommendationProfile(snapshot: LibrarySnapshot, explicitInterests: string[], excludedSuggestions: string[] = []) {
  const explicit = [...new Map(explicitInterests.map(t => t.trim()).filter(Boolean).map(t => [normalize(t), t])).values()];
  if (!snapshot.settings.useLibraryInterests) return { interests: explicit, suggested: [] as { topic: string; evidence: string }[], dislikedTopics: snapshot.recommendationFeedback.filter(f => f.action === 'less-like-this').flatMap(f => f.topics) };
  const positive = new Map<string, { topic: string; evidence: string; score: number }>();
  const negative = new Set(snapshot.recommendationFeedback.filter(f => f.action === 'less-like-this').flatMap(f => f.topics).map(normalize));
  for (const book of snapshot.books) {
    const topics = topicsFor(book);
    if (book.personalRating !== undefined && book.personalRating <= 2) { topics.forEach(t => negative.add(normalize(t))); continue; }
    const sessions = snapshot.sessions.some(s => s.workId === book.id && (s.pages > 0 || s.minutes > 0 || s.page !== undefined || s.percent !== undefined));
    const completed = book.status === 'finished' || snapshot.readingCycles.some(c => c.workId === book.id && c.status === 'finished');
    const engaged = completed || book.status === 'reading' || sessions;
    if (!engaged || book.status === 'abandoned') continue;
    const score = (completed ? 3 : 1) + (sessions ? 1 : 0) + (book.personalRating && book.personalRating >= 4 ? 2 : 0);
    for (const topic of topics) {
      const key = normalize(topic);
      if (!positive.has(key) || positive.get(key)!.score < score) positive.set(key, { topic, score, evidence: `${completed ? 'Finished' : 'Reading activity'} · ${book.title}${book.personalRating ? ` · rated ${book.personalRating}/5` : ''}` });
    }
  }
  const suggested = [...positive.values()].filter(t => !negative.has(normalize(t.topic)) && !explicit.some(e => normalize(e) === normalize(t.topic)))
    .sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic)).slice(0, 8).map(({ topic, evidence }) => ({ topic, evidence }));
  const included = suggested.filter(t => !excludedSuggestions.includes(t.topic)).map(t => t.topic);
  return {
    interests: [...explicit, ...included],
    suggested,
    dislikedTopics: [...negative].filter(t => !explicit.some(e => normalize(e) === t)),
  };
}

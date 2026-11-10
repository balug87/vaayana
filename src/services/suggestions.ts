import type { LayerId, MetadataCandidate, TagKind } from '../domain/types';
export const SUGGESTION_VERSION = 'purpose-rules-1';
export function normalizeTag(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}
export interface TagSuggestion {
  name: string; normalizedName: string; kind: TagKind; origin: 'provider'; sourceRef: string;
  version: string; label: 'tentative'; evidence: string;
}
export function suggestTags(book: MetadataCandidate, options: { existing?: (string | { name: string; normalizedName?: string })[]; rejectedNames?: string[]; limit?: number } = {}): TagSuggestion[] {
  const blocked = new Set([...(options.existing ?? []).map(value => typeof value === 'string' ? normalizeTag(value) : value.normalizedName ?? normalizeTag(value.name)), ...(options.rejectedNames ?? []).map(normalizeTag)]);
  const seen = new Set<string>();
  return book.subjects.flatMap(subject => {
    const name = subject.normalize('NFKC').trim().replace(/\s+/g, ' ');
    const normalizedName = normalizeTag(name);
    // Exclude catalogue codes, machine facets and enormous provider subject lists.
    if (!name || name.length > 65 || /^[\d\W]+$/.test(name) || /^(?:nyt:|[A-Z]{1,3}\d|new york times bestseller|spiegel-bestseller)/i.test(name) || blocked.has(normalizedName) || seen.has(normalizedName)) return [];
    seen.add(normalizedName);
    return [{ name, normalizedName, kind: 'topic' as const, origin: 'provider' as const, sourceRef: book.sourceUrl, version: SUGGESTION_VERSION, label: 'tentative' as const, evidence: `Catalogue subject: ${name}. Confirm if useful to you.` }];
  }).slice(0, Math.min(Math.max(options.limit ?? 8, 0), 20));
}
export interface LayerSuggestion { layer: LayerId; origin: 'rule'; version: string; label: 'tentative' | 'needs-review'; evidence: string }
const rules: { layer: LayerId; purpose: RegExp; subjects: RegExp; reason: string }[] = [
  { layer: 'operating-system', purpose: /\b(think|thinking|focus|attention|reason|reasoning|learn how to learn|decid|self-understanding|emotional regulation|identity|metacogn)/i, subjects: /\b(metacognition|critical thinking|attention|logic|decision making|cognitive psychology)\b/i, reason: 'Thinking, attention, reasoning or understanding your own mental processes.' },
  { layer: 'fuel', purpose: /\b(now|today|immediate|execute|executing|solve|practical|tactical|task|recipe|cook|negotia|reference|how to)\b/i, subjects: /\b(cookbooks|handbooks|manuals|recipes|negotiation)\b/i, reason: 'Immediate practical use or a reference for a task. Confirm what you need it for.' },
  { layer: 'hardware', purpose: /\b(sleep|nutrition|health|body|exercise|fitness|energy|longevity)\b/i, subjects: /\b(health|sleep|nutrition|exercise|fitness|physiology|longevity)\b/i, reason: 'Health, energy or the body. This classification does not validate medical claims.' },
  { layer: 'mind-expanding', purpose: /\b(perspective|worldview|broaden|unfamiliar|cross-pollination|big history|systems|new ideas)\b/i, subjects: /\b(anthropology|cosmology|world history|systems thinking|cultural studies|philosophy)\b/i, reason: 'A perspective or unfamiliar world to explore, rather than necessarily a thinking practice.' },
  { layer: 'software-applications', purpose: /\b(expertise|master|career|domain|discipline|professional|sustained|study|competence|skill)\b/i, subjects: /\b(programming|engineering|finance|management|architecture|mathematics|economics|design)\b/i, reason: 'Sustained knowledge in a field, including fields outside computing.' },
  { layer: 'screensaver-sandbox', purpose: /\b(rest|relax|renewal|escape|play|story|stories|empathy|fiction|narrative|restoration)\b/i, subjects: /\b(fiction|stories|novels|biography|biographies|memoirs|poetry)\b/i, reason: 'Narrative, play, empathy or restoration. Genre alone does not determine your purpose.' },
];
export function suggestLayers(book: MetadataCandidate, options: { purpose?: string; confirmedLayers?: LayerId[]; rejectedLayers?: LayerId[] } = {}): LayerSuggestion[] {
  const blocked = new Set([...(options.confirmedLayers ?? []), ...(options.rejectedLayers ?? [])]);
  const subjects = book.subjects.join(' ');
  const purpose = options.purpose?.trim() ?? '';
  return rules.flatMap(rule => {
    if (blocked.has(rule.layer)) return [];
    const purposeMatch = rule.purpose.test(purpose);
    const subjectMatch = rule.subjects.test(subjects);
    if (!purposeMatch && !subjectMatch) return [];
    return [{
      layer: rule.layer, origin: 'rule' as const, version: SUGGESTION_VERSION,
      label: purposeMatch ? 'tentative' as const : 'needs-review' as const,
      evidence: `${purposeMatch ? 'Your stated reading purpose suggests this.' : 'Catalogue subjects suggest this; your purpose may differ.'} ${rule.reason}`,
    }];
  });
}

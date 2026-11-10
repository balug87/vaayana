import { describe, expect, it } from 'vitest';
import type { Book, LibrarySnapshot, Tag } from '../domain/types';
import { buildRecommendationProfile } from './recommendationProfile';
const book = (id: string, title: string, status: string, topic?: string, rating?: number, extra = {}) => ({ id, title, status, personalRating: rating, tags: topic ? [{ name: topic, kind: 'topic' } as Tag] : [], purpose: '', ...extra }) as Book;
const snapshot = (books: Book[], extra = {}) => ({ books, sessions: [], readingCycles: [], recommendationFeedback: [], settings: { useLibraryInterests: true }, ...extra }) as unknown as LibrarySnapshot;

describe('reader-history grounded recommendation profile', () => {
  it('does not treat unread wishlist tags as positive history', () => {
    const profile = buildRecommendationProfile(snapshot([book('a', 'Unread cookbook', 'wishlist', 'Cooking'), book('b', 'A history read', 'finished', 'History', 5)]), []);
    expect(profile.interests).toEqual(['History']);
    expect(profile.suggested[0].evidence).toContain('Finished');
  });
  it('moves poorly rated read topics to dislike signals and uses purpose/subjects without tags', () => {
    const profile = buildRecommendationProfile(snapshot([book('a', 'Disliked cookbook', 'finished', 'Cooking', 1), book('b', 'Connections', 'finished', undefined, 5, { purpose: 'Understand systems and big history', subjects: ['Science'] })]), []);
    expect(profile.interests).toEqual(expect.arrayContaining(['History', 'Systems thinking', 'Science']));
    expect(profile.interests).not.toContain('Cooking');
    expect(profile.dislikedTopics).toContain('cooking');
    expect(profile.interests).not.toContain('Understand systems and big history');
  });
  it('keeps explicit choices first, permits removal, and suppresses sensitive inference', () => {
    const profile = buildRecommendationProfile(snapshot([book('a', 'A book', 'reading', 'History'), book('b', 'Private', 'finished', 'Depression', 5)]), ['Design'], ['History']);
    expect(profile.interests).toEqual(['Design']);
    expect(profile.suggested.map(s => s.topic)).toEqual(['History']);
  });
  it('requires consent and respects less-like feedback', () => {
    const input = snapshot([book('a', 'A history', 'finished', 'History', 5)], { settings: { useLibraryInterests: false } });
    expect(buildRecommendationProfile(input, ['Art']).interests).toEqual(['Art']);
    input.settings.useLibraryInterests = true;
    input.recommendationFeedback = [{ action: 'less-like-this', topics: ['History'] }] as LibrarySnapshot['recommendationFeedback'];
    expect(buildRecommendationProfile(input, []).interests).toEqual([]);
  });
  it('uses recorded reading activity even when current status is paused', () => {
    const input = snapshot([book('a', 'Learning', 'paused', 'Programming')], { sessions: [{ workId: 'a', pages: 12, minutes: 0 }] });
    expect(buildRecommendationProfile(input, []).interests).toEqual(['Programming']);
  });
  it('never infers raw sensitive or unknown tags, but explicit input is a deliberate choice', () => {
    const input = snapshot([book('a', 'One read', 'finished', 'History', 5), book('b', 'Another read', 'finished', 'HIV', 5), book('c', 'Unknown category', 'finished', 'A private belief', 5), book('d', 'Unread cookbook', 'wishlist', 'Cooking'), book('e', 'Disliked', 'finished', 'Cooking', 1)]);
    const result = buildRecommendationProfile(input, ['Design']);
    expect(result.interests).toEqual(['Design', 'History']);
    expect(result.suggested.map(s => s.topic)).not.toContain('HIV');
    expect(buildRecommendationProfile(input, ['HIV']).interests[0]).toBe('HIV');
  });
});

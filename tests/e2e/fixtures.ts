import type { Page, Route } from '@playwright/test';
import type { BackupDocument } from '../../src/domain/types';

/** Explicit synthetic Open Library fixtures, never live-provider evidence. */
export const providerFixture = {
  numFound: 1,
  start: 0,
  docs: [{
    key: '/works/OL1W',
    title: 'A Field Guide to Thinking',
    author_name: ['Alex Reader'],
    author_key: ['OL1A'],
    edition_key: ['OL1M'],
    editions: { docs: [{ key: '/books/OL1M', title: 'A Field Guide to Thinking', language: ['eng'], isbn: ['9780140328721'] }] },
    isbn: ['9780140328721'],
    first_publish_year: 2024,
    subject: ['Decision making', 'Learning'],
    cover_i: 900001,
    ratings_average: 4.25,
    ratings_count: 24,
    language: ['eng'],
  }],
};

export const editionFixture = {
  key: '/books/OL1M',
  title: 'A Field Guide to Thinking',
  works: [{ key: '/works/OL1W' }],
  authors: [{ key: '/authors/OL1A' }],
  isbn_13: ['9780140328721'],
  number_of_pages: 240,
  publishers: ['Synthetic QA Press'],
  publish_date: '2024',
  languages: [{ key: '/languages/eng' }],
};

export const deepenFixture = {
  ...providerFixture,
  docs: [{
    ...providerFixture.docs[0],
    key: '/works/OL2W',
    title: 'Decisions in Practice',
    edition_key: ['OL2M'],
    editions: { docs: [{ key: '/books/OL2M', title: 'Decisions in Practice', language: ['eng'], isbn: [] }] },
    subject: ['Decision making', 'Psychology'],
    isbn: [],
  }],
};

export const expandFixture = {
  ...providerFixture,
  docs: [{
    ...providerFixture.docs[0],
    key: '/works/OL3W',
    title: 'Culture and Human Choices',
    edition_key: ['OL3M'],
    editions: { docs: [{ key: '/books/OL3M', title: 'Culture and Human Choices', language: ['eng'], isbn: [] }] },
    subject: ['Cognitive anthropology', 'Culture'],
    isbn: [],
  }],
};

export async function mockLookup(page: Page, revised = false) {
  await page.route('https://openlibrary.org/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const body = url.pathname === '/search.json'
      ? { ...providerFixture, docs: providerFixture.docs.map((doc) => ({ ...doc, ...(revised ? { title: 'Updated Provider Title', subject: ['Decision making', 'Learning', 'Reasoning'] } : {}) })) }
      : url.pathname.endsWith('/editions.json')
        ? { entries: [editionFixture] }
      : url.pathname.endsWith('/ratings.json')
        ? { summary: { average: 4.25, count: 24 } }
      : url.pathname.startsWith('/books/')
        ? { ...editionFixture, ...(revised ? { title: 'Updated Provider Title', number_of_pages: 260 } : {}) }
        : url.pathname.startsWith('/isbn/')
          ? editionFixture
        : url.pathname.startsWith('/authors/')
          ? { name: 'Alex Reader', key: '/authors/OL1A' }
          : { key: '/works/OL1W', title: revised ? 'Updated Provider Title' : providerFixture.docs[0].title, subjects: ['Decision making', 'Learning'] };
    await route.fulfill({ json: body });
  });
  await page.route('https://covers.openlibrary.org/**', (route) => route.abort());
}

export function fileUpload(name: string, text: string) {
  return { name, mimeType: 'application/json', buffer: Buffer.from(text) };
}

/** Mutate an actual exported backup so validation exercises the shipped format. */
export function malformedBackups(original: BackupDocument) {
  const unknownVersion = structuredClone(original);
  unknownVersion.formatVersion = 999 as 1;
  const brokenRelation = structuredClone(original);
  if (brokenRelation.entities.editions[0]) {
    brokenRelation.entities.editions[0].workId = 'missing-parent-work';
  }
  const unsafeLink = structuredClone(original);
  if (unsafeLink.entities.holdings[0]) {
    unsafeLink.entities.holdings[0].sourceUrl = 'javascript:alert("unsafe")';
  }
  const hostileKey = JSON.stringify(original).replace('"entities":{', '"entities":{"__proto__":{"polluted":true},');
  return [
    { label: 'invalid JSON', text: '{"format":' },
    { label: 'unsupported version', text: JSON.stringify(unknownVersion) },
    { label: 'broken relation', text: JSON.stringify(brokenRelation) },
    { label: 'unsafe URL', text: JSON.stringify(unsafeLink) },
    { label: 'hostile key', text: hostileKey },
  ];
}

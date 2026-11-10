// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { addBook, db, getSnapshot, initializeLibrary, LibraryDatabase } from './repository';

beforeEach(async () => { db.close(); await db.delete(); await db.open(); });
afterEach(cleanup);

function Shelf() {
  const snapshot = useLiveQuery(getSnapshot);
  if (!snapshot) return createElement('p', null, 'Loading');
  return createElement('p', null, snapshot.books.length ? snapshot.books.map((book) => book.title).join(', ') : 'Your empty shelf');
}
it('boots a clean database before mounting the real React live-query hook, then reacts to edits', async () => {
  await initializeLibrary();
  render(createElement(Shelf));
  expect(await screen.findByText('Your empty shelf')).toBeTruthy();
  await addBook({ title: 'A first real book' });
  expect(await screen.findByText('A first real book')).toBeTruthy();
});
it('the query itself remains strictly readonly even before explicit bootstrap', async () => {
  render(createElement(Shelf));
  expect(await screen.findByText('Your empty shelf')).toBeTruthy();
  expect(await db.meta.get('library')).toBeUndefined();
  await initializeLibrary();
  await waitFor(async () => expect((await getSnapshot()).libraryId).not.toBe(''));
});
it('initialization from two database connections creates one stable library identity', async () => {
  const other = new LibraryDatabase(db.name);
  try {
    await Promise.all([initializeLibrary(db), initializeLibrary(other)]);
    const first = await db.meta.get('library'), second = await other.meta.get('library');
    expect(first?.libraryId).toBe(second?.libraryId);
    expect(await db.meta.count()).toBe(1);
    expect(first?.revision).toBe(0);
    await initializeLibrary();
    expect((await db.meta.get('library'))?.libraryId).toBe(first?.libraryId);
  } finally { other.close(); }
});

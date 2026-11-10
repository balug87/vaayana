// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Settings from './Settings';
import BookDetail from './BookDetail';
import { addBook, commitImport, db, exportBackup, getSnapshot, initializeLibrary, previewImport, saveSettings, updateBook } from '../data/repository';
import { CATALOG_EXAMPLE_JSON } from './ImportFormats';
import { cancelSemantic, getSemanticState, removeSemanticModel, setNetworkPreferences } from '../services';

const dialogMethods = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype);
beforeEach(async () => {
  await db.delete(); await db.open(); await initializeLibrary();
  await saveSettings({ onlineAccess: true });
  setNetworkPreferences({ onlineLookup: true, covers: false });
  await removeSemanticModel();
});
afterEach(async () => {
  cleanup(); cancelSemantic(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await db.delete();
  for (const name of ['showModal', 'close']) {
    if (dialogMethods[name]) Object.defineProperty(HTMLDialogElement.prototype, name, dialogMethods[name]);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
  }
});
async function openSettings() {
  const notify = vi.fn();
  const view = render(createElement(Settings, { snapshot: await getSnapshot(), offline: { state: 'ready', online: true, retry: async () => {} }, notify }));
  fireEvent.click(view.getByRole('checkbox', { name: /^I agree to download the optional model/ }));
  fireEvent.click(view.getByRole('button', { name: /^Download optional model$/ }));
  return { ...view, notify };
}
describe('actual Settings download handler with real semantic state transitions', () => {
  it('reports unsupported-worker fallback, never the semantic-ready success toast', async () => {
    vi.stubGlobal('Worker', undefined);
    const view = await openSettings();
    await waitFor(() => expect(view.notify).toHaveBeenCalled());
    expect(getSemanticState().mode).toBe('basic-fallback');
    expect(view.notify).toHaveBeenCalledWith('Local workers or WebAssembly are unavailable. Use basic matching.');
    expect(view.notify.mock.calls.flat().some(message => String(message).includes('model is ready'))).toBe(false);
  });
  it('reports cancellation of a deliberately stalled worker without a false ready message', async () => {
    vi.stubGlobal('Worker', class { postMessage() {} terminate() {} });
    const view = await openSettings();
    await waitFor(() => expect(getSemanticState().mode).toBe('downloading'));
    fireEvent.click(view.getByRole('button', { name: /^Cancel model download$/ }));
    await waitFor(() => expect(view.notify).toHaveBeenCalledWith('Optional model download cancelled. Basic matching remains available.'));
    expect(getSemanticState().mode).toBe('basic-fallback');
    expect(view.notify.mock.calls.flat().some(message => String(message).includes('model is ready'))).toBe(false);
  });
});

async function renderImportSettings() {
  const notify = vi.fn();
  return { ...render(createElement(Settings, { snapshot: await getSnapshot(), offline: { state: 'ready', online: true, retry: async () => {} }, notify })), notify };
}
function upload(view: Awaited<ReturnType<typeof renderImportSettings>>, text: string) {
  const file = new File([text], 'invented-example.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => text });
  fireEvent.change(view.getByLabelText('Import backup or catalog'), { target: { files: [file] } });
}
async function confirmCatalog(view: Awaited<ReturnType<typeof renderImportSettings>>) {
  fireEvent.click(view.getByRole('checkbox', { name: /^I reviewed the catalog/ }));
  fireEvent.click(view.getByRole('button', { name: 'Import reviewed catalog' }));
  await waitFor(() => expect(view.notify).toHaveBeenCalledWith(expect.stringMatching(/^Import complete:/)));
}
describe('actual Settings catalog import flow', () => {
  it('detects the formerly rejected catalog root, exposes actual counts and warnings, and cancels without writes or network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network must remain unused'));
    const view = await renderImportSettings();
    const catalog = { ...JSON.parse(CATALOG_EXAMPLE_JSON), total_unique_titles: 1 };
    upload(view, JSON.stringify(catalog));
    await view.findByText('Detected format: Book catalog');
    expect(view.getByText('2 actual entries')).toBeTruthy();
    expect(view.getByText(/1 declared total.*1 unknown authors/)).toBeTruthy();
    expect(view.getByText(/differs.*none are truncated/)).toBeTruthy();
    expect(view.getByText(catalog.notes)).toBeTruthy();
    expect((view.getByLabelText('Starting shelf for new catalog books') as HTMLSelectElement).value).toBe('to-read');
    expect((view.getByLabelText('Owned formats for new catalog books') as HTMLSelectElement).value).toBe('unknown');
    expect((view.getByRole('button', { name: 'Import reviewed catalog' }) as HTMLButtonElement).disabled).toBe(true);
    expect((await getSnapshot()).books).toHaveLength(0);
    fireEvent.click(view.getByRole('button', { name: 'Cancel import' }));
    expect(view.queryByText('Detected format: Book catalog')).toBeNull();
    expect((await getSnapshot()).books).toHaveLength(0);
    expect(await db.entity('importReceipts').count()).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('restages changed defaults, resets review and imports only the chosen status/holdings without read history', async () => {
    const view = await renderImportSettings();
    upload(view, CATALOG_EXAMPLE_JSON);
    await view.findByText('Detected format: Book catalog');
    fireEvent.click(view.getByRole('checkbox', { name: /^I reviewed the catalog/ }));
    fireEvent.change(view.getByLabelText('Starting shelf for new catalog books'), { target: { value: 'wishlist' } });
    await waitFor(() => expect((view.getByLabelText('Starting shelf for new catalog books') as HTMLSelectElement).value).toBe('wishlist'));
    expect((view.getByRole('checkbox', { name: /^I reviewed the catalog/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(view.getByRole('checkbox', { name: /^I reviewed the catalog/ }));
    fireEvent.change(view.getByLabelText('Owned formats for new catalog books'), { target: { value: 'both' } });
    await waitFor(() => expect((view.getByLabelText('Owned formats for new catalog books') as HTMLSelectElement).value).toBe('both'));
    expect((view.getByRole('button', { name: 'Import reviewed catalog' }) as HTMLButtonElement).disabled).toBe(true);
    await confirmCatalog(view);
    const snapshot = await getSnapshot();
    expect(snapshot.books).toHaveLength(2);
    expect(snapshot.books.every(book => book.status === 'wishlist' && book.formats.join(',') === 'physical,digital' && book.notes === '')).toBe(true);
    expect(snapshot.books.find(book => book.title === 'The Quiet Orchard')?.authors).toEqual([]);
    expect(snapshot.readingCycles).toEqual([]); expect(snapshot.statusEvents).toEqual([]); expect(snapshot.sessions).toEqual([]);
  });
  it.each([false, true])('keeps a similar saved book untouched when add-separate is %s', async (addSeparate) => {
    const id = await addBook({ title: 'A Field Guide to Clouds', authors: ['Alex Example'], status: 'reading', formats: ['digital'] });
    await updateBook(id, { notes: 'An invented local diary note.' });
    const before = (await getSnapshot()).books.find(book => book.id === id)!;
    const view = await renderImportSettings();
    upload(view, CATALOG_EXAMPLE_JSON);
    await view.findByText('Detected format: Book catalog');
    const conflict = view.getByLabelText('Resolve catalog entry 1') as HTMLSelectElement;
    expect(conflict.value).toBe('keep-local');
    expect(view.getByRole('option', { name: 'Add as a separate book (never replace local)' })).toBeTruthy();
    if (addSeparate) {
      fireEvent.click(view.getByRole('checkbox', { name: /^I reviewed the catalog/ }));
      fireEvent.change(conflict, { target: { value: 'use-import' } });
      expect((view.getByRole('checkbox', { name: /^I reviewed the catalog/ }) as HTMLInputElement).checked).toBe(false);
    }
    await confirmCatalog(view);
    const snapshot = await getSnapshot();
    expect(snapshot.books).toHaveLength(addSeparate ? 3 : 2);
    expect(snapshot.books.find(book => book.id === id)).toEqual(before);
    expect(snapshot.statusEvents).toHaveLength(1);
  });
  it('keeps selected catalog defaults but requires review again after a pre-import backup', async () => {
    vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:invented-example'; } static revokeObjectURL() {} });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const view = await renderImportSettings();
    upload(view, CATALOG_EXAMPLE_JSON);
    await view.findByText('Detected format: Book catalog');
    fireEvent.change(view.getByLabelText('Owned formats for new catalog books'), { target: { value: 'digital' } });
    await waitFor(() => expect((view.getByLabelText('Owned formats for new catalog books') as HTMLSelectElement).value).toBe('digital'));
    fireEvent.click(view.getByRole('checkbox', { name: /^I reviewed the catalog/ }));
    fireEvent.click(view.getByRole('button', { name: 'Download a pre-import backup (then review again)' }));
    await waitFor(() => expect(view.notify).toHaveBeenCalledWith('Backup download prepared. Check that the file was saved.'));
    expect((view.getByLabelText('Owned formats for new catalog books') as HTMLSelectElement).value).toBe('digital');
    expect((view.getByRole('checkbox', { name: /^I reviewed the catalog/ }) as HTMLInputElement).checked).toBe(false);
    expect((await getSnapshot()).books).toHaveLength(0);
    await confirmCatalog(view);
    expect((await getSnapshot()).books.every(book => book.formats.join(',') === 'digital')).toBe(true);
  });
  it('retains the existing strict backup preview and confirmation flow', async () => {
    await addBook({ title: 'An Invented Local Book', authors: [], formats: [] });
    const backup = await exportBackup();
    const view = await renderImportSettings();
    upload(view, backup);
    await view.findByText('Detected format: Vaayana backup');
    expect(view.queryByLabelText('Starting shelf for new catalog books')).toBeNull();
    fireEvent.click(view.getByRole('checkbox', { name: 'I reviewed the merge and any restore decisions.' }));
    fireEvent.click(view.getByRole('button', { name: 'Commit safe merge' }));
    await waitFor(() => expect(view.notify).toHaveBeenCalledWith(expect.stringMatching(/^Import complete:/)));
    expect((await getSnapshot()).books).toHaveLength(1);
  });
  it('shows safe errors and clears an old preview before rejecting a malformed file', async () => {
    const view = await renderImportSettings();
    upload(view, CATALOG_EXAMPLE_JSON);
    await view.findByText('Detected format: Book catalog');
    upload(view, '{"books":[{"title":"Invented source text, never echo this",}]}');
    await view.findByRole('alert');
    expect(view.getByRole('alert').textContent).toMatch(/Invalid JSON/);
    expect(view.getByRole('alert').textContent).not.toContain('Invented source text');
    expect(view.queryByText('Detected format: Book catalog')).toBeNull();
    expect((await getSnapshot()).books).toHaveLength(0);
  });
  it('displays preserved unverified source details without copying them into diary notes', async () => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
      close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
    });
    await commitImport((await previewImport(CATALOG_EXAMPLE_JSON)).token);
    const snapshot = await getSnapshot();
    const book = snapshot.books.find(book => book.title === 'The Quiet Orchard')!;
    const view = render(createElement(BookDetail, { book, snapshot, onClose: () => {}, notify: () => {} }));
    fireEvent.click(view.getByRole('tab', { name: 'Sources' }));
    expect(view.getByRole('heading', { name: 'Unverified catalog sources' })).toBeTruthy();
    expect(view.getByText('Source entry notes (not your reading notes)')).toBeTruthy();
    expect(view.getByText('The author was not identified.')).toBeTruthy();
    expect(view.getByText('2, 3', { exact: false })).toBeTruthy();
    expect(book.notes).toBe('');
  });
});

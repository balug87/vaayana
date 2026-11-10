// @vitest-environment jsdom
import { createElement } from 'react';
import { readFile } from 'node:fs/promises';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_EXAMPLE_JSON, ImportFormats } from './ImportFormats';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('public import format guidance', () => {
  it('keeps the copyable invented example identical to its downloadable JSON', async () => {
    const download = await readFile('public/import-formats/catalog.example.json', 'utf8');
    expect(JSON.parse(CATALOG_EXAMPLE_JSON)).toEqual(JSON.parse(download));
    const example = JSON.parse(CATALOG_EXAMPLE_JSON);
    expect(example.total_unique_titles).toBe(2);
    expect(example.books).toHaveLength(2);
    expect(example.books[1].author).toBeNull();
  });
  it('distinguishes a catalog from a versioned full backup and keeps Pages download links scoped', () => {
    vi.stubEnv('BASE_URL', '/vaayana/');
    const view = render(createElement(ImportFormats));
    expect(view.getByText('Vaayana backup:')).toBeTruthy();
    expect(view.getByText('Book catalog:')).toBeTruthy();
    const links = view.getAllByRole('link');
    expect(links).toHaveLength(5);
    expect(links.every(link => link.getAttribute('href')?.startsWith('/vaayana/import-formats/'))).toBe(true);
    expect(links.filter(link => link.hasAttribute('download'))).toHaveLength(4);
  });
  it('copies only the generic example and handles unavailable clipboard access safely', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const view = render(createElement(ImportFormats));
    fireEvent.click(view.getByRole('button', { name: 'Copy example JSON' }));
    await waitFor(() => expect(view.getByRole('status').textContent).toBe('Example JSON copied.'));
    expect(writeText).toHaveBeenCalledWith(CATALOG_EXAMPLE_JSON);
    writeText.mockRejectedValue(new Error('Clipboard unavailable'));
    fireEvent.click(view.getByRole('button', { name: 'Copy example JSON' }));
    await waitFor(() => expect(view.getByRole('status').textContent).toBe('Select the example text and copy it.'));
  });
});

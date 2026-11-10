// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookCover } from './ui';

let visible: () => void;
const disconnect = vi.fn();
const createObjectURL = vi.fn(() => 'blob:local-cover');
const revokeObjectURL = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { visible = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    observe() {}
    disconnect = disconnect;
  });
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
  createObjectURL.mockClear(); revokeObjectURL.mockClear(); disconnect.mockClear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const book = { title: 'A local book', authors: ['Author'], coverId: 123 };
describe('owned lazy cover request lifecycle', () => {
  it('makes no request by default or before the image is near the viewport, then aborts when covers turn off', () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetcher);
    const view = render(createElement(BookCover, { book }));
    expect(fetcher).not.toHaveBeenCalled();
    view.rerender(createElement(BookCover, { book, covers: true }));
    expect(fetcher).not.toHaveBeenCalled();
    visible();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    expect(signal.aborted).toBe(false);
    view.rerender(createElement(BookCover, { book, covers: false }));
    expect(signal.aborted).toBe(true);
    visible();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('cancels on unmount even after the DOM ref has cleared, and ignores a late response', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetcher);
    const view = render(createElement(BookCover, { book, covers: true }));
    visible();
    const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    view.unmount();
    expect(signal.aborted).toBe(true);
    resolve(new Response('image', { headers: { 'content-type': 'image/png' } }));
    await Promise.resolve(); await Promise.resolve();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
  it('revokes a successfully loaded blob and never falls back to an unabortable remote image', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('image', { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetcher);
    const view = render(createElement(BookCover, { book, covers: true }));
    visible();
    await waitFor(() => expect(view.container.querySelector('img')?.getAttribute('src')).toBe('blob:local-cover'));
    expect(fetcher.mock.calls[0][1]).toMatchObject({ mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local-cover');
    fetcher.mockRejectedValue(new TypeError('CORS unavailable'));
    const second = render(createElement(BookCover, { book, covers: true }));
    visible();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(second.container.querySelector('img')?.hasAttribute('src')).toBe(false);
  });
});

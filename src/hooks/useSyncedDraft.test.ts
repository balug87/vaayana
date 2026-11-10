// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSyncedDraft } from './useSyncedDraft';
import { useLayoutEffect } from 'react';

describe('source refresh and form drafts', () => {
  it('updates a clean form after provider refresh', () => {
    const { result, rerender } = renderHook(({ source }) => useSyncedDraft(source), { initialProps: { source: 'Old provider title' } });
    rerender({ source: 'Fresh provider title' });
    expect(result.current[0]).toBe('Fresh provider title');
  });
  it('preserves an unsaved personal edit while other source updates arrive', () => {
    const { result, rerender } = renderHook(({ source }) => useSyncedDraft(source), { initialProps: { source: 'Old provider title' } });
    act(() => result.current[1]('My draft correction'));
    rerender({ source: 'Fresh provider title' });
    expect(result.current[0]).toBe('My draft correction');
  });
  it('never exposes an untouched old title during the source-update render while purpose is dirty', () => {
    const observed: string[] = [];
    const { result, rerender } = renderHook(({ title }) => {
      const titleDraft = useSyncedDraft(title);
      const purposeDraft = useSyncedDraft('Initial purpose');
      useLayoutEffect(() => { observed.push(titleDraft[0]); }, [title]);
      return { titleDraft, purposeDraft };
    }, { initialProps: { title: 'Old provider title' } });
    act(() => result.current.purposeDraft[1]('My unsaved purpose'));
    rerender({ title: 'Fresh provider title' });
    expect(observed).toEqual(['Old provider title', 'Fresh provider title']);
    expect(result.current.purposeDraft[0]).toBe('My unsaved purpose');
  });
});

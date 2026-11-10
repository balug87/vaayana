import { useEffect, useState, type SetStateAction } from 'react';
/** Refresh clean fields from source updates, without overwriting an unsaved edit. */
export function useSyncedDraft<T>(source: T) {
  const sourceKey = JSON.stringify(source);
  const [draft, setDraft] = useState({ value: source, baseline: sourceKey });
  const dirty = JSON.stringify(draft.value) !== draft.baseline;
  // Clean fields use the current source during render, not after a later effect.
  // An unrelated dirty purpose/note can never turn an untouched old title into an edit.
  const value = dirty ? draft.value : source;
  useEffect(() => {
    setDraft(current => {
      if (current.baseline === sourceKey) return current;
      const clean = JSON.stringify(current.value) === current.baseline;
      return clean || JSON.stringify(current.value) === sourceKey ? { value: source, baseline: sourceKey } : current;
    });
  }, [sourceKey]);
  const update = (action: SetStateAction<T>) => setDraft(current => {
    const clean = JSON.stringify(current.value) === current.baseline;
    const currentValue = clean ? source : current.value;
    const next = typeof action === 'function' ? (action as (value: T) => T)(currentValue) : action;
    return { value: next, baseline: sourceKey };
  });
  return [value, update] as const;
}

// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Settings from './Settings';
import { db, getSnapshot, initializeLibrary, saveSettings } from '../data/repository';
import { cancelSemantic, getSemanticState, removeSemanticModel, setNetworkPreferences } from '../services';

beforeEach(async () => {
  await db.delete(); await db.open(); await initializeLibrary();
  await saveSettings({ onlineAccess: true });
  setNetworkPreferences({ onlineLookup: true, covers: false });
  await removeSemanticModel();
});
afterEach(async () => { cleanup(); cancelSemantic(); vi.unstubAllGlobals(); await db.delete(); });
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

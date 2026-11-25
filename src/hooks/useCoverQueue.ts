import { useEffect, useSyncExternalStore } from 'react';
import { liveQuery } from 'dexie';
import type { Settings } from '../domain/types';
import * as repository from '../data/repository';
import { CoverQueueController } from '../services/cover-queue';
import { setNetworkPreferences } from '../services/network';

export const coverQueue = new CoverQueueController(repository);
export function useCoverQueue() {
  return useSyncExternalStore(coverQueue.subscribe, coverQueue.getState, coverQueue.getState);
}
/** Called once by the app, never by individual covers or the Settings screen. */
export function useCoverAutomation(settings?: Settings): void {
  useEffect(() => {
    setNetworkPreferences({ onlineLookup: settings?.onlineAccess === true, covers: settings?.loadCovers === true, autoFetchCovers: settings?.autoFetchCovers === true });
  }, [settings?.onlineAccess, settings?.loadCovers, settings?.autoFetchCovers]);
  useEffect(() => {
    const unmount = coverQueue.mount();
    const subscription = liveQuery(async () => ({
      targets: await repository.getCoverTargets(), queue: await repository.getCoverQueueSnapshot(),
    })).subscribe({ next: value => coverQueue.synchronize(value.targets, value.queue), error: () => coverQueue.fail() });
    const connection = () => coverQueue.preferencesChanged();
    window.addEventListener('online', connection); window.addEventListener('offline', connection);
    return () => { subscription.unsubscribe(); unmount(); window.removeEventListener('online', connection); window.removeEventListener('offline', connection); };
  }, []);
}

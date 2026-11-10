import { useCallback, useEffect, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

export function useOffline() {
  const [state, setState] = useState<'not-ready' | 'checking' | 'ready' | 'error'>('not-ready');
  const [online, setOnline] = useState(navigator.onLine);
  const check = useCallback(async () => {
    if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
    const controller = navigator.serviceWorker.controller;
    if (!controller) { setState('not-ready'); return; }
    setState('checking');
    try {
      const ready = await new Promise<boolean>((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = window.setTimeout(() => { channel.port1.close(); reject(new Error('Offline cache verification timed out.')); }, 8000);
        channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data?.ready === true); };
        controller.postMessage({ type: 'CHECK_OFFLINE' }, [channel.port2]);
      });
      setState(ready ? 'ready' : 'error');
    } catch { setState('error'); }
  }, []);
  useEffect(() => {
    const network = () => { setOnline(navigator.onLine); void check(); };
    const visibility = () => { if (!document.hidden) void check(); };
    window.addEventListener('online', network); window.addEventListener('offline', network);
    document.addEventListener('visibilitychange', visibility);
    if ('serviceWorker' in navigator && !import.meta.env.DEV) {
      navigator.serviceWorker.addEventListener('controllerchange', check);
      registerSW({ immediate: true, onOfflineReady: () => void check(), onRegisteredSW: () => void check(), onRegisterError: () => setState('error') });
      void check();
    }
    return () => { window.removeEventListener('online', network); window.removeEventListener('offline', network); document.removeEventListener('visibilitychange', visibility); navigator.serviceWorker?.removeEventListener('controllerchange', check); };
  }, [check]);
  return { state, online, retry: async () => { const registration = await navigator.serviceWorker?.getRegistration(import.meta.env.BASE_URL); await registration?.update(); await check(); } };
}

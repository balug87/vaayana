import { useEffect, useRef } from 'react';

/** Fetch only near the viewport, with cancellation owned by this mounted image. */
export function CoverImage({ src }: { src: string }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = ref.current!;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    let started = false;
    let disposed = false;
    async function load() {
      if (started || disposed) return;
      started = true;
      try {
        const response = await fetch(src, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return;
        const blob = await response.blob();
        if (disposed || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        image.src = objectUrl;
      } catch { /* Network/CORS/cancellation failures leave the local typographic cover. */ }
    }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void load(); }
    }, { rootMargin: '150px' });
    observer?.observe(image);
    return () => {
      disposed = true;
      observer?.disconnect();
      controller.abort();
      image.removeAttribute('src');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);
  return <img ref={ref} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none'; }} />;
}

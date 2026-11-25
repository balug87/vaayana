import { useEffect, useState } from 'react';
import { getUploadedCoverBlob } from '../data/repository';

export function UploadedCoverImage({ workId, revision }: { workId: string; revision: string }) {
  const [source, setSource] = useState<string>();
  useEffect(() => {
    let disposed = false; let url: string | undefined;
    setSource(undefined);
    void getUploadedCoverBlob(workId, revision).then(blob => {
      if (!blob || disposed) return;
      url = URL.createObjectURL(blob); setSource(url);
    }).catch(() => { /* The typographic cover remains if local storage is unavailable. */ });
    return () => { disposed = true; if (url) URL.revokeObjectURL(url); };
  }, [workId, revision]);
  return source ? <img src={source} alt="" onError={event => { event.currentTarget.style.display = 'none'; }} /> : null;
}

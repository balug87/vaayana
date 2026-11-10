// Preserve existing root cache names; project deployments must not erase a sibling app's caches.
const base = import.meta.env.BASE_URL;
export const DEPLOYMENT_CACHE_PREFIX = base === '/' ? 'vaayana-' : `vaayana@${encodeURIComponent(base)}-`;

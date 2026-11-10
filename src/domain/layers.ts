import type { LayerId } from './types';
export const LAYERS: { id: LayerId; name: string; purpose: string }[] = [
  { id: 'operating-system', name: 'Operating System', purpose: 'Thinking, learning, deciding, and understanding yourself.' },
  { id: 'fuel', name: 'Fuel', purpose: 'Practical help for what you need to do now.' },
  { id: 'hardware', name: 'Hardware', purpose: 'Health, energy, sleep, and physical wellbeing.' },
  { id: 'mind-expanding', name: 'Mind-Expanding', purpose: 'New perspectives, worldviews, and creative connections.' },
  { id: 'software-applications', name: 'Software Applications', purpose: 'Build lasting expertise in a field.' },
  { id: 'screensaver-sandbox', name: 'Screensaver or Sandbox', purpose: 'Stories, play, empathy, and restoration.' },
];

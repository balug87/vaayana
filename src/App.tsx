import { useCallback, useEffect, useRef, useState, Component, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { MotionConfig, motion } from 'motion/react';
import { BookOpen, LibraryBig, Compass, Layers3, Settings2, Leaf, Menu, X, ShieldCheck, ArrowUpRight, ChevronRight } from 'lucide-react';
import { getSnapshot, saveSettings, initializeLibrary } from './data/repository';
import { setNetworkPreferences } from './services';
import Library from './components/Library';
import Reading from './components/Reading';
import Discover from './components/Discover';
import Layers from './components/Layers';
import Settings from './components/Settings';
import AddBook from './components/AddBook';
import BookDetail from './components/BookDetail';
import { Toast } from './components/ui';
import { useOffline } from './hooks/useOffline';

const NAV = [
  { id: 'library', name: 'My library', icon: LibraryBig },
  { id: 'reading', name: 'Reading', icon: BookOpen },
  { id: 'discover', name: 'Discover', icon: Compass },
  { id: 'layers', name: 'The six Layers', icon: Layers3 },
  { id: 'settings', name: 'Settings & backup', icon: Settings2 },
] as const;
type Page = typeof NAV[number]['id'];
const currentPage = (): Page => NAV.find(n => n.id === location.hash.slice(1))?.id ?? 'library';
export default function App() { return <AppErrorBoundary><Startup /></AppErrorBoundary>; }
function Startup() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let mounted = true;
    void initializeLibrary().then(() => { if (mounted) setReady(true); }).catch(reason => { if (mounted) setError(reason instanceof Error ? reason.message : 'Local storage initialization failed.'); });
    return () => { mounted = false; };
  }, []);
  if (error) throw new Error(error);
  return ready ? <ReadingRoom /> : <div className="loading-room"><BookOpen size={32} /><span className="brand-word">vaayana<span>·</span></span><p>Opening your reading room…</p></div>;
}
function ReadingRoom() {
  const snapshot = useLiveQuery(() => getSnapshot(), []);
  const [page, setPage] = useState<Page>(currentPage);
  const [mobileNav, setMobileNav] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [toast, setToast] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const offline = useOffline();
  const notify = useCallback((text: string) => { clearTimeout(timer.current); setToast(text); timer.current = setTimeout(() => setToast(''), 6500); }, []);
  useEffect(() => { const listener = () => setPage(currentPage()); window.addEventListener('hashchange', listener); return () => window.removeEventListener('hashchange', listener); }, []);
  useEffect(() => {
    if (snapshot) setNetworkPreferences({ onlineLookup: snapshot.settings.onlineAccess, covers: snapshot.settings.loadCovers });
  }, [snapshot?.settings.onlineAccess, snapshot?.settings.loadCovers]);
  useEffect(() => () => clearTimeout(timer.current), []);
  function navigate(next: Page) { location.hash = next; setPage(next); setMobileNav(false); document.getElementById('main-content')?.focus(); }
  if (!snapshot) return <div className="loading-room"><BookOpen size={32} /><span className="brand-word">vaayana<span>·</span></span><p>Opening your reading room…</p></div>;
  const settings = snapshot.settings;
  const book = snapshot.books.find(b => b.id === selected);
  const reduce = settings.reducedMotion;
  return <MotionConfig reducedMotion={reduce ? 'always' : 'user'}>
    <div className="app-shell" data-reduced-motion={reduce ? 'true' : undefined}>
      <a className="skip-link" href="#main-content" onClick={e => { e.preventDefault(); document.getElementById('main-content')?.focus(); }}>Skip to content</a>
      {mobileNav && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}
      <aside className={`sidebar ${mobileNav ? 'is-open' : ''}`}>
        <a className="brand" href="#library" aria-label="Vaayana home" onClick={() => navigate('library')}><span className="brand-symbol"><BookOpen size={26} strokeWidth={1.5} /></span><span className="brand-word">vaayana<span>·</span></span></a>
        <button className="icon-button mobile-nav-close" aria-label="Close navigation" onClick={() => setMobileNav(false)}><X size={20} /></button>
        <div className="sidebar-caption">A LIFE IN BOOKS</div>
        <nav aria-label="Main navigation">{NAV.map(({ id, name, icon: Icon }) => <button key={id} aria-current={page === id ? 'page' : undefined} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => navigate(id)}><Icon size={19} strokeWidth={1.6} /><span>{name}</span>{id === 'library' && <small>{snapshot.books.length}</small>}{page === id && <span className="nav-active-dot" />}</button>)}</nav>
        <div className="sidebar-pause"><span className="pause-leaf"><Leaf size={24} strokeWidth={1.2} /></span><p>A little less scrolling.<br />A little more turning pages.</p><span>A QUIETER KIND OF FEED</span></div>
        <div className="sidebar-bottom"><div className="local-avatar"><BookOpen size={17} /></div><div><strong>Your reading room</strong><span><span className="status-dot" /> On this device</span></div><button className="icon-button" aria-label="Open settings" onClick={() => navigate('settings')}><Settings2 size={16} /></button></div>
      </aside>
      <div className="main-area"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" onClick={() => setMobileNav(true)} aria-label="Open navigation" aria-expanded={mobileNav}><Menu size={21} /></button><span>Your reading room</span><ChevronRight size={12} /><strong>{NAV.find(n => n.id === page)?.name}</strong></div><div className="topbar-right"><span className={`connection-state ${!offline.online ? 'is-offline' : ''}`}><span className="status-dot" />{!offline.online ? 'You’re offline' : offline.state === 'ready' ? 'Offline ready' : 'Local-first, always'}</span><span className="topbar-flower" aria-hidden="true"><Leaf size={18} strokeWidth={1.4} /></span></div></header>
        <main id="main-content" tabIndex={-1} className="main-content">
          {!settings.onboardingComplete && page === 'library' && <div className="onboarding-notice"><ShieldCheck size={18} /><p><strong>A private little corner of the internet.</strong> Your diary stays on this device. Online searches are optional; exports keep your library safe.</p><button className="text-button" onClick={() => void saveSettings({ onboardingComplete: true }).catch(e => notify(e.message))}>Got it <CheckIcon /></button></div>}
          <motion.div className="page-content" key={page} initial={{ opacity: 0, y: reduce ? 0 : 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
            {page === 'library' && <Library snapshot={snapshot} onAdd={() => setAdding(true)} onSelect={setSelected} onView={view => void saveSettings({ view }).catch(e => notify(e.message))} />}
            {page === 'reading' && <Reading snapshot={snapshot} onSelect={setSelected} onAdd={() => setAdding(true)} notify={notify} />}
            {page === 'discover' && <Discover snapshot={snapshot} notify={notify} onSettings={() => navigate('settings')} />}
            {page === 'layers' && <Layers snapshot={snapshot} onSelect={setSelected} />}
            {page === 'settings' && <Settings snapshot={snapshot} offline={offline} notify={notify} />}
          </motion.div>
          <footer className="app-footer"><span><BookOpen size={13} /> vaayana · a life in books</span><span>Made for curiosity, not comparison.</span></footer>
        </main>
      </div>
      {adding && <AddBook books={snapshot.books} settings={settings} onClose={() => setAdding(false)} onSaved={id => { setAdding(false); setSelected(id); notify('A new book, a new possibility. Saved on this device.'); }} onOnline={async () => { setNetworkPreferences({ onlineLookup: true, covers: settings.loadCovers }); await saveSettings({ onlineAccess: true }); }} />}
      {book && !adding && <BookDetail key={book.id} book={book} snapshot={snapshot} onClose={() => setSelected(undefined)} notify={notify} />}
      <Toast message={toast} />
    </div>
  </MotionConfig>;
}
function CheckIcon() { return <ArrowUpRight size={14} />; }
class AppErrorBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    return this.state.error ? <main className="recovery-page"><BookOpen size={30} /><h1>Your library needs a moment.</h1><p>We couldn't open local storage. No database has been deleted or reset.</p><p className="error-message" role="alert">{this.state.error}</p><p>Check browser storage permissions, leave private browsing if needed, and retry. If this started after an update, keep this browser's data for recovery.</p><button className="primary-button" onClick={() => location.reload()}>Try opening again</button></main> : this.props.children;
  }
}

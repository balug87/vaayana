import { useState } from 'react';
import { ArrowUpRight, Compass, Sparkles, Plus, X, LoaderCircle, Leaf } from 'lucide-react';
import type { LibrarySnapshot } from '../domain/types';
import { addBook, saveSettings, saveRecommendationFeedback } from '../data/repository';
import { discover, rerankSemantically, type Recommendation, type DiscoveryResult } from '../services';
import { useSemantic } from '../hooks/useSemantic';
import { BookCover, EmptyState, ErrorMessage, ExternalLink } from './ui';
import { buildRecommendationProfile } from '../ui/recommendationProfile';

export default function Discover({ snapshot, notify, onSettings }: { snapshot: LibrarySnapshot; notify: (message: string) => void; onSettings: () => void }) {
  const [interestText, setInterestText] = useState(snapshot.settings.interests.join(', '));
  const [lane, setLane] = useState<'deepen' | 'expand'>('deepen');
  const [results, setResults] = useState<Partial<Record<'deepen' | 'expand', DiscoveryResult>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [language, setLanguage] = useState('');
  const [hidden, setHidden] = useState<string[]>([]);
  const [excludedSuggestions, setExcludedSuggestions] = useState<string[]>([]);
  const semantic = useSemantic();
  const feedback = snapshot.recommendationFeedback ?? [];
  const interests = interestText.split(',').map(s => s.trim()).filter(Boolean);
  const profile = buildRecommendationProfile(snapshot, interests, excludedSuggestions);
  async function find() {
    setBusy(true); setError('');
    try {
      await saveSettings({ interests });
      const request = { interests: profile.interests, excludedWorkIds: [...snapshot.books.map(b => b.workKey).filter((id): id is string => Boolean(id)), ...feedback.filter(f => f.action === 'dismiss').map(f => f.workKey)], excludedIsbns: snapshot.books.map(b => b.isbn).filter((id): id is string => Boolean(id)), dislikedTopics: profile.dislikedTopics, language: language || undefined, limit: 12 };
      const [deepen, expand] = await Promise.all([discover({ ...request, lane: 'deepen' }), discover({ ...request, lane: 'expand' })]);
      setResults({ deepen, expand }); setHidden([]);
    } catch (e) { setError(e instanceof Error ? e.message : 'Discovery is unavailable. Your library is unaffected.'); }
    finally { setBusy(false); }
  }
  async function save(item: Recommendation) {
    try { await addBook({ title: item.book.title, authors: item.book.authors, candidate: item.book, status: 'wishlist', formats: [] }); notify('Saved to your wishlist.'); setHidden(h => [...h, item.book.workId]); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save this book.'); }
  }
  async function dismiss(item: Recommendation, action: 'dismiss' | 'less-like-this') {
    try { await saveRecommendationFeedback(item.book.workId, action, item.matchedTopics); setHidden(h => [...h, item.book.workId]); notify(action === 'dismiss' ? 'Book dismissed. Saved in your local preferences.' : 'Preference saved. Future results will use this feedback.'); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save feedback.'); }
  }
  const result = results[lane];
  const visible = result?.items.filter(i => !hidden.includes(i.book.workId) && !snapshot.books.some(b => b.workKey === i.book.workId) && !feedback.some(f => f.action === 'dismiss' && f.workKey === i.book.workId)) ?? [];
  return <>
    <div className="page-heading"><div><div className="eyebrow"><span /> FOLLOW YOUR CURIOSITY</div><h1>Your next good book<span className="heading-dot">.</span></h1><p>A little of what you love. A little beyond the familiar.</p></div><span className="mode-badge"><Leaf size={14} />{semantic.mode === 'semantic-ready' ? 'Semantic ready' : semantic.mode === 'downloading' ? 'Downloading' : semantic.mode === 'basic-fallback' ? 'Basic fallback' : 'Rule-based'}</span></div>
    <div className="interest-panel panel"><div><h3>What are you curious about?</h3><p className="muted">Choose broad topics. These search terms go to Open Library, never your private notes.</p></div><label>Interests<input value={interestText} placeholder="Psychology, design, history…" onChange={e => setInterestText(e.target.value)} /></label><div className="interest-chips">{['Psychology', 'History', 'Design', 'Science', 'Fiction', 'Finance'].map(topic => <button key={topic} className="tag" onClick={() => setInterestText([...new Set([...interests, topic])].join(', '))}>+ {topic}</button>)}</div>
      {snapshot.settings.useLibraryInterests && <div className="history-topics"><h4>From your actual reading, with your permission</h4><p className="small-print">Finished/active books and logged reading can suggest broad topics. Unread wishlist items and poorly rated books aren't positive signals. Review or remove these before searching; purpose text stays private.</p>{profile.suggested.map(s => <label className="inline-check" key={s.topic}><input type="checkbox" checked={!excludedSuggestions.includes(s.topic)} onChange={e => setExcludedSuggestions(e.target.checked ? excludedSuggestions.filter(t => t !== s.topic) : [...excludedSuggestions, s.topic])} /><span><strong>{s.topic}</strong><small>{s.evidence}</small></span></label>)}{!profile.suggested.length && <p className="small-print">No additional broad topics yet. Your explicit interests still lead.</p>}</div>}
      <p className="small-print">Search profile: {profile.interests.join(' · ') || 'Choose an interest'}. Your explicit interests come first; the first three topics shape provider searches. Edit the order above to change the focus.</p>
      <div className="interest-controls"><label>Book language<select value={language} onChange={e => setLanguage(e.target.value)}><option value="">Any language</option><option value="en">English</option><option value="ml">Malayalam</option><option value="hi">Hindi</option><option value="fr">French</option><option value="de">German</option><option value="es">Spanish</option></select></label><button className="primary-button" disabled={busy || !profile.interests.length} onClick={() => void find()}>{busy ? <LoaderCircle size={17} className="spin" /> : <Compass size={17} />} {busy ? 'Following the threads…' : 'Find my next read'}</button></div>{!snapshot.settings.onlineAccess && <p className="small-print">Online lookup is off. Saved provider results may be available; fresh discovery needs <button className="text-button" onClick={onSettings}>online access in Settings</button>.</p>}</div>
    <div className="discovery-tabs" role="tablist" aria-label="Recommendation lane"><button className={lane === 'deepen' ? 'selected' : ''} role="tab" aria-selected={lane === 'deepen'} onClick={() => setLane('deepen')}><span className="lane-icon"><Leaf size={20} /></span><span><strong>Deepen your interests</strong><small>Go further into what speaks to you.</small></span></button><button className={lane === 'expand' ? 'selected' : ''} role="tab" aria-selected={lane === 'expand'} onClick={() => setLane('expand')}><span className="lane-icon"><Sparkles size={20} /></span><span><strong>Expand your interests</strong><small>A familiar thread. An unexpected direction.</small></span></button></div>
    <ErrorMessage message={error} />
    {result && <div className="discovery-status"><span>{result.status === 'offline' ? 'Saved candidates · offline' : result.status === 'partial' ? 'Some provider queries were unavailable' : 'Candidates retrieved from Open Library'} · {visible.length} results</span>{semantic.mode === 'semantic-ready' && visible.length > 0 && <button className="text-button" disabled={busy} onClick={async () => { setBusy(true); try { const ranked = await rerankSemantically(visible, profile.interests); setResults(old => ({ ...old, [lane]: { ...result, items: ranked } })); notify('Ranked locally with the semantic model.'); } catch (e) { setError(e instanceof Error ? e.message : 'Using basic matching.'); } finally { setBusy(false); } }}><Sparkles size={14} /> Use semantic matching</button>}</div>}
    {result?.errors.length ? <details className="provider-errors"><summary>Provider status ({result.errors.length})</summary>{result.errors.map((e, i) => <p key={i}>{e}</p>)}</details> : null}
    {visible.length ? <div className="recommendation-grid">{visible.map(item => <article className="recommendation-card" key={item.book.workId}><div className="recommendation-cover"><BookCover book={item.book} covers={snapshot.settings.onlineAccess && snapshot.settings.loadCovers} /><button className="icon-button dismiss-book" aria-label={`Dismiss ${item.book.title}`} onClick={() => void dismiss(item, 'dismiss')}><X size={16} /></button></div><div className="recommendation-info"><span className="eyebrow">{item.mode === 'semantic' ? 'LOCAL SEMANTIC MATCH' : 'TOPIC-BASED MATCH'}</span><h3>{item.book.title}</h3><p className="muted">{item.book.authors.join(', ') || 'Unknown author'}</p>{item.bridge && <p className="bridge-label">{item.bridge.from} <ArrowUpRight size={13} /> {item.bridge.to}</p>}<p className="recommendation-reason">{item.reason}</p><p className="small-print">Open Library · fetched {new Date(item.book.fetchedAt).toLocaleDateString()}</p><div className="recommendation-actions"><button className="secondary-button compact" onClick={() => void save(item)}><Plus size={15} /> Wishlist</button><ExternalLink href={item.book.sourceUrl}>Source</ExternalLink></div><button className="text-button small-print" onClick={() => void dismiss(item, 'less-like-this')}>Less like this</button></div></article>)}</div> : <EmptyState title={busy ? 'A few new possibilities are on their way' : result ? 'Good suggestions need a little room' : 'Where will curiosity take you?'}>{busy ? 'Provider searches are queued respectfully. You can keep using the rest of your library.' : result ? 'Try another topic or language. We show fewer books rather than invent a match.' : 'Choose a few interests above. These are real book searches, not a shuffle of your own shelf.'}</EmptyState>}
    <p className="small-print discovery-footnote">Recommendations are possibilities, not predictions about who you are. No sensitive traits or medical effectiveness are inferred. Embeddings help match supplied book descriptions; they do not invent or discover a live catalog. Language filtering does not establish multilingual semantic quality.</p>
  </>;
}

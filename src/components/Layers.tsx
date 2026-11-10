import { LAYERS } from '../domain/layers';
import type { LibrarySnapshot } from '../domain/types';
import { Brain, Flame, Heart, Orbit, Compass, Moon } from 'lucide-react';

const DETAILS = [
  { icon: Brain, color: '#546985', examples: 'Focus, logic, emotional regulation, decision-making, core identity.', question: 'How do I think and understand myself?' },
  { icon: Flame, color: '#b77b48', examples: 'Cookbooks, a programming reference, immediate tactical help.', question: 'What do I need to do right now?' },
  { icon: Heart, color: '#8c795b', examples: 'Energy, sleep, movement, nutrition, longevity. Not a medical endorsement.', question: 'How do I care for the body I live in?' },
  { icon: Orbit, color: '#727d69', examples: 'Big history, systems, unfamiliar worldviews, creative cross-pollination.', question: 'What else could be true?' },
  { icon: Compass, color: '#a26d58', examples: 'Finance, management, architecture, or sustained programming expertise.', question: 'What field do I want to understand deeply?' },
  { icon: Moon, color: '#8a7183', examples: 'Fiction, biographies, empathy, emotional simulation, restorative stories.', question: 'Where can I wander and feel restored?' },
];
export default function Layers({ snapshot, onSelect }: { snapshot: LibrarySnapshot; onSelect: (id: string) => void }) {
  return <>
    <div className="page-heading"><div><div className="eyebrow"><span /> NOT JUST WHAT. WHAT FOR.</div><h1>Six ways to grow<span className="heading-dot">.</span></h1><p>A personal metaphor for the different things reading gives us.</p></div></div>
    <div className="layers-intro panel"><p>One book, many possibilities.</p><span>A cookbook can be Fuel for tonight. A book on finance can be Software Applications for years. A biography might restore you and change your perspective. Your purpose decides, not the genre.</span></div>
    <div className="layers-grid">{LAYERS.map((layer, i) => { const detail = DETAILS[i]; const Icon = detail.icon; const books = snapshot.books.filter(b => b.primaryLayer === layer.id || b.secondaryLayers.includes(layer.id)); return <article className="layer-card" key={layer.id} style={{ '--layer-color': detail.color } as React.CSSProperties}><div className="layer-card-top"><span className="layer-symbol"><Icon size={25} strokeWidth={1.4} /></span><span className="layer-number">0{i + 1}</span></div><h2>{layer.name}</h2><p className="layer-question">{detail.question}</p><p>{layer.purpose}</p><p className="small-print">{detail.examples}</p><div className="layer-books">{books.length ? books.slice(0, 3).map(b => <button className="text-button" key={b.id} onClick={() => onSelect(b.id)}>{b.title} ↗</button>) : <span>No books here yet. There's no need to fill every Layer.</span>}</div></article>; })}</div>
    <p className="small-print layer-footnote">This is your custom organizing metaphor, informed by DIKW, PARA, and mental-model ideas. It isn't an established six-Layer taxonomy. Use a primary Layer, optional secondary Layers, or leave a book unassigned. Your decisions always outrank suggestions.</p>
  </>;
}

import { useState } from 'react';
import './ImportFormats.css';

export const CATALOG_EXAMPLE_JSON = JSON.stringify({
  total_unique_titles: 2,
  notes: 'An invented two-book catalog example, not a full library backup.',
  books: [
    { title: 'A Field Guide to Clouds', author: 'Alex Example', source_images: [1] },
    { title: 'The Quiet Orchard', author: null, source_images: [2, 3], notes: 'The author was not identified.' },
  ],
}, null, 2);

export function ImportFormats() {
  const [copyNotice, setCopyNotice] = useState('');
  const base = `${import.meta.env.BASE_URL}import-formats/`;
  return <div className="import-format-help">
    <h3>Two accepted JSON formats</h3>
    <p><strong>Vaayana backup:</strong> an unedited file made with <strong>Export backup</strong>, marked <code>"format": "vaayana"</code> and <code>"formatVersion": 1</code>. It can restore notes, goals, history, settings, and other library records.</p>
    <p><strong>Book catalog:</strong> an object with a <code>books</code> array of titles and authors, with optional catalog notes and image references. It adds books, not reading history. An unknown author can be <code>null</code>. You will review import choices before anything is saved.</p>
    <p className="small-print">A catalog is not a complete backup. No catalog lookup or model download starts when you choose a file. Unknown fields and unsupported versions are rejected rather than silently discarded.</p>
    <div className="import-format-links">
      <a href={`${base}index.html`} target="_blank" rel="noopener noreferrer">Read the full import format guide</a>
      <a href={`${base}catalog.example.json`} download>Download catalog example</a>
      <a href={`${base}catalog.schema.json`} download>Download catalog JSON Schema</a>
      <a href={`${base}backup.example.json`} download>Download generated backup example</a>
      <a href={`${base}backup.schema.json`} download>Download backup JSON Schema</a>
    </div>
    <details>
      <summary>Copy a small catalog example</summary>
      <p className="small-print">These two books are invented. Replace them with your own entries. Use double quotes, no comments, and no trailing commas.</p>
      <pre className="json-example"><code>{CATALOG_EXAMPLE_JSON}</code></pre>
      <button type="button" className="text-button" onClick={async () => {
        try {
          await navigator.clipboard.writeText(CATALOG_EXAMPLE_JSON);
          setCopyNotice('Example JSON copied.');
        } catch { setCopyNotice('Select the example text and copy it.'); }
      }}>Copy example JSON</button>
      {copyNotice && <p role="status" className="small-print">{copyNotice}</p>}
    </details>
  </div>;
}

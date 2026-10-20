import { useState } from 'react';
import { ClassificationImportDialog } from './ClassificationImportDialog';

/** Assets page section: where sector, country and asset class can be corrected in bulk. Single securities are edited on their own page. */
export function ClassificationSection() {
  const [open, setOpen] = useState(false);
  return (
    <section aria-labelledby="classification-title" className="mb-10">
      <h2 id="classification-title" className="mb-1 text-lg font-semibold">
        Asset classification
      </h2>
      <p className="muted mb-4 max-w-prose text-sm">
        The allocation by asset class, sector and country follows the data of the market-data providers, which can be wrong or missing. Your own classification always wins: import your Snowball Holdings
        export here, or edit a single security on its page.
      </p>
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        Import classification from Snowball
      </button>
      {open && <ClassificationImportDialog onClose={() => setOpen(false)} />}
    </section>
  );
}

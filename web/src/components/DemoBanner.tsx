import { useState } from 'react';
import { REAL_APP_URL } from '../config';
import { Dialog } from './Dialog';

const INFRA_README_URL = 'https://github.com/quan240594/portfolio-tracker/blob/main/infra/terraform/README.md';

const SWITCH_CLASS =
  'inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg bg-amber-900 px-3 py-1 text-center text-xs leading-tight font-semibold text-amber-50 hover:bg-amber-800 focus-visible:outline-amber-950 sm:min-h-0 sm:px-4 sm:py-1.5 sm:text-sm dark:bg-amber-100 dark:text-amber-950 dark:hover:bg-white dark:focus-visible:outline-amber-100';

const LINK_CLASS = 'underline hover:text-brand-600 dark:hover:text-brand-400';

function SwitchDialog({ open, onClose }: Readonly<{ open: boolean; onClose: () => void }>) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Switch to real data"
      description="This demo runs on sample data in your browser only. Real Trading 212 data lives in your own deployment of this app."
    >
      <div className="space-y-4 text-sm">
        <p>
          The deployed app runs on AWS. You sign in with an authenticator app, then connect a read-only Trading 212 API key under
          Brokers. The first sync takes about 8 minutes because of Trading 212 rate limits.
        </p>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            Deploy your own copy: follow the{' '}
            <a href={INFRA_README_URL} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
              deployment guide
            </a>
            <span>.</span>
          </li>
          <li>
            Set the repository variable <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">REAL_APP_URL</code> to your
            deployed web address and re-run the Pages workflow, so this button links there. Or just open the deployed address.
          </li>
          <li>Sign in, open Brokers and connect Trading 212.</li>
        </ol>
        <p className="font-medium">Your Trading 212 key never goes through this demo site.</p>
      </div>
    </Dialog>
  );
}

/** Always shown in mock mode (e.g. the GitHub Pages demo); intentionally not dismissable. */
export function DemoBanner({ realAppUrl = REAL_APP_URL }: Readonly<{ realAppUrl?: string }>) {
  const [open, setOpen] = useState(false);
  return (
    <aside
      aria-label="Demo mode"
      className="sticky top-0 z-30 border-b border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950 dark:text-amber-100 sm:static"
    >
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-1.5 text-xs sm:gap-4 sm:px-6 sm:py-2 sm:text-sm">
        <p className="min-w-0 flex-1">
          <strong className="font-semibold">Demo mode</strong> — sample data, nothing is saved. Changes reset when you reload.
        </p>
        {realAppUrl ? (
          <a href={realAppUrl} rel="noopener" className={SWITCH_CLASS}>
            Switch to real data
          </a>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className={SWITCH_CLASS}>
            Switch to real data
          </button>
        )}
      </div>
      {!realAppUrl && <SwitchDialog open={open} onClose={() => setOpen(false)} />}
    </aside>
  );
}

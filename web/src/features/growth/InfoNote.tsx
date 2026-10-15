import type { ReactNode } from 'react';

/** Collapsible "how is this calculated" note below a card's content. */
export function InfoNote({ summary = 'How is this calculated?', children }: Readonly<{ summary?: string; children: ReactNode }>) {
  return (
    <details className="muted mt-4 text-xs">
      <summary className="cursor-pointer font-medium select-none">{summary}</summary>
      <div className="mt-2 max-w-prose space-y-1.5">{children}</div>
    </details>
  );
}

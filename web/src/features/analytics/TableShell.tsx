import type { ReactNode } from 'react';

export interface Column {
  label: string;
  align?: 'left' | 'right';
}

/** Responsive table wrapper with a screen-reader caption and the app's header styling. */
export function TableShell({ caption, columns, children }: Readonly<{ caption: string; columns: readonly Column[]; children: ReactNode }>) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="muted border-b border-slate-200 text-left text-xs dark:border-slate-800">
            {columns.map((c) => (
              <th key={c.label} scope="col" className={`py-2 pr-3 font-medium last:pr-0 ${c.align === 'right' ? 'text-right' : ''}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export const rowClass = 'border-b border-slate-100 last:border-0 dark:border-slate-800/60';
export const numCell = 'py-2 pr-3 text-right tabular-nums last:pr-0';

/** Panel heading with an optional control area on the right. */
export function PanelHeader({ id, title, description, controls }: Readonly<{ id: string; title: string; description?: string; controls?: ReactNode }>) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id={id} className="font-semibold">
          {title}
        </h2>
        {description && <p className="muted mt-0.5 max-w-prose text-xs">{description}</p>}
      </div>
      {controls && <div className="flex flex-wrap items-center gap-2">{controls}</div>}
    </div>
  );
}

import type { ReactNode } from 'react';

export function EmptyState({ title, description, actions }: Readonly<{ title: string; description?: string; actions?: ReactNode }>) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center dark:border-slate-700">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-10 w-10 text-brand-500" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 3v18h18" strokeLinecap="round" />
        <path d="M7 15l4-4 3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="muted max-w-md text-sm">{description}</p>}
      {actions && <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div>}
    </div>
  );
}

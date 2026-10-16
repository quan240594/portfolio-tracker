import { useState, type FormEvent } from 'react';
import { isCashSymbol, isCustomSymbol, type Category, type CategoryAssignment, type Holding } from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { useCategoryMutations } from '../../api/management-hooks';
import { Dialog } from '../../components/Dialog';
import { numberToInput, parseNumber } from '../management/form';

interface Props {
  portfolioId: string;
  /** Category being edited; `null` creates a new one. */
  category: Category | null;
  categories: readonly Category[];
  assignments: readonly CategoryAssignment[];
  holdings: readonly Holding[];
  onClose: () => void;
}

const DEFAULT_COLORS = ['#6366f1', '#14b8a6', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#84cc16', '#f97316'];

const holdingLabel = (h: Holding) => (isCashSymbol(h.symbol) || isCustomSymbol(h.symbol) ? h.name : `${h.symbol} · ${h.name}`);

/** Create/edit a category: name, colour, target weight and the holdings that belong to it. */
export function CategoryDialog({ portfolioId, category, categories, assignments, holdings, onClose }: Readonly<Props>) {
  const m = useCategoryMutations(portfolioId);
  const [name, setName] = useState(category?.name ?? '');
  const [color, setColor] = useState(category?.color ?? DEFAULT_COLORS[categories.length % DEFAULT_COLORS.length]!);
  const [target, setTarget] = useState(numberToInput(category?.targetWeight));
  const [symbols, setSymbols] = useState<Set<string>>(
    () => new Set(assignments.filter((a) => a.categoryId === category?.categoryId).map((a) => a.symbol)),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const otherCategory = (symbol: string) => {
    const a = assignments.find((x) => x.symbol === symbol && x.categoryId !== category?.categoryId);
    return categories.find((c) => c.categoryId === a?.categoryId)?.name;
  };
  const toggle = (symbol: string) =>
    setSymbols((prev) => {
      const next = new Set(prev);
      if (!next.delete(symbol)) next.add(symbol);
      return next;
    });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const targetWeight = parseNumber(target);
    if (name.trim() === '') return setError('Name is required');
    if (targetWeight === undefined || targetWeight < 0 || targetWeight > 100) return setError('Target must be a number between 0 and 100');
    setError(null);
    setSaving(true);
    try {
      const body = { name: name.trim(), color, targetWeight };
      const saved = category
        ? await m.update.mutateAsync({ id: category.categoryId, body })
        : await m.create.mutateAsync(body);
      await m.assign.mutateAsync({ id: saved.categoryId, body: { symbols: [...symbols] } });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={category ? `Edit ${category.name}` : 'New category'} size="lg">
      <form onSubmit={(e) => void onSubmit(e)} noValidate aria-label="Category" className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="cat-name">Name</label>
            <input id="cat-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} data-autofocus />
          </div>
          <div>
            <label className="label" htmlFor="cat-target">Target weight (%)</label>
            <input id="cat-target" className="input" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="cat-color">Colour</label>
            <input id="cat-color" type="color" className="h-10 w-full cursor-pointer rounded-lg border border-slate-300 bg-white p-1 dark:border-slate-700 dark:bg-slate-950" value={color} onChange={(e) => setColor(e.target.value)} />
          </div>
        </div>
        <fieldset>
          <legend className="label">Holdings in this category</legend>
          <p className="muted mb-2 text-xs">A holding belongs to at most one category; ticking one moves it here.</p>
          <ul className="grid max-h-56 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
            {holdings.map((h) => {
              const elsewhere = otherCategory(h.symbol);
              return (
                <li key={h.symbol}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
                    <input type="checkbox" checked={symbols.has(h.symbol)} onChange={() => toggle(h.symbol)} />
                    <span className="min-w-0 break-words">{holdingLabel(h)}</span>
                    {elsewhere && <span className="muted ml-auto shrink-0 text-xs whitespace-nowrap">in {elsewhere}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save category'}</button>
        </div>
      </form>
    </Dialog>
  );
}

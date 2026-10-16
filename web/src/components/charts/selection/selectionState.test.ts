import { allHidden, pruneKeys, toggleKey } from './selectionState';

describe('selectionState', () => {
  it('toggles a key without mutating the old set', () => {
    const none: ReadonlySet<string> = new Set();
    const one = toggleKey(none, 'a');
    expect([...one]).toEqual(['a']);
    expect(none.size).toBe(0);
    expect(toggleKey(one, 'a').size).toBe(0);
  });

  it('prunes keys that are no longer valid and keeps the same set when nothing changes', () => {
    const hidden: ReadonlySet<string> = new Set(['a', 'b']);
    expect(pruneKeys(hidden, new Set(['a', 'b', 'c']))).toBe(hidden);
    expect([...pruneKeys(hidden, new Set(['b']))]).toEqual(['b']);
  });

  it('knows when every key is hidden (never for an empty list)', () => {
    expect(allHidden(['a', 'b'], new Set(['a', 'b']))).toBe(true);
    expect(allHidden(['a', 'b'], new Set(['a']))).toBe(false);
    expect(allHidden([], new Set(['a']))).toBe(false);
  });
});

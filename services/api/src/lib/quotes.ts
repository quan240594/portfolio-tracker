import type { Quote } from '@portfolio/shared';
import type { Repository } from '../repository.js';

/** The stored quotes of `symbols` in one batched read (none for no symbols). */
export function loadQuotes(repo: Pick<Repository, 'getQuotes'>, symbols: string[]): Promise<Record<string, Quote>> {
  return symbols.length > 0 ? repo.getQuotes(symbols) : Promise.resolve({});
}

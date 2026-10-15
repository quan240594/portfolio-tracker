import type { SyncResult } from './sync.js';

/** Human-readable summary: counts, symbols (with transaction counts) and skipped instruments. No amounts, no credentials. */
export function formatResult(result: SyncResult): string {
  const lines = [`Trading 212 sync${result.dryRun ? ' (dry run, nothing written)' : ''} -> ${result.status}`];
  if (result.error) lines.push(`  error: ${result.error}`);
  const { counts } = result;
  if (counts) {
    const cash = counts.cashMovements;
    lines.push(
      `  account currency: ${result.accountCurrency ?? 'unknown'}`,
      `  orders: ${counts.orders}, dividends: ${counts.dividends}, skipped: ${counts.skipped}`,
      `  ${result.dryRun ? 'would write' : 'written'}: ${counts.written} transaction(s)`,
      `  cash movements (not imported): deposits ${cash.deposits}, withdrawals ${cash.withdrawals}, fees ${cash.fees}, interest ${cash.interest}, other ${cash.other}`,
    );
  }
  const symbols = Object.entries(result.symbols).sort(([a], [b]) => a.localeCompare(b));
  const symbolList = symbols.map(([s, n]) => `${s}×${n}`).join(', ');
  if (symbols.length > 0) lines.push(`  symbols (${symbols.length}): ${symbolList}`);
  if (result.unmapped.length > 0) {
    lines.push(`  UNMAPPED / skipped (${result.unmapped.length}):`);
    for (const u of result.unmapped) lines.push(`    ${u.ticker} [${u.reason}] ×${u.count}`);
  }
  const rec = result.reconciliation;
  if (rec) {
    lines.push(`  positions reconciled: ${rec.matched} match, ${rec.mismatched.length} differ, ${rec.unmapped.length} not comparable (unmapped)`);
    for (const m of rec.mismatched) lines.push(`    ${m.symbol}: imported ${m.expected}, Trading 212 ${m.actual}`);
  }
  for (const w of result.warnings) lines.push(`  warning: ${w}`);
  return lines.join('\n');
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/** Public egress IPv4 of this machine (plain GET, no credentials attached), to show which IP an allowlist needs. */
export async function whoami(fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn('https://checkip.amazonaws.com', { signal: AbortSignal.timeout(10_000) });
  const ip = (await res.text()).trim();
  if (!res.ok || !IPV4.test(ip)) throw new Error('Could not determine the public IPv4 address');
  return ip;
}

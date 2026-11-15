import type { DividendOverviewHolding } from '@portfolio/shared';

type BasisFields = Pick<DividendOverviewHolding, 'basis' | 'paymentsPerYear'>;

const paymentsText = (n: number): string => `${n} payment${n === 1 ? '' : 's'} a year`;

/** One line on what a holding's forward income rests on; empty when there is nothing to say. */
export function basisNote({ basis, paymentsPerYear }: BasisFields): string {
  switch (basis) {
    case 'declared':
      return 'every payment of the next 12 months is announced';
    case 'provider-history':
      return `based on ${paymentsText(paymentsPerYear)} from provider history`;
    case 'own-payments':
      return `based on ${paymentsText(paymentsPerYear)} from your own payments`;
    case 'single-payment-assumed':
      return 'only 1 payment known: assumed once a year - may be too low';
    default:
      return '';
  }
}

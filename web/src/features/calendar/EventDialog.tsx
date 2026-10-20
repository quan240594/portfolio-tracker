import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEvent } from '@portfolio/shared';
import { CompanyLogo } from '../../components/CompanyLogo';
import { Dialog } from '../../components/Dialog';
import { formatDate, formatMoney, formatQuantity, formatWeekdayDate } from '../../lib/format';
import { EVENT_META, STATUS_LABELS, isDividend, sourceLabel } from './calendarModel';
import { EventMarker } from './EventMarker';
import { EventRow } from './EventList';
import { perShareLabel, TIME_OF_DAY_LABELS } from './eventText';

function Row({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <>
      <dt className="muted">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </>
  );
}

function DividendRows({ event, baseCurrency }: Readonly<{ event: CalendarEvent; baseCurrency: string }>) {
  const paid = event.status === 'PAID';
  return (
    <>
      <Row label="Ex-dividend date">{event.exDate ? formatDate(event.exDate) : 'Not available'}</Row>
      <Row label="Payment date">{event.payDate ? formatDate(event.payDate) : 'Not announced'}</Row>
      <Row label="Per share">{perShareLabel(event) ?? 'Not available'}</Row>
      {event.quantity !== undefined && <Row label={paid ? 'Shares paid on' : 'Your shares on the ex-date'}>{formatQuantity(event.quantity)}</Row>}
      {event.expectedAmount !== undefined && (
        <Row label={paid ? 'Received (net)' : 'Expected (net)'}>
          <span className="tabular-nums">{formatMoney(event.expectedAmount, baseCurrency)}</span>
        </Row>
      )}
      {event.quantity === undefined && <Row label="Your amount">Not held: on your watchlist only</Row>}
    </>
  );
}

function EarningsRows({ event }: Readonly<{ event: CalendarEvent }>) {
  return (
    <>
      <Row label="Fiscal period ending">{event.fiscalPeriodEnd ? formatDate(event.fiscalPeriodEnd) : 'Not available'}</Row>
      <Row label="EPS estimate">{event.epsEstimate === undefined ? 'Not available' : formatMoney(event.epsEstimate, event.currency ?? 'USD')}</Row>
      <Row label="Time of day">{TIME_OF_DAY_LABELS[event.timeOfDay ?? 'unknown']}</Row>
    </>
  );
}

function SplitRows({ event }: Readonly<{ event: CalendarEvent }>) {
  return (
    <>
      <Row label="Ratio">{event.description}</Row>
      <Row label="Effective">{formatDate(event.date)}</Row>
    </>
  );
}

function TypeRows({ event, baseCurrency }: Readonly<{ event: CalendarEvent; baseCurrency: string }>) {
  if (isDividend(event)) return <DividendRows event={event} baseCurrency={baseCurrency} />;
  if (event.type === 'EARNINGS') return <EarningsRows event={event} />;
  return <SplitRows event={event} />;
}

interface Props {
  event: CalendarEvent | null;
  baseCurrency: string;
  onClose: () => void;
  /** Adds the active portfolio scope to in-app links. */
  withScope: (to: string) => string;
}

/** Details of one event: dates, per-share amount, your quantity and amount, status and source. */
export function EventDialog({ event, baseCurrency, onClose, withScope }: Readonly<Props>) {
  if (!event) return null;
  const meta = EVENT_META[event.type];
  const held = event.origin === 'HOLDING';
  const link = held ? { to: withScope('/holdings'), label: 'View in holdings' } : { to: withScope('/watchlist'), label: 'View on watchlist' };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${event.symbol} · ${meta.label}`}
      description={formatWeekdayDate(event.date)}
      footer={
        <>
          <Link to={link.to} className="btn-secondary" onClick={onClose}>
            {link.label}
          </Link>
          <button type="button" className="btn-primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <CompanyLogo symbol={event.symbol} name={event.name} size={40} decorative badge={<EventMarker type={event.type} className="h-5 w-5" />} className="mr-1" />
        <p className="font-medium">{event.name}</p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        <Row label="Type">{meta.label}</Row>
        <Row label="Date">{formatDate(event.date)}</Row>
        <TypeRows event={event} baseCurrency={baseCurrency} />
        <Row label="Status">{STATUS_LABELS[event.status]}</Row>
        <Row label="Source">{sourceLabel(event.source)}</Row>
      </dl>
      {event.status === 'ESTIMATED' && <p className="muted mt-3 text-xs">This date is a projection and may change once the company announces it.</p>}
    </Dialog>
  );
}

interface DayProps {
  date: string | null;
  events: readonly CalendarEvent[];
  baseCurrency: string;
  onClose: () => void;
  onSelect: (event: CalendarEvent) => void;
}

/** Everything on one day, opened from a "+N more" button. */
export function DayDialog({ date, events, baseCurrency, onClose, onSelect }: Readonly<DayProps>) {
  if (!date) return null;
  return (
    <Dialog open onClose={onClose} title={formatWeekdayDate(date)} description={`${events.length} events`} footer={<button type="button" className="btn-primary" onClick={onClose}>Close</button>}>
      <ul className="space-y-1.5">
        {events.map((e) => (
          <EventRow key={e.id} event={e} baseCurrency={baseCurrency} onSelect={onSelect} />
        ))}
      </ul>
    </Dialog>
  );
}

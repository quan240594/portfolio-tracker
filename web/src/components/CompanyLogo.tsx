import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { API_BASE_URL, LOGOS_ENABLED } from '../config';

/** Whether logos are requested at all; the app uses the build default, tests switch it with the provider. */
const LogosEnabledContext = createContext<boolean>(LOGOS_ENABLED);
export const LogosEnabledProvider = LogosEnabledContext.Provider;

/**
 * Symbols whose logo request failed in this session (404 "no logo", 501/404 from a deployment without a logo route, a rate limit,
 * a network error): they show the monogram without asking again, so a list of rows never retries per row.
 */
const withoutLogo = new Set<string>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function markWithoutLogo(symbol: string): void {
  if (withoutLogo.has(symbol)) return;
  withoutLogo.add(symbol);
  for (const listener of listeners) listener();
}

/** Forgets what the session learnt (tests). */
export function resetLogoSession(): void {
  withoutLogo.clear();
  for (const listener of listeners) listener();
}

/** Same origin and authenticated like the rest of `/api`: the browser never contacts a logo service. */
export const logoUrl = (symbol: string): string => `${API_BASE_URL}/logos/${encodeURIComponent(symbol)}`;

/** The first letters of the symbol (`SAP.DE` -> `SA`), the neutral stand-in of a logo. */
export function monogramOf(symbol: string): string {
  return Array.from(symbol.replaceAll(/[^\p{L}\p{N}]/gu, '').toUpperCase()).slice(0, 2).join('') || '?';
}

interface Props {
  symbol: string;
  /** The company name, used as the alternative text when the name is not written next to the logo. */
  name?: string;
  /** Edge in pixels (the logo is always square). */
  size?: number;
  /** The name or symbol is written next to the logo: the logo is then pure decoration (empty alt text). */
  decorative?: boolean;
  /** A small marker at the bottom right corner (the event type in the calendar). Decorative: say what it means in text next to it. */
  badge?: ReactNode;
  /** Replaces the neutral monogram (a screen with its own stand-in of the same size, such as the asset header). */
  fallback?: ReactNode;
  className?: string;
}

const DEFAULT_SIZE = 24;

/**
 * The logo of a security: the image from our own server, in a rounded light container (so dark or transparent logos stay legible
 * in both themes), or a neutral monogram of the same shape when logos are off (demo), no logo exists or the image fails. The box has
 * a fixed size, so nothing moves when the image arrives.
 */
export function CompanyLogo({ symbol, name, size = DEFAULT_SIZE, decorative = false, badge, fallback, className = '' }: Readonly<Props>) {
  const enabled = useContext(LogosEnabledContext);
  const missing = useSyncExternalStore(
    subscribe,
    () => withoutLogo.has(symbol),
    () => false,
  );
  const label = name ?? symbol;
  const showImage = enabled && !missing;
  return (
    <span className={`relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }} data-logo={showImage ? 'image' : 'monogram'}>
      {showImage ? (
        <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-md bg-white ring-1 ring-slate-300 dark:ring-slate-500">
          <img
            src={logoUrl(symbol)}
            alt={decorative ? '' : label}
            width={size}
            height={size}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="h-full w-full object-contain p-0.5"
            onError={() => markWithoutLogo(symbol)}
          />
        </span>
      ) : (
        (fallback ?? (
          <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-md bg-slate-200 font-bold text-slate-700 dark:bg-slate-700 dark:text-slate-100" style={{ fontSize: Math.max(8, Math.round(size * 0.4)) }}>
            {/* Drawn by CSS from the attribute, so copying the page or reading its text never picks the letters up as content. */}
            <span aria-hidden="true" data-monogram={monogramOf(symbol)} className="before:content-[attr(data-monogram)]" />
            {!decorative && <span className="sr-only">{label}</span>}
          </span>
        ))
      )}
      {badge !== undefined && (
        <span aria-hidden="true" className="absolute -right-1 -bottom-1 flex rounded-full bg-white ring-2 ring-white dark:bg-slate-900 dark:ring-slate-900">
          {badge}
        </span>
      )}
    </span>
  );
}

/**
 * MSW handler of `GET /logos/{symbol}`. The demo never reaches it (logos are off in mock mode, see `LOGOS_ENABLED`); it exists for the
 * Playwright run that starts the mock app with `VITE_LOGOS=on` to check the image path. A few symbols have a drawn stand-in (no real
 * company logo ships in the repository), every other one answers 404 like a symbol nobody has a logo for.
 */
import { http, HttpResponse, type HttpHandler } from 'msw';
import { api, errorResponse } from './utils';

export const DEMO_LOGO_SYMBOLS: readonly string[] = ['AAPL', 'KO'];

const demoLogo = (symbol: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="28" fill="#0f766e"/><text x="32" y="42" text-anchor="middle" font-family="sans-serif" font-size="28" font-weight="700" fill="#fff">${symbol.slice(0, 1)}</text></svg>`;

export const logoHandlers: HttpHandler[] = [
  http.get(api('/logos/:symbol'), ({ params }) => {
    const symbol = decodeURIComponent(String(params.symbol)).toUpperCase();
    if (!DEMO_LOGO_SYMBOLS.includes(symbol)) return errorResponse(404, 'NOT_FOUND', 'No logo for this symbol');
    return new HttpResponse(demoLogo(symbol), { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'private, max-age=86400' } });
  }),
];

import { apiUrl } from '../api/client';

describe('mock logo API (only reached when VITE_LOGOS=on)', () => {
  it('draws a stand-in for a few demo symbols', async () => {
    const response = await fetch(apiUrl('/logos/AAPL'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(await response.text()).toContain('<svg');
    expect((await fetch(apiUrl('/logos/ko'))).status).toBe(200);
  });

  it('answers 404 for every other symbol, like a symbol nobody has a logo for', async () => {
    const response = await fetch(apiUrl('/logos/MSFT'));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'No logo for this symbol' } });
  });
});

import { REAL_APP_URL, parseRealAppUrl, routerBasename } from './config';

describe('routerBasename', () => {
  it('strips the trailing slash of a sub-path base', () => {
    expect(routerBasename('/portfolio-tracker/')).toBe('/portfolio-tracker');
    expect(routerBasename('/a/b//')).toBe('/a/b');
    expect(routerBasename('/no-slash')).toBe('/no-slash');
  });

  it('returns undefined for the root or a relative base', () => {
    expect(routerBasename('/')).toBeUndefined();
    expect(routerBasename('')).toBeUndefined();
    expect(routerBasename('./')).toBeUndefined();
  });

  it("defaults to Vite's BASE_URL", () => {
    expect(import.meta.env.BASE_URL).toBe('/');
    expect(routerBasename()).toBeUndefined();
  });
});

describe('parseRealAppUrl', () => {
  it('accepts https URLs and normalises them', () => {
    expect(parseRealAppUrl('https://d111.cloudfront.net')).toBe('https://d111.cloudfront.net/');
    expect(parseRealAppUrl('  https://app.example.com/portfolio?x=1  ')).toBe('https://app.example.com/portfolio?x=1');
  });

  it.each(['http://app.example.com', 'javascript:alert(1)', 'data:text/html,hi', 'ftp://x.example.com', '//app.example.com', 'not a url', 'https://', 'https://user:pw@app.example.com'])(
    'rejects %s',
    (value) => {
      expect(parseRealAppUrl(value)).toBeUndefined();
    },
  );

  it('treats empty and missing values as unset', () => {
    expect(parseRealAppUrl(undefined)).toBeUndefined();
    expect(parseRealAppUrl('')).toBeUndefined();
    expect(parseRealAppUrl('   ')).toBeUndefined();
  });

  it('is unset in the test build', () => {
    expect(REAL_APP_URL).toBeUndefined();
  });
});

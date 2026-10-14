import { routerBasename } from './config';

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

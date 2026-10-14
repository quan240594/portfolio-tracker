import { describe, expect, it } from 'vitest';
import { parseAuthMode } from './auth.js';

describe('parseAuthMode', () => {
  it('fails closed to cognito when unset or blank', () => {
    expect(parseAuthMode(undefined)).toBe('cognito');
    expect(parseAuthMode('')).toBe('cognito');
    expect(parseAuthMode('   ')).toBe('cognito');
  });

  it('accepts the known modes case-insensitively', () => {
    expect(parseAuthMode('cognito')).toBe('cognito');
    expect(parseAuthMode(' Demo ')).toBe('demo');
  });

  it('rejects unknown values instead of guessing', () => {
    expect(() => parseAuthMode('none')).toThrow(/Invalid AUTH_MODE "none"/);
  });
});

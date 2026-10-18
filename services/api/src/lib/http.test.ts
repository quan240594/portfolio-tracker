import { describe, expect, it } from 'vitest';
import { errorBody, HttpError, ok, parseJsonBody, toResponse, validate } from './http.js';

describe('HttpError', () => {
  it('carries status, code and details', () => {
    const err = new HttpError(418, 'TEAPOT', 'short and stout', { spout: true });
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: 'HttpError', statusCode: 418, code: 'TEAPOT', message: 'short and stout', details: { spout: true } });
  });
});

describe('ok / errorBody', () => {
  it('defaults to 200 and allows overriding the status', () => {
    expect(ok({ a: 1 })).toEqual({ statusCode: 200, body: { a: 1 } });
    expect(ok(undefined, 204)).toEqual({ statusCode: 204, body: undefined });
  });

  it('omits details when not provided', () => {
    expect(errorBody('X', 'msg')).toEqual({ error: { code: 'X', message: 'msg' } });
    expect(errorBody('X', 'msg', [1])).toEqual({ error: { code: 'X', message: 'msg', details: [1] } });
  });
});

describe('toResponse', () => {
  it('serialises the body as JSON and sets CORS/caching headers', () => {
    expect(toResponse({ statusCode: 201, body: { id: 'a' } }, 'https://app.example')).toEqual({
      status: 201,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': 'https://app.example',
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization',
        'access-control-expose-headers': 'content-disposition',
        'cache-control': 'no-store',
      },
      body: '{"id":"a"}',
    });
  });

  it('returns an empty string body when there is no body', () => {
    expect(toResponse({ statusCode: 204, body: undefined }, '*').body).toBe('');
  });

  it('serialises falsy but defined bodies', () => {
    expect(toResponse({ statusCode: 200, body: null }, '*').body).toBe('null');
    expect(toResponse({ statusCode: 200, body: 0 }, '*').body).toBe('0');
  });
});

describe('validate', () => {
  it('returns parsed data on success', () => {
    expect(validate({ success: true, data: { x: 1 } })).toEqual({ x: 1 });
  });

  it('throws a 400 VALIDATION_ERROR carrying the issues', () => {
    const issues = [{ path: ['x'], message: 'bad' }];
    const run = () => validate({ success: false, error: { issues } });
    expect(run).toThrow(HttpError);
    expect(run).toThrow('Invalid request');
    try {
      validate({ success: false, error: { issues } }, 'Custom message');
    } catch (err) {
      expect(err).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR', message: 'Custom message', details: issues });
    }
    expect.assertions(3);
  });
});

describe('parseJsonBody', () => {
  it('requires a body', () => {
    for (const body of [undefined, '']) {
      expect(() => parseJsonBody(body)).toThrow(expect.objectContaining({ statusCode: 400, message: 'Request body is required' }));
    }
  });

  it('parses plain JSON', () => {
    expect(parseJsonBody('{"a":[1,2]}')).toEqual({ a: [1, 2] });
  });

  it('rejects malformed JSON with a 400', () => {
    expect(() => parseJsonBody('{nope')).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }),
    );
  });
});

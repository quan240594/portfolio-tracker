import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { apiGatewayIdentity, toApiGatewayResult, toPortableRequest } from './api-gateway.js';

const event = (overrides: Partial<APIGatewayProxyEventV2> = {}, claims?: Record<string, unknown>): APIGatewayProxyEventV2 =>
  ({
    version: '2.0',
    rawPath: '/portfolios/p1',
    headers: { 'content-type': 'application/json' },
    queryStringParameters: { a: '1' },
    isBase64Encoded: false,
    requestContext: { requestId: 'req-1', http: { method: 'post', path: '/portfolios/p1' }, ...(claims ? { authorizer: { jwt: { claims } } } : {}) },
    ...overrides,
  }) as unknown as APIGatewayProxyEventV2;

describe('toPortableRequest', () => {
  it('maps method, path, query, headers, body, identity and request id', () => {
    expect(toPortableRequest(event({ body: '{"a":1}' }, { sub: 'user-1' }))).toEqual({
      method: 'POST',
      path: '/portfolios/p1',
      query: { a: '1' },
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
      identity: { subject: 'user-1' },
      requestId: 'req-1',
    });
  });

  it('decodes a base64 body and prefers the Lambda request id', () => {
    const req = toPortableRequest(event({ body: Buffer.from('héllo').toString('base64'), isBase64Encoded: true }), 'lambda-id');
    expect(req.body).toBe('héllo');
    expect(req.requestId).toBe('lambda-id');
  });

  it('copes with a request without body, query, headers or identity', () => {
    const req = toPortableRequest(event({ queryStringParameters: undefined, headers: undefined as never }));
    expect(req).toEqual({ method: 'POST', path: '/portfolios/p1', query: {}, headers: {}, requestId: 'req-1' });
  });

  it('keeps an empty base64 body empty', () => {
    expect(toPortableRequest(event({ body: '', isBase64Encoded: true })).body).toBe('');
  });
});

describe('apiGatewayIdentity', () => {
  it('only accepts a non-empty string sub claim', () => {
    expect(apiGatewayIdentity.identify(event({}, { sub: 'abc' }))).toEqual({ subject: 'abc' });
    expect(apiGatewayIdentity.identify(event({}, { sub: '' }))).toBeUndefined();
    expect(apiGatewayIdentity.identify(event({}, { sub: 42 }))).toBeUndefined();
    expect(apiGatewayIdentity.identify(event({}, {}))).toBeUndefined();
    expect(apiGatewayIdentity.identify(event())).toBeUndefined();
  });
});

describe('toApiGatewayResult', () => {
  it('maps the portable response', () => {
    expect(toApiGatewayResult({ status: 201, headers: { a: 'b' }, body: 'x' })).toEqual({ statusCode: 201, headers: { a: 'b' }, body: 'x' });
  });

  it('maps several Set-Cookie values to the HTTP API cookies array', () => {
    expect(toApiGatewayResult({ status: 302, headers: {}, body: '', cookies: ['a=1; Path=/', 'b=2; Path=/'] }).cookies).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(toApiGatewayResult({ status: 200, headers: {}, body: '', cookies: [] })).not.toHaveProperty('cookies');
  });
});

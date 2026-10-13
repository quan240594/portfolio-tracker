import { describe, expect, it } from 'vitest';
import { extractS3Objects } from './messages.js';
import { eventBridgeBody, s3NotificationBody } from './testing/fakes.js';

describe('extractS3Objects', () => {
  it('reads EventBridge Object Created events', () => {
    expect(extractS3Objects(eventBridgeBody('b', 'imports/u/i.csv'))).toEqual([{ bucket: 'b', key: 'imports/u/i.csv' }]);
  });

  it('reads S3 notifications and keeps keys decodable (+ means space)', () => {
    expect(extractS3Objects(s3NotificationBody('b', 'imports/u/my+file%2B1.csv'))).toEqual([{ bucket: 'b', key: 'imports/u/my%20file%2B1.csv' }]);
  });

  it('ignores S3 test events, non-create events and garbage', () => {
    expect(extractS3Objects(JSON.stringify({ Service: 'Amazon S3', Event: 's3:TestEvent' }))).toEqual([]);
    expect(extractS3Objects(JSON.stringify({ Records: [{ eventName: 'ObjectRemoved:Delete', s3: { bucket: { name: 'b' }, object: { key: 'k' } } }] }))).toEqual([]);
    expect(extractS3Objects('not json')).toEqual([]);
    expect(extractS3Objects(JSON.stringify({ 'detail-type': 'Object Deleted', detail: { bucket: { name: 'b' }, object: { key: 'k' } } }))).toEqual([]);
  });

  it('accepts EventBridge-shaped messages without a detail-type', () => {
    expect(extractS3Objects(JSON.stringify({ detail: { bucket: { name: 'b' }, object: { key: 'k' } } }))).toEqual([{ bucket: 'b', key: 'k' }]);
  });

  it('ignores EventBridge events whose bucket name or key is not a string', () => {
    expect(extractS3Objects(JSON.stringify({ 'detail-type': 'Object Created', detail: { bucket: { name: 1 }, object: { key: 'k' } } }))).toEqual([]);
    expect(extractS3Objects(JSON.stringify({ 'detail-type': 'Object Created', detail: { bucket: { name: 'b' }, object: {} } }))).toEqual([]);
  });

  it('ignores JSON bodies that are not objects', () => {
    for (const body of ['null', '42', '"text"', '[1,2]']) expect(extractS3Objects(body)).toEqual([]);
  });

  it('returns every created object of a multi-record S3 notification and skips malformed records', () => {
    const body = JSON.stringify({
      Records: [
        null,
        'x',
        { eventName: 'ObjectCreated:Put' },
        { eventName: 'ObjectCreated:Put', s3: { bucket: 'b', object: { key: 'k' } } },
        { eventName: 'ObjectCreated:Put', s3: { bucket: { name: 'b' }, object: { key: 7 } } },
        { eventName: 'ObjectCreated:CompleteMultipartUpload', s3: { bucket: { name: 'b' }, object: { key: 'imports/u/a+b.csv' } } },
        { s3: { bucket: { name: 'b2' }, object: { key: 'imports/u/c.csv' } } },
      ],
    });
    expect(extractS3Objects(body)).toEqual([
      { bucket: 'b', key: 'imports/u/a%20b.csv' },
      { bucket: 'b2', key: 'imports/u/c.csv' },
    ]);
  });

  it('ignores objects that match neither shape', () => {
    expect(extractS3Objects(JSON.stringify({ detail: { bucket: { name: 'b' } } }))).toEqual([]);
    expect(extractS3Objects(JSON.stringify({ Records: 'nope' }))).toEqual([]);
  });
});


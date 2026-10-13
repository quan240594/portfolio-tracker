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
});

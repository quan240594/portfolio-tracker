export interface S3ObjectRef {
  bucket: string;
  /** Key as delivered (may be URL-encoded); `parseImportObjectKey` decodes it. */
  key: string;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null;

/**
 * Extracts S3 object references from an SQS message body. Supports:
 *  - EventBridge "Object Created" events (AWS): `{ "detail-type": "Object Created", detail: { bucket: { name }, object: { key } } }`
 *  - S3 event notifications (LocalStack): `{ Records: [{ eventName: "ObjectCreated:Put", s3: { bucket: { name }, object: { key } } }] }`
 *    whose keys are URL-encoded with `+` for spaces.
 * Anything else (e.g. `s3:TestEvent`) yields an empty list.
 */
export function extractS3Objects(body: string): S3ObjectRef[] {
  let msg: unknown;
  try {
    msg = JSON.parse(body);
  } catch {
    return [];
  }
  if (!isObj(msg)) return [];

  const detail = msg.detail;
  if (isObj(detail) && isObj(detail.bucket) && isObj(detail.object)) {
    const detailType = msg['detail-type'];
    if (detailType !== undefined && detailType !== 'Object Created') return [];
    const { name } = detail.bucket;
    const { key } = detail.object;
    return typeof name === 'string' && typeof key === 'string' ? [{ bucket: name, key }] : [];
  }

  if (Array.isArray(msg.Records)) {
    const out: S3ObjectRef[] = [];
    for (const r of msg.Records as unknown[]) {
      if (!isObj(r) || !isObj(r.s3) || !isObj(r.s3.bucket) || !isObj(r.s3.object)) continue;
      if (typeof r.eventName === 'string' && !r.eventName.startsWith('ObjectCreated')) continue;
      const { name } = r.s3.bucket;
      const { key } = r.s3.object;
      if (typeof name === 'string' && typeof key === 'string') out.push({ bucket: name, key: key.replace(/\+/g, '%20') });
    }
    return out;
  }
  return [];
}

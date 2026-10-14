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
    return fromEventBridge(msg, detail.bucket, detail.object);
  }
  if (Array.isArray(msg.Records)) return (msg.Records as unknown[]).flatMap(fromS3Record);
  return [];
}

function fromEventBridge(msg: Json, bucket: Json, object: Json): S3ObjectRef[] {
  const detailType = msg['detail-type'];
  if (detailType !== undefined && detailType !== 'Object Created') return [];
  const { name } = bucket;
  const { key } = object;
  return typeof name === 'string' && typeof key === 'string' ? [{ bucket: name, key }] : [];
}

function fromS3Record(r: unknown): S3ObjectRef[] {
  if (!isObj(r) || !isObj(r.s3) || !isObj(r.s3.bucket) || !isObj(r.s3.object)) return [];
  if (typeof r.eventName === 'string' && !r.eventName.startsWith('ObjectCreated')) return [];
  const { name } = r.s3.bucket;
  const { key } = r.s3.object;
  return typeof name === 'string' && typeof key === 'string' ? [{ bucket: name, key: key.replaceAll('+', '%20') }] : [];
}

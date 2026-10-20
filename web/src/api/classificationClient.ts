import type { ClassificationFields, ClassificationImportRequest, ClassificationImportResponse, ClassificationInstrument, ClassificationListResponse } from '@portfolio/shared';
import { request } from './client';

const path = (symbol: string) => `/classification/${encodeURIComponent(symbol)}`;

export const classificationApi = {
  list: (signal?: AbortSignal) => request<ClassificationListResponse>('GET', '/classification', { signal }),
  put: (symbol: string, fields: ClassificationFields) => request<ClassificationInstrument>('PUT', path(symbol), { body: fields }),
  remove: (symbol: string) => request<void>('DELETE', path(symbol)),
  import: (body: ClassificationImportRequest) => request<ClassificationImportResponse>('POST', '/classification/import', { body }),
};

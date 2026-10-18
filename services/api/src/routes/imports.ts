import { createImportSchema, importObjectKey, type CreateImportResponse, type ImportStatus } from '@portfolio/shared';
import { HttpError, ok, parseJsonBody, validate, type RouteResult } from '../lib/http.js';
import type { RouteContext } from '../deps.js';
import { requirePortfolio } from './portfolios.js';

export const UPLOAD_URL_EXPIRES_SECONDS = 300;

export async function createImport(ctx: RouteContext): Promise<RouteResult> {
  const { fileName, portfolioId } = validate(
    createImportSchema.safeParse(parseJsonBody(ctx.body)),
    'Invalid import request',
  );
  const { repo, files, now, uuid } = ctx.deps;
  await requirePortfolio(ctx, portfolioId);
  const importId = uuid();
  const ts = now().toISOString();
  const status: ImportStatus = { importId, userId: ctx.userId, portfolioId, fileName, status: 'PENDING', createdAt: ts, updatedAt: ts };
  await repo.putImport(status);
  const { url: uploadUrl } = await files.createUpload({
    key: importObjectKey(ctx.userId, importId),
    contentType: 'text/csv',
    expiresInSeconds: UPLOAD_URL_EXPIRES_SECONDS,
  });
  return ok({ importId, uploadUrl, expiresInSeconds: UPLOAD_URL_EXPIRES_SECONDS } satisfies CreateImportResponse, 201);
}

export async function getImport(ctx: RouteContext): Promise<RouteResult> {
  const id = ctx.pathParams.id!;
  const status = await ctx.deps.repo.getImport(ctx.userId, id);
  if (!status) throw new HttpError(404, 'NOT_FOUND', `Import ${id} not found`);
  return ok(status);
}

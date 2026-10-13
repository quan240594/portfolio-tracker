import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createImportSchema, type ImportStatus } from '@portfolio/shared';
import { ApiError, api, errorMessage, uploadCsv } from '../../api/client';
import { invalidatePortfolioData } from '../../api/hooks';

export const MAX_CSV_BYTES = 1024 * 1024;

export type ImportState =
  | { phase: 'idle' }
  | { phase: 'uploading'; fileName: string }
  | { phase: 'processing'; fileName: string; importId: string; status?: ImportStatus['status'] }
  | { phase: 'completed'; result: ImportStatus }
  | { phase: 'failed'; result: ImportStatus }
  | { phase: 'error'; message: string };

export interface CsvImportOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST /imports → PUT file to presigned URL → poll GET /imports/{id} until COMPLETED/FAILED. */
export function useCsvImport({ pollIntervalMs = 1500, timeoutMs = 60_000 }: CsvImportOptions = {}) {
  const qc = useQueryClient();
  const [state, setState] = useState<ImportState>({ phase: 'idle' });
  const runId = useRef(0);

  useEffect(
    () => () => {
      runId.current += 1;
    },
    [],
  );

  const reset = useCallback(() => {
    runId.current += 1;
    setState({ phase: 'idle' });
  }, []);

  const start = useCallback(
    async (file: File) => {
      const id = ++runId.current;
      const alive = () => runId.current === id;

      const nameCheck = createImportSchema.safeParse({ fileName: file.name });
      if (!nameCheck.success) {
        setState({ phase: 'error', message: nameCheck.error.issues[0]?.message ?? 'Invalid file name' });
        return;
      }
      if (file.size > MAX_CSV_BYTES) {
        setState({ phase: 'error', message: 'The file is larger than 1 MB.' });
        return;
      }

      try {
        setState({ phase: 'uploading', fileName: file.name });
        const { importId, uploadUrl } = await api.createImport({ fileName: file.name });
        if (!alive()) return;
        await uploadCsv(uploadUrl, file);
        if (!alive()) return;
        setState({ phase: 'processing', fileName: file.name, importId });

        const deadline = Date.now() + timeoutMs;
        while (alive()) {
          await sleep(pollIntervalMs);
          if (!alive()) return;
          const status = await api.getImport(importId);
          if (!alive()) return;
          if (status.status === 'COMPLETED') {
            setState({ phase: 'completed', result: status });
            await invalidatePortfolioData(qc);
            return;
          }
          if (status.status === 'FAILED') {
            setState({ phase: 'failed', result: status });
            return;
          }
          if (Date.now() >= deadline) {
            setState({
              phase: 'error',
              message: 'The import is taking longer than expected. It may still complete — check your transactions in a minute.',
            });
            return;
          }
          setState({ phase: 'processing', fileName: file.name, importId, status: status.status });
        }
      } catch (err) {
        if (alive()) setState({ phase: 'error', message: err instanceof ApiError ? err.message : errorMessage(err) });
      }
    },
    [pollIntervalMs, timeoutMs, qc],
  );

  return { state, start, reset };
}

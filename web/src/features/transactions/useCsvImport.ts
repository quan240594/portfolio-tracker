import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createImportSchema, type ImportStatus } from '@portfolio/shared';
import { ApiError, api, errorMessage, uploadCsv } from '../../api/client';
import { invalidatePortfolioData } from '../../api/hooks';
import { prepareImportFile, type PreparedCsv } from '../broker/trading212Csv';

export const MAX_CSV_BYTES = 1024 * 1024;

/** Present when the file was a Trading 212 export that was converted before the upload. */
export type Conversion = PreparedCsv['conversion'];

export type ImportState =
  | { phase: 'idle' }
  | { phase: 'uploading'; fileName: string }
  | { phase: 'processing'; fileName: string; importId: string; status?: ImportStatus['status'] }
  | { phase: 'completed'; result: ImportStatus; conversion?: Conversion }
  | { phase: 'failed'; result: ImportStatus; conversion?: Conversion }
  | { phase: 'error'; message: string };

export interface CsvImportOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fileError(file: File, portfolioId: string): string | undefined {
  const check = createImportSchema.safeParse({ fileName: file.name, portfolioId });
  if (!check.success) {
    const issue = check.error.issues[0];
    if (issue?.path[0] === 'portfolioId') return 'Choose a portfolio to import into.';
    return issue?.message ?? 'Invalid file name';
  }
  if (file.size > MAX_CSV_BYTES) return 'The file is larger than 1 MB.';
  return undefined;
}

interface PollContext extends Required<CsvImportOptions> {
  importId: string;
  portfolioId: string;
  fileName: string;
  alive: () => boolean;
  setState: (state: ImportState) => void;
  qc: QueryClient;
  conversion?: Conversion;
}

async function pollImport({ importId, portfolioId, fileName, alive, setState, qc, pollIntervalMs, timeoutMs, conversion }: PollContext): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (alive()) {
    await sleep(pollIntervalMs);
    if (!alive()) return;
    const status = await api.getImport(importId);
    if (!alive()) return;
    if (status.status === 'COMPLETED') {
      setState({ phase: 'completed', result: status, ...(conversion ? { conversion } : {}) });
      await invalidatePortfolioData(qc, portfolioId);
      return;
    }
    if (status.status === 'FAILED') {
      setState({ phase: 'failed', result: status, ...(conversion ? { conversion } : {}) });
      return;
    }
    if (Date.now() >= deadline) {
      setState({
        phase: 'error',
        message: 'The import is taking longer than expected. It may still complete — check your transactions in a minute.',
      });
      return;
    }
    setState({ phase: 'processing', fileName, importId, status: status.status });
  }
}

/** POST /imports (target portfolio) → PUT file to presigned URL → poll GET /imports/{id} until COMPLETED/FAILED. */
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
    async (file: File, portfolioId: string) => {
      const id = ++runId.current;
      const alive = () => runId.current === id;

      const invalid = fileError(file, portfolioId);
      if (invalid) {
        setState({ phase: 'error', message: invalid });
        return;
      }

      try {
        setState({ phase: 'uploading', fileName: file.name });
        const { file: prepared, conversion } = await prepareImportFile(file);
        if (!alive()) return;
        if (conversion && conversion.imported === 0) {
          setState({ phase: 'error', message: 'This Trading 212 export contains no trades or dividends that could be imported.' });
          return;
        }
        const { importId, uploadUrl } = await api.createImport({ fileName: file.name, portfolioId });
        if (!alive()) return;
        await uploadCsv(uploadUrl, prepared);
        if (!alive()) return;
        setState({ phase: 'processing', fileName: file.name, importId });

        await pollImport({ importId, portfolioId, fileName: file.name, alive, setState, qc, pollIntervalMs, timeoutMs, conversion });
      } catch (err) {
        if (alive()) setState({ phase: 'error', message: err instanceof ApiError ? err.message : errorMessage(err) });
      }
    },
    [pollIntervalMs, timeoutMs, qc],
  );

  return { state, start, reset };
}

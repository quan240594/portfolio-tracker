import { useCallback, useRef, useState } from 'react';
import type { ClassificationImportResponse, ClassificationRow, SnowballIssue } from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { useImportClassification } from '../../api/classificationHooks';
import { readSnowballFile } from './snowballCsv';

export interface LoadedImport {
  fileName: string;
  rows: ClassificationRow[];
  issues: SnowballIssue[];
  response: ClassificationImportResponse;
}

export type ImportStage =
  | { kind: 'idle' }
  | { kind: 'reading'; fileName: string }
  | { kind: 'error'; message: string }
  | { kind: 'preview'; loaded: LoadedImport; error?: string }
  | { kind: 'saving'; loaded: LoadedImport }
  | { kind: 'done'; loaded: LoadedImport };

/** Pick a file -> parse in the browser -> dry run (preview) -> confirm (stores). A newer pick makes an older, slower answer irrelevant. */
export function useClassificationImport() {
  const importer = useImportClassification();
  const [stage, setStage] = useState<ImportStage>({ kind: 'idle' });
  const latest = useRef(0);
  const { mutateAsync } = importer;

  const pick = useCallback(
    async (file: File) => {
      const mine = ++latest.current;
      const isCurrent = () => mine === latest.current;
      setStage({ kind: 'reading', fileName: file.name });
      const parsed = await readSnowballFile(file);
      if (!isCurrent()) return;
      if (!parsed.ok) {
        setStage({ kind: 'error', message: parsed.message });
        return;
      }
      try {
        const response = await mutateAsync({ dryRun: true, rows: parsed.rows });
        if (isCurrent()) setStage({ kind: 'preview', loaded: { fileName: file.name, rows: parsed.rows, issues: parsed.issues, response } });
      } catch (err) {
        if (isCurrent()) setStage({ kind: 'error', message: errorMessage(err) });
      }
    },
    [mutateAsync],
  );

  const confirm = useCallback(
    async (loaded: LoadedImport) => {
      setStage({ kind: 'saving', loaded });
      try {
        const response = await mutateAsync({ dryRun: false, rows: loaded.rows });
        setStage({ kind: 'done', loaded: { ...loaded, response } });
      } catch (err) {
        setStage({ kind: 'preview', loaded, error: errorMessage(err) });
      }
    },
    [mutateAsync],
  );

  return { stage, pick, confirm };
}

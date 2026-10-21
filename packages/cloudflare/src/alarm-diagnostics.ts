import { MeteredSql, type SqlStorageHost, type UsageOptions } from './sql.js';

/**
 * The alarm diagnostics log: two small ring buffers in the Durable Object's SQLite that answer "what did the alarm do?" without
 * access to the platform's logs. A run row is written when an alarm invocation starts and completed when it ends, so a row that
 * has a start but never a finish is the trace of an invocation the runtime cancelled or disconnected. Rows are pruned on insert
 * (ids only grow, so "older than the last N" is one range delete); the tables have no secondary index, a row written costs one.
 */
export const DIAGNOSTICS_SCHEMAS = [
  `CREATE TABLE IF NOT EXISTS alarm_runs (
    id INTEGER PRIMARY KEY,
    started_at INTEGER NOT NULL,
    retry_count INTEGER NOT NULL,
    is_retry INTEGER NOT NULL,
    scheduled_for INTEGER,
    trigger TEXT NOT NULL,
    finished_at INTEGER,
    duration_ms INTEGER,
    outcome TEXT,
    jobs TEXT,
    subrequests INTEGER,
    next_alarm_at INTEGER,
    error_class TEXT,
    error_message TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS alarm_arms (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    reason TEXT NOT NULL,
    alarm_at INTEGER NOT NULL,
    run_id INTEGER
  )`,
] as const;

/** Why the alarm was (re)armed. `rearm-after-run` is the normal end of a run; it is stored on the run row (`nextAlarmAt`), not as an arm row. */
export type ArmReason = 'start' | 'keep-alive' | 'job-enqueued' | 'rearm-after-run';

export type AlarmRunOutcome = 'completed' | 'deferred' | 'failed';
export type AlarmJobOutcome = 'done' | 'continued' | 'skipped' | 'retried' | 'failed';

export interface AlarmJobSummary {
  job: string;
  /** What the last step of the job did in this run. */
  outcome: AlarmJobOutcome;
  /** Handler invocations of the job in this run. */
  steps: number;
  /** Pause before the next step (continued) or the retry (retried); null otherwise. */
  delayMs: number | null;
}

export interface AlarmRunStart {
  retryCount: number;
  isRetry: boolean;
  /** The alarm time the platform fired for, when it says. */
  scheduledFor: number | null;
  /** What was due when the run began (schedule slots and job names; never payloads). */
  trigger: string;
}

export interface AlarmRunFinish {
  outcome: AlarmRunOutcome;
  jobs: readonly AlarmJobSummary[];
  subrequests: number;
  nextAlarmAt: number | null;
  /** Set when the run threw. The message is sanitised and shortened here. */
  error?: { name: string; message: string };
}

export interface AlarmRun {
  id: number;
  startedAt: number;
  retryCount: number;
  isRetry: boolean;
  scheduledFor: number | null;
  trigger: string;
  finishedAt: number | null;
  durationMs: number | null;
  outcome: AlarmRunOutcome | null;
  jobs: AlarmJobSummary[];
  subrequests: number | null;
  nextAlarmAt: number | null;
  error: { name: string; message: string } | null;
}

export interface AlarmArm {
  id: number;
  at: number;
  reason: ArmReason;
  alarmAt: number;
  runId: number | null;
}

export interface AlarmSummary {
  /** Start of the window the counts cover (epoch ms). */
  since: number;
  runs: number;
  completed: number;
  deferred: number;
  failed: number;
  /** Runs that started, never finished and are older than `UNFINISHED_AFTER_MS`: cancelled or disconnected invocations. */
  unfinished: number;
  /** Runs still within `UNFINISHED_AFTER_MS` of their start and not finished (normally the one in progress). */
  inProgress: number;
  /** Runs the platform retried after a thrown error (`isRetry`). */
  retries: number;
  maxRetryCount: number;
}

type RunRow = {
  id: number;
  started_at: number;
  retry_count: number;
  is_retry: number;
  scheduled_for: number | null;
  trigger: string;
  finished_at: number | null;
  duration_ms: number | null;
  outcome: string | null;
  jobs: string | null;
  subrequests: number | null;
  next_alarm_at: number | null;
  error_class: string | null;
  error_message: string | null;
};

type ArmRow = { id: number; at: number; reason: string; alarm_at: number; run_id: number | null };

export interface AlarmDiagnosticsOptions extends UsageOptions {
  now?: () => Date;
  /** Runs kept. Default 300. */
  keepRuns?: number;
  /** Arm rows kept. Default 300. */
  keepArms?: number;
}

export const DEFAULT_KEEP_RUNS = 300;
export const DEFAULT_KEEP_ARMS = 300;
/** A run that began longer ago than this and has no finish is reported as unfinished (the longest alarm is far shorter). */
export const UNFINISHED_AFTER_MS = 2 * 60_000;
export const SUMMARY_WINDOW_MS = 24 * 3_600_000;
export const MAX_DIAGNOSTIC_MESSAGE_CHARS = 200;
export const MAX_RUNS_PER_QUERY = 100;

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,59}$/;
const URL_PATTERN = /https?:\/\/\S+/gi;
const CREDENTIAL_PATTERN = /(?:token|key|secret|password|authorization)\s*[=:]\s*\S+/gi;
const BEARER_PATTERN = /\bbearer\s+\S+/gi;
const LONG_TOKEN_PATTERN = /[A-Za-z0-9_\-+/=.]{24,}/g;
const WHITESPACE_PATTERN = /\s+/g;

/**
 * An error message that is safe to keep: URLs (their query strings may carry keys), `key=value` credentials, bearer values and any
 * long token-like string are replaced, whitespace is collapsed and the result is cut to 200 characters. It is a safety net for
 * the generic error text of the runtime and the job handlers, which never put payloads in messages in the first place.
 */
export function sanitizeDiagnosticMessage(message: unknown): string {
  const text = typeof message === 'string' ? message : String(message);
  return text
    .replaceAll(URL_PATTERN, '<url>')
    .replaceAll(BEARER_PATTERN, '<redacted>')
    .replaceAll(CREDENTIAL_PATTERN, '<redacted>')
    .replaceAll(LONG_TOKEN_PATTERN, '<redacted>')
    .replaceAll(WHITESPACE_PATTERN, ' ')
    .trim()
    .slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS);
}

/** The error's class name when it is a plain identifier, else `Error`. */
export function diagnosticErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return NAME_PATTERN.test(name) ? name : 'Error';
}

/** `{ name, message }` of a thrown value, both safe to store and to show. */
export function describeDiagnosticError(error: unknown): { name: string; message: string } {
  return { name: diagnosticErrorName(error), message: sanitizeDiagnosticMessage(error instanceof Error ? error.message : error) };
}

const parseJobs = (text: string | null): AlarmJobSummary[] => {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as AlarmJobSummary[]) : [];
  } catch {
    return [];
  }
};

const toRun = (row: RunRow): AlarmRun => ({
  id: row.id,
  startedAt: row.started_at,
  retryCount: row.retry_count,
  isRetry: row.is_retry === 1,
  scheduledFor: row.scheduled_for,
  trigger: row.trigger,
  finishedAt: row.finished_at,
  durationMs: row.duration_ms,
  outcome: row.outcome as AlarmRunOutcome | null,
  jobs: parseJobs(row.jobs),
  subrequests: row.subrequests,
  nextAlarmAt: row.next_alarm_at,
  error: row.error_class === null ? null : { name: row.error_class, message: row.error_message ?? '' },
});

const toArm = (row: ArmRow): AlarmArm => ({ id: row.id, at: row.at, reason: row.reason as ArmReason, alarmAt: row.alarm_at, runId: row.run_id });

/**
 * The two ring buffers. Cost of one alarm run: the start row, its completion (an update) and the prune of the oldest row once the
 * buffer is full, that is 3 rows written; an alarm armed outside the normal end of a run adds 2 (the arm row and its prune). Reads
 * are by id (`ORDER BY id DESC LIMIT n`), the summary reads the whole 300-row buffer once.
 */
export class AlarmDiagnostics {
  private readonly db: MeteredSql;
  private readonly now: () => number;
  private readonly keepRuns: number;
  private readonly keepArms: number;

  constructor(storage: SqlStorageHost, options: AlarmDiagnosticsOptions = {}) {
    this.db = new MeteredSql(storage.sql, options.onUsage);
    const clock = options.now ?? (() => new Date());
    this.now = () => clock().getTime();
    this.keepRuns = Math.max(1, Math.floor(options.keepRuns ?? DEFAULT_KEEP_RUNS));
    this.keepArms = Math.max(1, Math.floor(options.keepArms ?? DEFAULT_KEEP_ARMS));
    for (const schema of DIAGNOSTICS_SCHEMAS) this.db.rows(schema);
  }

  /** Records the start of an alarm invocation and returns the id of its row. */
  begin(start: AlarmRunStart): number {
    const id = this.insert(
      'INSERT INTO alarm_runs (started_at, retry_count, is_retry, scheduled_for, trigger) VALUES (?, ?, ?, ?, ?) RETURNING id',
      this.now(),
      Math.max(0, Math.floor(start.retryCount)),
      start.isRetry ? 1 : 0,
      start.scheduledFor,
      sanitizeDiagnosticMessage(start.trigger),
    );
    this.db.rows('DELETE FROM alarm_runs WHERE id <= ?', id - this.keepRuns);
    return id;
  }

  /** Completes the row of a run. A row that never gets here is a run the runtime cut short. */
  finish(id: number, finish: AlarmRunFinish): void {
    const finishedAt = this.now();
    this.db.rows(
      'UPDATE alarm_runs SET finished_at = ?, duration_ms = ? - started_at, outcome = ?, jobs = ?, subrequests = ?, next_alarm_at = ?, error_class = ?, error_message = ? WHERE id = ?',
      finishedAt,
      finishedAt,
      finish.outcome,
      JSON.stringify(finish.jobs),
      finish.subrequests,
      finish.nextAlarmAt,
      finish.error?.name ?? null,
      finish.error ? sanitizeDiagnosticMessage(finish.error.message) : null,
      id,
    );
  }

  /** Records one `setAlarm` call (`runId` is the run that was executing at the time, if any). */
  recordArm(reason: ArmReason, alarmAt: number, runId: number | null): void {
    const id = this.insert('INSERT INTO alarm_arms (at, reason, alarm_at, run_id) VALUES (?, ?, ?, ?) RETURNING id', this.now(), reason, alarmAt, runId);
    this.db.rows('DELETE FROM alarm_arms WHERE id <= ?', id - this.keepArms);
  }

  /** The newest runs first (at most `MAX_RUNS_PER_QUERY`). */
  recentRuns(limit: number): AlarmRun[] {
    return this.db.rows<RunRow>('SELECT * FROM alarm_runs ORDER BY id DESC LIMIT ?', clampLimit(limit)).map((row) => toRun(row));
  }

  /** The newest arm records first (at most `MAX_RUNS_PER_QUERY`). */
  recentArms(limit: number): AlarmArm[] {
    return this.db.rows<ArmRow>('SELECT * FROM alarm_arms ORDER BY id DESC LIMIT ?', clampLimit(limit)).map((row) => toArm(row));
  }

  /** Counts of the runs of the last 24 hours (ids grow with time, so the buffer is read newest first and cut at the window). */
  summary(): AlarmSummary {
    const now = this.now();
    const since = now - SUMMARY_WINDOW_MS;
    const rows = this.db.rows<RunRow>('SELECT id, started_at, is_retry, retry_count, finished_at, outcome FROM alarm_runs WHERE started_at >= ?', since);
    return summarize(rows, since, now);
  }

  private insert(query: string, ...bindings: (string | number | null)[]): number {
    const row = this.db.first<{ id: number }>(query, ...bindings);
    if (!row) throw new Error('The diagnostics row could not be inserted');
    return row.id;
  }
}

const clampLimit = (limit: number): number => (Number.isFinite(limit) ? Math.min(MAX_RUNS_PER_QUERY, Math.max(1, Math.floor(limit))) : MAX_RUNS_PER_QUERY);

function summarize(rows: readonly Pick<RunRow, 'started_at' | 'is_retry' | 'retry_count' | 'finished_at' | 'outcome'>[], since: number, now: number): AlarmSummary {
  const summary: AlarmSummary = { since, runs: rows.length, completed: 0, deferred: 0, failed: 0, unfinished: 0, inProgress: 0, retries: 0, maxRetryCount: 0 };
  for (const row of rows) {
    if (row.is_retry === 1) summary.retries++;
    summary.maxRetryCount = Math.max(summary.maxRetryCount, row.retry_count);
    if (row.finished_at === null) {
      if (now - row.started_at > UNFINISHED_AFTER_MS) summary.unfinished++;
      else summary.inProgress++;
    } else if (row.outcome === 'completed' || row.outcome === 'deferred' || row.outcome === 'failed') {
      summary[row.outcome]++;
    }
  }
  return summary;
}

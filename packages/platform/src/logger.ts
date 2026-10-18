export type LogFields = Record<string, unknown>;

/** Structured logging port. Never log secrets, credentials or request bodies. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Adds keys to every following entry (e.g. the request id). */
  appendKeys(fields: LogFields): void;
  removeKeys(keys: readonly string[]): void;
  createChild(options?: { persistentKeys?: LogFields }): Logger;
}

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  appendKeys: () => undefined,
  removeKeys: () => undefined,
  createChild: () => silent,
};

/** A logger that drops everything. */
export const silentLogger: Logger = silent;

/** JSON lines on the console, for runtimes without a logging library. */
export function createConsoleLogger(base?: LogFields): Logger {
  const keys: LogFields = { ...base };
  const write = (level: string, message: string, fields?: LogFields) => {
    const entry = { level, message, ...keys, ...fields };
    console.log(JSON.stringify(entry, (_key, value: unknown) => (value instanceof Error ? { name: value.name, message: value.message } : value)));
  };
  return {
    debug: (message, fields) => write('DEBUG', message, fields),
    info: (message, fields) => write('INFO', message, fields),
    warn: (message, fields) => write('WARN', message, fields),
    error: (message, fields) => write('ERROR', message, fields),
    appendKeys: (fields) => {
      Object.assign(keys, fields);
    },
    removeKeys: (names) => {
      for (const name of names) delete keys[name];
    },
    createChild: (options) => createConsoleLogger({ ...keys, ...options?.persistentKeys }),
  };
}

let active: Logger = silent;

/** Installs the logger of the running platform (call once at start-up). Until then the application logs nowhere. */
export function setLogger(logger: Logger): void {
  active = logger;
}

/** The application-wide logger: a stable facade over whatever `setLogger` installed. */
export const logger: Logger = {
  debug: (message, fields) => active.debug(message, fields),
  info: (message, fields) => active.info(message, fields),
  warn: (message, fields) => active.warn(message, fields),
  error: (message, fields) => active.error(message, fields),
  appendKeys: (fields) => active.appendKeys(fields),
  removeKeys: (keys) => active.removeKeys(keys),
  createChild: (options) => active.createChild(options),
};

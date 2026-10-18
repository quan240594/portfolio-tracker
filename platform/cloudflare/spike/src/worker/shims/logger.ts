/** Workers stand-in for services/api/src/lib/logger.ts (which wraps @aws-lambda-powertools/logger). */
const noop = () => undefined;
const log = {
  info: noop,
  warn: (msg: string, extra?: unknown) => console.warn(msg, extra),
  error: (msg: string, extra?: unknown) => console.error(msg, extra),
  appendKeys: noop,
  removeKeys: noop,
  createChild: () => log,
};
export const logger = log;

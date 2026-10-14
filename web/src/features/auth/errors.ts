const MESSAGES: Record<string, string> = {
  NotAuthorizedException: 'Incorrect email or password.',
  UserNotFoundException: 'Incorrect email or password.',
  CodeMismatchException: 'That code is not correct. Check your authenticator app and try again.',
  EnableSoftwareTokenMFAException: 'That code is not correct. Check your authenticator app and try again.',
  ExpiredCodeException: 'That code has expired. Request a new one and try again.',
  InvalidPasswordException: 'The password does not meet the requirements.',
  LimitExceededException: 'Too many attempts. Wait a few minutes and try again.',
  TooManyRequestsException: 'Too many attempts. Wait a few minutes and try again.',
  TooManyFailedAttemptsException: 'Too many attempts. Wait a few minutes and try again.',
  PasswordResetRequiredException: 'A password reset is required. Choose "Forgot password?" to set a new one.',
  NetworkError: 'Could not reach the sign-in service. Check your connection and try again.',
};

const SESSION_EXPIRED = 'Your sign-in session expired. Go back and sign in again.';

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Maps Cognito / network errors to short, user-facing English messages (no technical details). */
export function authErrorMessage(err: unknown): string {
  const { code, name, message } = (err ?? {}) as { code?: unknown; name?: unknown; message?: unknown };
  const key = asString(code) || asString(name);
  const text = asString(message);
  if (key === 'NotAuthorizedException' && /session/i.test(text)) return SESSION_EXPIRED;
  if (key === 'ExpiredChallenge') return SESSION_EXPIRED;
  return MESSAGES[key] ?? (text || 'Something went wrong. Please try again.');
}

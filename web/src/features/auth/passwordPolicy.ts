export const MIN_PASSWORD_LENGTH = 12;

/** Mirrors the Cognito pool policy (infra/terraform/auth.tf). Returns a hint for the first unmet rule. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (!/[a-z]/.test(password)) return 'Add a lowercase letter.';
  if (!/[A-Z]/.test(password)) return 'Add an uppercase letter.';
  if (!/\d/.test(password)) return 'Add a number.';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Add a symbol, for example ! or #.';
  return undefined;
}

export const isTotpCode = (value: string): boolean => /^\d{6}$/.test(value);
export const normaliseTotpCode = (value: string): string => value.replaceAll(/\s+/g, '');

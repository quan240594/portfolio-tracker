import { useState } from 'react';
import { AuthCard, Field, FormMessage, LinkButton, useSubmit } from './AuthCard';
import { useAuth } from './AuthContext';
import { formatSecret, otpauthUri } from './otpauth';
import { MIN_PASSWORD_LENGTH, isTotpCode, normaliseTotpCode, passwordProblem } from './passwordPolicy';
import { TotpQr } from './TotpQr';

const BackToSignIn = () => {
  const { cancelChallenge } = useAuth();
  return <LinkButton onClick={() => void cancelChallenge()}>Back to sign in</LinkButton>;
};

/** Shared by the first-login challenge and the password-reset form. */
export function NewPasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
}: Readonly<{ password: string; confirm: string; onPassword: (v: string) => void; onConfirm: (v: string) => void }>) {
  return (
    <>
      <Field
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters with upper and lower case letters, a number and a symbol.`}
        value={password}
        onChange={(e) => onPassword(e.target.value)}
      />
      <Field label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => onConfirm(e.target.value)} />
    </>
  );
}

/** Returns a message when the pair of passwords is unusable, else undefined. */
export const newPasswordProblem = (password: string, confirm: string): string | undefined =>
  passwordProblem(password) ?? (password === confirm ? undefined : 'The passwords do not match.');

export function NewPasswordForm() {
  const { completeNewPassword } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { pending, error, onSubmit } = useSubmit(async () => {
    const problem = newPasswordProblem(password, confirm);
    if (problem) throw new Error(problem);
    await completeNewPassword(password);
  });

  return (
    <AuthCard title="Choose a new password" description="This is your first sign-in. Replace the temporary password with your own.">
      <form onSubmit={onSubmit} className="space-y-4">
        <NewPasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
        {error && <FormMessage kind="error">{error}</FormMessage>}
        <button type="submit" className="btn-primary w-full" disabled={pending}>
          {pending ? 'Saving…' : 'Set password'}
        </button>
        <div className="text-center">
          <BackToSignIn />
        </div>
      </form>
    </AuthCard>
  );
}

function useTotpSubmit(run: (code: string) => Promise<void>) {
  const [code, setCode] = useState('');
  const submit = useSubmit(async () => {
    const normalised = normaliseTotpCode(code);
    if (!isTotpCode(normalised)) throw new Error('Enter the 6-digit code from your authenticator app.');
    await run(normalised);
  });
  return { code, setCode, ...submit };
}

const CodeField = ({ value, onChange }: Readonly<{ value: string; onChange: (v: string) => void }>) => (
  <Field
    label="6-digit code"
    inputMode="numeric"
    autoComplete="one-time-code"
    maxLength={7}
    required
    value={value}
    onChange={(e) => onChange(e.target.value)}
  />
);

export function TotpSetupForm({ secret, email }: Readonly<{ secret: string; email: string }>) {
  const { verifyTotpSetup } = useAuth();
  const { code, setCode, pending, error, onSubmit } = useTotpSubmit(verifyTotpSetup);

  return (
    <AuthCard title="Set up two-factor authentication" description="Add this account to an authenticator app (1Password, Google Authenticator, Authy…), then enter the code it shows.">
      <form onSubmit={onSubmit} className="space-y-4">
        <TotpQr value={otpauthUri(email, secret)} label="QR code to add this account to your authenticator app" />
        <div>
          <p className="muted text-sm">Can’t scan? Enter this key manually:</p>
          <code data-testid="totp-secret" className="mt-1 block rounded-lg bg-slate-100 px-3 py-2 text-center font-mono text-sm tracking-wider break-all dark:bg-slate-800">
            {formatSecret(secret)}
          </code>
        </div>
        <CodeField value={code} onChange={setCode} />
        {error && <FormMessage kind="error">{error}</FormMessage>}
        <button type="submit" className="btn-primary w-full" disabled={pending}>
          {pending ? 'Verifying…' : 'Verify and continue'}
        </button>
        <div className="text-center">
          <BackToSignIn />
        </div>
      </form>
    </AuthCard>
  );
}

export function TotpCodeForm() {
  const { submitTotp } = useAuth();
  const { code, setCode, pending, error, onSubmit } = useTotpSubmit(submitTotp);

  return (
    <AuthCard title="Two-factor authentication" description="Enter the 6-digit code from your authenticator app.">
      <form onSubmit={onSubmit} className="space-y-4">
        <CodeField value={code} onChange={setCode} />
        {error && <FormMessage kind="error">{error}</FormMessage>}
        <button type="submit" className="btn-primary w-full" disabled={pending}>
          {pending ? 'Verifying…' : 'Verify'}
        </button>
        <div className="text-center">
          <BackToSignIn />
        </div>
      </form>
    </AuthCard>
  );
}

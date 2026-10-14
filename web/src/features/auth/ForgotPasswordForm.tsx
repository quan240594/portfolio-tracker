import { useState } from 'react';
import { AuthCard, Field, FormMessage, LinkButton, useSubmit } from './AuthCard';
import { useAuth } from './AuthContext';
import { NewPasswordFields, newPasswordProblem } from './ChallengeForms';

export const PASSWORD_UPDATED_NOTICE = 'Password updated. Sign in with your new password.';

/** Forgot-password flow: request an emailed code, then choose a new password. */
export function ForgotPasswordForm({ initialEmail, onBack, onDone }: Readonly<{ initialEmail: string; onBack: () => void; onDone: () => void }>) {
  const { requestPasswordReset, confirmPasswordReset } = useAuth();
  const [email, setEmail] = useState(initialEmail);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const { pending, error, onSubmit } = useSubmit(async () => {
    if (!codeSent) {
      await requestPasswordReset(email);
      setCodeSent(true);
      return;
    }
    const problem = newPasswordProblem(password, confirm);
    if (problem) throw new Error(problem);
    await confirmPasswordReset(email, code.trim(), password);
    onDone();
  });

  return (
    <AuthCard
      title="Reset your password"
      description={codeSent ? `If an account exists for ${email}, we emailed a verification code.` : 'Enter your email and we will send you a verification code.'}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {!codeSent && <Field label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}
        {codeSent && (
          <>
            <Field label="Verification code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
            <NewPasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
          </>
        )}
        {error && <FormMessage kind="error">{error}</FormMessage>}
        <button type="submit" className="btn-primary w-full" disabled={pending}>
          {codeSent ? 'Set new password' : 'Send code'}
        </button>
        <div className="text-center">
          <LinkButton onClick={onBack}>Back to sign in</LinkButton>
        </div>
      </form>
    </AuthCard>
  );
}

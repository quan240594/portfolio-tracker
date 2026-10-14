import { useState } from 'react';
import { AuthCard, Field, FormMessage, LinkButton, useSubmit } from './AuthCard';
import { useAuth } from './AuthContext';

export function SignInForm({ notice, onForgotPassword }: Readonly<{ notice?: string; onForgotPassword: (email: string) => void }>) {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { pending, error, onSubmit } = useSubmit(() => signIn(email, password));

  return (
    <AuthCard title="Sign in" description="Use the account created for you. Self sign-up is disabled.">
      <form onSubmit={onSubmit} className="space-y-4">
        {notice && <FormMessage kind="notice">{notice}</FormMessage>}
        <Field label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <FormMessage kind="error">{error}</FormMessage>}
        <button type="submit" className="btn-primary w-full" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="text-center">
          <LinkButton onClick={() => onForgotPassword(email)}>Forgot password?</LinkButton>
        </div>
      </form>
    </AuthCard>
  );
}

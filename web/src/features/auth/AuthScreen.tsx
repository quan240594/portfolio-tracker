import { useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { TotpCodeForm, NewPasswordForm, TotpSetupForm } from './ChallengeForms';
import { ForgotPasswordForm, PASSWORD_UPDATED_NOTICE } from './ForgotPasswordForm';
import { SignInForm } from './SignInForm';

type View = 'signIn' | 'forgot';

/** Everything a signed-out user can see. Lazy-loaded (it pulls in the QR code library). */
export default function AuthScreen() {
  const { challenge, email, notice } = useAuth();
  const [view, setView] = useState<View>('signIn');
  const [resetEmail, setResetEmail] = useState('');
  const [resetDone, setResetDone] = useState(false);

  useEffect(() => {
    document.title = 'Sign in · Portfolio Tracker';
  }, []);

  if (challenge?.kind === 'newPassword') return <NewPasswordForm />;
  if (challenge?.kind === 'totpSetup') return <TotpSetupForm secret={challenge.secret} email={email ?? ''} />;
  if (challenge?.kind === 'totp') return <TotpCodeForm />;

  if (view === 'forgot') {
    return (
      <ForgotPasswordForm
        initialEmail={resetEmail}
        onBack={() => setView('signIn')}
        onDone={() => {
          setResetDone(true);
          setView('signIn');
        }}
      />
    );
  }
  return (
    <SignInForm
      notice={resetDone ? PASSWORD_UPDATED_NOTICE : notice}
      onForgotPassword={(typed) => {
        setResetEmail(typed);
        setResetDone(false);
        setView('forgot');
      }}
    />
  );
}

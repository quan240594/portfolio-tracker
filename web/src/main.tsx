import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { USE_MOCKS } from './config';
import { AUTH_CONFIG } from './features/auth/config';
import { registerPushWorker } from './features/notifications/push';
import './index.css';

async function enableMocking() {
  if (!USE_MOCKS) return;
  const { worker } = await import('./mocks/browser');
  await worker.start({
    onUnhandledRequest: 'bypass',
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    quiet: true,
  });
}

await enableMocking();

// The notification service worker belongs to the personal (GitHub sign-in) deployment only: never the demo or the AWS build.
if (!USE_MOCKS && AUTH_CONFIG.mode === 'github') void registerPushWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

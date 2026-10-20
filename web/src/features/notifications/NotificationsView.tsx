import { useCallback, useEffect, useId, useState } from 'react';
import {
  MAX_EX_DIVIDEND_DAYS,
  MIN_EX_DIVIDEND_DAYS,
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_LABELS,
  type NotificationType,
  type NotificationsResponse,
  type PushDeviceSummary,
  type TestDeviceResult,
} from '@portfolio/shared';
import { errorMessage } from '../../api/client';
import { useNotifications, useRemoveDevice, useSaveNotificationSettings, useSubscribeDevice, useTestNotification } from '../../api/notificationsHooks';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { PageHeader } from '../../components/Layout';
import { LoadingRegion, Skeleton } from '../../components/Skeleton';
import { formatDateTime } from '../../lib/format';
import {
  PERMISSION_DENIED_MESSAGE,
  PushPermissionError,
  UNSUPPORTED_MESSAGES,
  currentSubscription,
  deviceLabel,
  detectPushSupport,
  disableOnThisDevice,
  enableOnThisDevice,
  endpointId,
  permissionState,
  type PermissionState,
} from './push';

const TYPE_HINTS: Readonly<Record<NotificationType, string>> = {
  exDividend: 'A reminder shortly before the ex-dividend date of a security you hold.',
  declared: 'A new dividend was announced: amount, dates and how it compares with the last payment and a year ago.',
  received: 'A dividend payment was recorded. The Trading 212 sync runs a few times a day.',
};

const TEST_RESULT_TEXT: Readonly<Record<TestDeviceResult['result'], string>> = {
  ok: 'sent to the push service; it should appear on the device within seconds',
  gone: 'the push service no longer knows this device, so it was removed',
  'rate-limited': 'the push service asked to slow down: try again in a minute',
  retryable: 'the push service could not be reached: try again',
  rejected: 'the push service refused the message',
};

const DAY_OPTIONS = Array.from({ length: MAX_EX_DIVIDEND_DAYS - MIN_EX_DIVIDEND_DAYS + 1 }, (_unused, index) => MIN_EX_DIVIDEND_DAYS + index);

/** Id of this browser's own push subscription (as the server names devices), `null` when there is none; `undefined` while unknown. */
function useThisDeviceId(refreshKey: number): string | null | undefined {
  const [id, setId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    currentSubscription()
      .then((subscription) => (subscription ? endpointId(subscription.endpoint) : null))
      .catch(() => null)
      .then((value) => {
        if (current) setId(value);
      });
    return () => {
      current = false;
    };
  }, [refreshKey]);
  return id;
}

function Notice({ tone, children }: Readonly<{ tone: 'info' | 'warning'; children: React.ReactNode }>) {
  const colours = tone === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100' : 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-100';
  return <p className={`rounded-lg border px-3 py-2 text-sm ${colours}`}>{children}</p>;
}

interface ThisDeviceProps {
  state: NotificationsResponse;
  thisDeviceId: string | null | undefined;
  onChanged: () => void;
}

/** Enabling is always a click: the permission prompt and the subscription never happen on their own. */
function ThisDevice({ state, thisDeviceId, onChanged }: Readonly<ThisDeviceProps>) {
  const subscribe = useSubscribeDevice();
  const remove = useRemoveDevice();
  const [permission, setPermission] = useState<PermissionState>(permissionState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const support = detectPushSupport();
  const enabled = thisDeviceId !== null && thisDeviceId !== undefined && state.devices.some((device) => device.id === thisDeviceId);

  const enable = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const subscription = await enableOnThisDevice(state.publicKey ?? '');
      await subscribe.mutateAsync({ ...subscription, label: deviceLabel() });
      onChanged();
    } catch (err) {
      if (err instanceof PushPermissionError) setPermission(err.permission);
      setError(err instanceof Error ? errorMessage(err) : 'Could not enable notifications on this device.');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (thisDeviceId) await remove.mutateAsync(thisDeviceId);
      await disableOnThisDevice();
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  let body: React.ReactNode;
  if (!support.supported) body = <Notice tone="warning">{UNSUPPORTED_MESSAGES[support.reason]}</Notice>;
  else if (!state.configured) body = <Notice tone="warning">Push notifications are not configured on the server yet: the VAPID keys are missing. The README describes the one-time setup (&quot;Dividend push notifications&quot;).</Notice>;
  else if (enabled) {
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm">Notifications are on for this device.</p>
        <button type="button" className="btn-secondary" onClick={() => void disable()} disabled={busy}>
          Turn off on this device
        </button>
      </div>
    );
  } else {
    body = (
      <div className="space-y-3">
        {permission === 'denied' && <Notice tone="warning">{PERMISSION_DENIED_MESSAGE}</Notice>}
        <button type="button" className="btn-primary" onClick={() => void enable()} disabled={busy || permission === 'denied'}>
          Enable on this device
        </button>
        <p className="muted text-xs">Your browser asks for permission when you choose this. Nothing is requested before.</p>
      </div>
    );
  }

  return (
    <section aria-labelledby="this-device-heading" className="card space-y-3 p-4">
      <h2 id="this-device-heading" className="text-base font-semibold">
        This device
      </h2>
      {body}
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}

function SettingsForm({ state }: Readonly<{ state: NotificationsResponse }>) {
  const save = useSaveNotificationSettings();
  const daysId = useId();
  const { settings } = state;
  return (
    <fieldset className="card space-y-4 p-4" aria-busy={save.isPending}>
      <legend className="px-1 text-base font-semibold">Notify me about</legend>
      {NOTIFICATION_TYPES.map((type) => (
        <label key={type} className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={settings.types[type]}
            disabled={save.isPending}
            onChange={(event) => save.mutate({ types: { [type]: event.target.checked } })}
          />
          <span>
            <span className="font-medium">{NOTIFICATION_TYPE_LABELS[type]}</span>
            <span className="muted block text-xs">{TYPE_HINTS[type]}</span>
          </span>
        </label>
      ))}
      <div>
        <label htmlFor={daysId} className="label">
          <span>Ex-dividend reminder</span>
        </label>
        <select
          id={daysId}
          className="input sm:w-auto"
          value={settings.exDividendDaysBefore}
          disabled={save.isPending || !settings.types.exDividend}
          onChange={(event) => save.mutate({ exDividendDaysBefore: Number(event.target.value) })}
        >
          {DAY_OPTIONS.map((days) => (
            <option key={days} value={days}>
              {days === 1 ? '1 day before' : `${days} days before`}
            </option>
          ))}
        </select>
      </div>
      <p className="muted text-xs">Quiet hours: nothing is sent between 22:00 and 08:00 (Amsterdam time); it arrives in the morning instead.</p>
      {save.isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {errorMessage(save.error)}
        </p>
      )}
    </fieldset>
  );
}

function DeviceRow({ device, isThisDevice, onRemove, disabled }: Readonly<{ device: PushDeviceSummary; isThisDevice: boolean; onRemove: () => void; disabled: boolean }>) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-3">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {device.label}
          {isThisDevice && <span className="muted font-normal"> (this device)</span>}
        </p>
        <p className="muted break-words text-xs">
          {device.service} · {device.lastSuccessAt ? `last delivery ${formatDateTime(device.lastSuccessAt)}` : 'no delivery yet'}
          {device.failures > 0 && ` · ${device.failures} failed ${device.failures === 1 ? 'attempt' : 'attempts'} in a row`}
        </p>
      </div>
      <button type="button" className="btn-secondary" aria-label={`Remove ${device.label}`} onClick={onRemove} disabled={disabled}>
        Remove
      </button>
    </li>
  );
}

function Devices({ state, thisDeviceId, onChanged }: Readonly<ThisDeviceProps>) {
  const remove = useRemoveDevice();
  const test = useTestNotification();
  const removeDevice = async (id: string) => {
    await remove.mutateAsync(id);
    // The browser's own subscription goes with the device the user removed here.
    if (id === thisDeviceId) await disableOnThisDevice();
    onChanged();
  };
  const noDevices = state.devices.length === 0;
  return (
    <section aria-labelledby="devices-heading" className="card space-y-3 p-4">
      <h2 id="devices-heading" className="text-base font-semibold">
        Devices
      </h2>
      {noDevices ? (
        <p className="muted text-sm">No device receives notifications yet.</p>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {state.devices.map((device) => (
            <DeviceRow key={device.id} device={device} isThisDevice={device.id === thisDeviceId} onRemove={() => void removeDevice(device.id).catch(() => undefined)} disabled={remove.isPending} />
          ))}
        </ul>
      )}
      <div>
        <button type="button" className="btn-secondary" onClick={() => test.mutate(undefined)} disabled={noDevices || !state.configured || test.isPending}>
          Send a test notification
        </button>
      </div>
      {test.data && (
        <output className="block space-y-1 text-sm">
          {test.data.results.map((result) => (
            <span key={result.id} className="block">
              {result.label}: {TEST_RESULT_TEXT[result.result]}
            </span>
          ))}
        </output>
      )}
      {(test.isError || remove.isError) && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {errorMessage(test.error ?? remove.error)}
        </p>
      )}
    </section>
  );
}

function Loaded({ state }: Readonly<{ state: NotificationsResponse }>) {
  const [refreshKey, setRefreshKey] = useState(0);
  const thisDeviceId = useThisDeviceId(refreshKey);
  const changed = useCallback(() => setRefreshKey((key) => key + 1), []);
  return (
    <div className="space-y-6">
      <ThisDevice state={state} thisDeviceId={thisDeviceId} onChanged={changed} />
      <SettingsForm state={state} />
      <Devices state={state} thisDeviceId={thisDeviceId} onChanged={changed} />
      <section aria-label="About notifications" className="muted space-y-1 text-xs">
        <p>Messages are encrypted end to end: the push service of your browser only carries ciphertext and never sees amounts or names.</p>
        <p>On an iPhone or iPad, notifications only work for an app added to the Home Screen (Share, then Add to Home Screen).</p>
      </section>
    </div>
  );
}

/** The Notifications page: this device, what to be notified about, the registered devices and a test button. Hidden when the server has no push support. */
export function NotificationsView() {
  const query = useNotifications();
  let body: React.ReactNode;
  if (query.isError) body = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  else if (!query.data) {
    body = (
      <LoadingRegion label="Loading notifications">
        <Skeleton className="h-64 w-full" />
      </LoadingRegion>
    );
  } else if (query.data.available) body = <Loaded state={query.data} />;
  else body = <EmptyState title="Notifications are not available" description="This deployment cannot send push notifications." />;
  return (
    <>
      <PageHeader title="Notifications" description="Dividend alerts for the securities you hold, pushed to your phone." />
      {body}
    </>
  );
}

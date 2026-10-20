import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationsResponse, SettingsPatch, SubscribeBody } from '@portfolio/shared';
import { notificationsApi } from './notificationsClient';

export const notificationKeys = { all: ['notifications'] as const };

/** State of the notification feature on the server: availability, settings and devices (never endpoints or keys). */
export const useNotifications = ({ enabled = true }: { enabled?: boolean } = {}) =>
  useQuery({ queryKey: notificationKeys.all, queryFn: ({ signal }) => notificationsApi.get(signal), enabled, staleTime: 0 });

export function useSaveNotificationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => notificationsApi.saveSettings(patch),
    onSuccess: (settings) => qc.setQueryData<NotificationsResponse>(notificationKeys.all, (previous) => (previous ? { ...previous, settings } : previous)),
  });
}

export function useSubscribeDevice() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: SubscribeBody) => notificationsApi.subscribe(body), onSuccess: () => qc.invalidateQueries({ queryKey: notificationKeys.all }) });
}

export function useRemoveDevice() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => notificationsApi.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: notificationKeys.all }) });
}

export function useTestNotification() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (subscriptionId?: string) => notificationsApi.test(subscriptionId), onSettled: () => qc.invalidateQueries({ queryKey: notificationKeys.all }) });
}

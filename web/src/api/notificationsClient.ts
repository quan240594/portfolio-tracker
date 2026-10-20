import type { NotificationSettings, NotificationsResponse, SettingsPatch, SubscribeBody, SubscribeResponse, TestNotificationResponse } from '@portfolio/shared';
import { request } from './client';

export const notificationsApi = {
  get: (signal?: AbortSignal) => request<NotificationsResponse>('GET', '/notifications', { signal }),
  saveSettings: (patch: SettingsPatch) => request<NotificationSettings>('PUT', '/notifications/settings', { body: patch }),
  subscribe: (body: SubscribeBody) => request<SubscribeResponse>('POST', '/notifications/subscriptions', { body }),
  remove: (id: string) => request<void>('DELETE', `/notifications/subscriptions/${encodeURIComponent(id)}`),
  test: (subscriptionId?: string) => request<TestNotificationResponse>('POST', '/notifications/test', { body: subscriptionId ? { subscriptionId } : {} }),
};

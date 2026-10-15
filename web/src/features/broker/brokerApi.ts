import type { BrokerStatusResponse, ConnectBrokerRequest, SyncBrokerResponse } from '@portfolio/shared';
import { request } from '../../api/client';

const PATH = '/brokers/trading212';

/** Trading 212 endpoints. The API never returns credentials; they are only ever sent by `connect`. */
export const brokerApi = {
  status: (portfolioId: string, signal?: AbortSignal) =>
    request<BrokerStatusResponse>('GET', PATH, { query: { portfolioId }, signal }),
  connect: (body: ConnectBrokerRequest) => request<void>('PUT', PATH, { body }),
  disconnect: () => request<void>('DELETE', PATH),
  sync: (portfolioId: string) => request<SyncBrokerResponse>('POST', `${PATH}/sync`, { body: { portfolioId } }),
};

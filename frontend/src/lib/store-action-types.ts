export interface StoreRef<T> {
  current: T;
}

export interface LiveAuthRequest {
  token: string;
  isCurrent: () => boolean;
}

export type BeginLiveAuthRequest = () => LiveAuthRequest;

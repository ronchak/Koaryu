export interface StoreRef<T> {
  current: T;
}

export interface LiveAuthRequest {
  token: string;
  isCurrent: () => boolean;
  canRetryAfterTokenChange?: () => boolean;
}

export type BeginLiveAuthRequest = () => LiveAuthRequest;

// Only read owners opt into replay. Mutations retain their original auth scope.
export async function withCurrentLiveAuthRead<T>(
  beginRequest: BeginLiveAuthRequest,
  read: (request: LiveAuthRequest) => Promise<T>,
  onRetryLimit: (error: Error) => void
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const request = beginRequest();
    try {
      const result = await read(request);
      if (!request.canRetryAfterTokenChange?.()) return result;
    } catch (error) {
      if (!request.canRetryAfterTokenChange?.()) throw error;
    }
  }
  const error = new Error("Session changed repeatedly. Please retry loading this data.");
  onRetryLimit(error);
  throw error;
}

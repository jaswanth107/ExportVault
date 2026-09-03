const RAW_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:5000';
export const API_BASE = RAW_BASE.replace(/\/$/, '');

const TOKEN_KEY = 'exportvault.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch (error) {
    // Private-mode browsers throw here; surface it rather than pretending we
    // are simply logged out for an unknown reason.
    console.error('Could not read the stored session token', error);
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch (error) {
    console.error('Could not persist the session token', error);
    throw new Error('Your browser blocked session storage, so login cannot be kept.');
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch (error) {
    console.error('Could not clear the session token', error);
  }
}

/** An error carrying the server's structured detail, for display in the UI. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(params: {
    message: string;
    status: number;
    code: string;
    requestId?: string;
    details?: unknown;
  }) {
    super(params.message);
    this.name = 'ApiError';
    this.status = params.status;
    this.code = params.code;
    this.requestId = params.requestId;
    this.details = params.details;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  auth?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // Network-level failure: never swallowed into a generic empty state.
    //
    // The browser deliberately hides the reason from JavaScript, so a blocked
    // CORS origin and a genuinely unreachable server are indistinguishable here
    // — both surface as a TypeError on fetch. Naming both possibilities is the
    // honest thing to do; claiming "the server is down" would be a guess, and
    // sent people looking in the wrong place during this project's own deploy.
    console.error(`Network request failed: ${method} ${path}`, error);
    throw new ApiError({
      message:
        `Could not reach the API at ${API_BASE}. The browser blocks the real reason, ` +
        `but it is almost always one of: the API is asleep or down, or this site's ` +
        `origin is not in the API's CLIENT_URL allowlist (CORS).`,
      status: 0,
      code: 'NETWORK_ERROR',
    });
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      console.error(`Malformed JSON from ${method} ${path}`, error, text.slice(0, 500));
      throw new ApiError({
        message: `The API returned a malformed response (HTTP ${response.status}).`,
        status: response.status,
        code: 'MALFORMED_RESPONSE',
      });
    }
  }

  if (!response.ok) {
    const errorBody = (payload as { error?: { message?: string; code?: string; requestId?: string; details?: unknown } } | null)?.error;

    if (response.status === 401) clearToken();

    throw new ApiError({
      message: errorBody?.message ?? `Request failed with HTTP ${response.status}`,
      status: response.status,
      code: errorBody?.code ?? 'HTTP_ERROR',
      requestId: errorBody?.requestId,
      details: errorBody?.details,
    });
  }

  return payload as T;
}

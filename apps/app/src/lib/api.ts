import type { ApiResponse, PaginatedResponse } from '@printforge/types';

const API_BASE = '/api';

/**
 * Thrown for every non-2xx response. `message` is the server's `error` text
 * (the envelope's `error` field); `status` lets callers tell a 404 from other
 * failures (e.g. the product page shows notFound() only on 404). `code` is
 * the envelope's machine-readable reason when the server sent one (e.g.
 * 'SPOOL_HAS_HISTORY', 'MATERIAL_DUPLICATE').
 */
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new ApiError(error.error || `HTTP ${res.status}`, res.status, typeof error.code === 'string' ? error.code : undefined);
  }

  const json = await res.json();
  return json.data !== undefined ? json.data : json;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(data) }),
  patch: <T>(path: string, data?: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(data) }),
  put: <T>(path: string, data?: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(data) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  postForm: async <T>(path: string, formData: FormData): Promise<T> => {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new ApiError(error.error || error.message || `HTTP ${res.status}`, res.status);
    }
    const json = await res.json();
    return (json.data !== undefined ? json.data : json) as T;
  },
  upload: async (path: string, file: File, params: Record<string, string>) => {
    const formData = new FormData();
    formData.append('file', file);
    const query = new URLSearchParams(params).toString();
    const res = await fetch(`${API_BASE}${path}?${query}`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(error.error || error.message || `HTTP ${res.status}`);
    }
    const json = await res.json();
    return json.data !== undefined ? json.data : json;
  },
};

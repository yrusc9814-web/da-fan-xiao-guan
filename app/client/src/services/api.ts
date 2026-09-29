import type { HealthResponse } from '../types/health';
import type { ApiResponse, DashboardDto } from '../../../shared/types';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api';
const pinTokenKey = 'dafan-pin-token';
export function setPinToken(token: string | null): void {
  if (token) localStorage.setItem(pinTokenKey, token);
  else localStorage.removeItem(pinTokenKey);
}
export function getPinToken(): string | null {
  return localStorage.getItem(pinTokenKey);
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, string | number | boolean | null>;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, string | number | boolean | null>
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { query?: Record<string, string | number | boolean | null | undefined> } = {}
): Promise<T> {
  const url = new URL(`${apiBaseUrl}/v1${path}`, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { ...(options.headers as Record<string, string> | undefined) };
  const hasBody = options.body !== undefined && options.body !== null;
  if (
    hasBody &&
    !(options.body instanceof FormData) &&
    !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')
  ) {
    headers['Content-Type'] = 'application/json';
  }
  const token = localStorage.getItem(pinTokenKey);
  if (token) headers['X-App-Pin-Token'] = token;
  const response = await fetch(url, { ...options, headers });
  const payload = (
    typeof response.text === 'function'
      ? (() => response.text().then((text) => (text ? JSON.parse(text) : null)))()
      : response.json()
  ) as Promise<ApiResponse<T> | null>;
  const resolvedPayload = await payload;
  if (!response.ok || !resolvedPayload || !resolvedPayload.success) {
    const error = resolvedPayload && !resolvedPayload.success ? resolvedPayload.error : null;
    throw new ApiRequestError(
      response.status,
      error?.code ?? 'INTERNAL_ERROR',
      error?.message ?? `请求失败（${response.status}）`,
      error?.details
    );
  }
  return resolvedPayload.data;
}

export async function fetchHealth(): Promise<HealthResponse['data']> {
  const response = await fetch(`${apiBaseUrl}/v1/health`);
  const payload = (await response.json()) as HealthResponse | { error?: { message?: string } };

  if (!response.ok || !('success' in payload) || !payload.success) {
    const message = 'error' in payload ? payload.error?.message : undefined;
    throw new Error(message ?? '后端服务不可用');
  }

  return payload.data;
}

export async function fetchDashboard(): Promise<DashboardDto> {
  return apiRequest<DashboardDto>('/dashboard');
}

export interface CalendarDayDto {
  date: string;
  hasPlans: boolean;
  hasRecords: boolean;
  hasDrafts: boolean;
}

export async function fetchCalendar(
  start: string,
  end: string
): Promise<{ start: string; end: string; days: CalendarDayDto[] }> {
  return apiRequest('/calendar', { query: { start, end } });
}

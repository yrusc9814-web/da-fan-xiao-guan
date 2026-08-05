import type { HealthResponse } from '../types/health';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api';

export async function fetchHealth(): Promise<HealthResponse['data']> {
  const response = await fetch(`${apiBaseUrl}/v1/health`);
  const payload = (await response.json()) as HealthResponse | { error?: { message?: string } };

  if (!response.ok || !('success' in payload) || !payload.success) {
    const message = 'error' in payload ? payload.error?.message : undefined;
    throw new Error(message ?? '后端服务不可用');
  }

  return payload.data;
}

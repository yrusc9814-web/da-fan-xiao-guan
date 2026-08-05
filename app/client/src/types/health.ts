export interface HealthData {
  status: 'ok';
  app: '搭饭小馆';
  version: '0.1.0';
  timestamp: string;
}

export interface HealthResponse {
  success: true;
  data: HealthData;
  error: null;
}

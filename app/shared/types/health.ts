export interface HealthDatabaseStatus {
  status: 'ok' | 'error';
  provider: 'sqlite';
}

export interface HealthData {
  status: 'ok' | 'error';
  app: '搭饭小馆';
  version: '0.1.0';
  database: HealthDatabaseStatus;
  timestamp: string;
}

export interface HealthResponse {
  success: true;
  data: HealthData;
  error: null;
}

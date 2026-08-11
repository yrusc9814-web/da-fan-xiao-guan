export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DATABASE_ERROR'
  | 'INTERNAL_ERROR'
  | 'VERSION_CONFLICT'
  | 'DUPLICATE_RESOURCE'
  | 'INVALID_UNIT'
  | 'UNIT_CONVERSION_REQUIRED'
  | 'INVALID_STATE'
  | 'MAINTENANCE'
  | 'REFERENCED_RESOURCE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'FILE_TOO_LARGE'
  | 'INVALID_FILE'
  | 'ONBOARDING_ALREADY_COMPLETED'
  | 'HIGH_RISK_AUTHORIZATION_REQUIRED'
  | 'HIGH_RISK_AUTHORIZATION_INVALID';

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  error: null;
}

export interface ApiFailure {
  success: false;
  data: null;
  error: ApiError;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface PaginationRequest {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginationResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface VersionedUpdateRequest {
  id: string;
  version: number;
}

export interface VersionConflictData {
  entity: string;
  id: string;
  expectedVersion: number;
  actualVersion: number;
}

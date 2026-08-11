import type { ApiError, ApiErrorCode, ApiFailure, ApiResponse, ApiSuccess } from '../../../shared/types/api.js';

export type { ApiError, ApiFailure, ApiResponse, ApiSuccess };

export function success<T>(data: T): ApiSuccess<T> {
  return {
    success: true,
    data,
    error: null
  };
}

export function failure(
  code: ApiErrorCode,
  message: string,
  details?: Record<string, string | number | boolean | null>
): ApiFailure {
  return {
    success: false,
    data: null,
    error: {
      code,
      message,
      ...(details ? { details } : {})
    }
  };
}

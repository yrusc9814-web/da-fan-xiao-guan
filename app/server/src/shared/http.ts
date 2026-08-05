export interface ApiError {
  code: string;
  message: string;
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

export function success<T>(data: T): ApiSuccess<T> {
  return {
    success: true,
    data,
    error: null
  };
}

export function failure(code: string, message: string): ApiFailure {
  return {
    success: false,
    data: null,
    error: {
      code,
      message
    }
  };
}

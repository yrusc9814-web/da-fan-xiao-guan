import type { PaginationRequest, PaginationResponse } from '../../../shared/types/api.js';

export interface PaginationValues {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export function normalizePagination(
  request: PaginationRequest = {},
  maxPageSize = 100
): PaginationValues {
  const page = Math.max(1, Math.floor(request.page ?? 1));
  const pageSize = Math.min(maxPageSize, Math.max(1, Math.floor(request.pageSize ?? 20)));

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize
  };
}

export function toPaginationResponse<T>(
  items: T[],
  page: number,
  pageSize: number,
  total: number
): PaginationResponse<T> {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize)
  };
}

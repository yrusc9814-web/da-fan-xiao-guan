export interface SoftDeleteFilter {
  deletedAt: null;
}

export function activeOnly(): SoftDeleteFilter {
  return { deletedAt: null };
}

export function withActiveFilter<T extends object>(where: T): T & SoftDeleteFilter {
  return {
    ...where,
    deletedAt: null
  };
}

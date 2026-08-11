export interface VersionConflict {
  entity: string;
  id: string;
  expectedVersion: number;
  actualVersion: number;
}

export class VersionConflictError extends Error {
  readonly conflict: VersionConflict;

  constructor(conflict: VersionConflict) {
    super('数据已在其他设备修改');
    this.name = 'VersionConflictError';
    this.conflict = conflict;
  }
}

export function assertVersion(entity: string, id: string, expectedVersion: number, actualVersion: number): void {
  if (expectedVersion !== actualVersion) {
    throw new VersionConflictError({
      entity,
      id,
      expectedVersion,
      actualVersion
    });
  }
}

export function nextVersion(version: number): number {
  return version + 1;
}

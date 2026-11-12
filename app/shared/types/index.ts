export * from './api';
export * from './dashboard';
export * from './domain';
export * from './health';
export * from './statistics';
// domain.ts 与 statistics.ts 都定义了 StatisticsDto（VAN-34 起 statistics.ts 是统计接口的正式契约），
// 显式再导出 statistics 版本以消除 `export *` 的同名冲突（TS2308），保持旧 domain 版本可按路径单独引用。
export type { StatisticsDto } from './statistics';

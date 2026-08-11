import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(projectRoot, 'dist-server');

if (basename(outputDirectory) !== 'dist-server') throw new Error('拒绝清理非服务端构建目录');
await rm(outputDirectory, { force: true, recursive: true });

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { ZipArchive } from 'archiver';
import unzipper from 'unzipper';
import { filePathFromDatabaseUrl, resolveDatabaseUrl } from '../../database/paths.js';
import { beginMaintenance, endMaintenance } from '../../plugins/maintenance.js';
import { clearPinSessions } from '../settings/service.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const uploadsDirectory = resolve(projectRoot, 'data/uploads');
interface ManifestFile { path:string; size:number; sha256:string }
interface Manifest { backupVersion:1; appVersion:string; createdAt:string; files:ManifestFile[] }
const hash=(buffer:Buffer)=>createHash('sha256').update(buffer).digest('hex');
async function fileHash(path:string){const data=await readFile(path);return{size:data.byteLength,sha256:hash(data)}}
async function filesUnder(root:string,prefix:string):Promise<Array<{path:string;source:string}>>{const result:Array<{path:string;source:string}>=[];async function walk(dir:string){for(const entry of await readdir(dir,{withFileTypes:true}).catch(()=>[])){const absolute=join(dir,entry.name);if(entry.isDirectory())await walk(absolute);else if(entry.isFile()){const relative=absolute.slice(root.length+1).split(sep).join('/');result.push({path:`${prefix}/${relative}`,source:absolute})}}}await walk(root);return result}
function databasePath(){const path=filePathFromDatabaseUrl(resolveDatabaseUrl());if(!path)throw Object.assign(new Error('仅支持备份本地 SQLite 数据库'),{statusCode:409});return path}

let backupQueue: Promise<void> = Promise.resolve();
async function withBackupLock<T>(work:()=>Promise<T>):Promise<T>{const previous=backupQueue;let release!:()=>void;backupQueue=new Promise<void>(resolve=>{release=resolve});await previous;try{return await work()}finally{release()}}
function sqliteString(value:string){return value.replaceAll("'","''")}

export async function createBackup(database:PrismaClient){return withBackupLock(async()=>{
  databasePath();
  const dir=await mkdtemp(join(tmpdir(),'dafan-backup-')),zipPath=join(dir,`搭饭小馆-${new Date().toLocaleDateString('sv-SE')}.zip`),dbPath=join(dir,'app.db');
  try{await database.$executeRawUnsafe(`VACUUM INTO '${sqliteString(dbPath)}'`)}catch(error){await rm(dir,{recursive:true,force:true});throw error}
  const settings=await database.settings.upsert({where:{id:1},create:{id:1},update:{}});const config=Buffer.from(JSON.stringify({appName:settings.appName,subtitle:settings.subtitle,defaultPort:settings.defaultPort,autoBackupEnabled:settings.autoBackupEnabled,createdAt:new Date().toISOString()},null,2));
  const sources=[{path:'app.db',source:dbPath},...await filesUnder(uploadsDirectory,'uploads')];const files:ManifestFile[]=[];for(const item of sources){files.push({path:item.path,...await fileHash(item.source)})}files.push({path:'config.json',size:config.byteLength,sha256:hash(config)});
  const manifest:Manifest={backupVersion:1,appVersion:'1.0.0',createdAt:new Date().toISOString(),files};
  const output=createWriteStream(zipPath),archive=new ZipArchive({zlib:{level:9}});archive.pipe(output);for(const item of sources)archive.file(item.source,{name:item.path});archive.append(config,{name:'config.json'});archive.append(JSON.stringify(manifest,null,2),{name:'backup-manifest.json'});await archive.finalize();await new Promise<void>((ok,fail)=>{output.on('close',()=>ok());output.on('error',fail)});
  return{zipPath,filename:zipPath.split(sep).at(-1)!,cleanup:()=>rm(dir,{recursive:true,force:true})};
})}
export async function ensureDailyBackup(database:PrismaClient){const settings=await database.settings.upsert({where:{id:1},create:{id:1},update:{}});if(!settings.autoBackupEnabled)return{created:false};const directory=resolve(projectRoot,'data/backups');await mkdir(directory,{recursive:true});const day=new Date().toLocaleDateString('sv-SE');const existing=(await readdir(directory)).find(name=>name.startsWith(`auto-${day}-`)&&name.endsWith('.zip'));if(existing)return{created:false,path:resolve(directory,existing)};const backup=await createBackup(database);const target=resolve(directory,`auto-${day}-${Date.now()}.zip`);try{await copyFile(backup.zipPath,target)}finally{await backup.cleanup()}const backups=(await readdir(directory)).filter(name=>name.startsWith('auto-')&&name.endsWith('.zip')).sort().reverse();for(const old of backups.slice(30))await rm(resolve(directory,old),{force:true});return{created:true,path:target}}
function safeEntryPath(value:string){const normalized=posix.normalize(value.replaceAll('\\','/'));return Boolean(normalized)&&!normalized.startsWith('/')&&!normalized.startsWith('../')&&!normalized.includes('/../')&&!/^[A-Za-z]:/.test(normalized)}
export async function restoreBackup(database:PrismaClient,zipBuffer:Buffer,allowedInFlight=0){
  const dataRoot=resolve(projectRoot,'data'),stage=resolve(dataRoot,`.restore-${randomUUID()}`),rollback=resolve(dataRoot,`.rollback-${randomUUID()}`);await mkdir(stage,{recursive:true});
  let maintenanceStarted=false;
  try{
    const directory=await unzipper.Open.buffer(zipBuffer);for(const entry of directory.files){if(!safeEntryPath(entry.path))throw Object.assign(new Error('备份包包含不安全路径'),{statusCode:422});if(!['backup-manifest.json','config.json','app.db'].includes(entry.path)&&!entry.path.startsWith('uploads/'))throw Object.assign(new Error(`备份包包含未知文件：${entry.path}`),{statusCode:422});const target=resolve(stage,...entry.path.split('/'));if(!target.startsWith(`${stage}${sep}`))throw Object.assign(new Error('备份包路径越界'),{statusCode:422});if(entry.type==='Directory'){await mkdir(target,{recursive:true});continue}await mkdir(dirname(target),{recursive:true});await writeFile(target,await entry.buffer())}
    const manifest=JSON.parse(await readFile(resolve(stage,'backup-manifest.json'),'utf8')) as Manifest;if(manifest.backupVersion!==1||!Array.isArray(manifest.files))throw Object.assign(new Error('备份清单版本不受支持'),{statusCode:422});for(const file of manifest.files){if(!safeEntryPath(file.path))throw Object.assign(new Error('备份清单路径无效'),{statusCode:422});const actual=await fileHash(resolve(stage,...file.path.split('/')));if(actual.size!==file.size||actual.sha256!==file.sha256)throw Object.assign(new Error(`备份文件校验失败：${file.path}`),{statusCode:422})}
    const stagedDb=resolve(stage,'app.db');await stat(stagedDb);const check=(await import('../../database/client.js')).createPrismaClient(`file:${stagedDb}`);try{await check.$queryRawUnsafe('SELECT 1');const migrations=await check.$queryRawUnsafe<Array<{migration_name:string}>>('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL');if(!migrations.length)throw new Error('缺少数据库迁移记录')}finally{await check.$disconnect()}
    await beginMaintenance(allowedInFlight);maintenanceStarted=true;
    const currentDb=databasePath();await database.$queryRawUnsafe('PRAGMA wal_checkpoint(FULL)');await database.$disconnect();await mkdir(rollback,{recursive:true});await copyFile(currentDb,resolve(rollback,'app.db'));if(await stat(uploadsDirectory).catch(()=>null))await cp(uploadsDirectory,resolve(rollback,'uploads'),{recursive:true});
    try{await copyFile(stagedDb,currentDb);await rm(uploadsDirectory,{recursive:true,force:true});const stagedUploads=resolve(stage,'uploads');if(await stat(stagedUploads).catch(()=>null))await rename(stagedUploads,uploadsDirectory);else await mkdir(uploadsDirectory,{recursive:true});await database.$connect();await database.$queryRawUnsafe('SELECT 1');await database.settings.findUnique({where:{id:1}})}catch(error){await database.$disconnect().catch(()=>undefined);await copyFile(resolve(rollback,'app.db'),currentDb);await rm(uploadsDirectory,{recursive:true,force:true});if(await stat(resolve(rollback,'uploads')).catch(()=>null))await cp(resolve(rollback,'uploads'),uploadsDirectory,{recursive:true});await database.$connect();throw error}
    clearPinSessions();
    return{restored:true,restartRecommended:true};
  }finally{if(maintenanceStarted)endMaintenance();await rm(stage,{recursive:true,force:true});await rm(rollback,{recursive:true,force:true})}
}

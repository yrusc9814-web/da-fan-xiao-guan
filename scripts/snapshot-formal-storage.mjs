import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
const repo = resolve(import.meta.dirname, '..');
const [baselinePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !outputPath || resolve(baselinePath) === resolve(outputPath))
  throw new Error('usage: snapshot-formal-storage baseline output (exclusive new output)');
const readErrors = [];
function record(path, optional = false) {
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.nlink > 1) throw new Error('nonregular/symlink/hardlink file');
    const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
    const after = lstatSync(path);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== after.ino
    )
      throw new Error('changed during capture');
    return { path, exists: true, size: after.size, mtimeUtc: after.mtime.toISOString(), sha256 };
  } catch (error) {
    if (optional && error.code === 'ENOENT') return { path, exists: false };
    readErrors.push({ path, error: error.message });
    return { path, readError: error.message };
  }
}
function tree(root) {
  const files = [];
  try {
    function walk(dir) {
      const before = lstatSync(dir);
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`nonregular directory ${dir}`);
      const entries = readdirSync(dir).sort();
      for (const entry of entries) {
        const path = resolve(dir, entry);
        const stat = lstatSync(path);
        if (stat.isDirectory() && !stat.isSymbolicLink()) walk(path);
        else files.push({ ...record(path), relative: relative(root, path).replaceAll('\\', '/') });
      }
      const after = lstatSync(dir);
      if (before.mtimeMs !== after.mtimeMs || JSON.stringify(entries) !== JSON.stringify(readdirSync(dir).sort()))
        throw new Error(`directory changed during capture ${dir}`);
    }
    walk(root);
  } catch (error) {
    readErrors.push({ path: root, error: error.message });
  }
  return files;
}
function capture() {
  const dbPath = resolve(repo, 'data/app.db');
  return {
    db: record(dbPath),
    siblings: ['-wal', '-shm', '-journal'].map((suffix) => record(dbPath + suffix, true)),
    uploads: tree(resolve(repo, 'data/uploads')),
    backups: tree(resolve(repo, 'data/backups'))
  };
}
const forwardCapture = baselinePath === '--capture-forward';
const baseline = forwardCapture ? null : JSON.parse(readFileSync(baselinePath, 'utf8'));
const actual = capture();
const second = capture();
if (JSON.stringify(actual) !== JSON.stringify(second))
  readErrors.push({ path: repo, error: 'storage changed across capture passes' });
if (forwardCapture) {
  const status = readErrors.length ? 'FAIL' : 'PASS';
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        schemaVersion: 2,
        capturedAt: new Date().toISOString(),
        repo,
        purpose: 'forward-only; no assertion about history before capturedAt',
        status,
        stable: !readErrors.length,
        ...actual,
        readErrors
      },
      null,
      2
    ),
    { flag: 'wx' }
  );
  console.log(JSON.stringify({ status, forwardOnly: true, readErrors }));
  process.exit(status === 'PASS' ? 0 : 1);
}
const schemaErrors = [];
if (
  !baseline.db ||
  typeof baseline.db.path !== 'string' ||
  !Number.isFinite(baseline.db.size) ||
  !baseline.db.mtimeUtc ||
  !baseline.db.sha256
)
  schemaErrors.push('baseline.db missing complete fingerprint');
for (const field of ['siblings', 'uploads', 'backups']) {
  if (!Array.isArray(baseline[field])) schemaErrors.push(`baseline.${field} must be an explicit array`);
  else
    for (const item of baseline[field])
      if (!item.path || (item.exists !== false && (!Number.isFinite(item.size) || !item.mtimeUtc || !item.sha256)))
        schemaErrors.push(`baseline.${field} incomplete file record`);
}
if (!Array.isArray(baseline.readErrors) || baseline.readErrors.length)
  schemaErrors.push('baseline.readErrors missing or nonempty');
function map(snapshot) {
  return new Map(
    [snapshot.db, ...snapshot.siblings, ...snapshot.uploads, ...snapshot.backups].map((item) => [item.path, item])
  );
}
const added = [],
  removed = [],
  changed = [];
if (!schemaErrors.length) {
  const before = map(baseline),
    after = map(actual);
  const normalize = (item) =>
    JSON.stringify({
      path: item.path,
      exists: item.exists ?? true,
      size: item.size,
      mtimeUtc: item.mtimeUtc,
      sha256: item.sha256?.toUpperCase()
    });
  for (const [path, item] of after) {
    if (!before.has(path)) added.push(item);
    else if (normalize(item) !== normalize(before.get(path)))
      changed.push({ path, before: before.get(path), after: item });
  }
  for (const [path, item] of before) if (!after.has(path)) removed.push(item);
}
const databaseExpected =
  !schemaErrors.length && actual.db.sha256 === baseline.db.sha256?.toUpperCase() && actual.db.size === baseline.db.size;
const status =
  schemaErrors.length || readErrors.length || added.length || removed.length || changed.length || !databaseExpected
    ? 'FAIL'
    : 'PASS';
const report = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  repo,
  status,
  databaseExpected,
  actual,
  schemaErrors,
  added,
  removed,
  changed,
  readErrors,
  comparisonComplete: !schemaErrors.length
};
writeFileSync(outputPath, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(
  JSON.stringify({
    status,
    databaseExpected,
    schemaErrors,
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    readErrors: readErrors.length
  })
);
process.exitCode = status === 'PASS' ? 0 : 1;

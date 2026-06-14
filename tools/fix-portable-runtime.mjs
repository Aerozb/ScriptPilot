import fs from 'node:fs/promises';
import path from 'node:path';

const releaseRoot = resolveReleaseRoot();
const source = path.join(releaseRoot, 'resources', 'runtime');
const target = path.join(releaseRoot, 'runtime');
const appRuntime = path.join(releaseRoot, 'resources', 'app', 'runtime');

await fs.rm(target, { recursive: true, force: true });

try {
  await fs.rename(source, target);
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
}

await fs.rm(appRuntime, { recursive: true, force: true });

const nodePath = path.join(target, 'node', 'active', process.platform === 'win32' ? 'node.exe' : 'node');
await fs.access(nodePath);
console.log(`Portable runtime ready: ${nodePath}`);

const gitPath = path.join(target, 'git', 'active', 'cmd', process.platform === 'win32' ? 'git.exe' : 'git');
await fs.access(gitPath);
console.log(`Portable git ready: ${gitPath}`);

function resolveReleaseRoot() {
  const envValue = process.env.SCRIPTPILOT_RELEASE_ROOT?.trim();
  if (envValue) {
    return path.resolve(envValue);
  }

  return path.resolve('release/win-unpacked');
}

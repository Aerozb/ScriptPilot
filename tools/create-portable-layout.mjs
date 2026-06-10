import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const releaseRoot = path.resolve('release/win-unpacked');
const internalDirName = 'app';
const internalDir = path.join(releaseRoot, internalDirName);
const launcherSource = path.resolve('tools/launcher/ScriptPilotLauncher.cs');
const launcherManifest = path.resolve('tools/launcher/ScriptPilotLauncher.manifest');
const launcherOutput = path.join(os.tmpdir(), `ScriptPilotLauncher-${Date.now()}.exe`);

await fs.access(path.join(releaseRoot, 'ScriptPilot.exe'));
await compileLauncher(launcherOutput);

await fs.rm(internalDir, { recursive: true, force: true });
await fs.mkdir(internalDir, { recursive: true });

const entries = await fs.readdir(releaseRoot, { withFileTypes: true });
for (const entry of entries) {
  if (entry.name === internalDirName) continue;
  const source = path.join(releaseRoot, entry.name);
  const target = path.join(internalDir, entry.name);
  await fs.rename(source, target);
}

await fs.copyFile(launcherOutput, path.join(releaseRoot, 'ScriptPilot.exe'));
await fs.rm(launcherOutput, { force: true });

await fs.access(path.join(internalDir, 'ScriptPilot.exe'));
await fs.access(path.join(internalDir, 'runtime', 'node', 'active', 'node.exe'));

const rootEntries = (await fs.readdir(releaseRoot)).sort();
if (rootEntries.length !== 2 || rootEntries[0] !== 'ScriptPilot.exe' || rootEntries[1] !== internalDirName) {
  throw new Error(`Unexpected portable root layout: ${rootEntries.join(', ')}`);
}

console.log(`Portable layout ready: ${releaseRoot}`);
console.log(`Root entries: ${rootEntries.join(', ')}`);

async function compileLauncher(outputPath) {
  const csc = await findCsc();
  await execFileAsync(csc, [
    '/nologo',
    '/target:winexe',
    '/optimize+',
    `/out:${outputPath}`,
    `/win32manifest:${launcherManifest}`,
    '/reference:System.Windows.Forms.dll',
    launcherSource
  ], {
    windowsHide: true
  });
}

async function findCsc() {
  const candidates = [
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next compiler location.
    }
  }

  throw new Error('csc.exe not found. Windows .NET Framework compiler is required to build the launcher.');
}

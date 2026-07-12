import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from '../../../shared/errors/app-error.js';
import { assertInsidePath } from '../../../bootstrap/portable-paths.js';

export async function resolveNodeRuntime(paths) {
  const exeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const packaged = isElectronPackagedExe();
  const baseCandidates = [
    createEnvRuntimeCandidate(paths, packaged),
    { nodePath: path.join(paths.runtimeRoot, 'node', 'active', exeName), source: 'bundled' },
    { nodePath: path.join(paths.runtimeRoot, 'node', exeName), source: 'bundled' }
  ].filter(Boolean).filter((item) => item.nodePath);

  const candidates = packaged
    ? baseCandidates
    : [
        ...baseCandidates,
        { nodePath: process.execPath, source: 'current-process-dev-fallback' }
      ];

  for (const candidate of candidates) {
    if (await canExecute(candidate.nodePath) && await isNodeExecutable(candidate.nodePath)) {
      return {
        nodePath: candidate.nodePath,
        version: await readNodeVersion(candidate.nodePath),
        source: candidate.source
      };
    }
  }

  throw new AppError('RUNTIME_NOT_FOUND', '没有找到可执行的 Node 运行时');
}

function createEnvRuntimeCandidate(paths, packaged) {
  const nodePath = process.env.SCRIPTPILOT_NODE_PATH;
  if (!nodePath) return undefined;
  if (packaged) {
    assertInsidePath(paths.portableRoot, nodePath, 'Node 运行时路径');
  }
  return { nodePath, source: 'env' };
}

function isElectronPackagedExe() {
  return process.versions.electron && path.basename(process.execPath).toLowerCase() !== 'electron.exe';
}

async function canExecute(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readNodeVersion(nodePath) {
  return new Promise((resolve) => {
    const child = spawn(nodePath, ['-v'], { windowsHide: true });
    let output = '';

    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });

    child.on('close', () => {
      resolve(output.trim() || 'unknown');
    });

    child.on('error', () => {
      resolve('unknown');
    });
  });
}

async function isNodeExecutable(nodePath) {
  const version = await readNodeVersion(nodePath);
  return /^v\d+\.\d+\.\d+/.test(version);
}

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from '../../../shared/errors/app-error.js';
import { assertInsidePath } from '../../../bootstrap/portable-paths.js';

export async function resolveGitRuntime(paths) {
  const exeName = process.platform === 'win32' ? 'git.exe' : 'git';
  const packaged = isElectronPackagedExe();
  const baseCandidates = [
    createEnvGitCandidate(paths, packaged),
    { gitPath: path.join(paths.runtimeRoot, 'git', 'active', 'cmd', exeName), gitRoot: path.join(paths.runtimeRoot, 'git', 'active'), source: 'bundled' },
    { gitPath: path.join(paths.runtimeRoot, 'git', 'active', 'mingw64', 'bin', exeName), gitRoot: path.join(paths.runtimeRoot, 'git', 'active'), source: 'bundled' },
    { gitPath: path.join(paths.runtimeRoot, 'git', 'active', exeName), gitRoot: path.join(paths.runtimeRoot, 'git', 'active'), source: 'bundled' }
  ].filter(Boolean).filter((item) => item.gitPath);

  const candidates = packaged
    ? baseCandidates
    : [
        ...baseCandidates,
        { gitPath: 'git', gitRoot: undefined, source: 'system-dev-fallback' }
      ];

  for (const candidate of candidates) {
    if (await canExecute(candidate.gitPath) && await isGitExecutable(candidate.gitPath)) {
      return {
        gitPath: candidate.gitPath,
        gitRoot: candidate.gitRoot,
        version: await readGitVersion(candidate.gitPath),
        source: candidate.source
      };
    }
  }

  throw new AppError('GIT_RUNTIME_NOT_FOUND', '没有找到可执行的内置 Git，无法拉取仓库订阅');
}

function createEnvGitCandidate(paths, packaged) {
  const gitPath = process.env.SCRIPTPILOT_GIT_PATH;
  if (!gitPath) return undefined;
  if (packaged) {
    assertInsidePath(paths.portableRoot, gitPath, 'Git 运行时路径');
  }
  return {
    gitPath,
    gitRoot: path.dirname(path.dirname(gitPath)),
    source: 'env'
  };
}

function isElectronPackagedExe() {
  return process.versions.electron && path.basename(process.execPath).toLowerCase() !== 'electron.exe';
}

async function canExecute(filePath) {
  try {
    if (filePath === 'git') return true;
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readGitVersion(gitPath) {
  return new Promise((resolve) => {
    const child = spawn(gitPath, ['--version'], { windowsHide: true });
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

async function isGitExecutable(gitPath) {
  const version = await readGitVersion(gitPath);
  return /^git version \d+\.\d+\.\d+/.test(version);
}

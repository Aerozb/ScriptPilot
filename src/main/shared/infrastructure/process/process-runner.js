import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { assertInsidePath, createPortableProcessEnv } from '../../../bootstrap/portable-paths.js';

const MAX_CAPTURE_BYTES = 256 * 1024;
const runningProcesses = new Map();

export async function runNodeScript(input) {
  if (input.paths) {
    assertInsidePath(input.paths.portableRoot, input.scriptPath, '脚本路径');
    assertInsidePath(input.paths.portableRoot, input.cwd, '工作目录');
    assertInsidePath(input.paths.portableRoot, input.stdoutPath, '标准输出日志路径');
    assertInsidePath(input.paths.portableRoot, input.stderrPath, '错误日志路径');
  }

  await mkdir(path.dirname(input.stdoutPath), { recursive: true });
  await mkdir(path.dirname(input.stderrPath), { recursive: true });

  const startedAt = new Date();
  const streamOptions = { encoding: 'utf8', flags: input.appendLog ? 'a' : 'w' };
  const stdoutFile = createWriteStream(input.stdoutPath, streamOptions);
  const stderrFile = createWriteStream(input.stderrPath, streamOptions);
  const args = [input.scriptPath, ...(input.args || [])];
  let stdoutText = '';
  let stderrText = '';
  let timedOut = false;

  return new Promise((resolve, reject) => {
    const child = spawn(input.nodePath, args, {
      cwd: input.cwd,
      env: input.paths
        ? createPortableProcessEnv(input.paths, input.env)
        : { ...process.env, ...(input.env || {}) },
      windowsHide: true
    });
    if (input.runId) {
      runningProcesses.set(input.runId, child);
    }
    if (typeof input.onStarted === 'function') {
      input.onStarted({
        pid: child.pid
      });
    }

    const timeout = input.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, input.timeoutMs)
      : undefined;

    child.stdout.on('data', (chunk) => {
      stdoutFile.write(chunk);
      if (Buffer.byteLength(stdoutText) < MAX_CAPTURE_BYTES) {
        stdoutText += chunk.toString('utf8');
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrFile.write(chunk);
      if (Buffer.byteLength(stderrText) < MAX_CAPTURE_BYTES) {
        stderrText += chunk.toString('utf8');
      }
    });

    child.on('error', async (error) => {
      if (timeout) clearTimeout(timeout);
      if (input.runId) runningProcesses.delete(input.runId);
      stdoutFile.end();
      stderrFile.end();
      await Promise.allSettled([finished(stdoutFile), finished(stderrFile)]);
      reject(error);
    });

    child.on('close', async (exitCode, signal) => {
      if (timeout) clearTimeout(timeout);
      if (input.runId) runningProcesses.delete(input.runId);
      stdoutFile.end();
      stderrFile.end();
      await Promise.allSettled([finished(stdoutFile), finished(stderrFile)]);

      const endedAt = new Date();
      resolve({
        exitCode,
        signal,
        timedOut,
        stdoutText,
        stderrText,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime()
      });
    });
  });
}

export function stopRunningNodeScript(runId) {
  const child = runningProcesses.get(runId);
  if (!child) return false;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL');
  }, 1500).unref?.();
  return true;
}

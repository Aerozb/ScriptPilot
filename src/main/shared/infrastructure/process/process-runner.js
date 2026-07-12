import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { assertInsidePath, createPortableProcessEnv } from '../../../bootstrap/portable-paths.js';

const MAX_CAPTURE_BYTES = 256 * 1024;
const runningProcesses = new Map();

// 按字节上限累积输出块，最后统一解码，避免多字节字符被块边界截断。
function createOutputCapture() {
  const chunks = [];
  let capturedBytes = 0;
  return {
    push(chunk) {
      if (capturedBytes >= MAX_CAPTURE_BYTES) return;
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(slice);
      capturedBytes += slice.length;
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    }
  };
}

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
  const stdoutCapture = createOutputCapture();
  const stderrCapture = createOutputCapture();
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
      stdoutCapture.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrFile.write(chunk);
      stderrCapture.push(chunk);
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
        stdoutText: stdoutCapture.text(),
        stderrText: stderrCapture.text(),
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
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }, 1500).unref?.();
  return true;
}

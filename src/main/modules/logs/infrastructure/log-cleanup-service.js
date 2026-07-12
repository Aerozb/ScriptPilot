import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertInsidePath, resolvePortablePath } from '../../../bootstrap/portable-paths.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = 'log-cleanup-state.json';

export class LogCleanupService {
  constructor(deps) {
    this.paths = deps.paths;
    this.runRepository = deps.runRepository;
    this.settingsRepository = deps.settingsRepository;
    this.timer = undefined;
    this.intervalMs = deps.intervalMs || 60 * 60 * 1000;
    this.isCleaning = false;
  }

  start() {
    if (this.timer) return;
    this.runDueCleanup().catch((error) => {
      console.error('日志清理启动检查失败:', error);
    });
    this.timer = setInterval(() => {
      this.runDueCleanup().catch((error) => {
        console.error('日志定期清理失败:', error);
      });
    }, this.intervalMs);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runDueCleanup(now = new Date()) {
    const settings = await this.settingsRepository.get();
    const cleanup = settings.logCleanup;
    if (!cleanup.enabled) {
      return {
        skipped: true,
        reason: '日志清理未启用',
        settings: cleanup
      };
    }

    const lastCleanedAt = cleanup.lastCleanedAt ? new Date(cleanup.lastCleanedAt) : undefined;
    const intervalMs = cleanup.intervalDays * DAY_MS;
    if (lastCleanedAt && Number.isFinite(lastCleanedAt.getTime()) && now.getTime() - lastCleanedAt.getTime() < intervalMs) {
      return {
        skipped: true,
        reason: '未到下次清理时间',
        nextCleanAt: new Date(lastCleanedAt.getTime() + intervalMs).toISOString(),
        settings: cleanup
      };
    }

    return this.cleanNow({ now });
  }

  async cleanNow(options = {}) {
    if (this.isCleaning) {
      return {
        skipped: true,
        reason: '已有清理任务正在执行'
      };
    }

    this.isCleaning = true;
    try {
      const settings = await this.settingsRepository.get();
      const cleanup = settings.logCleanup;
      const now = options.now || new Date();
      const cutoff = new Date(now.getTime() - cleanup.retentionDays * DAY_MS);
      const runs = await this.runRepository.list();
      const expiredRuns = runs.filter((run) => isExpiredRun(run, cutoff));
      const deletedLogFiles = [];
      const failedLogFiles = [];

      for (const run of expiredRuns) {
        for (const logPath of [run.stdoutPath, run.stderrPath]) {
          if (!logPath) continue;
          const result = await deletePortableLogFile(this.paths, logPath);
          if (result.deleted) deletedLogFiles.push(result.path);
          if (result.failed) failedLogFiles.push(result);
        }
      }

      const runIds = expiredRuns.map((run) => run.id);
      const deleteResult = await this.runRepository.deleteByIds(runIds);
      const cleanedAt = now.toISOString();
      const savedSettings = await this.settingsRepository.save({
        logCleanup: {
          ...cleanup,
          lastCleanedAt: cleanedAt
        }
      });
      const summary = {
        cleanedAt,
        cutoffAt: cutoff.toISOString(),
        retentionDays: cleanup.retentionDays,
        intervalDays: cleanup.intervalDays,
        deletedRuns: deleteResult.deleted,
        deletedLogFiles: deletedLogFiles.length,
        failedLogFiles,
        settings: savedSettings.logCleanup
      };

      await writeFile(path.join(this.paths.appStateRoot, STATE_FILE), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
      return summary;
    } finally {
      this.isCleaning = false;
    }
  }
}

function isExpiredRun(run, cutoff) {
  if (!run || run.status === 'running') return false;
  const basis = run.endedAt || run.startedAt;
  if (!basis) return false;
  const time = new Date(basis).getTime();
  return Number.isFinite(time) && time < cutoff.getTime();
}

async function deletePortableLogFile(paths, logPath) {
  try {
    const resolved = resolvePortablePath(paths, logPath, { label: '日志路径' });
    assertInsidePath(paths.logsRoot, resolved, '日志路径');
    await rm(resolved, { force: true });
    return { deleted: true, path: resolved };
  } catch (error) {
    return {
      failed: true,
      path: logPath,
      code: error.code,
      message: error.message
    };
  }
}

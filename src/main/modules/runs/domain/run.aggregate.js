import { randomUUID } from 'node:crypto';

export class Run {
  constructor(props) {
    this.id = props.id;
    this.taskId = props.taskId;
    this.name = props.name;
    this.scriptPath = props.scriptPath;
    this.trigger = props.trigger;
    this.status = props.status;
    this.pid = props.pid;
    this.startedAt = props.startedAt;
    this.endedAt = props.endedAt;
    this.durationMs = props.durationMs;
    this.exitCode = props.exitCode;
    this.signal = props.signal;
    this.stdoutPath = props.stdoutPath;
    this.stderrPath = props.stderrPath;
    this.errorMessage = props.errorMessage;
    this.runtime = props.runtime;
    this.dependencyCheck = props.dependencyCheck;
  }

  static start(input, now = new Date()) {
    return new Run({
      id: input.id || randomUUID(),
      taskId: input.taskId,
      name: input.name,
      scriptPath: input.scriptPath,
      trigger: input.trigger,
      status: 'running',
      startedAt: now.toISOString(),
      stdoutPath: input.stdoutPath,
      stderrPath: input.stderrPath,
      runtime: input.runtime,
      dependencyCheck: input.dependencyCheck
    });
  }

  static fromRecord(record) {
    return new Run(record);
  }

  markFinished(result) {
    this.status = result.timedOut ? 'timeout' : result.exitCode === 0 ? 'success' : 'failed';
    this.endedAt = result.endedAt;
    this.durationMs = result.durationMs;
    this.exitCode = result.exitCode;
    this.signal = result.signal;
    this.errorMessage = result.timedOut ? '脚本执行超时' : result.exitCode === 0 ? undefined : result.stderrText;
  }

  markFailed(error, now = new Date()) {
    this.status = 'failed';
    this.endedAt = now.toISOString();
    this.durationMs = new Date(this.endedAt).getTime() - new Date(this.startedAt).getTime();
    this.errorMessage = error.message;
  }

  markStopped(reason = '用户停止', now = new Date()) {
    this.status = 'stopped';
    this.endedAt = now.toISOString();
    this.durationMs = new Date(this.endedAt).getTime() - new Date(this.startedAt).getTime();
    this.signal = this.signal || 'SIGTERM';
    this.errorMessage = reason;
  }

  toRecord() {
    return {
      id: this.id,
      taskId: this.taskId,
      name: this.name,
      scriptPath: this.scriptPath,
      trigger: this.trigger,
      status: this.status,
      pid: this.pid,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: this.durationMs,
      exitCode: this.exitCode,
      signal: this.signal,
      stdoutPath: this.stdoutPath,
      stderrPath: this.stderrPath,
      errorMessage: this.errorMessage,
      runtime: this.runtime,
      dependencyCheck: this.dependencyCheck
    };
  }
}

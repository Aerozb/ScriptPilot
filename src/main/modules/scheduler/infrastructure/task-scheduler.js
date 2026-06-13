import { runTaskNowCommand } from '../../runs/application/commands/run-task-now.command.js';
import { isCronDue } from './cron-expression.js';

export class TaskScheduler {
  constructor(deps) {
    this.taskRepository = deps.taskRepository;
    this.commandBus = deps.commandBus;
    this.intervalMs = deps.intervalMs || 15000;
    this.lastFiredMinutes = new Map();
    this.timer = undefined;
    this.isTicking = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        console.error('调度器执行失败:', error);
      });
    }, this.intervalMs);
    this.tick().catch((error) => {
      console.error('调度器启动检查失败:', error);
    });
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now = new Date()) {
    if (this.isTicking) return;
    this.isTicking = true;

    try {
      const minuteKey = toMinuteKey(now);
      const tasks = await this.taskRepository.list();
      for (const task of tasks) {
        if (!task.enabled) continue;
        if (!isTaskDue(task, now)) continue;
        if (this.lastFiredMinutes.get(task.id) === minuteKey) continue;

        this.lastFiredMinutes.set(task.id, minuteKey);
        this.commandBus.execute(runTaskNowCommand({
          taskId: task.id,
          trigger: 'schedule'
        })).catch((error) => {
          console.error(`定时任务执行失败: ${task.name}`, error);
        });
      }
    } finally {
      this.isTicking = false;
    }
  }
}

function isTaskDue(task, now) {
  return [task.cronExpression, ...(task.extraSchedules || [])]
    .filter(Boolean)
    .filter((expression) => !String(expression).startsWith('@'))
    .some((expression) => isCronDue(expression, now));
}

function toMinuteKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

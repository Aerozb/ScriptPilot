import { AppError } from '../../../shared/errors/app-error.js';
import { assertValidCronExpression } from '../../scheduler/infrastructure/cron-expression.js';

export function assertValidTaskSchedules(input) {
  assertValidTaskCron(input.cronExpression, 'Cron 表达式', { allowSpecial: true });

  if (input.extraSchedules !== undefined && !Array.isArray(input.extraSchedules)) {
    throw new AppError('INVALID_EXTRA_SCHEDULES', '额外定时规则 extraSchedules 必须是数组');
  }

  for (const schedule of input.extraSchedules || []) {
    assertValidTaskCron(schedule, '额外定时规则', { allowSpecial: false });
  }
}

function assertValidTaskCron(expression, label, options = {}) {
  if (!expression) return;

  const value = String(expression).trim();
  if (!value) return;
  if (value.startsWith('@')) {
    if (options.allowSpecial && ['@once', '@boot'].includes(value)) return;
    throw new AppError('INVALID_CRON', `${label} 不支持 ${value}`);
  }

  assertValidCronExpression(value);
}

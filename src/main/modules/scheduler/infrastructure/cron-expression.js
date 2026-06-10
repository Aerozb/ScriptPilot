import { AppError } from '../../../shared/errors/app-error.js';

const FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6]
];

export function isCronDue(expression, date = new Date()) {
  const fields = parseCronExpression(expression);
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay()
  ];

  return fields.every((field, index) => field.has(values[index]));
}

export function assertValidCronExpression(expression) {
  parseCronExpression(expression);
}

function parseCronExpression(expression) {
  if (!expression || typeof expression !== 'string') {
    throw new AppError('INVALID_CRON', 'Cron 表达式不能为空');
  }

  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new AppError('INVALID_CRON', 'Cron 表达式必须是 5 段: 分 时 日 月 周');
  }

  return parts.map((part, index) => parseCronField(part, FIELD_RANGES[index]));
}

function parseCronField(field, [min, max]) {
  const values = new Set();
  for (const segment of field.split(',')) {
    fillSegment(values, segment.trim(), min, max);
  }

  if (!values.size) {
    throw new AppError('INVALID_CRON', `Cron 字段无有效值: ${field}`);
  }

  return values;
}

function fillSegment(values, segment, min, max) {
  if (!segment) return;
  const [rangePart, stepPart] = segment.split('/');
  const step = stepPart ? Number(stepPart) : 1;
  if (!Number.isInteger(step) || step <= 0) {
    throw new AppError('INVALID_CRON', `Cron 步长无效: ${segment}`);
  }

  let start;
  let end;
  if (rangePart === '*') {
    start = min;
    end = max;
  } else if (rangePart.includes('-')) {
    const [rawStart, rawEnd] = rangePart.split('-').map(Number);
    start = rawStart;
    end = rawEnd;
  } else {
    start = Number(rangePart);
    end = Number(rangePart);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
    throw new AppError('INVALID_CRON', `Cron 取值超出范围: ${segment}`);
  }

  for (let value = start; value <= end; value += step) {
    values.add(value);
  }
}

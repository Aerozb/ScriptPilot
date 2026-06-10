export class AppError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  toPayload() {
    return {
      code: this.code,
      message: this.message,
      details: this.details
    };
  }
}

export function toAppError(error) {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError('UNKNOWN_ERROR', error?.message || '未知错误', {
    cause: error?.name
  });
}

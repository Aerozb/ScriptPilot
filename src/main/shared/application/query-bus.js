import { AppError } from '../errors/app-error.js';

export class QueryBus {
  constructor() {
    this.handlers = new Map();
  }

  register(type, handler) {
    if (this.handlers.has(type)) {
      throw new AppError('QUERY_ALREADY_REGISTERED', `查询已注册: ${type}`);
    }

    this.handlers.set(type, handler);
  }

  async execute(query) {
    const handler = this.handlers.get(query.type);
    if (!handler) {
      throw new AppError('QUERY_NOT_REGISTERED', `查询未注册: ${query.type}`);
    }

    return handler.handle(query);
  }
}

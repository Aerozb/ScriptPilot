import { AppError } from '../errors/app-error.js';

export class CommandBus {
  constructor() {
    this.handlers = new Map();
  }

  register(type, handler) {
    if (this.handlers.has(type)) {
      throw new AppError('COMMAND_ALREADY_REGISTERED', `命令已注册: ${type}`);
    }

    this.handlers.set(type, handler);
  }

  async execute(command) {
    const handler = this.handlers.get(command.type);
    if (!handler) {
      throw new AppError('COMMAND_NOT_REGISTERED', `命令未注册: ${command.type}`);
    }

    return handler.handle(command);
  }
}

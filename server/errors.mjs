export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const safeError = (error) => error instanceof AppError
  ? { code: error.code, message: error.message }
  : { code: 'SERVICE_ERROR', message: '服务暂时不可用，请查看任务状态。不会自动重新生图。' };

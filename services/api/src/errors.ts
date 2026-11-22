export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) { super(message); this.name = 'AppError'; }
}

export function notFound(): AppError {
  return new AppError(404, 'NOT_FOUND', '内容不存在或当前无法访问');
}

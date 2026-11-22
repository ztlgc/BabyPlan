import type { z } from 'zod';
import { AppError } from '../errors.js';

export function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, 'INVALID_REQUEST', '输入格式不正确，请检查后重试');
  }
  return parsed.data;
}

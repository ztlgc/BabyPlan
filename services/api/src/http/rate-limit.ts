import { AppError } from '../errors.js';

type Bucket = { startedAt: number; count: number };

export function createFixedWindowLimiter(maxRequests: number, windowMs: number): (key: string) => void {
  const buckets = new Map<string, Bucket>();
  return key => {
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [bucketKey, bucket] of buckets) {
        if (now - bucket.startedAt >= windowMs) buckets.delete(bucketKey);
      }
    }
    const current = buckets.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      buckets.set(key, { startedAt: now, count: 1 });
      return;
    }
    if (current.count >= maxRequests) {
      throw new AppError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
    }
    current.count += 1;
  };
}

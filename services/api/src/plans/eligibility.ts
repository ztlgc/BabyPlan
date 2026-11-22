import type { ContentCard } from '../content/package.js';
import { dateValue } from '../families/repository.js';

function monthDistance(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    end.getUTCMonth() - start.getUTCMonth() -
    Number(end.getUTCDate() < Math.min(start.getUTCDate(), lastDay));
}

export function ageMonthsAtDate(child: Record<string, unknown>, localDate: string): number | null {
  const estimated = child.age_mode === 'months';
  const baseline = dateValue((estimated ? child.age_as_of : child.birth_date) as string | Date | null);
  if (!baseline) return null;
  return (estimated ? Number(child.age_months) : 0) + monthDistance(baseline, localDate);
}

export function ageBandAtDate(child: Record<string, unknown>, localDate: string): string | null {
  const months = ageMonthsAtDate(child, localDate);
  if (months === null || months < 12 || months > 36) return null;
  if (months < 15) return 'm12_14';
  if (months < 18) return 'm15_17';
  if (months < 24) return 'm18_23';
  if (months < 30) return 'm24_29';
  if (months < 36) return 'm30_35';
  return 'm36';
}

export function curriculumDayAtDate(child: Record<string, unknown>, localDate: string): number | null {
  const months = ageMonthsAtDate(child, localDate);
  if (months === null || months < 12 || months >= 24) return null;
  const estimated = child.age_mode === 'months';
  const baseline = dateValue((estimated ? child.age_as_of : child.birth_date) as string | Date | null)!;
  const elapsed = (from: string) => Math.round((Date.parse(`${localDate}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  let day: number;
  if (estimated) {
    day = Math.floor((Number(child.age_months) - 12) * 365 / 12) + elapsed(baseline) + 1;
  } else {
    const birth = new Date(`${baseline}T00:00:00Z`);
    const year = birth.getUTCFullYear() + 1;
    const month = birth.getUTCMonth();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const anniversary = new Date(Date.UTC(year, month, Math.min(birth.getUTCDate(), lastDay))).toISOString().slice(0, 10);
    day = elapsed(anniversary) + 1;
  }
  // 月龄记录是估算；闰年多出的一天复玩第 365 项，满两岁后使用后续月龄内容。
  return Math.max(1, Math.min(365, day));
}

export function materialsMatch(materials: string[], available: ReadonlySet<string>, excluded: ReadonlySet<string>): boolean {
  return !materials.some(material => excluded.has(material)) &&
    (!available.size || materials.every(material => available.has(material)));
}

export function languageMatches(kind: ContentCard['kind'], language: string): boolean {
  return language !== 'zh' || kind !== 'english';
}

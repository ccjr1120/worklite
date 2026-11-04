import type { AppLocale } from './locale';

function toDate(value: Date | string | number): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: Date | string | number, locale: AppLocale): string {
  const date = toDate(value);
  if (!date) {
    return String(value);
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatNumber(value: number, locale: AppLocale): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** Token usage always uses k; three decimals preserve individual whole tokens. */
export function formatTokenCount(value: number, locale: AppLocale): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value / 1_000)}k`;
}

export function formatCurrency(value: number, locale: AppLocale, currency = 'USD'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function durationParts(totalSeconds: number): { minutes: string; seconds: string } {
  const safe = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return {
    minutes: String(minutes).padStart(2, '0'),
    seconds: String(seconds).padStart(2, '0'),
  };
}

export function formatDuration(totalMilliseconds: number): string {
  const { minutes, seconds } = durationParts(totalMilliseconds / 1_000);
  return `${minutes}:${seconds}`;
}

export function formatList(values: Iterable<string>, locale: AppLocale): string {
  const items = [...values];
  if (items.length === 0) {
    return '';
  }

  return new Intl.ListFormat(locale, { style: 'narrow', type: 'conjunction' }).format(items);
}

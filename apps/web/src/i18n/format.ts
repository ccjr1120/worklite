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

export function formatDate(value: Date | string | number, locale: AppLocale): string {
  const date = toDate(value);
  if (!date) {
    return String(value);
  }

  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

export function formatRelativeTime(value: Date | string | number, locale: AppLocale, now = new Date()): string {
  const date = toDate(value);
  if (!date) {
    return String(value);
  }

  const diffSeconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  if (absSeconds < 60) {
    return formatter.format(diffSeconds, 'second');
  }

  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, 'minute');
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, 'hour');
  }

  const diffDays = Math.round(diffHours / 24);
  if (Math.abs(diffDays) < 30) {
    return formatter.format(diffDays, 'day');
  }

  const diffMonths = Math.round(diffDays / 30);
  if (Math.abs(diffMonths) < 12) {
    return formatter.format(diffMonths, 'month');
  }

  return formatter.format(Math.round(diffDays / 365), 'year');
}

export function formatNumber(value: number, locale: AppLocale): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatPercent(value: number, locale: AppLocale): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value);
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

export function formatList(values: Iterable<string>, locale: AppLocale): string {
  const items = [...values];
  if (items.length === 0) {
    return '';
  }

  return new Intl.ListFormat(locale, { style: 'narrow', type: 'conjunction' }).format(items);
}

export function greetingPeriod(now = new Date()): 'night' | 'morning' | 'afternoon' | 'evening' {
  const hour = now.getHours();
  if (hour < 5) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'night';
}

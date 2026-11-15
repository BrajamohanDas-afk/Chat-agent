import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';

export type Confidence = 'high' | 'medium' | 'low';

export type ResolvedDate = {
  original: string;
  timezone: string;
  referenceIso: string;
  localStart: string;
  localEndExclusive: string;
  utcStart: string;
  utcEndExclusive: string;
  confidence: Confidence;
};

export class DateParseError extends Error {}

const LAST = /^\s*last\s+/i;
const MODIFIER = /^\s*(last|next|this)\s+/i;

export function resolveDate(
  expression: string,
  referenceIso: string,
  timezone: string,
): ResolvedDate {
  const ref = DateTime.fromISO(referenceIso, { zone: timezone });
  if (!ref.isValid) throw new DateParseError(`Invalid reference time: ${referenceIso}`);

  // Noon on the reference's local calendar date keeps chrono away from day boundaries.
  const anchor = new Date(ref.year, ref.month - 1, ref.day, 12, 0, 0);
  const parsed = chrono.parse(expression, anchor, { forwardDate: false });
  if (parsed.length === 0) throw new DateParseError(`Unrecognized date: ${expression}`);

  const first = parsed[0]!;
  const parsedDate = first.start.date();
  let day = DateTime.fromObject(
    {
      year: parsedDate.getFullYear(),
      month: parsedDate.getMonth() + 1,
      day: parsedDate.getDate(),
    },
    { zone: timezone },
  );

  // chrono resolves bare weekdays forward. A date question means the most recent
  // one, and "last X" on X must mean seven days ago.
  const bareWeekday =
    first.start.isCertain('weekday') &&
    !first.start.isCertain('day') &&
    !first.start.isCertain('month');
  if (bareWeekday) {
    const modifier = expression.match(MODIFIER)?.[1]?.toLowerCase();
    const refDay = ref.startOf('day');
    const dayStart = day.startOf('day');
    if (modifier === 'last' && dayStart >= refDay) {
      day = day.minus({ days: 7 });
    } else if (modifier !== 'next' && dayStart > refDay) {
      day = day.minus({ days: 7 });
    }
  }

  const start = day.startOf('day');
  const end = start.plus({ days: 1 });
  let confidence: Confidence = 'medium';
  if (parsed.length > 1) {
    confidence = 'low';
  } else if (
    LAST.test(expression) ||
    (first.start.isCertain('day') && first.start.isCertain('month'))
  ) {
    confidence = 'high';
  }
  return {
    original: expression,
    timezone,
    referenceIso,
    localStart: start.toISO()!,
    localEndExclusive: end.toISO()!,
    utcStart: start.toUTC().toISO()!,
    utcEndExclusive: end.toUTC().toISO()!,
    confidence,
  };
}

export function inRange(iso: string, resolved: ResolvedDate): boolean {
  return iso >= resolved.utcStart && iso < resolved.utcEndExclusive;
}

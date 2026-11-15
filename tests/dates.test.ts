import { describe, expect, it } from 'vitest';
import { DateParseError, inRange, resolveDate } from '../src/domain/dates.js';

const KOLKATA = 'Asia/Kolkata';
const REF = '2026-11-14T09:00:00+05:30';

describe('resolveDate', () => {
  it('resolves an explicit day and month to a half-open local day', () => {
    const resolved = resolveDate('3 November', REF, KOLKATA);

    expect(resolved.original).toBe('3 November');
    expect(resolved.timezone).toBe(KOLKATA);
    expect(resolved.referenceIso).toBe(REF);
    expect(resolved.localStart).toBe('2026-11-03T00:00:00.000+05:30');
    expect(resolved.localEndExclusive).toBe('2026-11-04T00:00:00.000+05:30');
    expect(resolved.utcStart).toBe('2026-11-02T18:30:00.000Z');
    expect(resolved.utcEndExclusive).toBe('2026-11-03T18:30:00.000Z');
  });

  it('resolves "last Tuesday" to the prior Tuesday from a Saturday', () => {
    const resolved = resolveDate('last Tuesday', REF, KOLKATA);

    expect(resolved.localStart).toBe('2026-11-10T00:00:00.000+05:30');
    expect(resolved.localEndExclusive).toBe('2026-11-11T00:00:00.000+05:30');
  });

  it('resolves "last Tuesday" seven days back when the reference is a Tuesday', () => {
    const resolved = resolveDate('last Tuesday', '2026-11-10T09:00:00+05:30', KOLKATA);

    expect(resolved.localStart).toBe('2026-11-03T00:00:00.000+05:30');
    expect(resolved.localEndExclusive).toBe('2026-11-04T00:00:00.000+05:30');
  });

  it('resolves a bare weekday to the most recent occurrence, never the future', () => {
    const resolved = resolveDate('Monday', REF, KOLKATA);

    expect(resolved.localStart).toBe('2026-11-09T00:00:00.000+05:30');
    expect(resolved.localEndExclusive).toBe('2026-11-10T00:00:00.000+05:30');
  });

  it('handles a month boundary', () => {
    const resolved = resolveDate('1 November', REF, KOLKATA);

    expect(resolved.localStart).toBe('2026-11-01T00:00:00.000+05:30');
    expect(resolved.localEndExclusive).toBe('2026-11-02T00:00:00.000+05:30');
  });

  it('handles a year boundary', () => {
    const resolved = resolveDate('31 December', REF, KOLKATA);

    expect(resolved.localStart).toBe('2026-12-31T00:00:00.000+05:30');
    expect(resolved.localEndExclusive).toBe('2027-01-01T00:00:00.000+05:30');
    expect(resolved.utcStart).toBe('2026-12-30T18:30:00.000Z');
    expect(resolved.utcEndExclusive).toBe('2026-12-31T18:30:00.000Z');
  });

  it('covers exactly one local day across the spring-forward transition', () => {
    const resolved = resolveDate('8 March', '2026-03-01T09:00:00-05:00', 'America/New_York');
    const hours = (Date.parse(resolved.utcEndExclusive) - Date.parse(resolved.utcStart)) / 3_600_000;

    expect(resolved.localStart).toBe('2026-03-08T00:00:00.000-05:00');
    expect(resolved.localEndExclusive).toBe('2026-03-09T00:00:00.000-04:00');
    expect(hours).toBe(23);
  });

  it('covers exactly one local day across the fall-back transition', () => {
    const resolved = resolveDate('1 November', '2026-10-25T09:00:00-04:00', 'America/New_York');
    const hours = (Date.parse(resolved.utcEndExclusive) - Date.parse(resolved.utcStart)) / 3_600_000;

    expect(resolved.localStart).toBe('2026-11-01T00:00:00.000-04:00');
    expect(resolved.localEndExclusive).toBe('2026-11-02T00:00:00.000-05:00');
    expect(hours).toBe(25);
  });

  it('derives confidence from the parse shape', () => {
    expect(resolveDate('3 Nov or 4 Nov', REF, KOLKATA).confidence).toBe('low');
    expect(resolveDate('last Tuesday', REF, KOLKATA).confidence).toBe('high');
    expect(resolveDate('3 November', REF, KOLKATA).confidence).toBe('high');
    expect(resolveDate('Monday', REF, KOLKATA).confidence).toBe('medium');
  });

  it('throws DateParseError for unusable input', () => {
    expect(() => resolveDate('banana', REF, KOLKATA)).toThrow(DateParseError);
    expect(() => resolveDate('3 November', 'not-a-timestamp', KOLKATA)).toThrow(DateParseError);
  });
});

describe('inRange', () => {
  const resolved = resolveDate('3 November', REF, KOLKATA);

  it('includes the start and excludes the end', () => {
    expect(inRange(resolved.utcStart, resolved)).toBe(true);
    expect(inRange('2026-11-03T18:29:59.999Z', resolved)).toBe(true);
    expect(inRange(resolved.utcEndExclusive, resolved)).toBe(false);
  });

  it('excludes timestamps before the interval', () => {
    expect(inRange('2026-11-02T18:29:59.999Z', resolved)).toBe(false);
  });
});

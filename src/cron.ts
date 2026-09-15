/**
 * Cron expression parsing and next-fire-time computation.
 *
 * Supports the classic 5-field form (`minute hour day-of-month month
 * day-of-week`), the 6-field form with a leading seconds field, the standard
 * `@alias` shorthands, ranges, lists, steps, and month/weekday names.
 *
 * Standard Vixie-cron semantics are preserved: when *both* day-of-month and
 * day-of-week are restricted, a date matches if *either* field matches.
 */

export class CronParseError extends Error {
  constructor(
    message: string,
    readonly expression: string,
    readonly field?: string,
  ) {
    super(`Invalid cron expression "${expression}"${field ? ` (field "${field}")` : ""}: ${message}`);
    this.name = "CronParseError";
  }
}

export interface CronFields {
  seconds: number[];
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** `true` when the expression constrains day-of-month (not `*`). */
  domRestricted: boolean;
  /** `true` when the expression constrains day-of-week (not `*`). */
  dowRestricted: boolean;
  /** Whether the source expression carried a leading seconds field. */
  hasSeconds: boolean;
  /** Set when the expression was an `@alias`. */
  alias?: string;
  expression: string;
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const DOW_NAMES: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
  "@minutely": "* * * * *",
  "@secondly": "* * * * * *",
};

export const CRON_ALIASES: Readonly<Record<string, string>> = Object.freeze({ ...ALIASES });

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
  /** Day-of-week accepts `7` as an alias for Sunday. */
  foldSeven?: boolean;
}

function expandField(raw: string, spec: FieldSpec, expression: string): { values: number[]; restricted: boolean } {
  const field = raw.trim();
  if (!field) throw new CronParseError("empty field", expression, spec.name);
  if (field === "*") {
    return { values: range(spec.min, spec.max), restricted: false };
  }

  const restricted = true;
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const segment = part.trim();
    if (!segment) throw new CronParseError("empty list segment", expression, spec.name);

    const [base, stepRaw] = splitStep(segment, expression, spec);
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) throw new CronParseError(`invalid step "${stepRaw}"`, expression, spec.name);
      step = Number(stepRaw);
      if (step < 1) throw new CronParseError(`step must be >= 1, got ${step}`, expression, spec.name);
    }

    let from: number;
    let to: number;

    if (base === "*") {
      from = spec.min;
      to = spec.max;
    } else if (base.includes("-")) {
      const [a, b, ...rest] = base.split("-");
      if (rest.length || a === undefined || b === undefined) {
        throw new CronParseError(`invalid range "${base}"`, expression, spec.name);
      }
      from = parseAtom(a, spec, expression);
      to = parseAtom(b, spec, expression);
      if (from > to) throw new CronParseError(`range start ${from} exceeds end ${to}`, expression, spec.name);
    } else {
      from = parseAtom(base, spec, expression);
      // `N/step` means "from N to max, every step" (Vixie behaviour).
      to = stepRaw !== undefined ? spec.max : from;
    }

    for (let value = from; value <= to; value += step) {
      values.add(normalizeValue(value, spec, expression));
    }
  }

  if (values.size === 0) throw new CronParseError("field matches no values", expression, spec.name);
  return { values: [...values].sort((a, b) => a - b), restricted };
}

function splitStep(segment: string, expression: string, spec: FieldSpec): [string, string | undefined] {
  const parts = segment.split("/");
  if (parts.length > 2) throw new CronParseError(`invalid step syntax "${segment}"`, expression, spec.name);
  const base = parts[0];
  if (base === undefined) throw new CronParseError(`invalid step syntax "${segment}"`, expression, spec.name);
  return [base, parts[1]];
}

function parseAtom(atom: string, spec: FieldSpec, expression: string): number {
  const token = atom.trim().toUpperCase();
  if (!token) throw new CronParseError("empty value", expression, spec.name);

  if (spec.names && token in spec.names) return spec.names[token] as number;
  if (!/^\d+$/.test(token)) throw new CronParseError(`unrecognised value "${atom}"`, expression, spec.name);

  const value = Number(token);
  return normalizeValue(value, spec, expression);
}

function normalizeValue(value: number, spec: FieldSpec, expression: string): number {
  if (spec.foldSeven && value === 7) return 0;
  if (value < spec.min || value > spec.max) {
    throw new CronParseError(`value ${value} outside ${spec.min}-${spec.max}`, expression, spec.name);
  }
  return value;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i += 1) out.push(i);
  return out;
}

/** Parse a cron expression into its expanded field sets. */
export function parseCron(expression: string): CronFields {
  if (typeof expression !== "string" || expression.trim() === "") {
    throw new CronParseError("expression is empty", String(expression));
  }

  const source = expression.trim();
  let body = source;
  let alias: string | undefined;

  if (source.startsWith("@")) {
    const key = source.toLowerCase();
    const mapped = ALIASES[key];
    if (!mapped) throw new CronParseError(`unknown alias "${source}"`, expression);
    body = mapped;
    alias = key;
  }

  const tokens = body.split(/\s+/).filter(Boolean);
  if (tokens.length !== 5 && tokens.length !== 6) {
    throw new CronParseError(
      `expected 5 or 6 fields but found ${tokens.length}`,
      expression,
    );
  }

  const hasSeconds = tokens.length === 6;
  const offset = hasSeconds ? 1 : 0;

  const seconds = hasSeconds
    ? expandField(tokens[0] as string, { name: "second", min: 0, max: 59 }, expression).values
    : [0];
  const minutes = expandField(tokens[offset] as string, { name: "minute", min: 0, max: 59 }, expression);
  const hours = expandField(tokens[offset + 1] as string, { name: "hour", min: 0, max: 23 }, expression);
  const dom = expandField(tokens[offset + 2] as string, { name: "day-of-month", min: 1, max: 31 }, expression);
  const month = expandField(
    tokens[offset + 3] as string,
    { name: "month", min: 1, max: 12, names: MONTH_NAMES },
    expression,
  );
  const dow = expandField(
    tokens[offset + 4] as string,
    { name: "day-of-week", min: 0, max: 7, names: DOW_NAMES, foldSeven: true },
    expression,
  );

  return {
    seconds,
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: dom.values,
    months: month.values,
    daysOfWeek: dow.values,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
    hasSeconds,
    ...(alias ? { alias } : {}),
    expression: source,
  };
}

/** Local-time components of an epoch instant for a fixed UTC offset. */
interface LocalParts {
  year: number;
  month: number;
  dom: number;
  hour: number;
  minute: number;
  second: number;
  dow: number;
}

function localParts(epochMs: number, tzOffsetMinutes: number): LocalParts {
  const shifted = new Date(epochMs + tzOffsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    dom: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    dow: shifted.getUTCDay(),
  };
}

function epochFromLocal(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  tzOffsetMinutes: number,
): number {
  return Date.UTC(year, monthIndex, day, hour, minute, second, 0) - tzOffsetMinutes * 60_000;
}

function inSet(values: number[], value: number): boolean {
  return values.includes(value);
}

/** Evaluate whether an instant satisfies the expression. */
export function cronMatches(fields: CronFields, epochMs: number, tzOffsetMinutes = 0): boolean {
  const p = localParts(epochMs, tzOffsetMinutes);
  if (!inSet(fields.seconds, p.second)) return false;
  if (!inSet(fields.minutes, p.minute)) return false;
  if (!inSet(fields.hours, p.hour)) return false;
  if (!inSet(fields.months, p.month)) return false;
  return dayMatches(fields, p);
}

function dayMatches(fields: CronFields, p: LocalParts): boolean {
  const domOk = inSet(fields.daysOfMonth, p.dom);
  const dowOk = inSet(fields.daysOfWeek, p.dow);
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
  if (fields.domRestricted) return domOk;
  if (fields.dowRestricted) return dowOk;
  return true;
}

const MAX_SEARCH_ITERATIONS = 200_000;

/**
 * First instant strictly after `from` that satisfies the expression, or
 * `null` when no match exists within roughly 4 years of search.
 */
export function nextRun(
  fields: CronFields,
  from: number,
  tzOffsetMinutes = 0,
): number | null {
  const startSecond = Math.floor(from / 1000);
  let cursor = (startSecond + 1) * 1000;

  for (let i = 0; i < MAX_SEARCH_ITERATIONS; i += 1) {
    const p = localParts(cursor, tzOffsetMinutes);

    if (!inSet(fields.months, p.month)) {
      cursor = epochFromLocal(p.year, p.month, 1, 0, 0, 0, tzOffsetMinutes);
      continue;
    }

    if (!dayMatches(fields, p)) {
      cursor = epochFromLocal(p.year, p.month - 1, p.dom + 1, 0, 0, 0, tzOffsetMinutes);
      continue;
    }

    if (!inSet(fields.hours, p.hour)) {
      cursor = epochFromLocal(p.year, p.month - 1, p.dom, p.hour + 1, 0, 0, tzOffsetMinutes);
      continue;
    }

    if (!inSet(fields.minutes, p.minute)) {
      cursor = epochFromLocal(p.year, p.month - 1, p.dom, p.hour, p.minute + 1, 0, tzOffsetMinutes);
      continue;
    }

    if (!inSet(fields.seconds, p.second)) {
      cursor += 1000;
      continue;
    }

    return cursor;
  }

  return null;
}

/** Next `count` fire times after `from` (inclusive of the first match). */
export function nextRuns(
  fields: CronFields,
  from: number,
  count: number,
  tzOffsetMinutes = 0,
): number[] {
  const out: number[] = [];
  let cursor = from;
  for (let i = 0; i < count; i += 1) {
    const next = nextRun(fields, cursor, tzOffsetMinutes);
    if (next === null) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * Most recent instant at or before `from` that satisfies the expression.
 * Used for misfire detection when a scheduler restarts.
 */
export function previousRun(
  fields: CronFields,
  from: number,
  tzOffsetMinutes = 0,
): number | null {
  const startSecond = Math.floor(from / 1000);
  let cursor = startSecond * 1000;

  for (let i = 0; i < MAX_SEARCH_ITERATIONS; i += 1) {
    const p = localParts(cursor, tzOffsetMinutes);

    if (!inSet(fields.months, p.month)) {
      cursor = epochFromLocal(p.year, p.month - 1, 0, 23, 59, 59, tzOffsetMinutes);
      continue;
    }

    if (!dayMatches(fields, p)) {
      cursor = epochFromLocal(p.year, p.month - 1, p.dom - 1, 23, 59, 59, tzOffsetMinutes);
      continue;
    }

    if (!inSet(fields.hours, p.hour)) {
      cursor = epochFromLocal(p.year, p.month - 1, p.dom, p.hour, 0, 0, tzOffsetMinutes) - 1000;
      continue;
    }

    if (!inSet(fields.minutes, p.minute)) {
      cursor = epochFromLocal(p.year, p.month - 1, p.dom, p.hour, p.minute, 0, tzOffsetMinutes) - 1000;
      continue;
    }

    if (!inSet(fields.seconds, p.second)) {
      cursor -= 1000;
      continue;
    }

    return cursor;
  }

  return null;
}

/** Human-readable description used by the CLI and HTTP API. */
export function describeCron(fields: CronFields): string {
  if (fields.alias) return fields.alias;
  const pad = (n: number) => String(n).padStart(2, "0");
  const secs = fields.hasSeconds ? `${pad(fields.seconds[0] ?? 0)} ` : "";
  return `${secs}${fields.expression}`;
}

/**
 * Human-readable formatting for the CLI.
 *
 * Kept apart from the scheduler because presentation should never leak into
 * scheduling decisions — and because a plain-English summary of a cron
 * expression is the single most useful thing a CLI can print.
 */

import { parseCron } from "./cron.ts";

/** `950` → `950ms`, `1_500` → `1.5s`, `92_000` → `1m 32s`, `3_600_000` → `1h`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const seconds = ms / 1_000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  if (ms < 3_600_000) {
    const totalSeconds = Math.floor(ms / 1_000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** 0-6 and 7 both mean Sunday, as in crontab. */
const DOW_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/**
 * Plain-English summary for the shapes operators actually write, falling back
 * to the raw expression (never a wrong guess) for anything unusual.
 */
export function formatSchedule(expression: string): string {
  const raw = expression.trim();
  const fields = parseCron(raw);
  if (fields.alias) return fields.alias;

  const parts = raw.split(/\s+/);
  const five = parts.length === 5 ? parts : parts.length === 6 ? parts.slice(1) : null;
  if (!five || fields.hasSeconds || parts.length === 6) {
    // Second-level expressions are rare enough that showing them verbatim is
    // more helpful than a fragile description.
    return raw;
  }
  const [minute, hour, dom, month, dow] = five as [string, string, string, string, string];

  if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "every minute";

  const minuteStep = /^\*\/(\d+)$/.exec(minute);
  if (minuteStep && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `every ${minuteStep[1]} minutes`;
  }
  if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return minute === "0" ? "hourly" : `hourly at :${pad(Number(minute))}`;
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    if (dom === "*" && month === "*" && dow === "*") {
      return `daily at ${pad(Number(hour))}:${pad(Number(minute))}`;
    }
    if (/^\d+$/.test(dom) && month === "*" && dow === "*") {
      return `monthly on day ${Number(dom)} at ${pad(Number(hour))}:${pad(Number(minute))}`;
    }
    const dowName =
      /^[A-Za-z]{3}$/.test(dow)
        ? dow.toUpperCase()
        : /^\d$/.test(dow) && Number(dow) <= 7
          ? DOW_NAMES[Number(dow) % 7]
          : null;
    if (dom === "*" && month === "*" && dowName) {
      return `weekly on ${dowName} at ${pad(Number(hour))}:${pad(Number(minute))}`;
    }
  }

  return raw;
}

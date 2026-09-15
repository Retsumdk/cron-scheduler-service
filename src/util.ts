/**
 * Small dependency-free helpers shared across the service.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/** Generates a short, prefixed, collision-resistant identifier. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** Identifies this process inside lease records. */
export function defaultNodeId(): string {
  return `${hostname()}:${process.pid}`;
}

/** Extracts a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Clamps `value` into the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Truncates a string to `limit` characters, marking the cut. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [truncated ${text.length - limit} chars]`;
}

/** `setTimeout` as a promise. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses a duration such as `250ms`, `30s`, `5m`, `2h`, `1d`. */
export function parseDuration(input: string | number, fallback: number): number {
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? input : fallback;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(input.trim());
  if (!match) return fallback;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return fallback;
  const unit = (match[2] ?? "ms").toLowerCase();
  const factor = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Math.round(value * factor);
}

/** Parses `UTC`, `Z`, or `±HH:MM` / `±HHMM` into a minute offset. */
export function parseTimezoneOffset(input: string): number | null {
  const value = input.trim().toUpperCase();
  if (value === "UTC" || value === "Z" || value === "GMT") return 0;
  const match = /^([+-])(\d{1,2})(?::?(\d{2}))$/.exec(value);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  if (hours > 23 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

/** Formats a minute offset as `UTC±HH:MM`. */
export function formatTimezoneOffset(offset: number): string {
  if (offset === 0) return "UTC";
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${minutes}`;
}

/** ISO-8601 rendering that tolerates a `null` timestamp. */
export function iso(epochMs: number | null | undefined): string | null {
  return epochMs === null || epochMs === undefined ? null : new Date(epochMs).toISOString();
}

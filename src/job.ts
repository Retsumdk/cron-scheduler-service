/**
 * Job defaults, validation and normalisation.
 *
 * This module is the single source of truth for what a valid job looks like.
 * Both creation (`normalizeJob`) and update (`mergeJobPatch`) funnel through
 * the same validator, so the store can never hold a definition the scheduler
 * would choke on at 3am: a bad cron expression, a missing action, or a negative
 * timeout is rejected at write time with a specific message.
 */

import { CronParseError, parseCron } from "./cron.ts";
import type { JobDefinition, JobInput, MisfirePolicy, OverlapPolicy, ShellKind } from "./types.ts";
import { clamp, newId } from "./util.ts";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 0;
export const DEFAULT_RETRY_BACKOFF_MS = 1_000;
export const DEFAULT_MAX_CATCHUP = 100;
export const DEFAULT_TZ_OFFSET_MINUTES = 0;
export const DEFAULT_SHELL: ShellKind = "bash";
/** Missed slots are recovered once, then the job resumes its normal cadence. */
export const DEFAULT_MISFIRE: MisfirePolicy = "fire-once";
export const DEFAULT_OVERLAP: OverlapPolicy = "skip";

const OVERLAP_POLICIES: OverlapPolicy[] = ["skip", "queue", "allow"];
const MISFIRE_POLICIES: MisfirePolicy[] = ["skip", "fire-once", "fire-all"];
const SHELLS: ShellKind[] = ["bash", "sh", "none"];

export class JobValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobValidationError";
  }
}

function assertEnum<T extends string>(value: unknown, allowed: T[], field: string): void {
  if (value !== undefined && !allowed.includes(value as T)) {
    throw new JobValidationError(`"${field}" must be one of: ${allowed.join(", ")}`);
  }
}

function requireNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new JobValidationError(`"${field}" must be a non-negative number (got ${value})`);
  }
  return value;
}

/**
 * Validates a job definition and fills in every default.
 *
 * When `previous` is supplied the call behaves like a PATCH: any field absent
 * from `input` keeps the value it had, and `createdAt` is preserved. Supplying
 * `handler` clears a previously-set `command` and vice versa, so switching a
 * job's action can never leave it with two.
 */
export function normalizeJob(input: JobInput, previous?: JobDefinition): JobDefinition {
  if (!input || typeof input !== "object") {
    throw new JobValidationError("Job definition must be an object");
  }

  const name = (input.name ?? previous?.name ?? "").trim();
  if (!name) throw new JobValidationError('"name" is required');

  const schedule = (input.schedule ?? previous?.schedule ?? "").trim();
  if (!schedule) throw new JobValidationError('"schedule" is required');
  // Parse eagerly so a bad expression never reaches the store.
  try {
    parseCron(schedule);
  } catch (err) {
    if (err instanceof CronParseError) throw new JobValidationError(err.message);
    throw err;
  }

  let command = input.command ?? previous?.command;
  let handler = input.handler ?? previous?.handler;
  if (input.handler !== undefined) command = undefined;
  if (input.command !== undefined) handler = undefined;

  const hasCommand = typeof command === "string" && command.trim().length > 0;
  const hasHandler = typeof handler === "string" && handler.trim().length > 0;
  if (hasCommand && hasHandler) {
    throw new JobValidationError('Provide either "command" or "handler", not both');
  }
  if (!hasCommand && !hasHandler) {
    throw new JobValidationError('A job needs a "command" or a "handler"');
  }

  assertEnum(input.overlap, OVERLAP_POLICIES, "overlap");
  assertEnum(input.misfire, MISFIRE_POLICIES, "misfire");
  assertEnum(input.shell, SHELLS, "shell");

  const timeoutMs = Math.round(input.timeoutMs ?? previous?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new JobValidationError('"timeoutMs" must be a positive number');
  }

  const maxRetries = Math.round(input.maxRetries ?? previous?.maxRetries ?? DEFAULT_MAX_RETRIES);
  requireNonNegative(maxRetries, "maxRetries");

  const retryBackoffMs = Math.round(input.retryBackoffMs ?? previous?.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
  requireNonNegative(retryBackoffMs, "retryBackoffMs");

  const tzOffsetMinutes = Math.round(input.tzOffsetMinutes ?? previous?.tzOffsetMinutes ?? DEFAULT_TZ_OFFSET_MINUTES);
  if (!Number.isFinite(tzOffsetMinutes) || Math.abs(tzOffsetMinutes) > 14 * 60) {
    throw new JobValidationError('"tzOffsetMinutes" must be within ±14 hours');
  }

  const maxRuns = input.maxRuns ?? previous?.maxRuns;
  if (maxRuns !== undefined && (!Number.isFinite(maxRuns) || Math.round(maxRuns) < 1)) {
    throw new JobValidationError('"maxRuns" must be one or greater');
  }

  const now = Date.now();
  return {
    id: input.id ?? previous?.id ?? newId("job"),
    name,
    schedule,
    command: hasCommand ? command!.trim() : undefined,
    handler: hasHandler ? handler!.trim() : undefined,
    args: input.args ?? previous?.args ?? {},
    enabled: input.enabled ?? previous?.enabled ?? true,
    tzOffsetMinutes,
    timeoutMs,
    maxRetries,
    retryBackoffMs,
    overlap: input.overlap ?? previous?.overlap ?? DEFAULT_OVERLAP,
    misfire: input.misfire ?? previous?.misfire ?? DEFAULT_MISFIRE,
    maxCatchup: clamp(
      Math.round(input.maxCatchup ?? previous?.maxCatchup ?? DEFAULT_MAX_CATCHUP),
      1,
      1_000,
    ),
    maxRuns: maxRuns === undefined ? undefined : Math.round(maxRuns),
    shell: input.shell ?? previous?.shell ?? DEFAULT_SHELL,
    cwd: input.cwd ?? previous?.cwd,
    env: input.env ?? previous?.env,
    metadata: input.metadata ?? previous?.metadata ?? {},
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

/** Throws a `JobValidationError` when `input` is not a usable job. */
export function validateJobInput(input: JobInput): void {
  normalizeJob(input);
}

/** Re-exported so callers can `instanceof` the underlying cron error. */
export { CronParseError };

/** Re-exported so `./job.ts` is a complete, self-contained job API. */
export type { JobContext, JobDefinition, JobInput, JobRuntimeState } from "./types.ts";

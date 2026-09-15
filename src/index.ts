/**
 * cron-scheduler-service — distributed cron with leader election.
 *
 * Public surface. Everything an embedder needs is re-exported here, so
 * consumers never have to reach into `src/` internals:
 *
 *   import { CronScheduler, RedisElector, FileJobStore } from "cron-scheduler-service";
 *
 * The library is zero-dependency at runtime; all four electors, both stores,
 * the cron parser and the HTTP control plane are implemented against the
 * Node/Bun standard library only.
 */

/* Scheduling engine */
export { CronScheduler, jsonLogger, silentLogger } from "./scheduler.ts";
export type { JobView, SchedulerOptions } from "./scheduler.ts";

/* Cron parsing */
export {
  CRON_ALIASES,
  CronParseError,
  cronMatches,
  describeCron,
  nextRun,
  nextRuns,
  parseCron,
  previousRun,
} from "./cron.ts";
export type { CronFields } from "./cron.ts";

/* Leader election */
export {
  DEFAULT_LEASE_MS,
  FileElector,
  HttpElector,
  MemoryElector,
  RedisConnection,
  RedisElector,
  encodeCommand,
  renewIntervalMs,
} from "./leader.ts";
export type { FileElectorOptions, HttpElectorOptions, RedisElectorOptions } from "./leader.ts";

/* Persistence */
export { FileJobStore, JsonlRunLog, MemoryJobStore, RunHistory } from "./store.ts";
export type { JobStore, RunQuery, RunSink } from "./store.ts";

/* Execution */
export { runCommand, runHandler, splitCommand } from "./executor.ts";
export type { ExecuteOptions } from "./executor.ts";

/* HTTP control plane */
export { createHandler, startServer } from "./server.ts";
export type { ServerOptions, StartServerOptions } from "./server.ts";

/* Job validation */
export {
  DEFAULT_MAX_CATCHUP,
  DEFAULT_RETRY_BACKOFF_MS,
  DEFAULT_TIMEOUT_MS,
  JobValidationError,
  normalizeJob,
  validateJobInput,
} from "./job.ts";

/* Formatting helpers */
export { formatDuration, formatSchedule } from "./format.ts";

/* Shared contracts */
export type {
  ElectorOptions,
  ElectorState,
  Handler,
  JobContext,
  JobDefinition,
  JobInput,
  JobRuntimeState,
  LeaderElector,
  Logger,
  MisfirePolicy,
  OverlapPolicy,
  RunRecord,
  RunResult,
  RunStatus,
  SchedulerStatus,
  ShellKind,
} from "./types.ts";

/**
 * Shared contracts for the cron scheduler service.
 */

/** Outcome of a single job execution. */
export type RunStatus = "success" | "failed" | "timeout" | "skipped";

/** What to do when a job is already running and its next fire time arrives. */
export type OverlapPolicy = "skip" | "queue" | "allow";

/**
 * What to do when the scheduler observes a fire time that fell in the past
 * (leader was down, process restarted, clock jumped).
 * - `skip`       — ignore the missed slot entirely
 * - `fire-once`  — run once to catch up, then resume normal cadence
 * - `fire-all`   — run once per missed slot (bounded by `maxCatchup`)
 */
export type MisfirePolicy = "skip" | "fire-once" | "fire-all";

/**
 * How a `command` job is spawned.
 * - `bash` — runs through `bash -lc` (login shell, profile loaded)
 * - `sh`   — runs through `sh -c` (POSIX shell, no profile)
 * - `none` — the command string is split on whitespace and spawned directly
 */
export type ShellKind = "bash" | "sh" | "none";

/** Result returned by a job handler. */
export interface RunResult {
  status: Exclude<RunStatus, "skipped">;
  /** Captured stdout / handler-returned value for the history view. */
  output?: string;
  /** Failure detail when `status` is `failed` or `timeout`. */
  error?: string;
  /** Process exit code when the job ran as a shell command. */
  exitCode?: number;
}

/** Context handed to every handler invocation. */
export interface JobContext {
  job: JobDefinition;
  /** Epoch ms of the schedule slot this run is fulfilling. */
  scheduledFor: number;
  runId: string;
  /** 1-based attempt counter, incremented on retry. */
  attempt: number;
  /** Aborted on timeout or scheduler shutdown. */
  signal: AbortSignal;
  logger: Logger;
}

export type Handler = (ctx: JobContext) => Promise<RunResult> | RunResult;

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** A persisted job definition. */
export interface JobDefinition {
  id: string;
  name: string;
  /** Cron expression: 5 fields, 6 fields, or an `@alias`. */
  schedule: string;
  /** Shell command to execute. Mutually exclusive with `handler`. */
  command?: string;
  /** Name of a handler registered with `scheduler.registerHandler`. */
  handler?: string;
  args: Record<string, unknown>;
  enabled: boolean;
  /** Fixed offset from UTC in minutes used to evaluate the schedule. */
  tzOffsetMinutes: number;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  overlap: OverlapPolicy;
  misfire: MisfirePolicy;
  /** Upper bound on catch-up runs for `misfire: "fire-all"`. */
  maxCatchup: number;
  /** Stop scheduling after this many completed runs. */
  maxRuns?: number;
  /** Shell used to spawn `command` jobs. */
  shell: ShellKind;
  /** Working directory for `command` jobs. Defaults to the process cwd. */
  cwd?: string;
  /** Extra environment variables merged over `process.env`. */
  env?: Record<string, string>;
  metadata: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Fields accepted when creating or patching a job.
 *
 * `name` and `schedule` are typed as optional because a PATCH legitimately
 * omits them; `normalizeJob` is the single authority on what is actually
 * required, and it rejects a job that ends up without either.
 */
export type JobInput = Partial<Omit<JobDefinition, "createdAt" | "updatedAt">>;

/** A completed (or in-flight) execution. */
export interface RunRecord {
  runId: string;
  jobId: string;
  jobName: string;
  scheduledFor: number;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus | "running";
  attempt: number;
  durationMs: number | null;
  output?: string;
  error?: string;
  exitCode?: number;
  /** `true` when invoked by `trigger()` rather than the schedule. */
  manual: boolean;
}

export interface JobRuntimeState {
  jobId: string;
  /** Epoch ms of the next slot to fire, or `null` when disabled/exhausted. */
  nextRunAt: number | null;
  lastRunAt: number | null;
  /** `running` while the latest attempt is still in flight. */
  lastStatus: RunStatus | "running" | null;
  activeRuns: number;
  queuedRuns: number;
  completedRuns: number;
  consecutiveFailures: number;
  lastError: string | null;
}

export interface SchedulerStatus {
  running: boolean;
  leader: boolean;
  elector: ElectorState;
  startedAt: number | null;
  tickMs: number;
  jobs: JobRuntimeState[];
  totals: {
    jobs: number;
    enabled: number;
    activeRuns: number;
    completedRuns: number;
    failedRuns: number;
  };
}

export interface ElectorState {
  name: string;
  isLeader: boolean;
  token: string | null;
  leaseUntil: number | null;
}

/** Distributed mutual-exclusion primitive used to elect a single scheduler. */
export interface LeaderElector {
  readonly name: string;
  /** Attempt to take the lease. Resolves `true` when this node holds it. */
  acquire(): Promise<boolean>;
  /** Extend an already-held lease. Resolves `false` if the lease was lost. */
  renew(): Promise<boolean>;
  /** Voluntarily give up the lease. */
  release(): Promise<void>;
  isLeader(): boolean;
  describe(): ElectorState;
}

export interface ElectorOptions {
  /** Lease duration in ms. Renewed at `leaseMs / 3`. */
  leaseMs?: number;
  /** Identifies this node in lease records. Defaults to `host:pid`. */
  nodeId?: string;
}

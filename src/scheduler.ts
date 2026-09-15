/**
 * The scheduler engine.
 *
 * Design in one paragraph: every node runs the same tick loop, but only the
 * node holding the leader lease dispatches work. Each tick the leader renews
 * its lease, asks the cron parser which jobs are due, and runs them. Jobs are
 * never assumed to be fast, so each one gets its own timeout, retry policy,
 * overlap policy and misfire policy — and every execution lands in a bounded
 * run history. Standbys stay hot: they renew nothing, spend nothing, and take
 * over within one lease when the leader disappears.
 *
 * Two invariants keep the cluster honest:
 *   1. Re-check leadership *after* the awaited lease call, before dispatching.
 *      The gap between "my lease expired" and "I noticed" is the only window in
 *      which two nodes could both fire a slot, and this bounds it to one tick.
 *   2. A missed slot is never silently reinterpreted. Every late fire is
 *      classified against the job's misfire policy and, when dropped, recorded
 *      as a `skipped` run so the gap is visible in the history.
 */

import { randomUUID } from "node:crypto";
import { nextRun, nextRuns, parseCron, type CronFields } from "./cron.ts";
import { runCommand, runHandler, type ExecuteOptions } from "./executor.ts";
import { normalizeJob } from "./job.ts";
import { MemoryJobStore, RunHistory, type JobStore, type RunQuery, type RunSink } from "./store.ts";
import type {
  Handler,
  JobContext,
  JobDefinition,
  JobInput,
  JobRuntimeState,
  LeaderElector,
  Logger,
  RunRecord,
  RunResult,
  RunStatus,
  SchedulerStatus,
} from "./types.ts";

export interface SchedulerOptions {
  /** Defaults to an in-memory store. Use `FileJobStore` to survive restarts. */
  store?: JobStore;
  /** Required: decides which node dispatches. */
  elector: LeaderElector;
  /** Tick interval. Must be well below the lease so renewal is never late. */
  tickMs?: number;
  /** Cap on retained run records. */
  historyLimit?: number;
  /**
   * Durable run journal, e.g. `new JsonlRunLog(".cron/runs.jsonl")`. When set,
   * finished runs are appended and the most recent `historyLimit` records are
   * reloaded on `start()`, so `runs` works across process restarts.
   */
  runLog?: RunSink;
  /** Injectable clock, for tests. */
  now?: () => number;
  logger?: Logger;
  /** Per-node cap on concurrent job executions. Default: unlimited. */
  maxConcurrentRuns?: number;
  /** Passed through to the executor (output caps, kill grace, base env). */
  execute?: ExecuteOptions;
  /** Start the loop on construction. Default false — call `start()` yourself. */
  autoStart?: boolean;
}

export interface JobView extends JobRuntimeState {
  job: JobDefinition;
  /** Next fire times after `nextRunAt`, for previews in the CLI and API. */
  upcoming: number[];
}

const DEFAULT_TICK_MS = 1_000;
const DEFAULT_HISTORY_LIMIT = 500;
/** How far back a job loaded from a store may look for missed slots. */
const INITIAL_LOOKBACK_MS = 60_000;

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** One JSON object per line — friendly to log shippers and `journalctl -o json`. */
export const jsonLogger: Logger = {
  debug: (message, meta) => console.debug(JSON.stringify({ level: "debug", message, ...meta })),
  info: (message, meta) => console.log(JSON.stringify({ level: "info", message, ...meta })),
  warn: (message, meta) => console.warn(JSON.stringify({ level: "warn", message, ...meta })),
  error: (message, meta) => console.error(JSON.stringify({ level: "error", message, ...meta })),
};

interface JobState {
  job: JobDefinition;
  cron: CronFields;
  /** Epoch ms of the next slot to fire, or `null` when idle/exhausted. */
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: RunStatus | "running" | null;
  activeRuns: number;
  completedRuns: number;
  failedRuns: number;
  consecutiveFailures: number;
  lastError: string | null;
  /** Catch-up slots waiting for a free tick, oldest first. */
  backlog: number[];
  /** Set once the job has been evaluated, so misfires are only scanned once. */
  observed: boolean;
}

export class CronScheduler {
  private readonly store: JobStore;
  private readonly elector: LeaderElector;
  private readonly tickMs: number;
  private readonly graceMs: number;
  private readonly history: RunHistory;
  private readonly historyLimit: number;
  private readonly now: () => number;
  private readonly logger: Logger;
  private readonly executeOptions: ExecuteOptions;
  private readonly runLog: RunSink | undefined;
  private readonly maxConcurrentRuns: number;
  private readonly handlers = new Map<string, Handler>();
  private readonly states = new Map<string, JobState>();

  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private startedAt: number | null = null;
  private stopped = true;
  private abort = new AbortController();
  private completedRuns = 0;
  private failedRuns = 0;

  constructor(options: SchedulerOptions) {
    this.store = options.store ?? new MemoryJobStore();
    this.elector = options.elector;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    if (!Number.isFinite(this.tickMs) || this.tickMs < 1) throw new Error("tickMs must be >= 1");
    // A slot arriving later than this is a misfire, not jitter.
    this.graceMs = Math.max(this.tickMs, 1_000);
    this.historyLimit = Math.max(1, options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
    // The sink is what makes history durable: `RunHistory` journals every
    // terminal record through it and replays recent ones on start.
    this.history = new RunHistory(this.historyLimit, options.runLog);
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? silentLogger;
    this.executeOptions = options.execute ?? {};
    this.runLog = options.runLog;
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? Number.POSITIVE_INFINITY;
    if (options.autoStart) void this.start();
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.startedAt = this.now();
    this.abort = new AbortController();
    await this.loadJobs();
    await this.loadRunLog();
    this.logger.info("scheduler started", { tickMs: this.tickMs, jobs: this.states.size });
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Cancels in-flight child processes; see the executor's abort handling.
    this.abort.abort();
    await this.elector.release().catch(() => {});
    this.logger.info("scheduler stopped", { completedRuns: this.completedRuns });
  }

  get running(): boolean {
    return !this.stopped;
  }

  /* ---------------------------------------------------------------------- */
  /* Job management                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Rehydrates history from the run journal. A journal that cannot be read is
   * not fatal — run history is diagnostic, and refusing to start because a log
   * file was truncated would be the wrong trade.
   */
  private async loadRunLog(): Promise<void> {
    const sink = this.runLog;
    if (!sink?.read) return;
    try {
      for (const record of await sink.read(this.historyLimit)) this.history.hydrate(record);
    } catch (err) {
      this.logger.warn("run journal unreadable; starting with empty history", { error: String(err) });
    }
  }

  private async loadJobs(): Promise<void> {
    const jobs = await this.store.list();
    const seen = new Set<string>();
    for (const job of jobs) {
      seen.add(job.id);
      this.states.set(job.id, this.freshState(job));
    }
    for (const id of [...this.states.keys()]) if (!seen.has(id)) this.states.delete(id);
  }

  private freshState(job: JobDefinition): JobState {
    return {
      job,
      cron: parseCron(job.schedule),
      nextRunAt: null,
      lastRunAt: null,
      lastStatus: null,
      activeRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      consecutiveFailures: 0,
      lastError: null,
      backlog: [],
      observed: false,
    };
  }

  private stateFor(job: JobDefinition): JobState {
    const existing = this.states.get(job.id);
    if (existing) {
      existing.job = job;
      return existing;
    }
    const state = this.freshState(job);
    this.states.set(job.id, state);
    return state;
  }

  /** Creates a job, computes its first slot, and persists it. */
  async addJob(input: JobInput): Promise<JobDefinition> {
    const job = normalizeJob(input);
    if (this.states.has(job.id) || (await this.store.get(job.id))) {
      throw new Error(`Job ${job.id} already exists`);
    }
    await this.store.put(job);
    const state = this.stateFor(job);
    // A brand-new job starts from now; it must not replay its own past.
    state.observed = true;
    state.nextRunAt = job.enabled ? this.nextSlotFor(state, this.now()) : null;
    this.logger.info("job added", { jobId: job.id, name: job.name, schedule: job.schedule });
    return job;
  }

  /** PATCH semantics: fields absent from `patch` keep their current values. */
  async updateJob(id: string, patch: Partial<JobInput>): Promise<JobDefinition> {
    const state = this.states.get(id);
    const existing = state?.job ?? (await this.store.get(id));
    if (!existing) throw new Error(`No job with id ${id}`);
    const updated = normalizeJob({ ...patch, id, name: patch.name ?? existing.name, schedule: patch.schedule ?? existing.schedule }, existing);
    await this.store.put(updated);
    const next = this.stateFor(updated);
    next.cron = parseCron(updated.schedule);
    next.backlog = [];
    next.nextRunAt = updated.enabled ? this.nextSlotFor(next, this.now()) : null;
    this.logger.info("job updated", { jobId: id, enabled: updated.enabled });
    return updated;
  }

  async removeJob(id: string): Promise<boolean> {
    const deleted = await this.store.delete(id);
    this.states.delete(id);
    if (deleted) this.logger.info("job removed", { jobId: id });
    return deleted;
  }

  async enableJob(id: string): Promise<JobDefinition> {
    return await this.updateJob(id, { enabled: true });
  }

  async disableJob(id: string): Promise<JobDefinition> {
    return await this.updateJob(id, { enabled: false });
  }

  registerHandler(name: string, handler: Handler): this {
    if (!name || typeof handler !== "function") throw new Error("registerHandler needs a name and a function");
    this.handlers.set(name, handler);
    return this;
  }

  listHandlers(): string[] {
    return [...this.handlers.keys()].sort();
  }

  /* ---------------------------------------------------------------------- */
  /* Inspection                                                             */
  /* ---------------------------------------------------------------------- */

  listJobs(): JobDefinition[] {
    return [...this.states.values()].map((s) => s.job).sort((a, b) => a.createdAt - b.createdAt);
  }

  getJob(id: string): JobDefinition | undefined {
    const job = this.states.get(id)?.job;
    return job ? { ...job } : undefined;
  }

  /** Resolves a job by id, then exact name, then a unique id/name prefix. */
  findJob(ref: string): JobDefinition | undefined {
    const byId = this.states.get(ref);
    if (byId) return byId.job;
    const all = this.listJobs();
    const exact = all.filter((j) => j.name === ref);
    if (exact.length === 1) return exact[0];
    const partial = all.filter((j) => j.name.startsWith(ref) || j.id.startsWith(ref));
    return partial.length === 1 ? partial[0] : undefined;
  }

  runs(query: RunQuery = {}): RunRecord[] {
    return this.history.list(query);
  }

  clearRuns(jobId?: string): number {
    return this.history.clear(jobId);
  }

  views(): JobView[] {
    const now = this.now();
    return [...this.states.values()].map((state) => ({
      ...this.runtimeOf(state),
      job: state.job,
      upcoming: state.job.enabled ? nextRuns(state.cron, now, 3, state.job.tzOffsetMinutes) : [],
    }));
  }

  status(): SchedulerStatus {
    const jobs = [...this.states.values()].map((s) => this.runtimeOf(s));
    return {
      running: this.running,
      leader: this.elector.isLeader(),
      elector: this.elector.describe(),
      startedAt: this.startedAt,
      tickMs: this.tickMs,
      jobs,
      totals: {
        jobs: jobs.length,
        enabled: jobs.filter((j) => this.states.get(j.jobId)!.job.enabled).length,
        activeRuns: jobs.reduce((sum, j) => sum + j.activeRuns, 0),
        completedRuns: this.completedRuns,
        failedRuns: this.failedRuns,
      },
    };
  }

  private runtimeOf(state: JobState): JobRuntimeState {
    return {
      jobId: state.job.id,
      nextRunAt: state.nextRunAt,
      lastRunAt: state.lastRunAt,
      lastStatus: state.lastStatus,
      activeRuns: state.activeRuns,
      queuedRuns: state.backlog.length,
      completedRuns: state.completedRuns,
      consecutiveFailures: state.consecutiveFailures,
      lastError: state.lastError,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* The tick loop                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * One scheduling cycle. Safe to call directly with a fake clock in tests.
   *
   * Order matters: renew the lease *before* dispatching, and re-check
   * leadership after the awaited call. A node that has lost its lease must not
   * start new work.
   */
  async tick(now: number = this.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.elector.isLeader()) {
        const renewed = await this.elector.renew();
        if (!renewed) this.logger.warn("lost leadership", { elector: this.elector.name });
      } else {
        const acquired = await this.elector.acquire();
        if (acquired) this.logger.info("became leader", { elector: this.elector.name });
      }
      if (!this.elector.isLeader()) return;

      for (const state of [...this.states.values()]) {
        await this.dispatchDue(state, now);
        this.drainBacklog(state);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** First slot strictly after `from`, or `null` when the expression is spent. */
  private nextSlotFor(state: JobState, from: number): number | null {
    return nextRun(state.cron, from, state.job.tzOffsetMinutes);
  }

  private async dispatchDue(state: JobState, now: number): Promise<void> {
    const job = state.job;
    if (!job.enabled) {
      state.nextRunAt = null;
      state.backlog = [];
      return;
    }

    // First evaluation of a job loaded from a store: recover only the recent
    // past, never the whole history of the expression.
    if (!state.observed) {
      state.observed = true;
      state.nextRunAt = this.nextSlotFor(state, now - 1);
      if (job.misfire !== "skip") {
        const boundary = now - INITIAL_LOOKBACK_MS;
        const missed = slotsBetween(state.cron, job.tzOffsetMinutes, boundary, now - 1, job.maxCatchup);
        if (missed.length > 0) {
          const take = job.misfire === "fire-once" ? missed.slice(-1) : missed;
          state.backlog.push(...take);
          this.logger.info("misfire recovered", { jobId: job.id, slots: take.length, policy: job.misfire });
        }
      }
      return;
    }

    if (state.nextRunAt === null) {
      state.nextRunAt = this.nextSlotFor(state, now - 1);
    }
    if (state.nextRunAt === null || state.nextRunAt > now) return;

    const due = state.nextRunAt;
    const late = now - due;
    const misfired = late > this.graceMs;

    if (misfired && job.misfire === "skip") {
      // Drop the slot entirely and resume from the next future one, so a long
      // outage costs one skip rather than N catch-up runs.
      state.nextRunAt = this.nextSlotFor(state, now);
      state.lastStatus = "skipped";
      this.recordSkipped(state, due, `missed by ${late}ms (misfire=skip)`);
      this.logger.warn("misfire skipped", { jobId: job.id, late });
      return;
    }

    if (misfired && job.misfire === "fire-all") {
      // Fire this slot now, then replay the rest one per tick, capped.
      // The run fired just above counts as one catch-up, so at most
      // `maxCatchup - 1` more are queued. Resuming strictly after `now` is what
      // ends the episode: without it each replay would still look overdue on
      // the next tick, and the catch-up would never converge.
      const missed = slotsBetween(state.cron, job.tzOffsetMinutes, due, now - 1, job.maxCatchup + 1);
      const remainder = missed.slice(0, Math.max(0, job.maxCatchup - 1));
      if (remainder.length > 0) {
        state.backlog.push(...remainder);
        this.logger.info("catch-up queued", { jobId: job.id, slots: remainder.length });
      }
      state.nextRunAt = this.nextSlotFor(state, now);
    } else {
      // On time, or `fire-once`: this run *is* the single catch-up.
      state.nextRunAt = this.nextSlotFor(state, misfired ? now : due);
    }

    if (job.maxRuns !== undefined && state.completedRuns >= job.maxRuns) {
      state.nextRunAt = null;
      this.recordSkipped(state, due, "maxRuns reached");
      return;
    }

    if (state.activeRuns > 0) {
      if (job.overlap === "skip") {
        state.lastStatus = "skipped";
        this.recordSkipped(state, due, "previous run still active (overlap=skip)");
        this.logger.warn("run skipped", { jobId: job.id, reason: "overlap" });
        return;
      }
      if (job.overlap === "queue") {
        state.backlog.push(due);
        this.logger.info("run queued", { jobId: job.id, depth: state.backlog.length });
        return;
      }
      // `allow` falls through to a concurrent run.
    }

    await this.startRun(state, due, false);
  }

  /** Drains one queued slot per tick so a large catch-up cannot stampede. */
  private drainBacklog(state: JobState): void {
    if (state.backlog.length === 0) return;
    if (state.activeRuns > 0 && state.job.overlap !== "allow") return;
    if (this.countActiveRuns() >= this.maxConcurrentRuns) return;
    const due = state.backlog.shift()!;
    void this.startRun(state, due, false);
  }

  private countActiveRuns(): number {
    let total = 0;
    for (const state of this.states.values()) total += state.activeRuns;
    return total;
  }

  /** Manual fire. Deliberately ignores `overlap: "skip"` — `trigger` means now. */
  async trigger(id: string): Promise<RunRecord> {
    const state = this.states.get(id);
    if (!state) throw new Error(`No job with id ${id}`);
    return await this.startRun(state, this.now(), true);
  }

  private async startRun(state: JobState, scheduledFor: number, manual: boolean): Promise<RunRecord> {
    const job = state.job;
    const runId = randomUUID();
    const startedAt = this.now();
    const record: RunRecord = {
      runId,
      jobId: job.id,
      jobName: job.name,
      scheduledFor,
      startedAt,
      finishedAt: null,
      status: "running",
      attempt: 0,
      durationMs: null,
      manual,
    };
    this.history.upsert(record);
    state.activeRuns += 1;
    state.lastRunAt = startedAt;
    state.lastStatus = "running";
    this.logger.info("run started", { jobId: job.id, runId, scheduledFor, manual });

    // Fire-and-forget: the tick loop must never block on job duration.
    void this.executeWithRetries(state, runId, scheduledFor, manual).catch((err) => {
      state.activeRuns = Math.max(0, state.activeRuns - 1);
      state.lastError = String(err);
      this.logger.error("run crashed", { jobId: job.id, runId, error: String(err) });
    });

    return record;
  }

  private async executeWithRetries(
    state: JobState,
    runId: string,
    scheduledFor: number,
    manual: boolean,
  ): Promise<void> {
    const job = state.job;
    const totalAttempts = job.maxRetries + 1;
    let last: RunResult = { status: "failed", error: "no attempt made" };

    try {
      for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
        const startedAt = this.now();
        const record: RunRecord = {
          runId,
          jobId: job.id,
          jobName: job.name,
          scheduledFor,
          startedAt,
          finishedAt: null,
          status: "running",
          attempt,
          durationMs: null,
          manual,
        };
        this.history.upsert(record);

        const ctx: JobContext = {
          job,
          scheduledFor,
          runId,
          attempt,
          signal: this.abort.signal,
          logger: this.logger,
        };
        last =
          job.handler !== undefined
            ? await runHandler(job, ctx, this.handlers, this.executeOptions)
            : await runCommand(job, ctx, this.executeOptions);

        const finishedAt = this.now();
        const finalRecord: RunRecord = {
          ...record,
          finishedAt,
          status: last.status,
          durationMs: finishedAt - startedAt,
          output: last.output,
          error: last.error,
          exitCode: last.exitCode,
        };
        this.history.upsert(finalRecord);

        if (last.status === "success") break;
        if (attempt >= totalAttempts) break;

        const delay = Math.round(job.retryBackoffMs * 2 ** (attempt - 1));
        const leaseUntil = this.elector.describe().leaseUntil;
        // Retrying past the lease is pointless — a new leader will have taken
        // over, and a duplicate run is worse than an honest failure.
        if (!this.elector.isLeader() || (leaseUntil !== null && this.now() + delay >= leaseUntil)) {
          this.logger.warn("retry abandoned", { jobId: job.id, runId, attempt });
          break;
        }
        this.logger.warn("run failed, retrying", { jobId: job.id, runId, attempt, delay });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      state.lastStatus = last.status;
      state.completedRuns += 1;
      this.completedRuns += 1;
      if (last.status === "success") {
        state.consecutiveFailures = 0;
        state.lastError = null;
        this.logger.info("run succeeded", { jobId: job.id, runId });
        if (job.maxRuns !== undefined && state.completedRuns >= job.maxRuns) {
          state.nextRunAt = null;
          await this.disableJob(job.id).catch(() => {});
        }
      } else {
        state.failedRuns += 1;
        this.failedRuns += 1;
        state.consecutiveFailures += 1;
        state.lastError = last.error ?? `run ended with status ${last.status}`;
        this.logger.error("run failed", { jobId: job.id, runId, status: last.status, error: last.error });
      }
    } finally {
      state.activeRuns = Math.max(0, state.activeRuns - 1);
      // A finished run frees capacity, so a `queue`d slot starts immediately
      // rather than waiting for the next tick. `drainBacklog` re-checks the
      // overlap policy, so this cannot run two jobs that must be serialised.
      this.drainBacklog(state);
    }
  }

  private recordSkipped(state: JobState, scheduledFor: number, reason: string): void {
    const now = this.now();
    const record: RunRecord = {
      runId: randomUUID(),
      jobId: state.job.id,
      jobName: state.job.name,
      scheduledFor,
      startedAt: now,
      finishedAt: now,
      status: "skipped",
      attempt: 0,
      durationMs: 0,
      error: reason,
      manual: false,
    };
    this.history.append(record);
  }
}

/**
 * Fire times strictly after `from` and at or before `to`, capped at `limit`.
 * The cap is what stops a `* * * * * *` expression over a week-long outage from
 * turning a single tick into a hundred thousand parses.
 */
export function slotsBetween(
  cron: CronFields,
  tzOffsetMinutes: number,
  from: number,
  to: number,
  limit: number,
): number[] {
  const out: number[] = [];
  if (to <= from || limit < 1) return out;
  let cursor = from;
  while (out.length < limit) {
    const next = nextRun(cron, cursor, tzOffsetMinutes);
    if (next === null || next > to) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

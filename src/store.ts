/**
 * Persistence: job definitions (durable, pluggable) and run history (bounded,
 * in-process ring buffer).
 *
 * Jobs are the source of truth and must survive restarts; run history is
 * diagnostic and is intentionally cheap and lossy. There is exactly one
 * normaliser for job definitions — `normalizeJob` in `job.ts` — and it runs
 * before anything reaches a store, so a store only ever round-trips values it
 * was handed.
 */

import { appendFileSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JobDefinition, RunRecord, RunStatus } from "./types.ts";

export interface JobStore {
  list(): Promise<JobDefinition[]>;
  get(id: string): Promise<JobDefinition | undefined>;
  put(job: JobDefinition): Promise<void>;
  delete(id: string): Promise<boolean>;
}

/** In-memory store. The default: zero setup, gone when the process exits. */
export class MemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobDefinition>();

  async list(): Promise<JobDefinition[]> {
    return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async get(id: string): Promise<JobDefinition | undefined> {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  async put(job: JobDefinition): Promise<void> {
    this.jobs.set(job.id, { ...job });
  }

  async delete(id: string): Promise<boolean> {
    return this.jobs.delete(id);
  }
}

/**
 * JSON-file store for a single node.
 *
 * Writes go through a temp file + `rename`, which is atomic on POSIX, so a
 * crash mid-write leaves the previous good state rather than a half-written job
 * list. Writes are serialised through a promise chain so two concurrent
 * mutations cannot interleave their read-modify-write cycles.
 *
 * Job definitions are only ever mutated by the leader, so a plain file is
 * sufficient; it is not a coordination primitive — that is the elector's job.
 */
export class FileJobStore implements JobStore {
  private cache: JobDefinition[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async load(): Promise<JobDefinition[]> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as { jobs?: JobDefinition[] };
      this.cache = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
      this.cache = [];
    }
    return this.cache;
  }

  private async flush(): Promise<void> {
    const payload = JSON.stringify({ version: 1, jobs: this.cache ?? [] }, null, 2);
    const tmp = `${this.path}.${process.pid}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(tmp, payload, "utf8");
    await rename(tmp, this.path);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async list(): Promise<JobDefinition[]> {
    const jobs = await this.load();
    return [...jobs].sort((a, b) => a.createdAt - b.createdAt);
  }

  async get(id: string): Promise<JobDefinition | undefined> {
    const job = (await this.load()).find((j) => j.id === id);
    return job ? { ...job } : undefined;
  }

  async put(job: JobDefinition): Promise<void> {
    await this.enqueue(async () => {
      const jobs = await this.load();
      const index = jobs.findIndex((j) => j.id === job.id);
      if (index >= 0) jobs[index] = { ...job };
      else jobs.push({ ...job });
      this.cache = jobs;
      await this.flush();
    });
  }

  async delete(id: string): Promise<boolean> {
    return await this.enqueue(async () => {
      const jobs = await this.load();
      const index = jobs.findIndex((j) => j.id === id);
      if (index < 0) return false;
      jobs.splice(index, 1);
      this.cache = jobs;
      await this.flush();
      return true;
    });
  }
}

export interface RunQuery {
  jobId?: string;
  status?: RunStatus | "running";
  limit?: number;
  since?: number;
}

/**
 * Bounded ring buffer of run records, newest-first on read.
 *
 * `upsert` lets a run transition from `running` to its terminal state without
 * leaving a stale row behind — which matters because the record is written
 * before the handler starts and rewritten once it finishes.
 */
/** Anything that can durably record a finished run. */
export interface RunSink {
  append(record: RunRecord): void;
  clear(): void;
  /**
   * The most recent `limit` records, oldest first. Optional: a write-only sink
   * (a log pipeline, a metrics collector) legitimately has nothing to replay,
   * and the scheduler simply starts with empty history.
   */
  read?(limit: number): RunRecord[] | Promise<RunRecord[]>;
}

/**
 * Append-only JSONL run log.
 *
 * Run history is deliberately bounded and lossy in memory, but a *durable*
 * trail matters operationally: "the 3am job failed, what was the error?" has
 * to be answerable tomorrow. Writes are synchronous appends — one line, no
 * read-modify-write, so a crash cannot corrupt earlier records and there is no
 * interleaving risk between concurrent runs. Corrupt lines are skipped on
 * read rather than failing the load.
 */
export class JsonlRunLog implements RunSink {
  constructor(private readonly path: string) {}

  append(record: RunRecord): void {
    try {
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // A failed log write must never take down a schedule.
    }
  }

  /** The most recent `limit` records, oldest first. */
  read(limit: number): RunRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const out: RunRecord[] = [];
    for (const line of lines.slice(Math.max(0, lines.length - limit))) {
      try {
        const parsed = JSON.parse(line) as RunRecord;
        if (parsed && typeof parsed.runId === "string") out.push(parsed);
      } catch {
        // A torn final line is expected after an unclean shutdown.
      }
    }
    return out;
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}

export class RunHistory {
  private readonly records: RunRecord[] = [];

  constructor(
    private readonly limit: number = 500,
    private readonly sink?: RunSink,
  ) {
    if (!Number.isFinite(limit) || limit < 1) throw new Error("RunHistory limit must be >= 1");
  }

  get size(): number {
    return this.records.length;
  }

  upsert(record: RunRecord): void {
    const index = this.records.findIndex((r) => r.runId === record.runId);
    if (index >= 0) {
      this.records[index] = { ...record };
      this.journal(record);
      return;
    }
    this.append(record);
  }

  append(record: RunRecord): void {
    this.records.push({ ...record });
    while (this.records.length > this.limit) this.records.shift();
    this.journal(record);
  }

  /**
   * Rehydrates a record read back from the journal. Deliberately does *not*
   * journal it: a record loaded from the log is already in the log, and
   * re-appending it would double the file on every restart.
   */
  hydrate(record: RunRecord): void {
    const index = this.records.findIndex((r) => r.runId === record.runId);
    if (index >= 0) {
      this.records[index] = { ...record };
      return;
    }
    this.records.push({ ...record });
    while (this.records.length > this.limit) this.records.shift();
  }

  /**
   * Only terminal states are journaled — a `running` row would be overwritten
   * moments later and would double the size of the log for no benefit. Exactly
   * one journal write per record transition.
   */
  private journal(record: RunRecord): void {
    if (record.status !== "running") this.sink?.append(record);
  }

  /** Newest first. `limit` is applied after filtering. */
  list(query: RunQuery = {}): RunRecord[] {
    const { jobId, status, since, limit } = query;
    let out = this.records;
    if (jobId !== undefined) out = out.filter((r) => r.jobId === jobId);
    if (status !== undefined) out = out.filter((r) => r.status === status);
    if (since !== undefined) out = out.filter((r) => r.startedAt >= since);
    out = [...out].sort((a, b) => b.startedAt - a.startedAt);
    return limit !== undefined ? out.slice(0, limit) : out;
  }

  clear(jobId?: string): number {
    if (jobId === undefined) {
      const count = this.records.length;
      this.records.length = 0;
      this.sink?.clear();
      return count;
    }
    let removed = 0;
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      if (this.records[i]!.jobId === jobId) {
        this.records.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }
}

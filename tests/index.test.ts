/**
 * Test suite for cron-scheduler-service.
 *
 * Organised by module, from the pure functions outwards: cron parsing first
 * (everything else depends on it), then leader election, persistence, the
 * executor, the scheduler engine, the HTTP control plane and finally the
 * public API surface. Every test that claims a behaviour asserts on the
 * observable result, not on an implementation detail.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer, type Socket } from "node:net";

import {
  CRON_ALIASES,
  CronParseError,
  CronScheduler,
  FileElector,
  FileJobStore,
  HttpElector,
  JobValidationError,
  JsonlRunLog,
  MemoryElector,
  MemoryJobStore,
  RedisConnection,
  RedisElector,
  RunHistory,
  cronMatches,
  describeCron,
  encodeCommand,
  formatDuration,
  formatSchedule,
  nextRun,
  nextRuns,
  normalizeJob,
  parseCron,
  previousRun,
  runCommand,
  runHandler,
  splitCommand,
  createHandler,
  validateJobInput,
} from "../src/index.ts";
import type { JobDefinition, LeaderElector, Logger, RunRecord } from "../src/index.ts";
import { parseDuration, parseTimezoneOffset } from "../src/util.ts";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A deterministic clock the tests drive by hand. */
function fakeClock(start = Date.UTC(2026, 0, 1, 0, 0, 0)) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    set(ms: number) {
      current = ms;
    },
  };
}

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cron-scheduler-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  MemoryElector.reset();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/** Polls until `predicate` holds, so tests never depend on a fixed sleep. */
async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Yield a macrotask *before* the first check: a predicate can be true from
    // synchronous work while the async tail (the run record being finalised)
    // has not run yet. Checking first would assert on unsettled state.
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (predicate()) return;
  }
  throw new Error("waitFor timed out");
}

/* -------------------------------------------------------------------------- */
/* Cron parsing                                                               */
/* -------------------------------------------------------------------------- */

describe("cron parsing", () => {
  test("parses a five-field expression into sorted field sets", () => {
    const fields = parseCron("*/15 9-17 * * MON-FRI");
    expect(fields.minutes).toEqual([0, 15, 30, 45]);
    expect(fields.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(fields.daysOfMonth.length).toBe(31);
    expect(fields.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
    expect(fields.hasSeconds).toBe(false);
    expect(fields.domRestricted).toBe(false);
    expect(fields.dowRestricted).toBe(true);
  });

  test("parses a six-field expression with seconds", () => {
    const fields = parseCron("30 0 12 * * *");
    expect(fields.hasSeconds).toBe(true);
    expect(fields.seconds).toEqual([30]);
    expect(fields.minutes).toEqual([0]);
    expect(fields.hours).toEqual([12]);
  });

  test("expands every @alias", () => {
    expect(parseCron("@hourly").minutes).toEqual([0]);
    expect(parseCron("@daily").hours).toEqual([0]);
    expect(parseCron("@weekly").daysOfWeek).toEqual([0]);
    expect(parseCron("@yearly").months).toEqual([1]);
    expect(parseCron("@secondly").hasSeconds).toBe(true);
    for (const alias of Object.keys(CRON_ALIASES)) {
      expect(() => parseCron(alias)).not.toThrow();
    }
  });

  test("accepts lists, ranges, steps and names interchangeably", () => {
    expect(parseCron("0,30 1,13 * * *").minutes).toEqual([0, 30]);
    expect(parseCron("0 0 * JAN,JUL *").months).toEqual([1, 7]);
    expect(parseCron("0 0 * * 7").daysOfWeek).toEqual([0]);
    expect(parseCron("0 0-6/3 * * *").hours).toEqual([0, 3, 6]);
  });

  test("rejects malformed expressions with a specific message", () => {
    expect(() => parseCron("not a cron")).toThrow(CronParseError);
    expect(() => parseCron("* * * *")).toThrow(CronParseError);
    expect(() => parseCron("60 * * * *")).toThrow(CronParseError);
    expect(() => parseCron("* 24 * * *")).toThrow(CronParseError);
    expect(() => parseCron("@nonsense")).toThrow(CronParseError);
    expect(() => parseCron("*/0 * * * *")).toThrow(CronParseError);
  });

  test("compute the documented next run times", () => {
    // 09:30 on 2026-01-01 (a Thursday).
    const from = Date.UTC(2026, 0, 1, 9, 0, 0);
    expect(nextRun(parseCron("30 9 * * *"), from)).toBe(Date.UTC(2026, 0, 1, 9, 30));
    expect(nextRun(parseCron("0 * * * *"), from)).toBe(Date.UTC(2026, 0, 1, 10, 0));
    expect(nextRun(parseCron("0 0 * * *"), from)).toBe(Date.UTC(2026, 0, 2, 0, 0));
    expect(nextRun(parseCron("@hourly"), from)).toBe(Date.UTC(2026, 0, 1, 10, 0));
  });

  test("is strictly exclusive of the `from` instant", () => {
    const at = Date.UTC(2026, 0, 1, 10, 0, 0);
    expect(cronMatches(parseCron("0 * * * *"), at)).toBe(true);
    expect(nextRun(parseCron("0 * * * *"), at)).toBe(Date.UTC(2026, 0, 1, 11, 0));
  });

  test("honours the DOM/DOW OR rule when both fields are restricted", () => {
    const fields = parseCron("0 0 1 * MON");
    // 2026-01-01 is a Thursday, and also the 1st: DOM matches.
    expect(cronMatches(fields, Date.UTC(2026, 0, 1))).toBe(true);
    // 2026-01-05 is a Monday but not the 1st: DOW matches, so OR still fires.
    expect(cronMatches(fields, Date.UTC(2026, 0, 5))).toBe(true);
    // 2026-01-06 is neither: no match.
    expect(cronMatches(fields, Date.UTC(2026, 0, 6))).toBe(false);
  });

  test("resolves the next slot around a timezone offset", () => {
    // 00:30 New York time (UTC-5) on 2026-01-01 is 05:30 UTC.
    const fields = parseCron("30 0 * * *");
    expect(nextRun(fields, Date.UTC(2026, 0, 1, 0, 0), -300)).toBe(Date.UTC(2026, 0, 1, 5, 30));
  });

  test("finds the previous slot and refuses impossible ones", () => {
    const fields = parseCron("0 12 * * *");
    expect(previousRun(fields, Date.UTC(2026, 0, 1, 18, 0))).toBe(Date.UTC(2026, 0, 1, 12, 0));
    // Feb 30 never exists.
    expect(nextRun(parseCron("0 0 30 2 *"), Date.UTC(2026, 0, 1))).toBeNull();
  });

  test("lists several upcoming slots in order", () => {
    const times = nextRuns(parseCron("0 0 * * *"), Date.UTC(2026, 0, 1, 12, 0), 3);
    expect(times).toEqual([
      Date.UTC(2026, 0, 2),
      Date.UTC(2026, 0, 3),
      Date.UTC(2026, 0, 4),
    ]);
  });

  test("describes an expression without inventing information", () => {
    expect(describeCron(parseCron("@daily"))).toBe("@daily");
    expect(describeCron(parseCron("*/5 * * * *"))).toBe("*/5 * * * *");
  });

  test("rejects impossible calendar dates in a leap year", () => {
    // 2028 is a leap year: Feb 29 exists, Feb 30 does not.
    expect(nextRun(parseCron("0 0 29 2 *"), Date.UTC(2028, 0, 1))).toBe(Date.UTC(2028, 1, 29));
    expect(nextRun(parseCron("0 0 30 2 *"), Date.UTC(2028, 0, 1))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

describe("job validation", () => {
  test("fills every default for a minimal job", () => {
    const job = normalizeJob({ name: "nightly", schedule: "0 3 * * *", command: "echo hi" });
    expect(job.id).toStartWith("job_");
    expect(job.enabled).toBe(true);
    expect(job.overlap).toBe("skip");
    expect(job.misfire).toBe("fire-once");
    expect(job.shell).toBe("bash");
    expect(job.timeoutMs).toBeGreaterThan(0);
    expect(job.createdAt).toBeLessThanOrEqual(Date.now());
  });

  test("requires exactly one action", () => {
    expect(() => normalizeJob({ name: "a", schedule: "* * * * *" })).toThrow(JobValidationError);
    expect(() =>
      normalizeJob({ name: "a", schedule: "* * * * *", command: "x", handler: "y" }),
    ).toThrow(JobValidationError);
  });

  test("rejects a bad schedule before it reaches the store", () => {
    expect(() => normalizeJob({ name: "a", schedule: "nope", command: "x" })).toThrow(JobValidationError);
    expect(() => validateJobInput({ name: "a", schedule: "61 * * * *", command: "x" })).toThrow(
      JobValidationError,
    );
  });

  test("rejects non-positive timeouts and negative retries", () => {
    expect(() => normalizeJob({ name: "a", schedule: "* * * * *", command: "x", timeoutMs: 0 })).toThrow(
      JobValidationError,
    );
    expect(() => normalizeJob({ name: "a", schedule: "* * * * *", command: "x", maxRetries: -1 })).toThrow(
      JobValidationError,
    );
  });

  test("merges a PATCH over the previous definition", () => {
    const base = normalizeJob({ name: "a", schedule: "0 0 * * *", command: "x", timeoutMs: 5_000 });
    const patched = normalizeJob({ name: "b" }, base);
    expect(patched.id).toBe(base.id);
    expect(patched.name).toBe("b");
    expect(patched.schedule).toBe("0 0 * * *");
    expect(patched.timeoutMs).toBe(5_000);
    expect(patched.createdAt).toBe(base.createdAt);
  });

  test("switching the action never leaves two", () => {
    const base = normalizeJob({ name: "a", schedule: "* * * * *", command: "x" });
    const switched = normalizeJob({ name: "a", schedule: "* * * * *", handler: "h" }, base);
    expect(switched.handler).toBe("h");
    expect(switched.command).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Leader election                                                            */
/* -------------------------------------------------------------------------- */

describe("leader election", () => {
  test("memory elector grants one lease at a time in-process", async () => {
    const a = new MemoryElector("unit-a", { leaseMs: 2_000 });
    const b = new MemoryElector("unit-a", { leaseMs: 2_000 });
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    expect(a.isLeader()).toBe(true);
    expect(await a.renew()).toBe(true);
    await a.release();
    expect(a.isLeader()).toBe(false);
    expect(await b.acquire()).toBe(true);
  });

  test("memory elector reports, and does not invent, its lease expiry", async () => {
    const elector = new MemoryElector("unit-b", { leaseMs: 1_500 });
    await elector.acquire();
    const state = elector.describe();
    expect(state.name).toBe("memory:unit-b");
    expect(state.isLeader).toBe(true);
    expect(state.token).toBeTruthy();
    expect(state.leaseUntil).toBeGreaterThan(Date.now());
  });

  test("renaming is refused when the lease cannot be renewed", async () => {
    const elector = new MemoryElector("unit-c", { leaseMs: 1_000 });
    expect(elector.describe().isLeader).toBe(false);
    // Renewing without holding the lease must drop, not grant.
    expect(await elector.renew()).toBe(false);
    expect(elector.describe().token).toBeNull();
  });

  test("file elector gives the lease to exactly one of two contenders", async () => {
    const dir = await tempDir();
    const path = join(dir, "leader.lock");
    const a = new FileElector(path, { leaseMs: 2_000, takeoverJitterMs: 0 });
    const b = new FileElector(path, { leaseMs: 2_000, takeoverJitterMs: 0 });

    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    expect(await a.renew()).toBe(true);

    // Losing the file (as a delete would) must invalidate the lease.
    await rm(path);
    expect(await a.renew()).toBe(false);
    expect(await b.acquire()).toBe(true);
  });

  test("file elector steals a lease whose TTL has expired", async () => {
    const dir = await tempDir();
    const path = join(dir, "expired.lock");
    await writeFile(path, JSON.stringify({ token: "stale", owner: "dead", pid: 1, expiresAt: Date.now() - 1 }));

    const elector = new FileElector(path, { leaseMs: 2_000, takeoverJitterMs: 0 });
    expect(await elector.acquire()).toBe(true);
    expect(elector.isLeader()).toBe(true);
    await elector.release();
    expect(elector.isLeader()).toBe(false);
  });

  test("http elector follows the CAS contract against an injected transport", async () => {
    let holder: string | null = null;
    const calls: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const body = init?.body ? (JSON.parse(String(init.body)) as { token: string }) : null;
      calls.push(`${method}:${headers.get("if-none-match") ?? headers.get("if-match") ?? "-"}`);

      if (method === "PUT" && headers.get("if-none-match") === "*") {
        if (holder) return new Response("held", { status: 412 });
        holder = body!.token;
        return new Response(null, { status: 201 });
      }
      if (method === "PUT" && headers.get("if-match") === holder) return new Response(null, { status: 200 });
      if (method === "DELETE" && headers.get("if-match") === holder) {
        holder = null;
        return new Response(null, { status: 200 });
      }
      return new Response("precondition failed", { status: 412 });
    }) as unknown as typeof fetch;

    const a = new HttpElector({ url: "https://coordinator.test/lease", leaseMs: 2_000, fetchImpl });
    const b = new HttpElector({ url: "https://coordinator.test/lease", leaseMs: 2_000, fetchImpl });

    expect(await a.acquire()).toBe(true);
    const heldByA = holder;
    expect(await b.acquire()).toBe(false);
    expect(await a.renew()).toBe(true);
    await a.release();
    expect(holder).toBeNull();
    expect(await b.acquire()).toBe(true);
    // acquire, acquire(lost), renew, release, acquire(successor)
    expect(calls).toEqual([
      "PUT:*",
      "PUT:*",
      "PUT:" + heldByA,
      "DELETE:" + heldByA,
      "PUT:*",
    ]);
  });

  test("http elector fails closed when the coordinator is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const elector = new HttpElector({ url: "https://coordinator.test/lease", fetchImpl });
    expect(await elector.acquire()).toBe(false);
    expect(elector.isLeader()).toBe(false);
  });

  test("encodes RESP commands and talks to a Redis-shaped server", async () => {
    expect(encodeCommand(["SET", "k", "v"]).toString()).toBe("*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n");

    // A minimal RESP server: enough to prove the client parses real replies.
    const store = new Map<string, string>();
    const sockets: Socket[] = [];
    const server = createTcpServer((socket) => {
      sockets.push(socket);
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          const args = decodeResp(buffer);
          if (!args) break;
          buffer = args.rest;
          const [command, ...rest] = args.items;
          const cmd = (command ?? "").toUpperCase();
          if (cmd === "SET") {
            // `rest` is the argv after SET: [key, value, ...flags].
            const [key, value] = rest;
            if (rest.includes("NX") && store.has(key!)) socket.write("$-1\r\n");
            else {
              store.set(key!, value!);
              socket.write("+OK\r\n");
            }
          } else if (cmd === "EVAL") {
            // `rest` is [script, numkeys, key, token, ...] for both Lua scripts.
            const [script, , key, token] = rest;
            const owned = store.get(key!) === token;
            // The release script deletes; the renew script only extends the TTL.
            if (owned && /"del"/i.test(script!)) store.delete(key!);
            socket.write(owned ? ":1\r\n" : ":0\r\n");
          } else if (cmd === "GET") {
            const value = store.get(rest[0]!);
            socket.write(value === undefined ? "$-1\r\n" : `$${value.length}\r\n${value}\r\n`);
          } else {
            socket.write("-ERR unknown command\r\n");
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const a = new RedisElector({ port, leaseMs: 2_000 });
      const b = new RedisElector({ port, leaseMs: 2_000 });
      expect(await a.acquire()).toBe(true);
      expect(await b.acquire()).toBe(false);
      expect(await a.renew()).toBe(true);
      await a.release();
      expect(await b.acquire()).toBe(true);
      await b.release();
      a.close();
      b.close();
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("redis elector fails closed when nothing is listening", async () => {
    const elector = new RedisElector({ port: 1, leaseMs: 2_000, connectTimeoutMs: 200 });
    expect(await elector.acquire()).toBe(false);
    expect(elector.isLeader()).toBe(false);
    expect(elector.describe().token).toBeNull();
  });

  test("redis client surfaces a connection error instead of hanging", async () => {
    const connection = new RedisConnection({ port: 1, connectTimeoutMs: 200 });
    await expect(connection.command("PING")).rejects.toThrow();
    connection.close();
  });
});

/** Decodes one RESP array of bulk strings from `input`, or `null` if partial. */
function decodeResp(input: string): { items: string[]; rest: string } | null {
  if (!input.startsWith("*")) return null;
  const lines = input.split("\r\n");
  const count = Number(lines[0]!.slice(1));
  if (Number.isNaN(count)) return null;
  const items: string[] = [];
  let index = 1;
  for (let i = 0; i < count; i += 1) {
    const header = lines[index];
    if (header === undefined) return null;
    const length = Number(header.slice(1));
    const body = lines[index + 1];
    if (body === undefined) return null;
    items.push(body.slice(0, length));
    index += 2;
  }
  return { items, rest: lines.slice(index).join("\r\n") };
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

describe("persistence", () => {
  test("memory store round-trips jobs in creation order", async () => {
    const store = new MemoryJobStore();
    const first = normalizeJob({ name: "one", schedule: "* * * * *", command: "echo 1" });
    const second = normalizeJob({ name: "two", schedule: "* * * * *", command: "echo 2" });
    await store.put(first);
    await store.put(second);

    expect((await store.list()).map((j) => j.name)).toEqual(["one", "two"]);
    expect((await store.get(first.id))?.name).toBe("one");
    expect(await store.delete(first.id)).toBe(true);
    expect(await store.delete(first.id)).toBe(false);
    expect((await store.list()).length).toBe(1);
  });

  test("file store survives a new instance and refuses to corrupt itself", async () => {
    const dir = await tempDir();
    const path = join(dir, "nested", "jobs.json");
    const job = normalizeJob({ name: "persisted", schedule: "0 0 * * *", command: "echo hi" });

    const first = new FileJobStore(path);
    await first.put(job);

    const second = new FileJobStore(path);
    expect((await second.list()).map((j) => j.name)).toEqual(["persisted"]);
    expect((await second.get(job.id))?.schedule).toBe("0 0 * * *");

    // A deleted job must not come back after a reload.
    expect(await second.delete(job.id)).toBe(true);
    const third = new FileJobStore(path);
    expect(await third.list()).toEqual([]);
  });

  test("file store treats unreadable JSON as empty rather than crashing", async () => {
    const dir = await tempDir();
    const path = join(dir, "broken.json");
    await writeFile(path, "{ not json");
    const store = new FileJobStore(path);
    expect(await store.list()).toEqual([]);
  });

  test("run history is bounded and evicts the oldest records", () => {
    const history = new RunHistory(3);
    const record = (id: string, startedAt: number): RunRecord => ({
      runId: id,
      jobId: "j1",
      jobName: "job",
      scheduledFor: startedAt,
      startedAt,
      finishedAt: startedAt + 1,
      status: "success",
      attempt: 1,
      durationMs: 1,
      manual: false,
    });
    history.append(record("a", 1));
    history.append(record("b", 2));
    history.append(record("c", 3));
    history.append(record("d", 4));

    expect(history.size).toBe(3);
    expect(history.list().map((r) => r.runId)).toEqual(["d", "c", "b"]);
    expect(history.list({ limit: 1 }).map((r) => r.runId)).toEqual(["d"]);
    expect(history.clear()).toBe(3);
    expect(history.size).toBe(0);
  });

  test("run history upsert replaces an in-flight record rather than duplicating it", () => {
    const history = new RunHistory(10);
    const base: RunRecord = {
      runId: "r1",
      jobId: "j1",
      jobName: "job",
      scheduledFor: 0,
      startedAt: 0,
      finishedAt: null,
      status: "running",
      attempt: 1,
      durationMs: null,
      manual: false,
    };
    history.upsert(base);
    history.upsert({ ...base, status: "success", finishedAt: 5, durationMs: 5 });
    expect(history.size).toBe(1);
    expect(history.list()[0]!.status).toBe("success");
  });

  test("run journal writes one line per finished run and skips a torn tail", async () => {
    const dir = await tempDir();
    const path = join(dir, "runs.jsonl");
    const log = new JsonlRunLog(path);
    const record = (id: string): RunRecord => ({
      runId: id,
      jobId: "j1",
      jobName: "job",
      scheduledFor: 0,
      startedAt: 1,
      finishedAt: 2,
      status: "success",
      attempt: 1,
      durationMs: 1,
      manual: false,
    });

    log.append(record("a"));
    log.append(record("b"));
    // A hard kill can leave a half-written final line; it must be skipped, not
    // abort the whole read, and the next real append must still land.
    appendFileSync(path, '{"runId":"torn"');
    expect((await log.read(10)).map((r) => r.runId)).toEqual(["a", "b"]);
    appendFileSync(path, "\n");
    log.append(record("c"));
    expect((await log.read(10)).map((r) => r.runId)).toEqual(["a", "b", "c"]);
    // `read` honours the limit by taking the newest records.
    expect((await log.read(1)).map((r) => r.runId)).toEqual(["c"]);
    log.clear();
    expect(await log.read(10)).toEqual([]);
  });

  test("run history journals exactly one line per terminal record", async () => {
    const dir = await tempDir();
    const path = join(dir, "runs.jsonl");
    const log = new JsonlRunLog(path);
    const history = new RunHistory(10, log);
    const base: RunRecord = {
      runId: "r1",
      jobId: "j1",
      jobName: "job",
      scheduledFor: 0,
      startedAt: 0,
      finishedAt: null,
      status: "running",
      attempt: 1,
      durationMs: null,
      manual: false,
    };

    history.upsert(base);
    history.upsert({ ...base, status: "success", finishedAt: 5, durationMs: 5 });
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as RunRecord).status).toBe("success");
  });

  test("a scheduler reloads run history from its journal on start", async () => {
    const dir = await tempDir();
    const path = join(dir, "runs.jsonl");
    const clock = fakeClock();
    const build = () =>
      new CronScheduler({
        elector: new MemoryElector("journal", { leaseMs: 60_000, nodeId: "node" }),
        now: clock.now,
        logger: silent,
        tickMs: 1_000,
        runLog: new JsonlRunLog(path),
      });

    const first = build();
    first.registerHandler("ok", () => ({ status: "success", output: "one" }));
    const job = await first.addJob({ name: "journaled", schedule: "* * * * *", handler: "ok" });
    await first.tick(clock.now() + 60_000);
    await waitFor(() => first.runs({ jobId: job.id }).some((r) => r.status === "success"));
    await first.stop();

    // A brand-new process must see the previous run in `runs`.
    const second = build();
    await second.start();
    const restored = second.runs({ jobId: job.id });
    expect(restored).toHaveLength(1);
    expect(restored[0]!.output).toBe("one");
    await second.stop();
  });
});

/* -------------------------------------------------------------------------- */
/* Executor                                                                   */
/* -------------------------------------------------------------------------- */

describe("executor", () => {
  test("splits a command line without invoking a shell", () => {
    expect(splitCommand("echo hello world")).toEqual(["echo", "hello", "world"]);
    expect(splitCommand('node -e "console.log(1)"')).toEqual(["node", "-e", "console.log(1)"]);
    expect(splitCommand("a  'b c'  d")).toEqual(["a", "b c", "d"]);
  });

  test("runs a command and captures stdout, exit code and injected env", async () => {
    const job = normalizeJob({
      name: "echo",
      schedule: "* * * * *",
      command: 'printf "%s" "$CRON_JOB_NAME:$CRON_ATTEMPT"',
    });
    const result = await runCommand(job, {
      job,
      scheduledFor: 0,
      runId: "run-1",
      attempt: 2,
      signal: new AbortController().signal,
      logger: silent,
    });
    expect(result.status).toBe("success");
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("echo:2");
  });

  test("reports a non-zero exit as a failure with stderr attached", async () => {
    const job = normalizeJob({ name: "boom", schedule: "* * * * *", command: "echo bad >&2; exit 3" });
    const result = await runCommand(job, {
      job,
      scheduledFor: 0,
      runId: "run-2",
      attempt: 1,
      signal: new AbortController().signal,
      logger: silent,
    });
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(3);
    expect(result.error).toContain("bad");
  });

  test("kills a command that overruns its timeout", async () => {
    const job = normalizeJob({
      name: "slow",
      schedule: "* * * * *",
      command: "sleep 30",
      timeoutMs: 300,
    });
    const started = Date.now();
    const result = await runCommand(job, {
      job,
      scheduledFor: 0,
      runId: "run-3",
      attempt: 1,
      signal: new AbortController().signal,
      logger: silent,
    });
    expect(result.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("runs a registered handler and reports a missing one as a failure", async () => {
    const job = normalizeJob({ name: "h", schedule: "* * * * *", handler: "greet" });
    const handlers = new Map([
      ["greet", () => ({ status: "success" as const, output: "hello" })],
    ]);
    const context = {
      job,
      scheduledFor: 0,
      runId: "run-4",
      attempt: 1,
      signal: new AbortController().signal,
      logger: silent,
    };
    expect((await runHandler(job, context, handlers)).output).toBe("hello");

    const missing = normalizeJob({ name: "m", schedule: "* * * * *", handler: "nope" });
    const result = await runHandler(missing, { ...context, job: missing }, handlers);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("nope");
  });

  test("turns a throwing handler into a failed run, not a crashed scheduler", async () => {
    const job = normalizeJob({ name: "thrower", schedule: "* * * * *", handler: "boom" });
    const handlers = new Map([
      ["boom", () => {
        throw new Error("kaboom");
      }],
    ]);
    const result = await runHandler(
      job,
      { job, scheduledFor: 0, runId: "run-5", attempt: 1, signal: new AbortController().signal, logger: silent },
      handlers,
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("kaboom");
  });

  test("times out a handler that never settles", async () => {
    const job = normalizeJob({ name: "hang", schedule: "* * * * *", handler: "hang", timeoutMs: 200 });
    const handlers = new Map([["hang", () => new Promise<never>(() => {})]]);
    const result = await runHandler(
      job,
      { job, scheduledFor: 0, runId: "run-6", attempt: 1, signal: new AbortController().signal, logger: silent },
      handlers,
    );
    expect(result.status).toBe("timeout");
  });
});

/* -------------------------------------------------------------------------- */
/* Scheduler engine                                                           */
/* -------------------------------------------------------------------------- */

describe("scheduler", () => {
  function build(options: { elector?: LeaderElector; store?: MemoryJobStore; clock?: ReturnType<typeof fakeClock> } = {}) {
    const clock = options.clock ?? fakeClock();
    const scheduler = new CronScheduler({
      store: options.store ?? new MemoryJobStore(),
      elector: options.elector ?? new MemoryElector("scheduler-test", { leaseMs: 60_000 }),
      now: clock.now,
      logger: silent,
      tickMs: 1_000,
    });
    return { scheduler, clock };
  }

  test("only the leader dispatches", async () => {
    const elector = new MemoryElector("dual", { leaseMs: 60_000 });
    const clock = fakeClock();
    const leader = new CronScheduler({ elector, now: clock.now, logger: silent, tickMs: 1_000 });
    const standbyElector = new MemoryElector("dual", { leaseMs: 60_000 });
    const standby = new CronScheduler({ elector: standbyElector, now: clock.now, logger: silent, tickMs: 1_000 });

    await leader.addJob({ name: "tick", schedule: "* * * * *", command: "echo leader" });
    await standby.addJob({ name: "tick", schedule: "* * * * *", command: "echo standby" });

    await leader.tick(clock.now() + 60_000);
    await waitFor(() => leader.runs().length > 0);
    expect(await standbyElector.acquire()).toBe(false);
    await standby.tick(clock.now() + 60_000);
    expect(standby.runs()).toEqual([]);
    await leader.stop();
    await standby.stop();
  });

  test("fires a due job once per slot and records the run", async () => {
    const { scheduler, clock } = build();
    const job = await scheduler.addJob({ name: "every-minute", schedule: "* * * * *", command: "echo tick" });

    // A slot fires only once it is due; the next tick after that is idle.
    const start = clock.now();
    await scheduler.tick(start);
    expect(scheduler.runs()).toEqual([]);

    await scheduler.tick(start + 60_000);
    await waitFor(() => scheduler.runs({ jobId: job.id }).length > 0);
    const [record] = scheduler.runs({ jobId: job.id });
    expect(record!.status).toBe("success");
    expect(record!.output?.trim()).toBe("tick");
    expect(record!.scheduledFor).toBe(start + 60_000);

    await scheduler.tick(start + 60_001);
    expect(scheduler.runs({ jobId: job.id }).length).toBe(1);
    await scheduler.stop();
  });

  test("a disabled job never fires", async () => {
    const { scheduler, clock } = build();
    const job = await scheduler.addJob({
      name: "off",
      schedule: "* * * * *",
      command: "echo nope",
      enabled: false,
    });
    await scheduler.tick(clock.now());
    await scheduler.tick(clock.now() + 120_000);
    expect(scheduler.runs({ jobId: job.id })).toEqual([]);
    expect(scheduler.views()[0]!.nextRunAt).toBeNull();
    await scheduler.stop();
  });

  test("enable and disable take effect immediately", async () => {
    const { scheduler, clock } = build();
    const job = await scheduler.addJob({ name: "toggle", schedule: "* * * * *", command: "echo on" });
    await scheduler.disableJob(job.id);
    await scheduler.tick(clock.now() + 60_000);
    expect(scheduler.runs({ jobId: job.id })).toEqual([]);

    await scheduler.enableJob(job.id);
    await scheduler.tick(clock.now() + 120_000);
    await waitFor(() => scheduler.runs({ jobId: job.id }).length > 0);
    await scheduler.stop();
  });

  test("overlap=skip drops a slot while the previous run is in flight", async () => {
    const { scheduler, clock } = build();
    const gate = Promise.withResolvers<void>();
    const job = await scheduler.addJob({ name: "slow", schedule: "* * * * *", handler: "slow", timeoutMs: 30_000 });
    scheduler.registerHandler("slow", async () => {
      await gate.promise;
      return { status: "success", output: "done" };
    });

    const start = clock.now();
    await scheduler.tick(start + 60_000);
    expect(scheduler.views()[0]!.activeRuns).toBe(1);

    await scheduler.tick(start + 121_000);
    const skipped = scheduler.runs({ jobId: job.id }).filter((r) => r.status === "skipped");
    expect(skipped.length).toBeGreaterThanOrEqual(1);

    gate.resolve();
    await waitFor(() => scheduler.views()[0]!.activeRuns === 0);
    await scheduler.stop();
  });

  test("overlap=queue runs the queued slot once the active run finishes", async () => {
    const { scheduler, clock } = build();
    const gate = Promise.withResolvers<void>();
    await scheduler.addJob({
      name: "queued",
      schedule: "* * * * *",
      handler: "queued",
      overlap: "queue",
      timeoutMs: 30_000,
    });
    let calls = 0;
    scheduler.registerHandler("queued", async () => {
      calls += 1;
      if (calls === 1) await gate.promise;
      return { status: "success", output: `call-${calls}` };
    });

    const start = clock.now();
    await scheduler.tick(start + 60_000);
    await scheduler.tick(start + 121_000);
    expect(scheduler.views()[0]!.queuedRuns).toBeGreaterThanOrEqual(1);

    gate.resolve();
    await waitFor(() => calls >= 2);
    await scheduler.stop();
  });

  test("retries a failing job and stops after maxRetries", async () => {
    const { scheduler, clock } = build();
    let attempts = 0;
    const job = await scheduler.addJob({
      name: "flaky",
      schedule: "* * * * *",
      handler: "flaky",
      maxRetries: 2,
      retryBackoffMs: 1,
    });
    scheduler.registerHandler("flaky", () => {
      attempts += 1;
      return { status: "failed", error: "nope" };
    });

    await scheduler.tick(clock.now() + 60_000);
    await waitFor(() => scheduler.runs({ jobId: job.id }).every((r) => r.status !== "running"));
    expect(attempts).toBe(3);
    const view = scheduler.views()[0]!;
    expect(view.lastStatus).toBe("failed");
    expect(view.consecutiveFailures).toBe(1);
    await scheduler.stop();
  });

  test("a successful retry clears consecutive failures", async () => {
    const { scheduler, clock } = build();
    let n = 0;
    const job = await scheduler.addJob({
      name: "recover",
      schedule: "* * * * *",
      handler: "recover",
      maxRetries: 1,
      retryBackoffMs: 1,
    });
    scheduler.registerHandler("recover", () => {
      n += 1;
      return n === 1 ? { status: "failed", error: "first" } : { status: "success", output: "second" };
    });

    await scheduler.tick(clock.now() + 60_000);
    await waitFor(() => scheduler.runs({ jobId: job.id }).some((r) => r.status === "success"));
    expect(scheduler.views()[0]!.consecutiveFailures).toBe(0);
    await scheduler.stop();
  });

  test("misfire=skip drops a long-overdue slot and resumes from now", async () => {
    const { scheduler, clock } = build();
    const start = clock.now();
    const job = await scheduler.addJob({
      name: "skip",
      schedule: "* * * * *",
      command: "echo skipped",
      misfire: "skip",
    });
    await scheduler.tick(start);
    // Ten minutes pass: the missed slots must be dropped, not replayed.
    await scheduler.tick(start + 600_000);
    expect(scheduler.runs({ jobId: job.id }).some((r) => r.status === "skipped")).toBe(true);
    expect(scheduler.views()[0]!.nextRunAt).toBeGreaterThan(start + 600_000);
    await scheduler.stop();
  });

  test("misfire=fire-all replays missed slots, capped by maxCatchup", async () => {
    const clock = fakeClock();
    let calls = 0;
    const scheduler = new CronScheduler({
      elector: new MemoryElector("catchup", { leaseMs: 60_000 }),
      now: clock.now,
      logger: silent,
      tickMs: 1_000,
    });
    scheduler.registerHandler("catchup", () => {
      calls += 1;
      return { status: "success", output: `call-${calls}` };
    });
    const job = await scheduler.addJob({
      name: "catchup",
      schedule: "* * * * *",
      handler: "catchup",
      misfire: "fire-all",
      maxCatchup: 3,
    });

    const start = clock.now();
    await scheduler.tick(start);
    await scheduler.tick(start + 300_000);
    await waitFor(() => calls >= 1);

    // Drain the backlog across subsequent ticks; one slot per tick.
    for (let i = 1; i <= 6; i += 1) {
      await scheduler.tick(start + 300_000 + i * 1_000);
    }
    await waitFor(() => scheduler.views()[0]!.queuedRuns === 0);

    // The overdue slot plus at most `maxCatchup - 1` replays, never all 5.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(4);
    expect(scheduler.runs({ jobId: job.id }).every((r) => r.status === "success")).toBe(true);
    await scheduler.stop();
  });

  test("maxRuns stops the job after the configured number of runs", async () => {
    const { scheduler, clock } = build();
    let calls = 0;
    const job = await scheduler.addJob({
      name: "limited",
      schedule: "* * * * *",
      handler: "limited",
      maxRuns: 1,
    });
    scheduler.registerHandler("limited", () => {
      calls += 1;
      return { status: "success", output: "once" };
    });

    await scheduler.tick(clock.now() + 60_000);
    await waitFor(() => calls === 1);
    await waitFor(() => scheduler.getJob(job.id)?.enabled === false);
    expect(scheduler.runs({ jobId: job.id }).filter((r) => r.status === "success").length).toBe(1);
    await scheduler.stop();
  });

  test("trigger fires immediately and ignores the schedule", async () => {
    const { scheduler } = build();
    let fired = 0;
    const job = await scheduler.addJob({ name: "manual", schedule: "0 0 1 1 *", handler: "manual" });
    scheduler.registerHandler("manual", () => {
      fired += 1;
      return { status: "success", output: "manual" };
    });

    const record = await scheduler.trigger(job.id);
    await waitFor(() => fired === 1);
    expect(record.manual).toBe(true);
    const stored = scheduler.runs({ jobId: job.id })[0]!;
    expect(stored.manual).toBe(true);
    expect(stored.status).toBe("success");
    await scheduler.stop();
  });

  test("triggering an unknown job throws a precise error", async () => {
    const { scheduler } = build();
    await expect(scheduler.trigger("nope")).rejects.toThrow("No job with id nope");
    await scheduler.stop();
  });

  test("findJob resolves by id, exact name and unique prefix", async () => {
    const { scheduler } = build();
    const alpha = await scheduler.addJob({ name: "alpha", schedule: "* * * * *", command: "echo a" });
    await scheduler.addJob({ name: "beta", schedule: "* * * * *", command: "echo b" });

    expect(scheduler.findJob(alpha.id)?.id).toBe(alpha.id);
    expect(scheduler.findJob("alpha")?.id).toBe(alpha.id);
    expect(scheduler.findJob("alp")?.id).toBe(alpha.id);
    await scheduler.addJob({ name: "alphabet", schedule: "* * * * *", command: "echo c" });
    // "alp" is now ambiguous and must not silently pick one.
    expect(scheduler.findJob("alp")).toBeUndefined();
    await scheduler.stop();
  });

  test("updateJob keeps unspecified fields and revalidates the schedule", async () => {
    const { scheduler } = build();
    const job = await scheduler.addJob({
      name: "updatable",
      schedule: "* * * * *",
      command: "echo one",
      timeoutMs: 5_000,
    });
    const updated = await scheduler.updateJob(job.id, { name: "renamed" });
    expect(updated.name).toBe("renamed");
    expect(updated.command).toBe("echo one");
    expect(updated.timeoutMs).toBe(5_000);
    expect(updated.createdAt).toBe(job.createdAt);

    await expect(scheduler.updateJob(job.id, { schedule: "bogus" })).rejects.toThrow(JobValidationError);
    await scheduler.stop();
  });

  test("removeJob deletes the job and its state", async () => {
    const { scheduler } = build();
    const job = await scheduler.addJob({ name: "gone", schedule: "* * * * *", command: "echo x" });
    expect(await scheduler.removeJob(job.id)).toBe(true);
    expect(scheduler.getJob(job.id)).toBeUndefined();
    expect(await scheduler.removeJob(job.id)).toBe(false);
    await scheduler.stop();
  });

  test("status reports leader, totals and per-job runtime state", async () => {
    const { scheduler, clock } = build();
    await scheduler.addJob({ name: "a", schedule: "* * * * *", command: "echo a" });
    await scheduler.addJob({ name: "b", schedule: "0 0 * * *", command: "echo b", enabled: false });
    await scheduler.tick(clock.now() + 60_000);
    await waitFor(() => scheduler.status().totals.completedRuns > 0);

    const status = scheduler.status();
    expect(status.leader).toBe(true);
    expect(status.totals.jobs).toBe(2);
    expect(status.totals.enabled).toBe(1);
    expect(status.jobs.find((j) => j.jobId && j.lastStatus === "success")).toBeTruthy();
    await scheduler.stop();
  });

  test("views include upcoming fire times for enabled jobs only", async () => {
    const { scheduler } = build();
    await scheduler.addJob({ name: "upcoming", schedule: "0 0 * * *", command: "echo u" });
    await scheduler.addJob({ name: "off", schedule: "0 0 * * *", command: "echo o", enabled: false });
    const views = scheduler.views();
    expect(views.find((v) => v.job.name === "upcoming")!.upcoming.length).toBe(3);
    expect(views.find((v) => v.job.name === "off")!.upcoming).toEqual([]);
    await scheduler.stop();
  });

  test("stop releases the lease so a standby can take over", async () => {
    const elector = new MemoryElector("handover", { leaseMs: 60_000 });
    const other = new MemoryElector("handover", { leaseMs: 60_000 });
    const scheduler = new CronScheduler({ elector, logger: silent, now: () => Date.now(), tickMs: 1_000 });
    await scheduler.start();
    expect(elector.isLeader()).toBe(true);
    expect(await other.acquire()).toBe(false);
    await scheduler.stop();
    expect(await other.acquire()).toBe(true);
  });

  test("start loads persisted jobs and schedules them", async () => {
    const dir = await tempDir();
    const store = new FileJobStore(join(dir, "jobs.json"));
    const clock = fakeClock();
    const job = normalizeJob({ name: "loaded", schedule: "* * * * *", command: "echo loaded" });
    await store.put(job);

    const scheduler = new CronScheduler({
      store,
      elector: new MemoryElector("persisted", { leaseMs: 60_000 }),
      now: clock.now,
      logger: silent,
      tickMs: 1_000,
    });
    await scheduler.start();
    expect(scheduler.listJobs().map((j) => j.name)).toEqual(["loaded"]);
    await scheduler.tick(clock.now() + 60_000);
    await waitFor(() => scheduler.runs({ jobId: job.id }).length > 0);
    expect(scheduler.runs({ jobId: job.id })[0]!.status).toBe("success");
    await scheduler.stop();
  });
});

/* -------------------------------------------------------------------------- */
/* HTTP control plane                                                         */
/* -------------------------------------------------------------------------- */

describe("http control plane", () => {
  async function harness(options: { token?: string } = {}) {
    const scheduler = new CronScheduler({
      elector: new MemoryElector("http", { leaseMs: 60_000 }),
      logger: silent,
      now: () => Date.now(),
      tickMs: 1_000,
    });
    await scheduler.start();
    const handler = createHandler(scheduler, options);
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await handler(
        new Request(`http://localhost${path}`, {
          method,
          headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    };
    return { scheduler, call };
  }

  test("reports health while running", async () => {
    const { scheduler, call } = await harness();
    const health = await call("GET", "/health");
    expect(health.status).toBe(200);
    expect(health.body.leader).toBe(true);
    await scheduler.stop();
  });

  test("creates, lists, reads and deletes jobs over HTTP", async () => {
    const { scheduler, call } = await harness();
    const created = await call("POST", "/api/jobs", {
      name: "http-job",
      schedule: "*/5 * * * *",
      command: "echo http",
    });
    expect(created.status).toBe(201);
    const id = (created.body.job as JobDefinition).id;

    const listed = await call("GET", "/api/jobs");
    expect((listed.body.jobs as unknown[]).length).toBe(1);

    const read = await call("GET", `/api/jobs/${id}`);
    expect((read.body.job as JobDefinition).name).toBe("http-job");

    const removed = await call("DELETE", `/api/jobs/${id}`);
    expect(removed.status).toBe(200);
    expect((await call("GET", "/api/jobs")).body.jobs).toEqual([]);
    await scheduler.stop();
  });

  test("validates bodies and returns 400 rather than 500", async () => {
    const { scheduler, call } = await harness();
    const bad = await call("POST", "/api/jobs", { name: "x", schedule: "nonsense", command: "echo x" });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toContain("Invalid cron expression");
    await scheduler.stop();
  });

  test("404s an unknown job and 405s an unsupported method", async () => {
    const { scheduler, call } = await harness();
    expect((await call("GET", "/api/jobs/missing")).status).toBe(404);
    expect((await call("PUT", "/api/jobs")).status).toBe(405);
    await scheduler.stop();
  });

  test("drives actions: trigger, disable and enable", async () => {
    const { scheduler, call } = await harness();
    const created = await call("POST", "/api/jobs", {
      name: "actioned",
      schedule: "0 0 1 1 *",
      command: "echo action",
    });
    const id = (created.body.job as JobDefinition).id;

    const triggered = await call("POST", `/api/jobs/${id}/trigger`);
    expect(triggered.status).toBe(202);

    const disabled = await call("POST", `/api/jobs/${id}/disable`);
    expect((disabled.body.job as JobDefinition).enabled).toBe(false);
    const enabled = await call("POST", `/api/jobs/${id}/enable`);
    expect((enabled.body.job as JobDefinition).enabled).toBe(true);

    const unknown = await call("POST", `/api/jobs/${id}/frobnicate`);
    expect(unknown.status).toBe(404);
    await scheduler.stop();
  });

  test("exposes run history and handlers", async () => {
    const { scheduler, call } = await harness();
    scheduler.registerHandler("noop", () => ({ status: "success" }));
    const runs = await call("GET", "/api/runs?limit=5");
    expect(runs.status).toBe(200);
    expect(Array.isArray(runs.body.runs)).toBe(true);
    const handlers = await call("GET", "/api/handlers");
    expect(handlers.body.handlers).toEqual(["noop"]);
    await scheduler.stop();
  });

  test("enforces the bearer token when one is configured", async () => {
    const { scheduler, call } = await harness({ token: "s3cret-token" });
    const denied = await call("GET", "/api/status");
    expect(denied.status).toBe(401);
    expect(denied.body.error).toBe("Unauthorized");

    const wrong = await call("GET", "/api/status", undefined, { authorization: "Bearer wrong-token" });
    expect(wrong.status).toBe(401);

    const allowed = await call("GET", "/api/status", undefined, { authorization: "Bearer s3cret-token" });
    expect(allowed.status).toBe(200);
    await scheduler.stop();
  });

  test("rejects a malformed JSON body with 400", async () => {
    const { scheduler } = await harness();
    const handler = createHandler(scheduler);
    const response = await handler(
      new Request("http://localhost/api/jobs", { method: "POST", body: "{ oops" }),
    );
    expect(response.status).toBe(400);
    await scheduler.stop();
  });
});

/* -------------------------------------------------------------------------- */
/* Formatting and utilities                                                   */
/* -------------------------------------------------------------------------- */

describe("formatting and utilities", () => {
  test("formats durations across every unit boundary", () => {
    expect(formatDuration(950)).toBe("950ms");
    expect(formatDuration(1_500)).toBe("1.5s");
    expect(formatDuration(92_000)).toBe("1m 32s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_780_000)).toBe("1h 3m");
    expect(formatDuration(-1)).toBe("-");
  });

  test("summarises the schedules operators actually write", () => {
    expect(formatSchedule("@daily")).toBe("@daily");
    expect(formatSchedule("* * * * *")).toBe("every minute");
    expect(formatSchedule("*/15 * * * *")).toBe("every 15 minutes");
    expect(formatSchedule("0 * * * *")).toBe("hourly");
    expect(formatSchedule("30 9 * * *")).toBe("daily at 09:30");
    expect(formatSchedule("0 0 1 * *")).toBe("monthly on day 1 at 00:00");
    expect(formatSchedule("0 9 * * MON")).toBe("weekly on MON at 09:00");
    // Numeric day-of-week is crontab's form too, and 7 means Sunday.
    expect(formatSchedule("0 0 * * 0")).toBe("weekly on SUN at 00:00");
    expect(formatSchedule("30 4 * * 7")).toBe("weekly on SUN at 04:30");
    // Anything unusual is echoed verbatim: never a wrong plain-English guess.
    expect(formatSchedule("0 9,17 * * 1-5")).toBe("0 9,17 * * 1-5");
  });

  test("parses durations and timezone offsets", () => {
    expect(parseDuration("250ms", 0)).toBe(250);
    expect(parseDuration("30s", 0)).toBe(30_000);
    expect(parseDuration("5m", 0)).toBe(300_000);
    expect(parseDuration("2h", 0)).toBe(7_200_000);
    expect(parseDuration("nonsense", 42)).toBe(42);
    expect(parseTimezoneOffset("UTC")).toBe(0);
    expect(parseTimezoneOffset("-05:00")).toBe(-300);
    expect(parseTimezoneOffset("+0530")).toBe(330);
    expect(parseTimezoneOffset("not-a-zone")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Public API surface                                                         */
/* -------------------------------------------------------------------------- */

describe("public api", () => {
  test("re-exports the documented entry points", () => {
    for (const value of [
      CronScheduler,
      MemoryElector,
      FileElector,
      RedisElector,
      HttpElector,
      FileJobStore,
      MemoryJobStore,
      RunHistory,
      parseCron,
      nextRun,
      nextRuns,
      previousRun,
      cronMatches,
      describeCron,
      normalizeJob,
      validateJobInput,
      runCommand,
      runHandler,
      splitCommand,
      createHandler,
      formatDuration,
      formatSchedule,
      encodeCommand,
    ]) {
      expect(value).toBeDefined();
    }
  });

  test("a job definition built by the library is accepted by the store", async () => {
    const job: JobDefinition = normalizeJob({
      name: "end-to-end",
      schedule: "@hourly",
      command: "echo e2e",
    });
    const store = new MemoryJobStore();
    await store.put(job);
    expect((await store.get(job.id))?.schedule).toBe("@hourly");
  });
});

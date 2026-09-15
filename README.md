[![CI](https://github.com/Retsumdk/cron-scheduler-service/actions/workflows/ci.yml/badge.svg)](https://github.com/Retsumdk/cron-scheduler-service/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.0-14151A?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen?style=flat-square)](package.json)
[![Tests](https://img.shields.io/badge/tests-77%20passing-brightgreen?style=flat-square)](tests/index.test.ts)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

# cron-scheduler-service

A cron scheduler that is safe to run on **more than one replica**.

`cron-scheduler-service` runs your scheduled jobs on every node in the cluster, but executes each schedule slot on exactly one of them using a lease-based leader election. It handles the things that actually break scheduled work in production: overlapping runs, missed slots after a deploy, hung commands that never return, partial failures that deserve a retry, and the question of what happened at 3am.

It has **zero runtime dependencies**. The cron parser, the four leader-election backends, the Redis client, the job store, the run journal, the HTTP control plane and the CLI are all implemented against the Node/Bun standard library.

---

## The problem

`crontab` and every naive `node-cron`/`setInterval` wrapper share the same three failures in production.

**1. One machine, one point of failure.** The moment you run two replicas you get double execution — two nightly invoices, two backup restores, two emails. The usual workaround is a `if (process.env.INSTANCE_ID !== "0") return;` guard, which is a lie: it survives exactly one deployment topology.

**2. A missed slot is invisible.** A rolling deploy at 02:59 means the 03:00 backup simply does not exist. Nothing retries it, nothing reports it. You discover it during an incident review.

**3. There is no record.** `crontab` mails output to a local user nobody reads. When a job fails, there is no timeout, no retry, no captured stderr and no history — only a missing artefact and a guess.

## The solution

- **Leases, not locks.** Every node runs an identical tick loop; only the lease holder dispatches. Four backends implement the same four-method interface: in-process, shared filesystem, Redis (`SET NX PX` + Lua compare-and-extend), and any compare-and-swap HTTP endpoint (etcd gateway, Consul KV `?cas=`, a Durable Object). A crashed leader is replaced within one lease, with no human involvement.
- **Explicit misfire policy.** A slot observed late is handled by policy, not by hope: `skip` (drop it), `fire-once` (run one catch-up), or `fire-all` (replay every missed slot, bounded by `maxCatchup`).
- **Explicit overlap policy.** `skip`, `queue` (a queued slot starts the moment capacity frees) or `allow`.
- **Every run is a record.** Status, duration, exit code, captured stdout/stderr, attempt number and the exact `scheduledFor` slot — in memory for the live API, and optionally in an append-only JSONL journal that survives restarts and is readable by a different process.
- **Timeouts that actually kill.** Child processes are spawned detached and signalled as a process group: `SIGTERM`, then `SIGKILL` after a grace period. A wedged command cannot hold the schedule hostage.

### How this differs from the alternatives

| | `node-cron` / `setInterval` | `crontab` | Managed cloud schedulers | **this** |
|---|---|---|---|---|
| Multiple replicas without double-firing | ✗ | ✗ | ✓ (vendor-managed) | ✓ (your choice of lease backend) |
| Runs inside your process, with your code and env | ✓ | ✗ | ✗ | ✓ |
| Misfire and overlap policies | ✗ | ✗ | partial | ✓ |
| Durable run history you own | ✗ | ✗ | vendor-only | ✓ (JSONL) |
| Self-hosted, no vendor, no runtime dependency | ✓ | ✓ | ✗ | ✓ |

---

## How it works

```
                        ┌──────────────────────────────┐
                        │        CronScheduler         │
                        │  (identical on every node)   │
                        └──────────────┬───────────────┘
                                       │ tick every tickMs
                        ┌──────────────▼───────────────┐
                        │         LeaderElector        │
                        │  renew() ─ not leader? stop  │
                        │  acquire() ─ leader? dispatch│
                        └──────────────┬───────────────┘
                                       │ leader only
                        ┌──────────────▼───────────────┐
                        │   dispatchDue() per job      │
                        │   due? overlap? misfired?    │
                        └──────────────┬───────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
     ┌────────────────┐      ┌──────────────────┐     ┌──────────────────┐
     │ runCommand()   │      │  runHandler()    │     │   RunHistory     │
     │ detached child │      │  in-process fn   │     │  + JsonlRunLog   │
     │ SIGTERM→SIGKILL│      │  timeout race    │     │  durable trail   │
     └────────────────┘      └──────────────────┘     └──────────────────┘
                                       │
                        ┌──────────────▼───────────────┐
                        │ retries → backoff → journal  │
                        └──────────────────────────────┘
```

**The tick loop, in order.** Each tick (1s by default) renews the lease *before* dispatching, then re-checks leadership after the awaited call. A node that has lost its lease never starts new work. Because renewal happens first, the window in which two nodes can both believe they are leader is bounded by the lease, not by how long a job runs.

**Why retirement is bounded.** A retry whose backoff would land after the lease expires is abandoned rather than fired — a duplicate run is worse than an honest failure, because the successor leader will already have taken over that slot.

**Misfire handling.** A slot is "late" when it arrives more than `max(tickMs, 1000)` ms after its scheduled time. `fire-all` fires the overdue slot immediately, queues at most `maxCatchup - 1` more, and then resumes at the first slot strictly after now — without that last step every replay would still look overdue on the next tick and the catch-up would never converge.

---

## Getting started

Requires [Bun](https://bun.sh) ≥ 1.0 (recommended) or Node ≥ 20.

```bash
git clone https://github.com/Retsumdk/cron-scheduler-service.git
cd cron-scheduler-service
bun install
```

Validate an expression and preview its fire times — no config needed:

```console
$ bun src/cli.ts validate "*/15 9-17 * * MON-FRI"
✔ valid — */15 9-17 * * MON-FRI

$ bun src/cli.ts next "0 3 * * *" | head -4
2026-09-16T03:00:00.000Z
2026-09-17T03:00:00.000Z
2026-09-18T03:00:00.000Z
2026-09-19T03:00:00.000Z
```

Create a job, inspect it, run it by hand, read the history:

```console
$ bun src/cli.ts --store .cron/jobs.json add \
    --name hello --schedule "*/5 * * * *" --command "echo hello from cron"
Added hello (job_e095430378c14ef0a67b) — next run 2026-09-15T20:25:00.000Z

$ bun src/cli.ts --store .cron/jobs.json list
NAME   SCHEDULE         TZ   NEXT                      LAST  STATE
hello  every 5 minutes  UTC  2026-09-15T20:25:00.000Z  -     idle

$ bun src/cli.ts --store .cron/jobs.json trigger hello
success  hello

$ for i in 1 2 3; do bun src/cli.ts --store .cron/jobs.json trigger hello >/dev/null; done

$ bun src/cli.ts --store .cron/jobs.json runs --limit 3
2026-09-15T20:24:27.075Z  success      9ms  hello manual  hello from cron
2026-09-15T20:24:25.018Z  success     10ms  hello manual  hello from cron
2026-09-15T20:24:22.964Z  success      8ms  hello manual  hello from cron
```

`runs` works across processes because terminal records are appended to a JSONL journal (`<store>.runs.jsonl` by default). One line per run, appended, never rewritten.

### Running two replicas

Start the same service on every node, pointed at the same store, lease file and journal:

```bash
# node A
bun src/cli.ts --store .cron/jobs.json --history .cron/runs.jsonl \
  --elector file --lock-file .cron/leader.lock --lease 5s --port 4190 serve

# node B — identical, different port
bun src/cli.ts --store .cron/jobs.json --history .cron/runs.jsonl \
  --elector file --lock-file .cron/leader.lock --lease 5s --port 4191 serve
```

Verified against two live nodes sharing one lock file, with a job scheduled `* * * * * *` (every second):

| moment | node A | node B | journal lines |
|---|---|---|---|
| after 3s | `leader: false` | `leader: true` | 6 |
| `SIGKILL` node B | `leader: false` | *(dead)* | 26 |
| +5.9s | `leader: true` | *(dead)* | 26 |

Six runs in six seconds during the overlap — one per slot, not ten. And the journal is *frozen* across the kill: node A did not fire while it was still a standby, and only took over once B's lease had expired. That is the property that stops a rolling deploy from double-charging your customers.

For Redis instead of a shared filesystem:

```bash
--elector redis --redis-host 127.0.0.1 --redis-port 6379 --redis-key cron-scheduler:leader
```

---

## HTTP control plane

`serve` exposes the scheduler so you can inspect and steer it without a deploy.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health`, `/api/health` | Liveness. Always unauthenticated — probes cannot carry a token. |
| `GET` | `/api/status` | Scheduler state, leader, per-job runtime state, totals |
| `GET` | `/api/jobs` | Every job with its next fire time and upcoming slots |
| `POST` | `/api/jobs` | Create a job |
| `GET` | `/api/jobs/:id` | One job plus its last 20 runs |
| `PATCH`/`PUT` | `/api/jobs/:id` | Update (unspecified fields are kept) |
| `DELETE` | `/api/jobs/:id` | Remove |
| `POST` | `/api/jobs/:id/trigger` | Fire now, ignoring the schedule |
| `POST` | `/api/jobs/:id/enable` · `/disable` | Toggle |
| `GET` | `/api/runs` | Run history. Filters: `jobId`, `status`, `since`, `limit` |
| `DELETE` | `/api/runs` | Clear history (optionally scoped by `jobId`) |
| `GET` | `/api/handlers` | Handler names registered in this process |

```console
$ curl -s -X POST localhost:4180/api/jobs -H 'content-type: application/json' \
    -d '{"name":"every-second","schedule":"* * * * * *","command":"date -u +%H:%M:%S"}' >/dev/null
$ sleep 4
$ curl -s "localhost:4180/api/runs?limit=3" | jq -r '.runs[] | "\(.status)  \(.scheduledFor)  \(.output | gsub("\n$"; ""))  \(.durationMs)ms"'
success  1789503901000  20:25:01   6ms
success  1789503900000  20:25:00  12ms
success  1789503899000  20:24:59   7ms
```

Every run carries the exact `scheduledFor` slot, so a skipped or replayed slot is auditable rather than inferred.

Pass `--token <secret>` (or `CRON_API_TOKEN`) to require `Authorization: Bearer <secret>` on everything except `/health`. Comparison is length-checked and constant-time-ish, so an unauthenticated probe learns nothing about the token.

---

## Cron expression reference

Five fields, six fields (leading seconds), or an `@alias`:

```
┌───────────── minute        (0-59)
│ ┌─────────── hour          (0-23)
│ │ ┌───────── day of month  (1-31)
│ │ │ ┌─────── month         (1-12 or JAN-DEC)
│ │ │ │ ┌───── day of week   (0-6 or SUN-SAT, 0 and 7 = Sunday)
│ │ │ │ │
* * * * *
```

| Syntax | Meaning |
|---|---|
| `*` | every value |
| `*/15` | every 15th value |
| `9-17` | inclusive range |
| `1,15,30` | list |
| `9-17/2` | range with step |
| `MON-FRI`, `JAN,MAR` | names (case-insensitive) |
| `@hourly` `@daily` `@weekly` `@monthly` `@yearly` `@minutely` `@secondly` | shorthands (`@midnight` = `@daily`, `@annually` = `@yearly`) |

Top-level parsing is [Vixie-compatible](https://man7.org/linux/man-pages/man5/crontab.5.html), including the rule most implementations get wrong: **when both day-of-month and day-of-week are restricted, a date matches if *either* field matches** (`0 0 13 * FRI` fires on every 13th *and* every Friday). `parseCron` throws a `CronParseError` naming the offending field, and every job is validated at write time so a bad expression never reaches the store.

Schedules evaluate in UTC by default; `--tz +02:00` (or `tzOffsetMinutes` on the definition) evaluates in a fixed offset, which keeps behaviour deterministic and testable rather than depending on the host's `TZ`.

---

## Job policies

| Option | Default | Meaning |
|---|---|---|
| `timeoutMs` | `60000` | Per-attempt cap. Commands are killed as a process group. |
| `maxRetries` | `0` | Retries after a failure, so total attempts = `maxRetries + 1`. |
| `retryBackoffMs` | `1000` | Base delay, doubled per attempt. A retry landing after the lease is abandoned. |
| `overlap` | `skip` | `skip` drops the slot, `queue` runs it when capacity frees, `allow` runs concurrently. |
| `misfire` | `fire-once` | `skip`, `fire-once`, or `fire-all`. |
| `maxCatchup` | `100` | Upper bound on replayed slots per misfire episode. |
| `maxRuns` | — | Disable the job after N completed runs. |
| `shell` | `bash` | `bash` (`bash -lc`), `sh` (`sh -c`), or `none` (whitespace-split argv, no shell). |
| `cwd` / `env` | — | Working directory and extra environment for command jobs. |

Command jobs receive `CRON_JOB_ID`, `CRON_JOB_NAME`, `CRON_RUN_ID`, `CRON_ATTEMPT` and `CRON_SCHEDULED_FOR` in their environment, so the command can correlate its own logs with the run record.

---

## Using it as a library

```ts
import { CronScheduler, FileJobStore, JsonlRunLog, RedisElector, jsonLogger } from "cron-scheduler-service";

const scheduler = new CronScheduler({
  store: new FileJobStore(".cron/jobs.json"),
  runLog: new JsonlRunLog(".cron/runs.jsonl"),
  elector: new RedisElector({ host: "127.0.0.1", leaseMs: 15_000 }),
  tickMs: 1_000,
  logger: jsonLogger,
});

scheduler.registerHandler("invoice.reconcile", async ({ job, scheduledFor, attempt, logger }) => {
  logger.info("reconciling", { jobId: job.id, scheduledFor, attempt });
  const result = await reconcileInvoices(job.args.since as string);
  return { status: "success", output: `${result.count} invoices reconciled` };
});

await scheduler.addJob({
  name: "invoice-reconcile",
  schedule: "0 2 * * *",
  handler: "invoice.reconcile",
  args: { since: "-1d" },
  timeoutMs: 10 * 60_000,
  maxRetries: 2,
  overlap: "skip",
  misfire: "fire-once",
});

await scheduler.start();          // acquires the lease, begins ticking
process.on("SIGTERM", () => scheduler.stop());
```

A job is either a `command` (a shell command) or a `handler` (a function registered in this process) — never both. `handler` is the right choice when the job needs your application's modules, database pool or config; `command` is the right choice when the job is a script or another binary.

### Public API

| Export | What it is |
|---|---|
| `CronScheduler` | The engine: `start`/`stop`/`tick`, `addJob`/`updateJob`/`removeJob`/`enableJob`/`disableJob`, `trigger`, `registerHandler`, `views`/`status`/`runs`/`clearRuns`, `findJob` (by id, exact name, or unique prefix) |
| `parseCron`, `nextRun`, `nextRuns`, `previousRun`, `cronMatches`, `describeCron`, `CRON_ALIASES` | The cron parser as a standalone, dependency-free library |
| `MemoryElector`, `FileElector`, `RedisElector`, `HttpElector` | The four lease backends, each implementing `LeaderElector` |
| `MemoryJobStore`, `FileJobStore` | Job persistence (`MemoryJobStore` is a `Map`; `FileJobStore` writes atomically via temp file + `rename`) |
| `RunHistory`, `JsonlRunLog` | The bounded in-memory view and the durable append-only journal |
| `runCommand`, `runHandler`, `splitCommand` | The executor, usable on its own |
| `createHandler`, `startServer` | The HTTP control plane — `createHandler` returns a portable `fetch` handler that runs on Bun, Node, Deno or Workers |
| `normalizeJob`, `validateJobInput`, `JobValidationError` | Validation, so a bad definition fails at write time rather than at 3am |
| `formatDuration`, `formatSchedule` | Presentation helpers (`"*/15 * * * *"` → `"every 15 minutes"`) |

`LeaderElector` is four methods — `acquire()`, `renew()`, `release()`, `isLeader()` — so a backend for your own coordination system is a small class, not a fork.

---

## Design notes and honest limitations

- **Lease, not consensus.** A single lease grants at-most-one dispatcher, but the failure mode of a coordination backend that is *down* is "no leader", not "two leaders": every backend fails closed. `RedisElector` is correct against a single Redis node (use a hash tag, `{cron}:leader`, on a cluster so all commands land in one slot); `FileElector` assumes a filesystem with real atomic `open(..., "wx")` and needs clock agreement; `HttpElector` delegates the TTL to the server.
- **Lease expiry is the double-fire window.** If a leader stalls past its lease (GC pause, suspended VM) it may still be mid-run when a successor takes over. `tickMs` is deliberately decoupled from job duration to keep this window small; the retry-abandonment rule removes the most common way to walk into it.
- **Run history is deliberately lossy.** The in-memory view is bounded (`historyLimit`, default 500) because it is a diagnostic, not a ledger. The JSONL journal is the durable half; it is appended with `O(1)` writes and a torn final line is skipped on read.
- **`fire-all` is bounded on purpose.** A week-long outage during a `* * * * * *` schedule would otherwise replay 600,000 slots and stampede whatever the job touches. `maxCatchup` caps the episode, and each queued slot starts one per tick.
- **No distributed lock around the job body.** The lease elects a *scheduler*, not a critical section. If a job must never run twice under any circumstance, put an idempotency key in the run — `CRON_RUN_ID` is a fresh identifier for every execution, so it is the natural idempotency key (see [`idempotency-key-manager`](https://github.com/Retsumdk/idempotency-key-manager)).

---

## Testing

```bash
bun test          # 77 tests, 274 assertions
bun run typecheck # strict tsc, noUncheckedIndexedAccess
bun run build     # type declarations + dist/index.js + dist/cli.js
```

The suite runs against a deterministic fake clock and a real TCP server impersonating Redis over RESP, so leader election, misfire, overlap, retry, timeout and HTTP behaviour are covered without mocking the system under test. Nothing in the suite sleeps on a fixed interval: asynchronous effects are awaited with a predicate poll.

CI runs typecheck, tests, build, and a smoke test of the *built* CLI (`node dist/cli.js validate …`), which catches the class of bug where source imports resolve but the bundle does not.

---

## Related repositories

- [`retry-queue-worker`](https://github.com/Retsumdk/retry-queue-worker) — exponential-backoff retry queue
- [`dead-letter-queue`](https://github.com/Retsumdk/dead-letter-queue) — routing and inspection for failed messages
- [`health-check-monitor`](https://github.com/Retsumdk/health-check-monitor) — service health monitoring
- [`service-discovery-client`](https://github.com/Retsumdk/service-discovery-client) — dynamic service discovery with health-aware routing
- [`metrics-aggregator`](https://github.com/Retsumdk/metrics-aggregator) — metrics aggregation
- [`audit-logger`](https://github.com/Retsumdk/audit-logger) — tamper-evident hash-chained audit log
- [`api-key-manager`](https://github.com/Retsumdk/api-key-manager) — key issuance, quotas and rotation
- [`json-schema-validator`](https://github.com/Retsumdk/json-schema-validator) — dependency-free draft-07 validator

## License

MIT © [Retsumdk](https://github.com/Retsumdk)

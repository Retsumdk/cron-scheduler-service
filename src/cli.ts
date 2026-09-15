#!/usr/bin/env bun
/**
 * `cron-scheduler-service` CLI.
 *
 * Built on `node:util`'s `parseArgs`, so the whole package stays at zero
 * runtime dependencies. The CLI is the operator's tool: it can add, inspect,
 * trigger and remove jobs against the same store the service uses, and it can
 * start the service itself.
 *
 * Exit codes: 0 success, 1 operational failure, 2 usage or validation error.
 */

import { parseArgs } from "node:util";
import { formatDuration, formatSchedule } from "./format.ts";
import { CronParseError, nextRuns, parseCron } from "./cron.ts";
import { JobValidationError, type JobInput } from "./job.ts";
import { FileElector, HttpElector, MemoryElector, RedisElector } from "./leader.ts";
import { jsonLogger, silentLogger, CronScheduler } from "./scheduler.ts";
import { createHandler, startServer } from "./server.ts";
import { FileJobStore, JsonlRunLog, MemoryJobStore, type JobStore } from "./store.ts";
import type { LeaderElector, Logger } from "./types.ts";
import { parseDuration, parseTimezoneOffset } from "./util.ts";

const USAGE = `cron-scheduler-service — distributed cron with leader election

USAGE
  cron-scheduler-service <command> [options]

COMMANDS
  list                        List jobs with schedule, next fire time and state
  add                         Add a job
  remove <job>                Remove a job (by id, name, or unique prefix)
  enable <job>                Enable a job
  disable <job>               Disable a job
  trigger <job>               Fire a job now, regardless of schedule
  runs                        Show run history
  status                      Show scheduler and leader state
  serve                       Run the scheduler and HTTP control plane
  validate <expression>       Check a cron expression
  next <expression>           Print the next fire times for an expression
  help                        Show this message

GLOBAL OPTIONS
  --store <file>              JSON job store (default: in-memory)
  --history <file>            JSONL run journal (default: <store>.runs.jsonl)
  --elector <kind>            memory | file | redis | http   (default: memory)
  --lease <duration>          Lease TTL, e.g. 15s          (default: 15s)
  --node <id>                 Node identifier in lease records
  --token <secret>            Bearer token required by the HTTP API
  --port <n>                  HTTP port for \`serve\`         (default: $PORT or 3000)
  --log <format>              pretty | json | none          (default: pretty)
  --json                      Machine-readable output
  --help                      Show help

ELECTOR OPTIONS
  --lock-file <path>          file elector: lease file path
  --redis-host <host>         redis elector: host           (default: 127.0.0.1)
  --redis-port <n>            redis elector: port           (default: 6379)
  --redis-key <key>           redis elector: lease key      (default: cron-scheduler:leader)
  --redis-password <pw>       redis elector: AUTH password
  --coordinator-url <url>     http elector: CAS endpoint

ADD OPTIONS
  --name <name>               Human-readable job name          (required)
  --schedule <expr>           5-field, 6-field, or @alias cron  (required)
  --command <shell>           Shell command to run
  --handler <name>            Registered handler name (serve only)
  --timeout <duration>        Per-attempt timeout               (default: 60s)
  --retries <n>               Retry attempts after a failure    (default: 0)
  --backoff <duration>        Base delay between retries        (default: 1s)
  --overlap <policy>          skip | queue | allow              (default: skip)
  --misfire <policy>          skip | fire-once | fire-all       (default: fire-once)
  --max-catchup <n>           Cap on catch-up runs              (default: 100)
  --max-runs <n>              Disable the job after N runs
  --tz <±HH:MM>               Schedule timezone offset          (default: UTC)
  --shell <kind>              bash | sh | none                  (default: bash)
  --cwd <dir>                 Working directory for the command
  --env KEY=VALUE             Extra environment variable (repeatable)
  --disabled                  Create the job in the disabled state

EXAMPLES
  cron-scheduler-service next "*/15 * * * *"
  cron-scheduler-service add --name nightly --schedule "0 3 * * *" --command "make backup"
  cron-scheduler-service --store .cron/jobs.json list --json
  cron-scheduler-service trigger nightly
  cron-scheduler-service --elector redis serve --port 8080
`;

interface CliOptions {
  store?: string;
  history?: string;
  elector: string;
  lease: number;
  node?: string;
  token?: string;
  port?: number;
  log: string;
  json: boolean;
  lockFile?: string;
  redisHost?: string;
  redisPort?: number;
  redisKey?: string;
  redisPassword?: string;
  coordinatorUrl?: string;
}

function buildLogger(kind: string): Logger {
  return kind === "json" ? jsonLogger : silentLogger;
}

function buildStore(path: string | undefined): JobStore {
  return path ? new FileJobStore(path) : new MemoryJobStore();
}

function buildElector(options: CliOptions): LeaderElector {
  const common = { leaseMs: options.lease, nodeId: options.node };
  switch (options.elector) {
    case "memory":
      return new MemoryElector("cli", common);
    case "file": {
      if (!options.lockFile) throw new JobValidationError('--elector file requires --lock-file <path>');
      return new FileElector(options.lockFile, common);
    }
    case "redis":
      return new RedisElector({
        ...common,
        host: options.redisHost,
        port: options.redisPort,
        key: options.redisKey,
        password: options.redisPassword,
      });
    case "http": {
      if (!options.coordinatorUrl) throw new JobValidationError('--elector http requires --coordinator-url <url>');
      return new HttpElector({ ...common, url: options.coordinatorUrl });
    }
    default:
      throw new JobValidationError(`Unknown elector "${options.elector}"`);
  }
}

function printJobs(views: ReturnType<CronScheduler["views"]>, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify({ jobs: views }, null, 2));
    return;
  }
  if (views.length === 0) {
    console.log("No jobs registered.");
    return;
  }
  const rows = views.map((view) => ({
    name: view.job.name,
    schedule: formatSchedule(view.job.schedule),
    tz: view.job.tzOffsetMinutes === 0 ? "UTC" : `${view.job.tzOffsetMinutes}m`,
    next: view.nextRunAt === null ? "-" : new Date(view.nextRunAt).toISOString(),
    last: view.lastStatus ?? "-",
    state: view.job.enabled ? (view.activeRuns > 0 ? "running" : "idle") : "disabled",
  }));
  const header = ["NAME", "SCHEDULE", "TZ", "NEXT", "LAST", "STATE"];
  const keys = ["name", "schedule", "tz", "next", "last", "state"] as const;
  const widths = keys.map((key, i) => Math.max(header[i]!.length, ...rows.map((r) => r[key].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  console.log(line(header));
  for (const row of rows) console.log(line(keys.map((key) => row[key])));
}

function printRuns(runs: ReturnType<CronScheduler["runs"]>, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify({ runs }, null, 2));
    return;
  }
  if (runs.length === 0) {
    console.log("No runs recorded.");
    return;
  }
  for (const run of runs) {
    const stamp = new Date(run.startedAt).toISOString();
    const duration = run.durationMs === null ? "-" : formatDuration(run.durationMs);
    const detail = run.error ?? run.output?.split("\n")[0] ?? "";
    const attempt = run.attempt > 1 ? ` attempt=${run.attempt}` : "";
    const manual = run.manual ? " manual" : "";
    console.log(
      `${stamp}  ${run.status.padEnd(8)}${duration.padStart(8)}  ${run.jobName}${attempt}${manual}${
        detail ? `  ${detail.slice(0, 120)}` : ""
      }`,
    );
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // `run` is accepted as an alias for `serve` for operators who expect it.
  const normalized = argv[0] === "run" ? ["serve", ...argv.slice(1)] : argv;

  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({
      args: normalized,
      allowPositionals: true,
      strict: false,
      options: {
        store: { type: "string" },
        history: { type: "string" },
        elector: { type: "string" },
        lease: { type: "string" },
        node: { type: "string" },
        token: { type: "string" },
        port: { type: "string" },
        log: { type: "string" },
        json: { type: "boolean" },
        "lock-file": { type: "string" },
        "redis-host": { type: "string" },
        "redis-port": { type: "string" },
        "redis-key": { type: "string" },
        "redis-password": { type: "string" },
        "coordinator-url": { type: "string" },
        name: { type: "string" },
        schedule: { type: "string" },
        command: { type: "string" },
        handler: { type: "string" },
        timeout: { type: "string" },
        retries: { type: "string" },
        backoff: { type: "string" },
        overlap: { type: "string" },
        misfire: { type: "string" },
        "max-catchup": { type: "string" },
        "max-runs": { type: "string" },
        tz: { type: "string" },
        shell: { type: "string" },
        cwd: { type: "string" },
        env: { type: "string", multiple: true },
        disabled: { type: "boolean" },
        limit: { type: "string" },
        job: { type: "string" },
        help: { type: "boolean" },
      },
    }) as unknown as { values: Record<string, unknown>; positionals: string[] };
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error("\nRun `cron-scheduler-service help` for usage.");
    return 2;
  }

  const options = parsed.values as Record<string, unknown>;
  const [command, ...rest] = parsed.positionals;

  if (!command || command === "help" || options.help === true) {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  const rawEnv = Array.isArray(options.env) ? (options.env as string[]) : [];
  const env: Record<string, string> = {};
  for (const entry of rawEnv) {
    const index = entry.indexOf("=");
    if (index <= 0) throw new JobValidationError(`--env expects KEY=VALUE, got "${entry}"`);
    env[entry.slice(0, index)] = entry.slice(index + 1);
  }

  const cli: CliOptions = {
    store: options.store as string | undefined,
    history: options.history as string | undefined,
    elector: (options.elector as string | undefined) ?? "memory",
    lease: parseDuration((options.lease as string | undefined) ?? "15s", 15_000),
    node: options.node as string | undefined,
    token: (options.token as string | undefined) ?? process.env.CRON_API_TOKEN,
    port: options.port === undefined ? undefined : Number(options.port),
    log: (options.log as string | undefined) ?? "pretty",
    json: options.json === true,
    lockFile: options["lock-file"] as string | undefined,
    redisHost: options["redis-host"] as string | undefined,
    redisPort: options["redis-port"] === undefined ? undefined : Number(options["redis-port"]),
    redisKey: options["redis-key"] as string | undefined,
    redisPassword:
      (options["redis-password"] as string | undefined) ?? process.env.CRON_REDIS_PASSWORD,
    coordinatorUrl: options["coordinator-url"] as string | undefined,
  };

  // `validate` and `next` are pure functions of the expression — no store, no
  // elector, so they cannot fail for environmental reasons.
  if (command === "validate" || command === "next") {
    const expression = rest.join(" ").trim();
    if (!expression) {
      console.error(`Usage: cron-scheduler-service ${command} "<cron expression>"`);
      return 2;
    }
    try {
      const fields = parseCron(expression);
      if (command === "validate") {
        if (cli.json) console.log(JSON.stringify({ valid: true, expression, fields }, null, 2));
        else console.log(`✔ valid — ${formatSchedule(expression)}`);
        return 0;
      }
      const from = Date.now();
      const times = nextRuns(fields, from, 10, 0);
      if (cli.json) console.log(JSON.stringify({ expression, times }, null, 2));
      else for (const time of times) console.log(new Date(time).toISOString());
      return 0;
    } catch (err) {
      if (!(err instanceof CronParseError)) throw err;
      if (cli.json) console.log(JSON.stringify({ valid: false, error: err.message }, null, 2));
      else console.error(`✖ ${err.message}`);
      return 2;
    }
  }

  const store = buildStore(cli.store);
  const elector = buildElector(cli);
  const scheduler = new CronScheduler({
    store,
    elector,
    logger: buildLogger(cli.log),
    execute: { env },
    // A journal alongside the job store means `runs` answers questions about
    // runs that happened in earlier processes, not just this one.
    runLog: new JsonlRunLog(cli.history ?? `${cli.store ?? ".cron/jobs.json"}.runs.jsonl`),
  });
  await scheduler.start();

  switch (command) {
    case "list": {
      printJobs(scheduler.views(), cli.json);
      await scheduler.stop();
      return 0;
    }

    case "status": {
      const status = scheduler.status();
      if (cli.json) console.log(JSON.stringify(status, null, 2));
      else {
        console.log(`running    ${status.running}`);
        console.log(`leader     ${status.leader} (${status.elector.name})`);
        console.log(`jobs       ${status.totals.jobs} (${status.totals.enabled} enabled)`);
        console.log(`runs       ${status.totals.completedRuns} completed, ${status.totals.failedRuns} failed`);
        if (status.elector.leaseUntil !== null) {
          console.log(`lease      until ${new Date(status.elector.leaseUntil).toISOString()}`);
        }
      }
      await scheduler.stop();
      return 0;
    }

    case "add": {
      const tzRaw = options.tz as string | undefined;
      const tzOffsetMinutes = tzRaw === undefined ? 0 : parseTimezoneOffset(tzRaw);
      if (tzRaw !== undefined && tzOffsetMinutes === null) {
        throw new JobValidationError(`--tz expects UTC or ±HH:MM, got "${tzRaw}"`);
      }
      const input: JobInput = {
        name: options.name as string,
        schedule: options.schedule as string,
        command: options.command as string | undefined,
        handler: options.handler as string | undefined,
        timeoutMs: options.timeout === undefined ? undefined : parseDuration(options.timeout as string, 30_000),
        maxRetries: options.retries === undefined ? undefined : Number(options.retries),
        retryBackoffMs: options.backoff === undefined ? undefined : parseDuration(options.backoff as string, 1_000),
        overlap: options.overlap as JobInput["overlap"],
        misfire: options.misfire as JobInput["misfire"],
        maxCatchup: options["max-catchup"] === undefined ? undefined : Number(options["max-catchup"]),
        maxRuns: options["max-runs"] === undefined ? undefined : Number(options["max-runs"]),
        tzOffsetMinutes: tzOffsetMinutes ?? 0,
        shell: options.shell as JobInput["shell"],
        cwd: options.cwd as string | undefined,
        env: Object.keys(env).length > 0 ? env : undefined,
        enabled: options.disabled === true ? false : undefined,
      };
      // `addJob` normalises and validates, so the CLI passes raw values and
      // lets a single validator own the rules.
      const job = await scheduler.addJob(input);
      const view = scheduler.views().find((v) => v.job.id === job.id);
      if (cli.json) console.log(JSON.stringify(job, null, 2));
      else console.log(`Added ${job.name} (${job.id}) — next run ${view?.nextRunAt ? new Date(view.nextRunAt).toISOString() : "never"}`);
      await scheduler.stop();
      return 0;
    }

    case "remove": {
      const ref = rest[0];
      if (!ref) throw new JobValidationError("remove requires a job id, name, or unique prefix");
      const job = scheduler.findJob(ref);
      if (!job) throw new JobValidationError(`No job matching "${ref}"`);
      const deleted = await scheduler.removeJob(job.id);
      if (cli.json) console.log(JSON.stringify({ deleted, jobId: job.id }, null, 2));
      else console.log(deleted ? `Removed ${job.name}` : `Job ${job.id} was not in the store`);
      await scheduler.stop();
      return deleted ? 0 : 1;
    }

    case "enable":
    case "disable": {
      const ref = rest[0];
      if (!ref) throw new JobValidationError(`${command} requires a job id, name, or unique prefix`);
      const job = scheduler.findJob(ref);
      if (!job) throw new JobValidationError(`No job matching "${ref}"`);
      const updated = command === "enable" ? await scheduler.enableJob(job.id) : await scheduler.disableJob(job.id);
      if (cli.json) console.log(JSON.stringify(updated, null, 2));
      else console.log(`${updated.enabled ? "Enabled" : "Disabled"} ${updated.name}`);
      await scheduler.stop();
      return 0;
    }

    case "trigger": {
      const ref = rest[0];
      if (!ref) throw new JobValidationError("trigger requires a job id, name, or unique prefix");
      const job = scheduler.findJob(ref);
      if (!job) throw new JobValidationError(`No job matching "${ref}"`);
      const record = await scheduler.trigger(job.id);
      // Give the executor a moment to settle so the printed status is final.
      await new Promise((resolve) => setTimeout(resolve, Math.min(job.timeoutMs, 2_000)));
      const settled = scheduler.runs({ jobId: job.id, limit: 1 })[0];
      if (cli.json) console.log(JSON.stringify(settled ?? record, null, 2));
      else console.log(`${settled?.status ?? "running"}  ${job.name}${settled?.error ? `  ${settled.error}` : ""}`);
      await scheduler.stop();
      return settled && settled.status !== "success" ? 1 : 0;
    }

    case "runs": {
      printRuns(
        scheduler.runs({
          jobId: options.job === undefined ? undefined : scheduler.findJob(options.job as string)?.id,
          limit: options.limit === undefined ? 25 : Number(options.limit),
        }),
        cli.json,
      );
      await scheduler.stop();
      return 0;
    }

    case "serve": {
      const port = cli.port ?? Number(process.env.PORT ?? 3000);
      const logger = cli.log === "none" ? silentLogger : jsonLogger;
      const server = startServer(scheduler, {
        port,
        token: cli.token,
        onListen: ({ url }) => logger.info("control plane listening", { url }),
      });
      console.log(`cron-scheduler-service listening on ${server.url}`);
      if (!cli.token) console.log("warning: no --token set; the control plane is unauthenticated");
      // The scheduler's interval is unref'd, so keep the process alive here.
      await new Promise<void>((resolve) => {
        const shutdown = () => resolve();
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
      await scheduler.stop();
      await server.stop();
      return 0;
    }

    default:
      console.error(`Unknown command "${command}".`);
      console.error("\nRun `cron-scheduler-service help` for usage.");
      await scheduler.stop();
      return 2;
  }
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(err instanceof JobValidationError || err instanceof CronParseError ? 2 : 1);
    });
}

export { createHandler };

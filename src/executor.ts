/**
 * Job execution.
 *
 * Two kinds of job:
 *   - `command` — a shell command, spawned as a child process
 *   - `handler` — a function registered in-process with the scheduler
 *
 * Both paths share the same contract: they must honour the job's timeout, must
 * never leave a child process running after the timeout fires, and must return
 * a `RunResult` rather than throwing. A throwing executor would take down the
 * tick loop; a hanging child process would wedge the whole cluster.
 */

import { spawn } from "node:child_process";
import { parseArgs as parseCommandLine } from "node:util";
import type { Handler, JobContext, JobDefinition, RunResult } from "./types.ts";

export interface ExecuteOptions {
  /** Cap on captured stdout/stderr held in the run record. Default 16 KiB. */
  maxOutputBytes?: number;
  /** Grace period between SIGTERM and SIGKILL. Default 5s. */
  killGraceMs?: number;
  /** Environment merged into every child process. */
  env?: Record<string, string>;
}

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;

/** Splits a command string into argv without invoking a shell. */
export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of command) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Runs a job. Dispatches on whether the job names a handler or a command.
 * Used by the scheduler for both paths; handlers missing from the registry are
 * a configuration error and are reported as failures, not thrown.
 */
export async function runHandler(
  job: JobDefinition,
  ctx: JobContext,
  handlers: Map<string, Handler>,
  options?: ExecuteOptions,
): Promise<RunResult> {
  const name = job.handler;
  if (!name) return { status: "failed", error: "Job has no handler name" };
  const handler = handlers.get(name);
  if (!handler) {
    return {
      status: "failed",
      error: `No handler registered under "${name}". Register it with scheduler.registerHandler("${name}", fn).`,
    };
  }

  const timeoutMs = job.timeoutMs > 0 ? job.timeoutMs : 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();

  const timeout = timeoutMs
    ? new Promise<RunResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout", error: `Handler timed out after ${timeoutMs}ms` }), timeoutMs);
        timer.unref?.();
      })
    : null;

  try {
    // The handler is invoked inside a `then` so that a handler which throws
    // *synchronously* becomes a failed run rather than a rejected promise that
    // escapes the executor and stalls the caller.
    const work = Promise.resolve()
      .then(() => handler(ctx))
      .then(
      (result): RunResult => (result && typeof result === "object" ? result : { status: "success", output: String(result) }),
      (err): RunResult => ({ status: "failed", error: err instanceof Error ? err.message : String(err) }),
    );
    const result = timeout ? await Promise.race([work, timeout]) : await work;
    const durationMs = Date.now() - started;
    if (ctx.attempt > 0) {
      ctx.logger.debug("handler finished", { jobId: job.id, durationMs, status: result.status });
    }
    return truncateOutput(result, options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Spawns a shell command and captures its output. On timeout the process group
 * is signalled, first with SIGTERM and then, after `killGraceMs`, with SIGKILL —
 * so a wedged child cannot hold the scheduler hostage.
 */
export async function runCommand(
  job: JobDefinition,
  ctx: JobContext,
  options?: ExecuteOptions,
): Promise<RunResult> {
  const command = job.command;
  if (!command) return { status: "failed", error: "Job has no command" };

  const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const killGraceMs = options?.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  const args: string[] =
    job.shell === "bash"
      ? ["-lc", command]
      : job.shell === "sh"
        ? ["-c", command]
        : splitCommand(command);
  const file = job.shell === "none" ? args.shift() : job.shell === "bash" ? "bash" : "sh";
  if (!file) return { status: "failed", error: "Command resolved to an empty argv" };

  if (job.shell === "none" && args.length === 0) {
    return { status: "failed", error: "Command resolved to an executable with no arguments" };
  }

  const env = {
    ...process.env,
    ...(options?.env ?? {}),
    ...(job.env ?? {}),
    // Exposed so the command can correlate its logs with the run record.
    CRON_JOB_ID: job.id,
    CRON_JOB_NAME: job.name,
    CRON_RUN_ID: ctx.runId,
    CRON_ATTEMPT: String(ctx.attempt),
    CRON_SCHEDULED_FOR: new Date(ctx.scheduledFor).toISOString(),
  };

  return await new Promise<RunResult>((resolve) => {
    const child = spawn(file, args, {
      cwd: job.cwd ?? options?.env?.CRON_CWD ?? process.cwd(),
      env,
      detached: job.shell === "none" ? false : true,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const append = (target: "out" | "err", chunk: Buffer) => {
      const budget = maxOutputBytes - (target === "out" ? stdoutBytes : stderrBytes);
      if (budget <= 0) {
        truncated = true;
        return;
      }
      const slice = chunk.byteLength > budget ? chunk.subarray(0, budget) : chunk;
      if (slice.byteLength < chunk.byteLength) truncated = true;
      if (target === "out") {
        stdout += slice.toString("utf8");
        stdoutBytes += slice.byteLength;
      } else {
        stderr += slice.toString("utf8");
        stderrBytes += slice.byteLength;
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => append("out", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("err", chunk));

    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        // Negative pid targets the whole process group so grandchildren die too.
        if (job.shell === "none") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const trimmed = truncateOutput(result, maxOutputBytes);
      // Make the cut visible to whoever reads the run record, rather than
      // silently handing back a half-finished log.
      resolve(truncated && trimmed.output ? { ...trimmed, output: `${trimmed.output}\n… output truncated` } : trimmed);
    };

    const timer =
      job.timeoutMs > 0
        ? setTimeout(() => {
            kill("SIGTERM");
            killTimer = setTimeout(() => kill("SIGKILL"), killGraceMs);
            killTimer.unref?.();
            finish({ status: "timeout", error: `Command timed out after ${job.timeoutMs}ms`, output: stdout, exitCode: -1 });
          }, job.timeoutMs)
        : undefined;
    timer?.unref?.();

    const onAbort = () => {
      kill("SIGKILL");
      finish({ status: "failed", error: "Scheduler shut down while the command was running", output: stdout, exitCode: -1 });
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      ctx.signal.removeEventListener("abort", onAbort);
      finish({ status: "failed", error: `Failed to spawn command: ${err.message}` });
    });

    child.on("close", (code, signal) => {
      ctx.signal.removeEventListener("abort", onAbort);
      const output = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");
      if (code === 0) {
        finish({ status: "success", output, exitCode: 0 });
        return;
      }
      const reason = signal ? `killed by ${signal}` : `exited with code ${code}`;
      finish({
        status: "failed",
        error: stderr.trim() || `Command ${reason}`,
        output,
        exitCode: code ?? -1,
      });
    });
  });
}

function truncateOutput(result: RunResult, maxBytes: number): RunResult {
  if (!result.output || Buffer.byteLength(result.output) <= maxBytes) return result;
  return { ...result, output: `${Buffer.from(result.output).subarray(0, maxBytes).toString("utf8")}\n… output truncated` };
}

/** Parses `--key=value` pairs from a CLI-style argument list. */
export function parseKeyValues(raw: string[]): Record<string, string> {
  if (raw.length === 0) return {};
  const { values } = parseCommandLine({ args: raw, strict: false, allowPositionals: true });
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return out;
}

/**
 * HTTP control plane.
 *
 * A cron service that cannot be inspected or steered at runtime is a liability:
 * when a job misfires at 3am you need to see why it fired, disable it, and fire
 * it by hand — without a deploy. These endpoints are that surface.
 *
 * `createHandler` returns a portable fetch-style handler (Bun, Deno, Workers,
 * tests). `startServer` binds it to a real port, preferring Bun's server and
 * falling back to `node:http` so the same code runs on either runtime.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CronParseError } from "./cron.ts";
import { JobValidationError, type JobInput } from "./job.ts";
import type { CronScheduler } from "./scheduler.ts";

export interface ServerOptions {
  /** Optional bearer token. When set, every /api route requires it. */
  token?: string;
  /** Serve the read-only routes without a token even when one is configured. */
  publicRead?: boolean;
  /** Route prefix. Default `/api`. */
  prefix?: string;
}

export interface StartServerOptions extends ServerOptions {
  port: number;
  hostname?: string;
  onListen?: (info: { port: number; url: string }) => void;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

function fail(message: string, status = 400, extra?: Record<string, unknown>): Response {
  return json({ error: message, ...extra }, status);
}

/** Maps thrown errors onto the right status code instead of a blanket 500. */
function errorResponse(err: unknown): Response {
  if (err instanceof JobValidationError || err instanceof CronParseError) return fail(err.message, 400);
  if (err instanceof SyntaxError) return fail(`Malformed JSON body: ${err.message}`, 400);
  const message = err instanceof Error ? err.message : String(err);
  if (/^No job with id/.test(message)) return fail(message, 404);
  if (/already exists/.test(message)) return fail(message, 409);
  return fail(message, 500);
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JobValidationError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function authorized(req: Request, options: ServerOptions, method: string, path: string): boolean {
  if (!options.token) return true;
  if (options.publicRead && method === "GET" && !path.endsWith("/status") && !path.endsWith("/runs")) return true;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token.length !== options.token.length) return false;
  // Length-checked constant-time-ish compare; avoids leaking the prefix.
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) diff |= token.charCodeAt(i) ^ options.token.charCodeAt(i);
  return diff === 0;
}

function matches(segments: string[], pattern: string[]): Record<string, string> | null {
  if (segments.length !== pattern.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i]!;
    const actual = segments[i]!;
    if (expected.startsWith(":")) params[expected.slice(1)] = decodeURIComponent(actual);
    else if (expected !== actual) return null;
  }
  return params;
}

/** Builds a fetch handler bound to one scheduler instance. */
export function createHandler(scheduler: CronScheduler, options: ServerOptions = {}): (req: Request) => Promise<Response> {
  const prefix = (options.prefix ?? "/api").replace(/\/$/, "");

  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/$/, "") || "/";
      const method = req.method.toUpperCase();

      // Liveness is deliberately unauthenticated: an orchestrator's probe
      // cannot be expected to hold a token, and the payload exposes nothing
      // beyond whether this node is up and holds the lease.
      const isLiveness = method === "GET" && (path === "/health" || path === `${prefix}/health`);

      if (!isLiveness && !authorized(req, options, method, path)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...JSON_HEADERS, "www-authenticate": 'Bearer realm="cron-scheduler"' },
        });
      }

      /* ---- health & status ---- */
      if (isLiveness) {
        const status = scheduler.status();
        return json({ ok: status.running, leader: status.leader, elector: status.elector.name }, status.running ? 200 : 503);
      }
      if (method === "GET" && path === `${prefix}/status`) return json(scheduler.status());

      /* ---- jobs ---- */
      if (path === `${prefix}/jobs`) {
        if (method === "GET") return json({ jobs: scheduler.views() });
        if (method === "POST") {
          const body = await readJson(req);
          const created = await scheduler.addJob(body as unknown as JobInput);
          return json(scheduler.views().find((v) => v.job.id === created.id) ?? { job: created }, 201);
        }
        return fail(`${method} not allowed on ${path}`, 405);
      }

      const jobRoute = matches(path.split("/").filter(Boolean), [...prefix.split("/").filter(Boolean), "jobs", ":id"]);
      if (jobRoute) {
        const job = scheduler.findJob(jobRoute.id!);
        if (!job) return fail(`No job with id ${jobRoute.id}`, 404);
        const id = job.id;

        if (method === "GET") {
          const view = scheduler.views().find((v) => v.job.id === id);
          return json({ ...view, runs: scheduler.runs({ jobId: id, limit: 20 }) });
        }
        if (method === "PATCH" || method === "PUT") {
          const updated = await scheduler.updateJob(id, (await readJson(req)) as Partial<JobInput>);
          return json({ job: updated });
        }
        if (method === "DELETE") {
          const removed = await scheduler.removeJob(id);
          return json({ removed }, removed ? 200 : 404);
        }
        return fail(`${method} not allowed on ${path}`, 405);
      }

      const actionRoute = matches(path.split("/").filter(Boolean), [
        ...prefix.split("/").filter(Boolean),
        "jobs",
        ":id",
        ":action",
      ]);
      if (actionRoute && method === "POST") {
        const job = scheduler.findJob(actionRoute.id!);
        if (!job) return fail(`No job with id ${actionRoute.id}`, 404);
        switch (actionRoute.action) {
          case "trigger": {
            const record = await scheduler.trigger(job.id);
            return json({ triggered: true, runId: record.runId, jobId: job.id }, 202);
          }
          case "enable":
            return json({ job: await scheduler.enableJob(job.id) });
          case "disable":
            return json({ job: await scheduler.disableJob(job.id) });
          default:
            return fail(`Unknown action "${actionRoute.action}"`, 404);
        }
      }

      /* ---- runs ---- */
      if (path === `${prefix}/runs`) {
        if (method === "GET") {
          const status = url.searchParams.get("status") ?? undefined;
          const jobRef = url.searchParams.get("jobId") ?? undefined;
          const resolved = jobRef ? scheduler.findJob(jobRef)?.id : undefined;
          if (jobRef && !resolved) return fail(`No job matching "${jobRef}"`, 404);
          const limit = url.searchParams.get("limit");
          return json({
            runs: scheduler.runs({
              jobId: resolved,
              status: status as never,
              limit: limit ? Math.max(1, Number(limit)) : 100,
              since: url.searchParams.get("since") ? Number(url.searchParams.get("since")) : undefined,
            }),
          });
        }
        if (method === "DELETE") {
          const jobRef = url.searchParams.get("jobId") ?? undefined;
          const resolved = jobRef ? scheduler.findJob(jobRef)?.id : undefined;
          return json({ cleared: scheduler.clearRuns(resolved) });
        }
        return fail(`${method} not allowed on ${path}`, 405);
      }

      /* ---- handlers ---- */
      if (method === "GET" && path === `${prefix}/handlers`) return json({ handlers: scheduler.listHandlers() });

      return fail(`No route for ${method} ${path}`, 404);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/**
 * Binds the handler to a port. Uses Bun's server when available and otherwise
 * `node:http`, so the same CLI works on Bun and Node without a flag.
 */
export function startServer(scheduler: CronScheduler, options: StartServerOptions): { stop: () => Promise<void>; url: string } {
  const handler = createHandler(scheduler, options);
  const hostname = options.hostname ?? "0.0.0.0";
  const bunGlobal = (globalThis as { Bun?: { serve: (opts: unknown) => { port: number; stop: (force?: boolean) => void } } }).Bun;

  if (bunGlobal) {
    const server = bunGlobal.serve({
      port: options.port,
      hostname,
      fetch: (req: Request) => handler(req),
    });
    const url = `http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${server.port}`;
    options.onListen?.({ port: server.port, url });
    return { stop: async () => server.stop(true), url };
  }

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length > 0 ? new Uint8Array(Buffer.concat(chunks)) : undefined;
      const request = new Request(url, {
        method: req.method ?? "GET",
        headers: req.headers as Record<string, string>,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((err: unknown) => {
      res.writeHead(500, JSON_HEADERS);
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });

  server.listen(options.port, hostname);
  const url = `http://${hostname === "0.0.0.0" ? "localhost" : hostname}:${options.port}`;
  options.onListen?.({ port: options.port, url });
  return {
    stop: async () =>
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    url,
  };
}

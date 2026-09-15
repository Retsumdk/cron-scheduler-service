/**
 * Leader election.
 *
 * A cron *service* differs from a cron *job* in exactly one way: several
 * replicas run it, and only one may fire each schedule slot. Everything else —
 * parsing, timeouts, retries — is local. So leadership is isolated behind a
 * four-method lease interface, and four backends implement it:
 *
 *   MemoryElector — single process, useful for tests and dev
 *   FileElector   — shared filesystem (NFS, EFS, a k8s RWX volume)
 *   RedisElector  — Redis SET NX PX + Lua compare-and-extend
 *   HttpElector   — any CAS-capable coordination endpoint (etcd-style)
 *
 * Leases, not locks. Every backend has a TTL so a crashed leader is replaced
 * without human intervention. The dangerous window is the gap between "my
 * lease expired" and "I noticed" — all four backends answer `renew()` with
 * `false` the moment the lease is gone, and the scheduler refuses to dispatch
 * new work until it re-acquires.
 */

import { randomUUID } from "node:crypto";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { connect, type Socket } from "node:net";
import type { ElectorOptions, ElectorState, LeaderElector } from "./types.ts";

export const DEFAULT_LEASE_MS = 15_000;

export function defaultNodeId(): string {
  return `${hostname()}:${process.pid}`;
}

/** Renewal interval: a third of the lease leaves room for two lost rounds. */
export function renewIntervalMs(leaseMs: number): number {
  return Math.max(250, Math.floor(leaseMs / 3));
}

abstract class BaseElector implements LeaderElector {
  readonly name: string;
  protected readonly leaseMs: number;
  protected readonly nodeId: string;
  protected token: string | null = null;
  protected leaseUntil: number | null = null;

  constructor(name: string, options: ElectorOptions = {}) {
    this.name = name;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.nodeId = options.nodeId ?? defaultNodeId();
    if (this.leaseMs < 1_000) throw new Error(`leaseMs must be >= 1000 (got ${this.leaseMs})`);
  }

  isLeader(): boolean {
    return this.token !== null && (this.leaseUntil ?? 0) > Date.now();
  }

  describe(): ElectorState {
    return {
      name: this.name,
      isLeader: this.isLeader(),
      token: this.token,
      leaseUntil: this.leaseUntil,
    };
  }

  protected grant(token: string): boolean {
    this.token = token;
    this.leaseUntil = Date.now() + this.leaseMs;
    return true;
  }

  protected drop(): void {
    this.token = null;
    this.leaseUntil = null;
  }

  abstract acquire(): Promise<boolean>;
  abstract renew(): Promise<boolean>;
  abstract release(): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* In-memory                                                                  */
/* -------------------------------------------------------------------------- */

interface MemoryLease {
  token: string;
  owner: string;
  expiresAt: number;
}

/**
 * Process-wide elector. Leases live in a module-level registry so two
 * schedulers in the *same* process contend correctly — that is what makes it
 * useful as a test double. It is not coordination across machines.
 */
export class MemoryElector extends BaseElector {
  private static readonly leases = new Map<string, MemoryLease>();

  private readonly key: string;
  /**
   * Distinguishes this elector *instance* from any other in the same process.
   * The node id is a host:pid pair, so without this two schedulers in one
   * process would both believe they own the lease — which would make the
   * in-memory backend useless as a test double and would mask real contention.
   */
  private readonly instanceId = randomUUID();

  /** Lease owner key for this instance. */
  private get owner(): string {
    return `${this.nodeId}#${this.instanceId}`;
  }

  constructor(scope = "default", options: ElectorOptions = {}) {
    super(`memory:${scope}`, options);
    this.key = scope;
  }

  async acquire(): Promise<boolean> {
    const existing = MemoryElector.leases.get(this.key);
    const now = Date.now();
    if (existing && existing.expiresAt > now && existing.owner !== this.owner) {
      return false;
    }
    const mine = existing && existing.expiresAt > now && existing.owner === this.owner;
    const token = mine ? existing.token : randomUUID();
    MemoryElector.leases.set(this.key, { token, owner: this.owner, expiresAt: now + this.leaseMs });
    return this.grant(token);
  }

  async renew(): Promise<boolean> {
    if (!this.isLeader()) {
      this.drop();
      return false;
    }
    MemoryElector.leases.set(this.key, { token: this.token!, owner: this.owner, expiresAt: Date.now() + this.leaseMs });
    this.leaseUntil = Date.now() + this.leaseMs;
    return true;
  }

  async release(): Promise<void> {
    const existing = MemoryElector.leases.get(this.key);
    if (existing && existing.token === this.token) MemoryElector.leases.delete(this.key);
    this.drop();
  }

  /** Test helper — wipes all in-process leases. */
  static reset(): void {
    MemoryElector.leases.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* File system                                                                */
/* -------------------------------------------------------------------------- */

interface FileLease {
  token: string;
  owner: string;
  pid: number;
  expiresAt: number;
}

export interface FileElectorOptions extends ElectorOptions {
  /**
   * Delay before stealing an expired lease, randomised up to this many ms.
   * Spreads out contention when several standbys notice the expiry together.
   */
  takeoverJitterMs?: number;
}

/**
 * Lease file on a shared filesystem.
 *
 * Acquisition uses `open(path, "wx")`, which is atomic on POSIX — exactly one
 * of N concurrent creators wins. Expiry takeover has an unavoidable race
 * (two nodes can both delete a stale file and both re-create it); the jittered
 * delay plus a post-write re-read that verifies we still own the file makes
 * the window small, and the lease TTL bounds the damage if it is lost.
 */
export class FileElector extends BaseElector {
  private readonly path: string;
  private readonly takeoverJitterMs: number;

  constructor(path: string, options: FileElectorOptions = {}) {
    super(`file:${path}`, options);
    this.path = path;
    this.takeoverJitterMs = options.takeoverJitterMs ?? 50;
  }

  private async readLease(): Promise<FileLease | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as FileLease;
    } catch {
      return null;
    }
  }

  private async writeLease(token: string): Promise<void> {
    const payload: FileLease = {
      token,
      owner: this.nodeId,
      pid: process.pid,
      expiresAt: Date.now() + this.leaseMs,
    };
    await writeFile(this.path, JSON.stringify(payload), "utf8");
  }

  async acquire(): Promise<boolean> {
    const now = Date.now();
    const token = randomUUID();

    // Fast path: nobody holds the file.
    try {
      const handle = await open(this.path, "wx");
      await handle.writeFile(JSON.stringify({ token, owner: this.nodeId, pid: process.pid, expiresAt: now + this.leaseMs }));
      await handle.close();
      return this.grant(token);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // Someone holds it. Is it stale?
    const existing = await this.readLease();
    if (existing && existing.expiresAt > now) return false;
    // `existing === null` means the file was unreadable or corrupt. Treat it as
    // stale, but only after the jittered pause below, and verify ownership
    // after writing — a corrupt lease must not let two nodes both win.

    if (this.takeoverJitterMs > 0) {
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * this.takeoverJitterMs)));
    }
    try {
      await unlink(this.path);
    } catch {
      /* someone else cleaned it up first */
    }

    try {
      const handle = await open(this.path, "wx");
      await handle.writeFile(JSON.stringify({ token, owner: this.nodeId, pid: process.pid, expiresAt: Date.now() + this.leaseMs }));
      await handle.close();
    } catch {
      return false;
    }

    // Re-read to confirm no concurrent takeover overwrote us.
    const verify = await this.readLease();
    if (!verify || verify.token !== token) return false;
    return this.grant(token);
  }

  async renew(): Promise<boolean> {
    if (!this.isLeader()) {
      this.drop();
      return false;
    }
    const existing = await this.readLease();
    if (!existing || existing.token !== this.token) {
      this.drop();
      return false;
    }
    try {
      await this.writeLease(this.token!);
    } catch {
      this.drop();
      return false;
    }
    this.leaseUntil = Date.now() + this.leaseMs;
    return true;
  }

  async release(): Promise<void> {
    const existing = await this.readLease();
    if (existing && existing.token === this.token) {
      await unlink(this.path).catch(() => {});
    }
    this.drop();
  }
}

/* -------------------------------------------------------------------------- */
/* Redis (RESP, zero dependencies)                                            */
/* -------------------------------------------------------------------------- */

export interface RedisElectorOptions extends ElectorOptions {
  host?: string;
  port?: number;
  /** Key used for the lease. */
  key?: string;
  /** Redis logical database. */
  db?: number;
  password?: string;
  connectTimeoutMs?: number;
}

/** Extend the lease only if we still own it. Atomic server-side. */
const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

/** Release only if we still own it. Prevents deleting a successor's lease. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

type RespReply = string | number | null | Buffer | RespReply[];

/**
 * Minimal Redis client: just enough RESP to elect a leader.
 *
 * Pulling in a full client for four commands would be the wrong trade for a
 * library that otherwise has zero dependencies, and the protocol subset needed
 * here is small and stable. Replies are matched to requests in FIFO order, as
 * RESP requires.
 */
export class RedisConnection {
  private socket: Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending: Array<{ resolve: (v: RespReply) => void; reject: (e: Error) => void }> = [];
  private connecting: Promise<void> | null = null;

  constructor(private readonly options: RedisElectorOptions = {}) {}

  private get host(): string {
    return this.options.host ?? "127.0.0.1";
  }

  private get port(): number {
    return this.options.port ?? 6379;
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return await this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out connecting to Redis at ${this.host}:${this.port}`));
      }, this.options.connectTimeoutMs ?? 5_000);

      socket.once("connect", () => {
        clearTimeout(timeout);
        this.socket = socket;
        this.connecting = null;
        resolve();
      });
      socket.on("data", (chunk: Buffer) => this.onData(chunk));
      socket.on("error", (err) => {
        clearTimeout(timeout);
        this.failAll(err);
        this.socket = null;
        this.connecting = null;
        reject(err);
      });
      socket.on("close", () => {
        this.socket = null;
        this.failAll(new Error("Redis connection closed"));
      });
    });
    return await this.connecting;
  }

  private failAll(err: Error): void {
    const pending = this.pending.splice(0, this.pending.length);
    for (const p of pending) p.reject(err);
    this.buffer = Buffer.alloc(0);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = this.parseReply();
      if (parsed === INCOMPLETE) return;
      const next = this.pending.shift();
      if (!next) return;
      if (parsed instanceof Error) next.reject(parsed);
      else next.resolve(parsed);
    }
  }

  private parseReply(): RespReply | Error | typeof INCOMPLETE {
    const { value, offset } = this.parseAt(0);
    if (value === INCOMPLETE) return INCOMPLETE;
    this.buffer = this.buffer.subarray(offset);
    return value;
  }

  private parseAt(start: number): { value: RespReply | Error | typeof INCOMPLETE; offset: number } {
    if (start >= this.buffer.length) return { value: INCOMPLETE, offset: start };
    const type = String.fromCharCode(this.buffer[start]!);
    const lineEnd = this.buffer.indexOf("\r\n", start);
    if (lineEnd === -1) return { value: INCOMPLETE, offset: start };
    const line = this.buffer.subarray(start + 1, lineEnd).toString("utf8");

    switch (type) {
      case "+":
        return { value: line, offset: lineEnd + 2 };
      case "-":
        return { value: new Error(line), offset: lineEnd + 2 };
      case ":":
        return { value: Number(line), offset: lineEnd + 2 };
      case "$": {
        const length = Number(line);
        if (length === -1) return { value: null, offset: lineEnd + 2 };
        const bodyStart = lineEnd + 2;
        const bodyEnd = bodyStart + length;
        if (bodyEnd + 2 > this.buffer.length) return { value: INCOMPLETE, offset: start };
        return { value: this.buffer.subarray(bodyStart, bodyEnd).toString("utf8"), offset: bodyEnd + 2 };
      }
      case "*": {
        const count = Number(line);
        if (count === -1) return { value: null, offset: lineEnd + 2 };
        const items: RespReply[] = [];
        let cursor = lineEnd + 2;
        for (let i = 0; i < count; i += 1) {
          const child = this.parseAt(cursor);
          if (child.value === INCOMPLETE) return { value: INCOMPLETE, offset: start };
          if (child.value instanceof Error) return { value: child.value, offset: child.offset };
          items.push(child.value);
          cursor = child.offset;
        }
        return { value: items, offset: cursor };
      }
      default:
        return { value: new Error(`Unsupported RESP type "${type}"`), offset: lineEnd + 2 };
    }
  }

  async command(...args: string[]): Promise<RespReply> {
    if (!this.socket || this.socket.destroyed) await this.connect();
    if (!this.socket) throw new Error("Redis socket unavailable");
    const payload = encodeCommand(args);
    return await new Promise<RespReply>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket!.write(payload, (err) => {
        if (err) {
          const index = this.pending.findIndex((p) => p.reject === reject);
          if (index >= 0) this.pending.splice(index, 1);
          reject(err);
        }
      });
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}

const INCOMPLETE = Symbol("incomplete");

export function encodeCommand(args: string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`, "utf8")];
  for (const arg of args) {
    const body = Buffer.from(arg, "utf8");
    parts.push(Buffer.from(`$${body.byteLength}\r\n`, "utf8"), body, Buffer.from("\r\n", "utf8"));
  }
  return Buffer.concat(parts);
}

/**
 * Single-instance Redis lease. Correct on one Redis node, which is what nearly
 * every deployment actually runs; for a Redis Cluster, hash-tag the key
 * (`{cron}:leader`) so all commands land on the same slot.
 */
export class RedisElector extends BaseElector {
  private readonly client: RedisConnection;
  private readonly key: string;
  private readonly password?: string;

  constructor(options: RedisElectorOptions = {}) {
    super(`redis:${options.host ?? "127.0.0.1"}:${options.port ?? 6379}`, options);
    this.key = options.key ?? "cron-scheduler:leader";
    this.password = options.password;
    this.client = new RedisConnection(options);
  }

  async acquire(): Promise<boolean> {
    const token = randomUUID();
    try {
      await this.client.connect();
      if (this.password) await this.client.command("AUTH", this.password);
      const reply = await this.client.command("SET", this.key, token, "NX", "PX", String(this.leaseMs));
      return reply === "OK" ? this.grant(token) : false;
    } catch (err) {
      // Coordination backend unreachable means "not the leader", never "assume
      // leadership". Failing closed is what keeps a partition from double-firing.
      return false;
    }
  }

  async renew(): Promise<boolean> {
    if (!this.isLeader()) {
      this.drop();
      return false;
    }
    try {
      const reply = await this.client.command("EVAL", RENEW_SCRIPT, "1", this.key, this.token!, String(this.leaseMs));
      if (Number(reply) === 1) {
        this.leaseUntil = Date.now() + this.leaseMs;
        return true;
      }
      this.drop();
      return false;
    } catch {
      this.drop();
      return false;
    }
  }

  async release(): Promise<void> {
    if (this.token) {
      await this.client
        .command("EVAL", RELEASE_SCRIPT, "1", this.key, this.token)
        .catch(() => {});
    }
    this.drop();
  }

  close(): void {
    this.client.close();
  }
}

/* -------------------------------------------------------------------------- */
/* HTTP CAS                                                                   */
/* -------------------------------------------------------------------------- */

export interface HttpElectorOptions extends ElectorOptions {
  /** Lease resource URL, e.g. `https://etcd-gw.internal/v3/kv/cron-leader`. */
  url: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/**
 * Lease over a compare-and-swap HTTP endpoint.
 *
 * The contract is deliberately the smallest one that can express a lease and
 * is implementable on top of etcd's gateway, Consul's KV `?cas=`, a Durable
 * Object, or a dozen lines of Cloudflare Worker:
 *
 *   PUT   url                 If-None-Match: *   → 200 acquired / 412 held
 *   PUT   url                 If-Match: <token>  → 200 extended / 412 lost
 *   DELETE url                If-Match: <token>  → 200 released
 *
 * The server owns the TTL, so a node that dies mid-lease is cleaned up without
 * cooperation.
 */
export class HttpElector extends BaseElector {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpElectorOptions) {
    super(`http:${options.url}`, options);
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async acquire(): Promise<boolean> {
    const token = randomUUID();
    try {
      const res = await this.fetchImpl(this.url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "if-none-match": "*",
          ...this.headers,
        },
        body: JSON.stringify({ token, owner: this.nodeId, ttlMs: this.leaseMs }),
      });
      if (res.status === 200 || res.status === 201 || res.status === 204) return this.grant(token);
      return false;
    } catch {
      // A coordination endpoint that is down must not be treated as "I'm the
      // leader" — the safe answer is "no".
      return false;
    }
  }

  async renew(): Promise<boolean> {
    if (!this.isLeader()) {
      this.drop();
      return false;
    }
    try {
      const res = await this.fetchImpl(this.url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "if-match": this.token!,
          ...this.headers,
        },
        body: JSON.stringify({ token: this.token, owner: this.nodeId, ttlMs: this.leaseMs }),
      });
      if (res.status === 200 || res.status === 204) {
        this.leaseUntil = Date.now() + this.leaseMs;
        return true;
      }
      this.drop();
      return false;
    } catch {
      // Network blip: keep the lease locally until its TTL runs out, but do
      // not extend it. The scheduler stops dispatching the moment it expires.
      return false;
    }
  }

  async release(): Promise<void> {
    if (this.token) {
      await this.fetchImpl(this.url, {
        method: "DELETE",
        headers: { "if-match": this.token, ...this.headers },
      }).catch(() => {});
    }
    this.drop();
  }
}

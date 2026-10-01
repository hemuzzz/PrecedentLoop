import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { backendEnvironment, verifyBundledNode, type BuildInfo, type RuntimeConfig } from "./config.js";

const listeningSchema = z.object({ type: z.literal("listening"), buildId: z.string(), endpoint: z.string() });
const readySchema = z.object({ ok: z.literal(true), data: z.object({
  buildId: z.string(), service: z.object({ readiness: z.literal("READY") }),
  mcpEndpoint: z.object({ ready: z.literal(true) }),
}) });

export async function readyResponse(origin: string, buildId: string): Promise<boolean> {
  const response = await fetch(`${origin}/api/system/status`, { signal: AbortSignal.timeout(1500), redirect: "error" });
  if (!response.ok) return false;
  const parsed = readySchema.safeParse(await response.json());
  return parsed.success && parsed.data.data.buildId === buildId;
}

export async function backendStatus(origin: string, buildId: string): Promise<{ serviceReady: boolean; mcpReady: boolean }> {
  const response = await fetch(`${origin}/api/system/status`, { signal: AbortSignal.timeout(1500), redirect: "error" });
  const parsed = z.object({ ok: z.literal(true), data: z.object({ buildId: z.literal(buildId),
    service: z.object({ readiness: z.string() }), mcpEndpoint: z.object({ ready: z.boolean() }) }) }).safeParse(await response.json());
  return response.ok && parsed.success ? { serviceReady: parsed.data.data.service.readiness === "READY", mcpReady: parsed.data.data.mcpEndpoint.ready }
    : { serviceReady: false, mcpReady: false };
}

/** Owns exactly one child. Never adopts or kills a process discovered by port. */
export class Backend extends EventEmitter {
  readonly origin: string;
  readonly startedAt = new Date().toISOString();
  child: ChildProcess | undefined;
  isReady = false;
  private stopping = false;
  private booted = false;
  private finished = false;
  private failure: Error | undefined;
  private stopPromise: Promise<void> | undefined;
  private readonly abort = new AbortController();

  constructor(readonly runtime: string, readonly config: RuntimeConfig, readonly build: BuildInfo, readonly appConfigPath?: string) {
    super();
    this.origin = `http://127.0.0.1:${config.port}`;
    mkdirSync(dirname(config.desktopLogPath), { recursive: true });
  }

  log(event: string, fields: Record<string, unknown> = {}): void {
    appendFileSync(this.config.desktopLogPath, `${JSON.stringify({ event, at: new Date().toISOString(),
      mainPid: process.pid, startedAt: this.startedAt, childPid: this.child?.pid, buildId: this.build.buildId, ...fields })}\n`);
  }

  async start(): Promise<void> {
    const nodePath = await verifyBundledNode(this.runtime, this.build);
    if (this.stopping) throw new Error("启动已取消");
    const child = fork(join(this.runtime, "apps/server/dist/main.js"), [], {
      execPath: nodePath, execArgv: [], cwd: this.runtime,
      env: backendEnvironment(this.config, this.appConfigPath), stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;
    child.stdout?.on("data", (data: Buffer) => this.log("stdout", { text: data.toString() }));
    child.stderr?.on("data", (data: Buffer) => this.log("stderr", { text: data.toString() }));
    this.log("backend-starting");
    let resolveListening: (() => void) | undefined;
    let rejectListening: ((error: Error) => void) | undefined;
    const listening = new Promise<void>((resolve, reject) => { resolveListening = resolve; rejectListening = reject; });
    const fail = (error: Error): void => {
      this.isReady = false;
      this.failure = error;
      rejectListening?.(error);
      this.abort.abort();
      this.emit("unavailable", error);
    };
    child.on("message", (message: unknown) => {
      if (typeof message === "object" && message !== null && "type" in message && message.type === "booted") {
        this.booted = true;
        if (this.stopping) child.kill("SIGTERM");
        return;
      }
      if (typeof message === "object" && message !== null && "type" in message && message.type === "open-inbox") {
        this.emit("open-inbox");
        return;
      }
      const parsed = listeningSchema.safeParse(message);
      if (!parsed.success || parsed.data.buildId !== this.build.buildId || parsed.data.endpoint !== `${this.origin}/mcp`) {
        fail(new Error("后端监听回执与目标构建不匹配"));
      } else if (!this.stopping) resolveListening?.();
    });
    child.on("error", fail);
    child.once("disconnect", () => { if (!this.stopping) fail(new Error("后端连接已断开")); });
    child.once("close", (code, signal) => {
      this.finished = true;
      this.log("backend-exited", { code, signal, normal: this.stopping && code === 0 && signal === null });
      if (code !== 0 || signal !== null) this.failure = new Error(`后端异常退出（${code ?? signal}）`);
      if (!this.stopping) fail(this.failure ?? new Error("后端已停止"));
    });
    const timeout = setTimeout(() => fail(new Error("后端启动超时，请退出后检查日志")), this.config.startupTimeoutMs);
    const cancelListening = (): void => rejectListening?.(this.failure ?? new Error("启动已取消"));
    this.abort.signal.addEventListener("abort", cancelListening, { once: true });
    try {
      await listening;
      while (!this.stopping && !this.finished && !this.failure) {
        try {
          if (await readyResponse(this.origin, this.build.buildId)) {
            if (this.stopping || this.finished || this.failure) break;
            this.log("backend-ready");
            this.isReady = true;
            return;
          }
        } catch { /* A failed readiness probe never establishes ownership or success. */ }
        await delay(100, undefined, { signal: this.abort.signal });
      }
      throw this.failure ?? new Error("启动已取消");
    } finally {
      clearTimeout(timeout);
      this.abort.signal.removeEventListener("abort", cancelListening);
    }
  }

  stop(): Promise<void> {
    this.isReady = false;
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.abort.abort();
    const child = this.child;
    if (!child) return Promise.resolve();
    if (this.finished) return this.failure ? Promise.reject(this.failure) : Promise.resolve();
    this.stopPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("后端尚未正常退出，已停止更新；不会自动强杀")), this.config.shutdownTimeoutMs);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        code === 0 && signal === null ? resolve() : reject(new Error(`后端未正常关闭（${code ?? signal}）`));
      });
      // Wait for the child's early handler-installation receipt before sending SIGTERM.
      if (this.booted) child.kill("SIGTERM");
    });
    return this.stopPromise;
  }
}

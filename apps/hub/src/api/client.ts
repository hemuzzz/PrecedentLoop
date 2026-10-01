import type {
  OverviewDto,
  AssetDetail,
  AssetListFilters,
  AssetListResult,
  InboxResult,
  AiOperation, AiProvider, AiConfiguration, AiTestResult,
  SystemStatus,
  WorkspaceProjection, RecallProjection, RecallDetail, UsageProjection,
} from "./types.js";

interface RestErrorDetail {
  code: string;
  message: string;
  retryable: boolean;
}

type FetchImplementation = typeof fetch;

export class HubApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status: number,
  ) {
    super(message);
    this.name = "HubApiError";
  }
}

export class HubApiClient {
  #writeToken: string | undefined;
  constructor(readonly fetchImplementation: FetchImplementation = globalThis.fetch.bind(globalThis)) {}

  listAssets(filters: AssetListFilters, signal?: AbortSignal): Promise<AssetListResult> {
    return this.#get(buildAssetListPath(filters), signal);
  }

  getAsset(assetId: string, signal?: AbortSignal): Promise<{ asset: AssetDetail }> {
    return this.#get(`/api/assets/${encodeURIComponent(assetId)}`, signal);
  }

  getInbox(signal?: AbortSignal): Promise<InboxResult> {
    return this.#get("/api/inbox", signal);
  }

  providers(): Promise<{ providers: AiProvider[] }> { return this.#get("/api/inbox/providers"); }
  aiSettings(): Promise<AiConfiguration> { return this.#get("/api/inbox/ai-settings"); }
  testAi(provider: "codex" | "claude"): Promise<AiTestResult> { return this.candidateAction("test", { provider }); }
  operation(requestId?: string): Promise<{ operation: AiOperation | null }> { return this.#get(`/api/inbox/operation${requestId ? `?requestId=${encodeURIComponent(requestId)}` : ""}`); }
  async candidateAction<T = unknown>(action: "accept" | "defer" | "reject" | "register" | "import" | "rewrite" | "workspaces" | "test", input: object): Promise<T> {
    this.#writeToken ??= (await this.#get<{ token: string }>("/api/inbox/session")).token;
    try { return await this.#request(`/api/inbox/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-hub-write-token": this.#writeToken }, body: JSON.stringify(input) }); }
    catch (error) { if (error instanceof HubApiError && error.code === "WRITE_SESSION_INVALID") this.#writeToken = undefined; throw error; }
  }

  getWorkspaces(signal?: AbortSignal): Promise<WorkspaceProjection> { return this.#get("/api/workspaces", signal); }
  getRecalls(offset = 0, signal?: AbortSignal, limit = 50): Promise<{ items: RecallProjection[]; total: number }> { return this.#get(`/api/recalls?offset=${offset}&limit=${limit}`, signal); }
  getRecall(id: string, signal?: AbortSignal): Promise<RecallDetail> { return this.#get(`/api/recalls/${encodeURIComponent(id)}`, signal); }
  getUsage(offset = 0, signal?: AbortSignal, limit = 50): Promise<{ items: UsageProjection[]; total: number }> { return this.#get(`/api/usage?offset=${offset}&limit=${limit}`, signal); }

  getOverview(signal?: AbortSignal): Promise<OverviewDto> {
    return this.#get("/api/overview", signal);
  }

  getSystemStatus(signal?: AbortSignal): Promise<SystemStatus> {
    return this.#get("/api/system/status", signal);
  }

  async #get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.#request(path, { method: "GET", ...(signal === undefined ? {} : { signal }) });
  }

  async #request<T>(path: string, options: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImplementation(path, {
        ...options,
        headers: { accept: "application/json", ...options.headers },
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new HubApiError(
        "SERVICE_UNREACHABLE",
        "本地 Precedent Loop 服务未响应",
        true,
        0,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await response.text()) as unknown;
    } catch {
      throw new HubApiError(
        "INVALID_RESPONSE",
        "本地服务返回了无法读取的响应",
        true,
        response.status,
      );
    }

    if (response.ok && isRecord(payload) && payload.ok === true && Object.hasOwn(payload, "data")) {
      return payload.data as T;
    }
    if (isRecord(payload) && payload.ok === false && isRestErrorDetail(payload.error)) {
      throw new HubApiError(
        payload.error.code,
        payload.error.message,
        payload.error.retryable,
        response.status,
      );
    }
    throw new HubApiError(
      "INVALID_RESPONSE",
      "本地服务返回了非预期响应",
      true,
      response.status,
    );
  }
}

export function buildAssetListPath(filters: AssetListFilters): string {
  if (filters.workspace === null && filters.scope === "WORKSPACE") {
    throw invalidFilterCombination();
  }
  if (typeof filters.workspace === "string" && filters.scope === "GLOBAL") {
    throw invalidFilterCombination();
  }

  const parameters = new URLSearchParams();
  appendText(parameters, "query", filters.query);
  if (filters.workspace === null) {
    parameters.set("workspace", "null");
  } else {
    appendText(parameters, "workspace", filters.workspace);
  }
  appendText(parameters, "type", filters.type);
  appendText(parameters, "scope", filters.scope);
  if (filters.limit !== undefined) {
    parameters.set("limit", String(filters.limit));
  }
  if (filters.offset !== undefined) {
    parameters.set("offset", String(filters.offset));
  }
  const query = parameters.toString();
  return query.length === 0 ? "/api/assets" : `/api/assets?${query}`;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function appendText(parameters: URLSearchParams, name: string, value: string | undefined): void {
  if (value !== undefined && value.length > 0) {
    parameters.set(name, value);
  }
}

function appendWorkspace(parameters: URLSearchParams, workspace: string | null | undefined): void {
  if (workspace === null) {
    parameters.set("workspace", "null");
  } else {
    appendText(parameters, "workspace", workspace);
  }
}

function appendLimit(parameters: URLSearchParams, limit: number | undefined): void {
  if (limit !== undefined) {
    parameters.set("limit", String(limit));
  }
}

function withQuery(path: string, parameters: URLSearchParams): string {
  const query = parameters.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

function invalidFilterCombination(): HubApiError {
  return new HubApiError(
    "INVALID_FILTER_COMBINATION",
    "工作区与范围筛选不兼容",
    false,
    0,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRestErrorDetail(value: unknown): value is RestErrorDetail {
  return isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean";
}

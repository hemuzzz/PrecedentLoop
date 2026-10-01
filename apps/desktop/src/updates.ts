import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { z } from "zod";

export const RELEASE_REPOSITORY = "hemuzzz/PrecedentLoop";
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
const versionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u)
  .refine(value => value.split(".").every(part => Number.isSafeInteger(Number(part))));
export const updateManifestSchema = z.object({
  updateProtocol: z.literal(1), version: versionSchema, arch: z.enum(["arm64", "x64"]),
  buildId: z.string().uuid(), filename: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().positive().max(1024 * 1024 * 1024),
  requiresManualUpgrade: z.boolean(),
}).strict();
export type UpdateManifest = z.infer<typeof updateManifestSchema>;
export type UpdateCheck = { kind: "unpublished" | "current" } | { kind: "available"; manifest: UpdateManifest; url: string };

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionSchema.parse(candidate).split(".").map(Number);
  const previous = versionSchema.parse(current).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (next[i] !== previous[i]) return next[i]! > previous[i]!;
  }
  return false;
}

export function releaseAssetUrl(version: string, name: string): string {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${versionSchema.parse(version)}/${encodeURIComponent(name)}`;
}

// Only this public repository is a release source; redirects may use GitHub's asset CDN.
export async function requestRelease(url: string, signal: AbortSignal): Promise<Response> {
  const hosts = new Set(["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
  for (let count = 0; count < 6; count++) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || !hosts.has(parsed.hostname)) {
      throw new Error("更新下载地址不属于受支持的 GitHub HTTPS 地址");
    }
    const response = await fetch(parsed, { redirect: "manual", signal,
      headers: { "user-agent": "PrecedentLoop", accept: "application/octet-stream, application/json" } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("更新下载重定向缺少地址");
    url = new URL(location, parsed).href;
  }
  throw new Error("更新下载重定向次数过多");
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error(`检查更新失败（HTTP ${response.status}），请稍后重试。`);
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256 * 1024) throw new Error("版本信息超出允许大小");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { await reader.cancel().catch(() => {}); }
}

export async function checkForUpdate(current: string, arch: string): Promise<UpdateCheck> {
  const signal = AbortSignal.timeout(30000);
  const response = await requestRelease(RELEASE_API, signal);
  if (response.status === 404) { await response.body?.cancel(); return { kind: "unpublished" }; }
  const release = z.object({ draft: z.literal(false), prerelease: z.literal(false), tag_name: z.string(),
    assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })) }).parse(await readJson(response));
  if (!release.tag_name.startsWith("v")) throw new Error("发布版本标签格式不正确");
  const version = versionSchema.parse(release.tag_name.slice(1));
  if (!isNewerVersion(version, current)) return { kind: "current" };
  const manifestName = `PrecedentLoop-${version}-${arch}.json`;
  const entry = release.assets.find(asset => asset.name === manifestName);
  if (!entry || entry.browser_download_url !== releaseAssetUrl(version, manifestName)) throw new Error("新版本缺少当前架构的更新信息");
  const manifest = updateManifestSchema.parse(await readJson(await requestRelease(entry.browser_download_url, signal)));
  const filename = `PrecedentLoop-${version}-${arch}-update.dmg`;
  if (manifest.version !== version || manifest.arch !== arch || manifest.filename !== filename) throw new Error("更新信息与发布版本不符");
  const image = release.assets.find(asset => asset.name === filename);
  const url = releaseAssetUrl(version, filename);
  if (!image || image.browser_download_url !== url) throw new Error("发布中缺少对应更新包");
  return { kind: "available", manifest, url };
}

export async function downloadUpdate(url: string, manifest: UpdateManifest, destination: string, progress: (value: number) => void): Promise<void> {
  if (url !== releaseAssetUrl(manifest.version, manifest.filename)) throw new Error("更新包来源与发布信息不符");
  const file = await open(destination, "wx", 0o600);
  let complete = false;
  try {
    const response = await requestRelease(url, AbortSignal.timeout(10 * 60 * 1000));
    if (!response.ok || !response.body) throw new Error(`下载更新失败（HTTP ${response.status}）`);
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > manifest.size) throw new Error("下载文件超过发布声明的大小");
        hash.update(value);
        await file.writeFile(value);
        progress(size / manifest.size);
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (size !== manifest.size || hash.digest("hex") !== manifest.sha256) throw new Error("更新包校验失败，未安装。请重新下载。");
    complete = true;
  } finally {
    await file.close();
    if (!complete) await rm(destination, { force: true });
  }
}

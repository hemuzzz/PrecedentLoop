import { isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export type NavigationTarget =
  | { kind: "internal" | "external"; url: string }
  | { kind: "local"; path: string; line?: number; column?: number }
  | { kind: "blocked" };

export function navigationTarget(raw: string, origin: string): NavigationTarget {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return { kind: "blocked" };
    let path: string;
    if (url.protocol === "file:" && !url.hostname) {
      path = fileURLToPath(url);
    } else if (["http:", "https:"].includes(url.protocol)) {
      if (url.origin !== origin) return { kind: "external", url: url.href };
      // Hub uses hash routing. Same-origin API/static/unknown paths are not pages.
      if (url.pathname === "/" && !url.search) return { kind: "internal", url: url.href };
      path = decodeURIComponent(url.pathname);
      // Markdown absolute macOS paths arrive as same-origin HTTP links.
      if (!/^\/(?:Users|Volumes|private|tmp|var|opt)\//u.test(normalize(path))) return { kind: "blocked" };
    } else return { kind: "blocked" };

    if (url.search || /[\u0000-\u001f\u007f]/u.test(path) || !isAbsolute(path)) return { kind: "blocked" };
    const position = /:(\d+)(?::(\d+))?$/u.exec(path);
    const anchor = url.hash ? /^#L(\d+)(?:C(\d+))?$/u.exec(url.hash) : null;
    if (url.hash && (!anchor || position)) return { kind: "blocked" };
    const reference = position ?? anchor;
    const line = reference ? Number(reference[1]) : undefined;
    const column = reference?.[2] ? Number(reference[2]) : undefined;
    if ([line, column].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 1))) return { kind: "blocked" };
    return { kind: "local", path: normalize(position ? path.slice(0, position.index) : path),
      ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
  } catch { return { kind: "blocked" }; }
}

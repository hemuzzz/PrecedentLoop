import { onBeforeUnmount, ref } from "vue";

export type Page =
  | "overview"
  | "library"
  | "search"
  | "inbox"
  | "workspaces"
  | "recalls"
  | "usage"
  | "status"
  | "settings";
const pages: Page[] = [
  "overview",
  "library",
  "search",
  "inbox",
  "workspaces",
  "recalls",
  "usage",
  "status",
  "settings",
];

export function readRoute() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [page, encodedId, presentation] = (path ?? "").split("/");
  let id: string | undefined;
  try {
    id = encodedId ? decodeURIComponent(encodedId) : undefined;
  } catch {
    /* Malformed links open the list. */
  }
  return {
    page: pages.includes(page as Page) ? (page as Page) : ("overview" as Page),
    id,
    query,
    expanded: presentation === "read",
  };
}

let navigationGuard: ((hash: string) => boolean) | undefined;
let acceptedHash = location.hash;
export function guardNavigation(guard: (hash: string) => boolean): () => void {
  acceptedHash = location.hash;
  navigationGuard = guard;
  return () => { if (navigationGuard === guard) navigationGuard = undefined; };
}
export function navigateHash(hash: string, confirmed = false): void {
  if (location.hash === hash) return;
  if (!confirmed && navigationGuard && !navigationGuard(hash)) return;
  history.pushState(null, "", hash); acceptedHash = hash;
  window.dispatchEvent(new Event("hub:navigate"));
}
// Registered before useRoute listeners so a cancelled Back/hash navigation
// leaves the active editor mounted with its exact current draft.
for (const event of ["popstate", "hashchange"]) window.addEventListener(event, () => {
  const next = location.hash;
  if (next !== acceptedHash && navigationGuard && !navigationGuard(next)) history.replaceState(null, "", acceptedHash);
  else acceptedHash = next;
});
export function navigate(page: Page, id?: string, expanded = false, filters?: Record<string, string>): void {
  const query = new URLSearchParams(filters).toString();
  const hash = `#/${page}${id ? `/${encodeURIComponent(id)}` : ""}${expanded ? "/read" : ""}${query ? `?${query}` : ""}`;
  navigateHash(hash);
}

export function useRoute() {
  const route = ref(readRoute());
  const update = () => {
    route.value = readRoute();
  };
  const events = ["popstate", "hashchange", "hub:navigate"];
  events.forEach((event) => window.addEventListener(event, update));
  onBeforeUnmount(() =>
    events.forEach((event) => window.removeEventListener(event, update)),
  );
  return route;
}

import type { SettingsBridge } from "../../../desktop/src/setup-contract.js";
import "../setup/bridge.js";
export type { SettingsBridge, SettingsSnapshot } from "../../../desktop/src/setup-contract.js";

let connection: Promise<SettingsBridge | null> | undefined;
export function settingsBridge(): Promise<SettingsBridge | null> {
  connection ??= (async () => {
    if (window.precedentSetup) return window.precedentSetup;
    if (import.meta.env.DEV && ["http:", "https:"].includes(location.protocol)) {
      const params = new URLSearchParams(location.search), scenario = params.get("scenario") ?? "";
      if (/^(T[13459]-[a-f]|T2-[abc]|T6-[a-e]|T7-[aef]|T8-[a-d]|S5-a)$/u.test(scenario) && scenario !== "T9-b") {
        const { createSettingsMock } = await import("./mock-bridge.js");
        return createSettingsMock(scenario, params);
      }
    }
    return null;
  })();
  return connection;
}

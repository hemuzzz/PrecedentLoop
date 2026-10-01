import { createApp } from "vue";

import App from "./App.vue";
import "@fontsource-variable/geist/index.css";
import "./styles.css";
import "./setup/setup.css";
import "./settings/settings.css";

if (import.meta.env.DEV && !window.precedentSetup && !location.hash) {
  const scenario = new URLSearchParams(location.search).get("scenario") ?? "";
  const page = scenario.startsWith("T1-") ? "general" : scenario.startsWith("T2-") ? "storage" : scenario.startsWith("T3-") || scenario.startsWith("T4-") || scenario.startsWith("T5-") || scenario === "T9-c" ? "agents" : scenario.startsWith("T6-") || scenario === "T9-a" ? "ai" : scenario.startsWith("T7-") ? "projects" : scenario.startsWith("T8-") ? "advanced" : "agents";
  if (/^(T[13459]-[a-f]|T2-[abc]|T6-[a-e]|T7-[aef]|T8-[a-d])$/u.test(scenario)) history.replaceState(null, "", scenario === "T9-d" ? "#/status" : `#/settings/${page}`);
  else if (scenario === "S5-a") history.replaceState(null, "", "#/overview");
}

createApp(App).mount("#app");

import { ref } from "vue";

export const theme = ref<"dark" | "light" | "system">("dark");
export function changeTheme(): void {
  document.documentElement.dataset.theme = theme.value;
  try { localStorage.setItem("hub-theme", theme.value); } catch { /* Appearance still works without storage. */ }
}
export function initializeTheme(): void {
  try {
    const stored = localStorage.getItem("hub-theme");
    if (stored === "dark" || stored === "light" || stored === "system") theme.value = stored;
  } catch { /* Retain the existing Hub default. */ }
  changeTheme();
}

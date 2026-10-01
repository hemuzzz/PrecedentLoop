<script setup lang="ts">
defineProps<{ name: string }>();
const paths: Record<string, string> = {
  upload: "M7 17H5a4 4 0 0 1-.8-7.9 7 7 0 0 1 13.6-1.7A5 5 0 0 1 19 17h-2M12 21V11m-4 4 4-4 4 4",
  "file-upload": "M12 21H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8l6 6v3M14 2v6h6M18 22V14m-4 4 4-4 4 4",
  sparkles: "m12 3 2.3 6.7L21 12l-6.7 2.3L12 21l-2.3-6.7L3 12l6.7-2.3L12 3ZM20 2v4m-2-2h4",
  tick: "m5 12 4 4L19 6",
  "arrow-down": "M12 4v16m-5-5 5 5 5-5",
  sort: "M4 5v14m-3-3 3 3 3-3M11 5h10M11 12h7M11 19h4",
  external: "M14 3h7v7m0-7L10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6",
  bulb: "M9 18h6M10 22h4M9 18v-3a6 6 0 1 1 6 0v3",
  ban: "M5 5l14 14M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  server: "M4 3h16v6H4zM4 15h16v6H4zM7 6h.01M7 18h.01M15 6h2M15 18h2",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2",
  check: "m8 12 3 3 5-6M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  info: "M12 11v6M12 7h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
  globe: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM2 12h20M12 2a18 18 0 0 1 0 20 18 18 0 0 1 0-20Z",
  folder: "M3 7V5h6l2 2h10v13H3V7Z",
  database: "M20 5c0 2-3.6 3-8 3S4 7 4 5s3.6-3 8-3 8 1 8 3ZM4 5v14c0 2 3.6 3 8 3s8-1 8-3V5M4 12c0 2 3.6 3 8 3s8-1 8-3",
  chevron: "m9 5 7 7-7 7",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  fit: "M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5",
  overview: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  close: "M18 6 6 18M6 6l12 12",
  panel:
    "M9 3v18M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
  expand: "M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7",
  minimize: "M4 10h6V4M10 10 3 3M20 14h-6v6M14 14l7 7",
  document:
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M8 13h8M8 17h6",
  memory: "M9 3H5v4M15 3h4v4M9 21H5v-4M15 21h4v-4M8 8h8v8H8Z",
  code: "m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18",
  warning: "m12 3 10 18H2L12 3Zm0 6v4m0 3v1",
  refresh: "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2",

  search: "m21 21-4.4-4.4M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0",
  library: "M4 4h4v16H4zM12 4v16M16 4l4 16",
  inbox: "M4 4h16l2 12v4H2v-4L4 4ZM2 16h6l2 3h4l2-3h6",
  layers: "m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5",
  activity: "M2 12h5l3-8 4 16 3-8h5",
  "monitor-activity": "M3 4h18v14H3zM8 22h8M12 18v4M5 11h3l2-4 4 8 2-4h3",
  settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
  gear: "M10 2h4l.6 3 2.3 1.3 2.9-1L22 9l-2.3 2v2L22 15l-2.2 3.7-2.9-1L14.6 19l-.6 3h-4l-.6-3-2.3-1.3-2.9 1L2 15l2.3-2v-2L2 9l2.2-3.7 2.9 1L9.4 5l.6-3ZM15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0",
  sun: "M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  filter: "M4 6h16M7 12h10M10 18h4",
};
</script>

<template>
  <svg
    class="ui-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] ?? paths.library" />
  </svg>
</template>

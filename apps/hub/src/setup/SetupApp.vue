<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import UiIcon from "../components/UiIcon.vue";
import { setupBridge, type AgentDetection, type AgentName, type CoreCheck, type DirectoryCheck, type PreparationProgress,
  type SetupBridge, type SetupDraft, type SetupSnapshot } from "./bridge.js";
import { useIntegrations } from "./use-integrations.js";
import IntegrationStep from "./IntegrationStep.vue";
import IntegrationCheck from "./IntegrationCheck.vue";
import AgentLogo from "../components/AgentLogo.vue";

let bridge: SetupBridge | undefined;
let unsubscribe: (() => void) | undefined;
let unsubscribeIntegration: (() => void) | undefined;
const snapshot = ref<SetupSnapshot>();
const directory = ref<DirectoryCheck>();
const draft = ref<SetupDraft>();
const detections = ref<AgentDetection[]>([]);
const integrations = reactive(useIntegrations(() => bridge!, draft, detections));
const core = ref<CoreCheck[]>([]);
const progress = ref<PreparationProgress[]>([]);
const busy = ref(false);
const detecting = ref(false);
const error = ref("");
const resumed = ref(false);
const syncRiskConfirmed = ref(false);
const writersStopped = ref(false);
const upgradeDialog = ref<HTMLDialogElement>();
const resetConfigDialog = ref<HTMLDialogElement>();
const theme = ref<"dark" | "light" | "system">("dark");
const previewScenario = ref("");
const steps = ["本地数据", "Coding Agent", "接入与工作区", "检查"];
const step = computed(() => draft.value?.step ?? 1);
const recovery = computed(() => snapshot.value?.startup.mode === "RECOVERY");
const invalidConfig = computed(() => snapshot.value?.startup.mode === "RECOVERY" && snapshot.value.startup.code === "CONFIG_INVALID");
const inspection = computed(() => directory.value?.inspection.kind === "SYNC_RISK" ? directory.value.inspection.inspection : directory.value?.inspection);
const syncRisk = computed(() => directory.value?.inspection.kind === "SYNC_RISK");
const committed = computed(() => snapshot.value?.dataCommitted ?? false);
const preparing = computed(() => progress.value.length > 0 && step.value === 1);
const failed = computed(() => progress.value.some(item => item.status === "failed"));
// The check must describe the path on screen; a stale result never enables writing.
const checkedCurrent = computed(() => Boolean(directory.value && draft.value && directory.value.selectedPath === draft.value.dataDirectory));
const productKinds = ["PRODUCT", "PRODUCT_UPGRADABLE", "PRODUCT_INCOMPLETE"];
const dataMode = ref<"existing" | "new">("new");
const modeMismatch = computed(() => !committed.value && checkedCurrent.value && inspection.value !== undefined
  && (dataMode.value === "existing" ? !productKinds.includes(inspection.value.kind) : ["PRODUCT", "PRODUCT_UPGRADABLE"].includes(inspection.value.kind)));
const canPrepare = computed(() => Boolean(checkedCurrent.value && directory.value!.port && inspection.value && !modeMismatch.value &&
  !["NOT_WRITABLE", "PRODUCT_UNSUPPORTED"].includes(inspection.value.kind) && (!syncRisk.value || syncRiskConfirmed.value)));
const coreReady = computed(() => core.value.length === 5 && core.value.every(item => item.ok));
const serviceReady = computed(() => core.value.some(item => item.id === "service" && item.ok));
const allMissing = computed(() => detections.value.length === 2 && detections.value.every(item => !item.found));
const availableProviders = computed(() => detections.value.filter(item => item.runnable));
const names: Record<AgentName, string> = { codex: "Codex", claude: "Claude Code" };
const coreNames: Record<CoreCheck["id"], string> = { directory: "数据目录", storage: "存储", runtime: "运行环境（内置）", service: "本地服务与索引", mcp: "MCP 地址" };
const progressNames = { folders: "创建文件夹", storage: "准备存储", service: "启动本地服务" };
const directoryText = computed(() => {
  if (committed.value) return "知识库已准备好";
  if (syncRisk.value) return "同步盘或网络盘可能损坏数据库，不建议使用";
  switch (inspection.value?.kind) {
    case "PRODUCT": return "找到已有知识库";
    case "PRODUCT_UPGRADABLE": return "此知识库需要升级存储后才能使用候选管理";
    case "PRODUCT_INCOMPLETE": return "发现尚未完成的初始化，可以继续准备知识库";
    case "OTHER_NON_EMPTY": return "此目录已有其他文件";
    case "NOT_WRITABLE": return "没有写入权限";
    case "PRODUCT_UNSUPPORTED": return "此知识库的存储版本暂不受支持";
    default: return "将在此创建新的知识库";
  }
});
const primaryText = computed(() => {
  if (step.value === 4) return "完成";
  if (step.value === 3) return integrations.phase === "selection" && hasStep3Work.value ? "配置并继续" : "继续";
  if (step.value === 2 && allMissing.value) return "跳过";
  if (step.value !== 1 || committed.value) return "继续";
  if (inspection.value?.kind === "PRODUCT") return "使用此知识库";
  if (inspection.value?.kind === "PRODUCT_UPGRADABLE") return "备份并升级";
  if (inspection.value?.kind === "PRODUCT_INCOMPLETE") return "继续初始化";
  if (inspection.value?.kind === "OTHER_NON_EMPTY") return "在其中新建 PrecedentLoop 文件夹";
  return "创建并继续";
});
const hasStep3Work = computed(() => integrations.activeAgents.length > 0 || integrations.selectedProjects.length > 0);
const directoryTone = computed(() => committed.value || inspection.value?.kind === "PRODUCT" ? "ok"
  : syncRisk.value || ["PRODUCT_UPGRADABLE", "OTHER_NON_EMPTY"].includes(inspection.value?.kind ?? "") ? "warn"
    : ["NOT_WRITABLE", "PRODUCT_UNSUPPORTED"].includes(inspection.value?.kind ?? "") ? "error" : "neutral");

function plainDraft(): SetupDraft {
  const value = draft.value!;
  // Bridge payloads must be plain data: a Vue proxy cannot cross Electron IPC ("An object could not be cloned").
  const integrationChoices = value.step >= 3 ? integrations.choices().choices : value.integrationChoices ?? {};
  return { step: value.step, dataDirectory: value.dataDirectory, agents: { ...value.agents }, manualPaths: { ...value.manualPaths }, aiProvider: value.aiProvider,
    integrationChoices: JSON.parse(JSON.stringify(integrationChoices)) as typeof integrationChoices };
}
function applySnapshot(value: SetupSnapshot) {
  snapshot.value = value;
  draft.value = { step: value.draft.step, dataDirectory: value.draft.dataDirectory, agents: { ...value.draft.agents },
    manualPaths: { ...value.draft.manualPaths }, aiProvider: value.draft.aiProvider, integrationChoices: value.draft.integrationChoices ?? {} };
  detections.value = value.draft.detections;
  progress.value = value.progress;
}
async function perform(action: () => Promise<void>) {
  if (!bridge || busy.value || integrations.busy) return;
  busy.value = true; error.value = "";
  try { await action(); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
  finally { busy.value = false; }
}
async function save() { if (bridge && draft.value) draft.value.integrationChoices = (await bridge.saveDraft(plainDraft())).integrationChoices; }
async function inspect() {
  if (!bridge || !draft.value) return;
  directory.value = await bridge.checkDirectory({ path: draft.value.dataDirectory });
  const kind = directory.value.inspection.kind === "SYNC_RISK" ? directory.value.inspection.inspection.kind : directory.value.inspection.kind;
  if (productKinds.includes(kind)) dataMode.value = "existing";
}
async function chooseDirectory() {
  await perform(async () => {
    const path = await bridge!.selectDirectory();
    if (path && draft.value) await usePath(path);
  });
}
async function usePath(path: string) {
  const previous = draft.value!.dataDirectory;
  draft.value!.dataDirectory = path; syncRiskConfirmed.value = false; progress.value = []; directory.value = undefined;
  try { await save(); await inspect(); }
  catch (reason) {
    // Restore the last saved location so the screen never shows an unchecked path.
    draft.value!.dataDirectory = previous;
    try { await inspect(); } catch { /* The original error explains the failure. */ }
    throw reason;
  }
}
async function selectMode(mode: "existing" | "new") {
  if (dataMode.value === mode || committed.value || preparing.value) return;
  dataMode.value = mode;
  if (mode === "new" && inspection.value && productKinds.includes(inspection.value.kind)) await perform(async () => { await usePath(snapshot.value!.defaultDataDirectory); });
  else if (mode === "existing" && !(inspection.value && productKinds.includes(inspection.value.kind))) await chooseDirectory();
}
async function detect() {
  detecting.value = true;
  try {
    await bridge!.detectAgents();
    const value = await bridge!.getState();
    detections.value = value.draft.detections;
    draft.value!.agents = { ...value.draft.agents };
    draft.value!.aiProvider = value.draft.aiProvider;
  } finally { detecting.value = false; }
}
async function changePath(agent: AgentName, automatic = false) {
  await perform(async () => {
    const path = automatic ? null : await bridge!.selectExecutable({ agent });
    if (!automatic && !path) return;
    draft.value!.manualPaths[agent] = path;
    await save(); await detect();
  });
}
async function go(next: 1 | 2 | 3 | 4) {
  const previous = draft.value!.step;
  draft.value!.step = next;
  try { await save(); } catch (reason) { draft.value!.step = previous; throw reason; }
  progress.value = [];
  if (next === 1) await inspect();
  if (next === 2) await detect();
  if (next === 3) await integrations.initialize(true);
  if (next === 4) { core.value = await bridge!.checkCore(); await integrations.initialize(false); }
}
async function prepare(upgradeConfirmed = false) {
  upgradeDialog.value?.close();
  await perform(async () => {
    try {
      const value = await bridge!.prepareDirectory({ path: draft.value!.dataDirectory, syncRiskConfirmed: syncRiskConfirmed.value,
        upgradeConfirmed, writersStopped: writersStopped.value });
      applySnapshot(value);
    } catch (reason) { applySnapshot(await bridge!.getState()); throw reason; }
    await detect();
  });
}
async function next() {
  if (step.value === 3 && integrations.phase === "selection" && hasStep3Work.value) { await integrations.configure(); return; }
  if (step.value === 1 && !committed.value) {
    if (inspection.value?.kind === "PRODUCT_UPGRADABLE") { writersStopped.value = false; upgradeDialog.value?.showModal(); return; }
    await prepare(); return;
  }
  await perform(async () => {
    if (step.value === 4) {
      await save();
      await bridge!.complete();
      if (previewScenario.value) error.value = "开发预览：本地核心检查通过。桌面应用将在此进入知识库。";
    } else await go((step.value + 1) as 2 | 3 | 4);
  });
}
async function retryPreparation() {
  try { await inspect(); } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); return; }
  if (inspection.value?.kind === "PRODUCT_UPGRADABLE") { writersStopped.value = false; upgradeDialog.value?.showModal(); }
  else await prepare();
}
async function retryCore() {
  await perform(async () => {
    await bridge!.recheck();
    core.value = await bridge!.checkCore();
    await integrations.initialize(false);
  });
}
async function recoveryAction(select = false) {
  await perform(async () => {
    const value = select ? await bridge!.selectRecoveryDirectory() : await bridge!.recheck();
    if (value) { applySnapshot(value); if (value.startup.mode === "SETUP") await inspect(); }
  });
}
async function resetInvalidConfig() {
  resetConfigDialog.value?.close();
  await perform(async () => {
    applySnapshot(await bridge!.resetInvalidConfig());
    resumed.value = false;
    await inspect();
  });
}
function changeTheme() {
  document.documentElement.dataset.theme = theme.value;
  try { localStorage.setItem("hub-theme", theme.value); } catch { /* System storage may be unavailable. */ }
}
onMounted(async () => {
  try {
    const stored = localStorage.getItem("hub-theme");
    if (stored === "dark" || stored === "light" || stored === "system") theme.value = stored;
  } catch { /* Use the same dark default as Hub. */ }
  changeTheme();
  try {
    const connection = await setupBridge(); bridge = connection.bridge; previewScenario.value = connection.scenario ?? "";
    unsubscribe = bridge.onProgress(value => { progress.value = [...progress.value.filter(item => item.step !== value.step), value]; });
    unsubscribeIntegration = bridge.onIntegrationProgress(integrations.receiveProgress);
    await perform(async () => {
      const value = await bridge!.getState(); applySnapshot(value); resumed.value = value.resumed;
      if (!recovery.value) {
        if (step.value === 1) await inspect();
        if (step.value === 2) await detect();
        if (step.value === 3) await integrations.initialize(true);
        if (step.value === 4) { core.value = await bridge!.checkCore(); await integrations.initialize(false); }
      }
    });
    if (connection.scenario === "S1-c-confirm") { await nextTick(); upgradeDialog.value?.showModal(); }
    if (import.meta.env.DEV && connection.scenario) {
      if (["S3-e", "S3-f"].includes(connection.scenario)) { integrations.phase = "results"; integrations.applied = true; }
      if (connection.scenario === "S3-d") await integrations.configure();
    }
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
});
onBeforeUnmount(() => { unsubscribe?.(); unsubscribeIntegration?.(); });
</script>

<template>
  <div class="setup-window">
    <header class="setup-titlebar"><span>Precedent Loop</span><span v-if="previewScenario" class="setup-preview">开发预览 · {{ previewScenario }}</span>
      <label class="setup-theme"><UiIcon name="sun" /><select v-model="theme" aria-label="外观" @change="changeTheme"><option value="dark">深色</option><option value="light">浅色</option><option value="system">跟随系统</option></select></label>
    </header>
    <div v-if="!snapshot" class="setup-unavailable"><h1>{{ error ? '无法打开设置' : '正在读取设置…' }}</h1><p role="alert">{{ error }}</p></div>
    <template v-else-if="recovery">
      <main class="setup-recovery">
        <div class="setup-recovery-icon"><UiIcon name="folder" /></div>
        <h1>无法打开知识库</h1><p class="setup-subtitle">{{ invalidConfig ? '配置文件无效，可以备份后重新设置。' : '检查磁盘连接，或重新选择知识库所在的位置。' }}</p>
        <div class="setup-notice error"><UiIcon name="warning" /><div><p>{{ snapshot.startup.mode !== 'NORMAL' ? snapshot.startup.reason : '' }}</p><code>{{ snapshot.startup.dataDirectory }}</code></div></div>
        <p class="setup-help">{{ invalidConfig ? '损坏配置将保留在备份目录，重新设置时可选择原有知识库。' : '如果知识库位于外置磁盘，请连接磁盘后重新检查。' }}</p>
        <p v-if="error" class="setup-notice error" role="alert">{{ error }}</p>
        <div class="setup-recovery-actions"><button class="setup-button primary" :disabled="busy" @click="recoveryAction()">重新检查</button><button v-if="invalidConfig" class="setup-button" :disabled="busy" @click="resetConfigDialog?.showModal()">备份损坏的配置并重新设置</button><button v-else class="setup-button" :disabled="busy" @click="recoveryAction(true)">选择新的位置…</button></div>
        <div class="setup-actions"><button class="setup-link" @click="perform(async () => { await bridge!.openLogs(); })">打开日志</button><button class="setup-link" @click="perform(async () => { await bridge!.quit(); })">退出</button></div>
        <p class="setup-help">你的知识文件不会被修改。</p>
      </main>
    </template>
    <div v-else-if="draft" class="setup-layout">
      <aside class="setup-steps" aria-label="设置步骤"><div class="setup-step-list"><div v-for="(label, index) in steps" :key="label" class="setup-step" :class="{ current: step === index + 1, done: step > index + 1 }" :aria-current="step === index + 1 ? 'step' : undefined">
        <span class="setup-step-number"><UiIcon v-if="step > index + 1" name="tick" /><template v-else>{{ index + 1 }}</template></span><span>{{ label }}<small>{{ step === index + 1 ? '当前步骤' : step > index + 1 ? index === 2 ? '后续可配置' : '已完成' : '待完成' }}</small></span>
      </div></div><p class="setup-step-note">你的知识，保存在本机。<br />Agent 接入可随时在设置中补充。</p></aside>
      <main class="setup-main">
        <div v-if="resumed" class="setup-resumed"><UiIcon name="info" />已恢复上次的设置进度<button aria-label="关闭提示" @click="resumed = false"><UiIcon name="close" /></button></div>
        <div class="setup-scroll"><div class="setup-content">
          <p class="setup-eyebrow">首次设置 / {{ steps[step - 1] }}</p>
          <p v-if="snapshot.draftWarning" class="setup-notice warn">{{ snapshot.draftWarning }}</p>
          <p v-if="error" class="setup-notice error" role="alert">{{ error }}</p>
          <template v-if="step === 1">
            <h1>{{ preparing ? '正在准备知识库' : '选择知识库' }}</h1><p class="setup-subtitle">{{ preparing ? '这通常只需要几秒钟。你的知识将保存在本机。' : '知识以 Markdown 文件保存在本机，可以随时用其他工具查看或备份。' }}</p>
            <template v-if="committed || preparing">
              <div class="setup-path"><UiIcon name="folder" /><code>{{ draft.dataDirectory }}</code></div>
            </template>
            <template v-else>
              <div class="setup-choice" :class="{ selected: dataMode === 'existing' }" role="radio" :aria-checked="dataMode === 'existing'" tabindex="0" @click="selectMode('existing')" @keydown.enter.space.prevent="selectMode('existing')">
                <span class="setup-radio"></span>
                <div class="setup-choice-body">
                  <h2>使用已有知识库</h2><p class="setup-help">之前用过 Precedent Loop，选这个。不会复制、移动或覆盖任何文件。</p>
                  <template v-if="dataMode === 'existing'">
                    <div class="setup-path" @click.stop><UiIcon name="folder" /><code>{{ draft.dataDirectory }}</code><button class="setup-button" :disabled="busy" @click="chooseDirectory">选择…</button></div>
                    <div v-if="checkedCurrent && inspection?.kind === 'PRODUCT'" class="setup-found"><strong>✓ 找到已有知识库</strong><span v-if="directory?.statistics?.assets !== undefined">正式知识 <b>{{ directory.statistics.assets }}</b></span><span v-if="directory?.statistics?.candidates !== undefined">待处理候选 <b>{{ directory.statistics.candidates }}</b></span><span v-if="directory?.statistics?.workspaces !== undefined">工作区 <b>{{ directory.statistics.workspaces }}</b></span><span>存储版本 <b>6</b></span></div>
                    <p v-else-if="modeMismatch" class="setup-notice warn">所选目录不是 Precedent Loop 知识库。请重新选择，或改为“新建知识库”。</p>
                  </template>
                </div>
              </div>
              <div class="setup-choice" :class="{ selected: dataMode === 'new' }" role="radio" :aria-checked="dataMode === 'new'" tabindex="0" @click="selectMode('new')" @keydown.enter.space.prevent="selectMode('new')">
                <span class="setup-radio"></span>
                <div class="setup-choice-body">
                  <h2>新建知识库</h2><p class="setup-help">第一次使用，在本机创建一个空的知识库。</p>
                  <template v-if="dataMode === 'new'">
                    <div class="setup-path" @click.stop><UiIcon name="folder" /><code>{{ draft.dataDirectory }}</code><button class="setup-button" :disabled="busy" @click="chooseDirectory">选择…</button></div>
                    <p v-if="modeMismatch" class="setup-notice warn">此位置已有知识库。请改为“使用已有知识库”。</p>
                  </template>
                </div>
              </div>
            </template>
            <div v-if="preparing" class="setup-progress" aria-live="polite">
              <div v-for="key in (['folders', 'storage', 'service'] as const)" :key="key" class="setup-progress-row"><span class="setup-progress-icon" :class="progress.find(item => item.step === key)?.status"><UiIcon :name="progress.find(item => item.step === key)?.status === 'done' ? 'tick' : progress.find(item => item.step === key)?.status === 'failed' ? 'close' : 'refresh'" /></span><div><h2>{{ progressNames[key] }}</h2><p class="setup-help">{{ progress.find(item => item.step === key)?.reason ?? (progress.find(item => item.step === key)?.status === 'done' ? key === 'folders' ? '知识文件、配置与日志目录已准备好' : key === 'storage' ? '存储版本 6 · 候选存储已就绪' : '本地服务已就绪' : key === 'service' ? '正在等待本地服务与索引就绪…' : '等待中') }}</p></div></div>
              <div v-if="failed" class="setup-notice error"><div>已完成的步骤会保留。可打开日志查看原因后重试。<div class="setup-actions"><button class="setup-button" :disabled="busy" @click="retryPreparation">重试</button><button class="setup-link" @click="perform(async () => { await bridge!.openLogs(); })">打开日志</button></div></div></div>
            </div>
            <template v-else-if="directory && checkedCurrent">
              <div v-if="!(dataMode === 'existing' && inspection?.kind === 'PRODUCT') && !modeMismatch" class="setup-directory-result"><span class="setup-status" :class="directoryTone">{{ directoryText }}</span>
                <details v-if="!committed" :open="['PRODUCT_UPGRADABLE', 'OTHER_NON_EMPTY', 'NOT_WRITABLE', 'PRODUCT_UNSUPPORTED'].includes(inspection?.kind ?? '') || syncRisk"><summary>查看说明</summary><p class="setup-help">
                  <template v-if="syncRisk">同步冲突可能影响正在使用的数据库，请优先选择本地文件夹。</template>
                  <template v-else-if="inspection?.kind === 'PRODUCT_UPGRADABLE'">升级前将备份主数据库与候选协调库。</template>
                  <template v-else-if="inspection?.kind === 'PRODUCT_INCOMPLETE'">已创建的目录与内容将保留，只继续缺失的初始化步骤。</template>
                  <template v-else-if="inspection?.kind === 'OTHER_NON_EMPTY'">不会在这里直接创建或覆盖文件。新知识库将位于 <code>{{ directory.dataDirectory }}</code>。</template>
                  <template v-else-if="inspection && 'reason' in inspection">{{ inspection.reason }}</template>
                  <template v-else>不会改动其他目录。创建完成后，知识文件可以直接查看和备份。</template>
                </p></details>
              </div>
              <div v-if="committed" class="setup-notice"><UiIcon name="info" />如需更换，请在完成后于设置中迁移。</div>
              <label v-if="syncRisk && !committed" class="setup-check"><input v-model="syncRiskConfirmed" type="checkbox" />我了解风险，仍然使用</label>
              <div v-if="inspection?.kind === 'PRODUCT_UPGRADABLE'" class="setup-backup"><UiIcon name="database" /><div>升级前的备份位置<code>{{ directory.backupRoot }}/&lt;时间戳&gt;/storage/</code></div></div>
              <p v-if="directory.portReason" class="setup-notice error">{{ directory.portReason }}</p>
            </template>
            <p v-else-if="!committed && !preparing && busy" class="setup-help" role="status">正在检查所选位置…</p>
          </template>
          <template v-else-if="step === 2">
            <h1>选择要接入的 Coding Agent</h1><p class="setup-subtitle">只做本机检查，不会发送任何模型请求。</p>
            <section v-for="agent in (['codex', 'claude'] as const)" :key="agent" class="setup-agent">
              <div class="setup-agent-heading"><AgentLogo :agent="agent" /><div><h2>{{ names[agent] }}</h2><p class="setup-help">{{ agent === 'codex' ? 'OpenAI' : 'Anthropic' }}</p></div><label v-if="!allMissing" class="setup-switch"><input v-model="draft.agents[agent]" type="checkbox" role="switch" :aria-label="`接入 ${names[agent]}`" :disabled="busy || detecting || !detections.find(item => item.agent === agent)?.found" @change="perform(save)" /><span aria-hidden="true"></span></label></div>
              <div class="setup-agent-body"><template v-if="detecting"><div class="setup-skeleton"></div><div class="setup-skeleton short"></div><span class="setup-status neutral">检测中…</span></template>
                <template v-else><template v-if="detections.find(item => item.agent === agent)?.path"><div class="setup-agent-path"><code>{{ detections.find(item => item.agent === agent)?.path }}</code><span class="setup-chip">{{ draft.manualPaths[agent] ? '手动指定' : '自动检测' }}</span></div>
                  <p v-if="detections.find(item => item.agent === agent)?.reason" class="setup-directory-result"><span class="setup-status warn">{{ detections.find(item => item.agent === agent)?.reason }}</span></p>
                  <div v-else class="setup-info-pair"><span>版本 <b>{{ detections.find(item => item.agent === agent)?.version ?? '未验证' }}</b></span><span>登录状态 <b>{{ detections.find(item => item.agent === agent)?.login === 'logged-in' ? '已登录' : detections.find(item => item.agent === agent)?.login === 'logged-out' ? '未登录' : '未验证' }}</b></span></div>
                </template><template v-else><span class="setup-status neutral">未在本机找到</span><p v-if="!allMissing" class="setup-help">安装后可在设置中接入。</p></template></template>
                <div class="setup-actions"><button class="setup-link" :disabled="busy" @click="perform(detect)">重新检测</button><button class="setup-link" :disabled="busy" @click="changePath(agent)">手动指定…</button><button v-if="draft.manualPaths[agent]" class="setup-link" :disabled="busy" @click="changePath(agent, true)">恢复自动检测</button></div>
              </div>
            </section>
            <div v-if="allMissing && !detecting" class="setup-empty"><h2>没有找到 Codex 或 Claude Code</h2><p>你仍可以使用 Precedent Loop 浏览和管理知识。<br />安装后可在设置中接入。</p></div>
            <div class="setup-ai"><div><label for="ai-provider">AI 整理默认使用</label><p class="setup-help">用于导入 Markdown 和 AI 改稿，不影响 Agent 使用知识库。<br />本次仅保存选择，后续版本接入。</p></div><select v-if="availableProviders.length" id="ai-provider" v-model="draft.aiProvider" :disabled="busy" @change="perform(save)"><option :value="null">稍后选择</option><option v-for="provider in availableProviders" :key="provider.agent" :value="provider.agent">{{ provider.agent === 'codex' ? 'Codex CLI' : 'Claude Code' }}</option></select><span v-else class="setup-help">暂不可用，可稍后在设置中配置</span></div>
          </template>
          <template v-else-if="step === 3">
            <IntegrationStep :model="integrations" />
          </template>
          <template v-else>
            <h1>检查</h1><p class="setup-subtitle">确认本地知识库已就绪。Agent 接入可稍后继续完成。</p>
            <h2 class="setup-section-title">本地核心</h2><div v-if="!core.length" class="setup-help">正在检查…</div>
            <div v-for="item in core" :key="item.id" class="setup-check-row"><div><h2>{{ coreNames[item.id] }}</h2><p class="setup-help" :class="{ 'setup-mono': item.id === 'directory' || item.id === 'mcp' }">{{ item.detail }}</p></div><span class="setup-status" :class="item.id === 'mcp' && !serviceReady ? 'neutral' : item.ok ? 'ok' : 'error'">{{ item.id === 'mcp' && !serviceReady ? '等待服务' : item.ok ? '就绪' : '未就绪' }}</span></div>
            <div class="setup-actions"><button class="setup-link" :disabled="busy" @click="retryCore">重新检查</button><button class="setup-link" @click="perform(async () => { await bridge!.openLogs(); })">打开日志</button><button v-if="!coreReady" class="setup-link" :disabled="busy" @click="perform(async () => { await go(1); })">返回本地数据</button></div>
            <IntegrationCheck :model="integrations" :detections="detections" :selected="draft.agents" :service-ready="serviceReady" />
            <p v-if="coreReady" class="setup-notice">{{ integrations.activeAgents.length ? '本地核心已就绪。待处理的 Agent 接入不会阻止你进入知识库。' : '知识库已就绪。你可以在 Hub 中导入 Markdown、管理候选和浏览知识；接入 Agent 后，它们才能在工作中使用这些知识。' }}</p>
          </template>
        </div></div>
        <footer class="setup-footer"><div class="setup-footer-inner"><button class="setup-button ghost" :disabled="step === 1 || busy || integrations.busy" @click="perform(async () => { await go((step - 1) as 1 | 2 | 3); })">上一步</button><span class="setup-help">{{ step }} / 4</span><span class="setup-spacer"></span><span v-if="step === 4 && !coreReady" class="setup-footer-reason">{{ !serviceReady ? '本地服务就绪后才能完成设置' : '本地核心检查通过后可完成' }}</span><button v-if="step === 2 && !allMissing" class="setup-button ghost" :disabled="busy" @click="perform(async () => { draft!.agents = { codex: false, claude: false }; await go(3); })">跳过</button><button class="setup-button primary" :disabled="busy || detecting || integrations.busy || (step === 1 && (preparing || (!committed && !canPrepare))) || (step === 3 && integrations.phase === 'applying') || (step === 4 && !coreReady)" @click="next">{{ preparing ? '继续' : primaryText }}</button></div></footer>
      </main>
    </div>
    <dialog ref="resetConfigDialog" class="setup-dialog" aria-labelledby="reset-config-title" aria-describedby="reset-config-description">
      <header><h2 id="reset-config-title">备份损坏的配置并重新设置</h2></header>
      <div class="setup-dialog-body"><p id="reset-config-description">将把当前 app-config.json 移动到备份目录，并从第 1 步重新设置。端口等应用设置将恢复默认，知识数据不受影响。</p><p class="setup-help">备份保存在 userData/backups/&lt;时间戳&gt;/app-config.json，不会覆盖已有备份。重新设置时可以选择原有知识库目录继续使用。</p></div>
      <footer><button class="setup-button" autofocus @click="resetConfigDialog?.close()">取消</button><button class="setup-button primary" :disabled="busy" @click="resetInvalidConfig">确认备份并重新设置</button></footer>
    </dialog>
    <dialog ref="upgradeDialog" class="setup-dialog" aria-labelledby="upgrade-title" aria-describedby="upgrade-description">
      <header><h2 id="upgrade-title">备份并升级存储</h2><p id="upgrade-description" class="setup-help">已有知识与候选将保留。</p></header>
      <div class="setup-dialog-body"><p>将先停止本地服务，确认没有其他写入者，再备份并升级此知识库。</p><code>{{ directory?.dataDirectory }}</code><ol><li>备份主数据库与候选协调库</li><li>将存储版本 5 升级到版本 6</li><li>启动服务并检查结果</li></ol><div class="setup-backup"><UiIcon name="database" /><code>{{ directory?.backupRoot }}/&lt;时间戳&gt;/storage/</code></div><label class="setup-check"><input v-model="writersStopped" type="checkbox" />我已停止其他使用此知识库的程序及写入者</label></div>
      <footer><button class="setup-button" autofocus @click="upgradeDialog?.close()">取消</button><button class="setup-button primary" :disabled="!writersStopped || busy" @click="prepare(true)">确认备份并升级</button></footer>
    </dialog>
  </div>
</template>

-- 正式知识：主库是内容的唯一原件，id 只用于显示编号。
CREATE TABLE IF NOT EXISTS asset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL UNIQUE,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('MEMORY','DOCUMENT','SKILL')), -- MEMORY-判断，DOCUMENT-参考，SKILL-流程
  asset_scope TEXT NOT NULL CHECK (asset_scope IN ('GLOBAL','WORKSPACE')), -- GLOBAL-全局，WORKSPACE-工作区
  workspace TEXT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  retrieval_terms TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(retrieval_terms)), -- 检索词：JSON 字符串数组
  body_markdown TEXT NOT NULL CHECK (length(trim(body_markdown)) > 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  previous_content TEXT CHECK (previous_content IS NULL OR json_valid(previous_content)),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)), -- 0-未删除，1-已删除
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((asset_scope='GLOBAL' AND workspace IS NULL) OR (asset_scope='WORKSPACE' AND workspace IS NOT NULL))
);

-- 正式知识全文索引；仓储在内容事务内同步，关联仅使用业务主键。
CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(asset_id UNINDEXED, title, summary, retrieval_terms, body_markdown, tokenize='trigram');

-- 待人工处理及已处理候选，与正式知识分开保存。
CREATE TABLE IF NOT EXISTS asset_candidate (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL UNIQUE,
  asset_id TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('NEW','REVISION')), -- NEW-新增，REVISION-修订
  asset_type TEXT NOT NULL CHECK (asset_type IN ('MEMORY','DOCUMENT','SKILL')), -- MEMORY-判断，DOCUMENT-参考，SKILL-流程
  asset_scope TEXT NOT NULL CHECK (asset_scope IN ('GLOBAL','WORKSPACE')), -- GLOBAL-全局，WORKSPACE-工作区
  workspace TEXT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  retrieval_terms TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(retrieval_terms)), -- 检索词：JSON 字符串数组
  body_markdown TEXT NOT NULL CHECK (length(trim(body_markdown)) > 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  base_version INTEGER,
  status TEXT NOT NULL CHECK (status IN ('PENDING','DEFERRED','ACCEPTED','REJECTED')), -- PENDING-待审，DEFERRED-暂存，ACCEPTED-已接受，REJECTED-已拒绝
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)), -- 0-未删除，1-已删除
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((asset_scope='GLOBAL' AND workspace IS NULL) OR (asset_scope='WORKSPACE' AND workspace IS NOT NULL)),
  CHECK ((intent='NEW' AND base_version IS NULL) OR (intent='REVISION' AND base_version IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS asset_candidate_open ON asset_candidate(asset_id) WHERE status IN ('PENDING','DEFERRED') AND is_deleted = 0;

-- 成功写入的幂等回执，和业务内容一起提交。
CREATE TABLE IF NOT EXISTS write_operation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK (operation IN ('prepare','import','update','rewrite','defer','reject','accept','delete')), -- prepare-准备，import-导入，update-修改，rewrite-改稿，defer-暂存或取消，reject-拒绝，accept-接受，delete-删除知识
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)), -- 0-未删除，1-已删除
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 已签发的持续工作区能力；撤销仅逻辑删除。
CREATE TABLE IF NOT EXISTS workspace_capability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capability_key_hash TEXT NOT NULL UNIQUE,
  workspace TEXT NOT NULL,
  trusted_workspace_mapping_hash TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)), -- 0-有效，1-已撤销
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 每次召回的授权、表达、诊断与预算快照。
CREATE TABLE IF NOT EXISTS recall_operation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recall_id TEXT NOT NULL UNIQUE,
  authorized_workspaces_json TEXT NOT NULL CHECK (json_valid(authorized_workspaces_json)),
  queries_json TEXT NOT NULL CHECK (json_valid(queries_json)),
  diagnostics_json TEXT NOT NULL CHECK (json_valid(diagnostics_json)),
  budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)), -- 0-未删除，1-已删除
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 召回交付条目，不外键到可删除的知识。
CREATE TABLE IF NOT EXISTS recall_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recall_item_id TEXT NOT NULL UNIQUE,
  recall_id TEXT NOT NULL REFERENCES recall_operation(recall_id),
  asset_id TEXT NOT NULL,
  asset_version INTEGER NOT NULL DEFAULT 0,
  asset_scope TEXT NOT NULL CHECK (asset_scope IN ('GLOBAL','WORKSPACE')), -- GLOBAL-全局，WORKSPACE-工作区
  asset_workspace TEXT,
  delivered_mode TEXT NOT NULL CHECK (delivered_mode IN ('DIRECT','ON_DEMAND')), -- DIRECT-摘要，ON_DEMAND-引用
  delivery_reasons_json TEXT NOT NULL CHECK (json_valid(delivery_reasons_json)),
  ordinal INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)), -- 0-未删除，1-已删除
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((asset_scope='GLOBAL' AND asset_workspace IS NULL) OR (asset_scope='WORKSPACE' AND asset_workspace IS NOT NULL)),
  UNIQUE(recall_id,asset_id),
  UNIQUE(recall_id,ordinal)
);
CREATE INDEX IF NOT EXISTS recall_item_asset ON recall_item(asset_id);

-- 每次读取事实，保留原召回来源和读取时版本。
CREATE TABLE IF NOT EXISTS read_operation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  read_ref TEXT NOT NULL UNIQUE,
  authorized_workspaces_json TEXT NOT NULL CHECK (json_valid(authorized_workspaces_json)),
  asset_id TEXT NOT NULL,
  asset_version INTEGER NOT NULL DEFAULT 0,
  asset_scope TEXT NOT NULL CHECK (asset_scope IN ('GLOBAL','WORKSPACE')), -- GLOBAL-全局，WORKSPACE-工作区
  asset_workspace TEXT,
  recall_item_id TEXT REFERENCES recall_item(recall_item_id),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)), -- 0-未删除，1-已删除
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((asset_scope='GLOBAL' AND asset_workspace IS NULL) OR (asset_scope='WORKSPACE' AND asset_workspace IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS read_operation_asset ON read_operation(asset_id);

-- 显式使用事实，来源幂等且不随知识删除而消失。
CREATE TABLE IF NOT EXISTS used_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  used_id TEXT NOT NULL UNIQUE,
  authorized_workspaces_json TEXT NOT NULL CHECK (json_valid(authorized_workspaces_json)),
  recall_item_id TEXT UNIQUE REFERENCES recall_item(recall_item_id),
  direct_read_ref TEXT UNIQUE REFERENCES read_operation(read_ref),
  asset_id TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)), -- 0-未删除，1-已删除
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((recall_item_id IS NULL) != (direct_read_ref IS NULL))
);
CREATE INDEX IF NOT EXISTS used_event_asset ON used_event(asset_id);

-- 待修订问题：使用时反馈、召回自测与引用核对发现的知识问题，经候选页处理。
CREATE TABLE IF NOT EXISTS asset_issue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL UNIQUE,
  asset_id TEXT NOT NULL REFERENCES asset(asset_id),
  asset_version INTEGER NOT NULL CHECK (asset_version >= 0), -- 报告时的知识版本
  kind TEXT NOT NULL CHECK (kind IN ('OUTDATED','INACCURATE','INCOMPLETE','MISLEADING','MISSED','UNREACHABLE','BROKEN_REFERENCE')), -- OUTDATED-过时，INACCURATE-有误，INCOMPLETE-不完整，MISLEADING-标题摘要误导，MISSED-换说法才召回到，UNREACHABLE-自测未命中，BROKEN_REFERENCE-引用文件不存在
  detail TEXT NOT NULL CHECK (length(trim(detail)) > 0),
  evidence TEXT,
  queries TEXT CHECK (queries IS NULL OR json_valid(queries)), -- 未命中的查询词或自测请求与查询词
  source TEXT NOT NULL CHECK (source IN ('CODEX','CLAUDE','RETRIEVAL_CHECK','REFERENCE_CHECK')), -- CODEX-Codex 会话反馈，CLAUDE-Claude 会话反馈，RETRIEVAL_CHECK-召回自测，REFERENCE_CHECK-引用核对
  session_id TEXT,
  turn_id TEXT,
  check_id TEXT REFERENCES retrieval_check(check_id),
  status TEXT NOT NULL CHECK (status IN ('OPEN','DRAFTED','RESOLVED','DISMISSED')), -- OPEN-待处理，DRAFTED-已起草修订，RESOLVED-已随修订关闭，DISMISSED-已驳回
  candidate_id TEXT REFERENCES asset_candidate(candidate_id),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)), -- 0-未删除，1-已删除
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((source IN ('CODEX','CLAUDE')) = (session_id IS NOT NULL AND turn_id IS NOT NULL)),
  CHECK ((source = 'RETRIEVAL_CHECK') = (check_id IS NOT NULL)),
  CHECK (status <> 'DRAFTED' OR candidate_id IS NOT NULL)
);

-- 召回自测结果：每次对一个目标（正式知识或候选）的确切版本测试一次。
CREATE TABLE IF NOT EXISTS retrieval_check (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id TEXT NOT NULL UNIQUE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('ASSET','CANDIDATE')), -- ASSET-正式知识，CANDIDATE-候选
  target_id TEXT NOT NULL, -- asset_id 或 candidate_id
  target_version INTEGER NOT NULL CHECK (target_version >= 0),
  result TEXT NOT NULL CHECK (json_valid(result)), -- [{question, queries[], hit, rank}]
  passed INTEGER NOT NULL CHECK (passed IN (0,1)), -- 0-有请求未命中，1-全部命中
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)), -- 0-未删除，1-已删除
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

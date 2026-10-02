-- 正式知识：主库是内容的唯一原件，id 只用于显示编号。
CREATE TABLE asset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL UNIQUE,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('MEMORY','DOCUMENT','SKILL')), -- MEMORY-判断，DOCUMENT-参考，SKILL-流程
  asset_scope TEXT NOT NULL CHECK (asset_scope IN ('GLOBAL','WORKSPACE')), -- GLOBAL-全局，WORKSPACE-工作区
  workspace TEXT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  body_markdown TEXT NOT NULL CHECK (length(trim(body_markdown)) > 0),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  previous_content TEXT CHECK (previous_content IS NULL OR json_valid(previous_content)),
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)), -- 0-未删除，1-已删除
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((asset_scope='GLOBAL' AND workspace IS NULL) OR (asset_scope='WORKSPACE' AND workspace IS NOT NULL))
);

-- 正式知识全文索引；仓储在内容事务内同步，关联仅使用业务主键。
CREATE VIRTUAL TABLE asset_fts USING fts5(asset_id UNINDEXED, title, summary, body_markdown, tokenize='trigram');

-- 待人工处理及已处理候选，与正式知识分开保存。
CREATE TABLE asset_candidate (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id TEXT NOT NULL UNIQUE,
  asset_id TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('NEW','REVISION')), -- NEW-新增，REVISION-修订
  asset_type TEXT NOT NULL CHECK (asset_type IN ('MEMORY','DOCUMENT','SKILL')), -- MEMORY-判断，DOCUMENT-参考，SKILL-流程
  asset_scope TEXT NOT NULL CHECK (asset_scope IN ('GLOBAL','WORKSPACE')), -- GLOBAL-全局，WORKSPACE-工作区
  workspace TEXT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
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
CREATE UNIQUE INDEX asset_candidate_open ON asset_candidate(asset_id) WHERE status IN ('PENDING','DEFERRED') AND is_deleted = 0;

-- 成功写入的幂等回执，和业务内容一起提交。
CREATE TABLE write_operation (
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
CREATE TABLE workspace_capability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capability_key_hash TEXT NOT NULL UNIQUE,
  workspace TEXT NOT NULL,
  trusted_workspace_mapping_hash TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1)), -- 0-有效，1-已撤销
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 每次召回的授权、表达、诊断与预算快照。
CREATE TABLE recall_operation (
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
CREATE TABLE recall_item (
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
CREATE INDEX recall_item_asset ON recall_item(asset_id);

-- 每次读取事实，保留原召回来源和读取时版本。
CREATE TABLE read_operation (
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
CREATE INDEX read_operation_asset ON read_operation(asset_id);

-- 显式使用事实，来源幂等且不随知识删除而消失。
CREATE TABLE used_event (
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
CREATE INDEX used_event_asset ON used_event(asset_id);

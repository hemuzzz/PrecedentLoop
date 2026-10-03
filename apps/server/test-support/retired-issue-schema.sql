-- Historical schema fixture only: never loaded by production code.
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

-- 召回自测结果已停用、不再写入；保留表结构与历史数据，使新库与已有库一致。
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

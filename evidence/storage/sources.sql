CREATE TABLE IF NOT EXISTS t3_threads (
  instance TEXT NOT NULL, thread_id TEXT NOT NULL, created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL,
  settled INTEGER NOT NULL, captured_run_count INTEGER NOT NULL,
  PRIMARY KEY (instance, thread_id)
) STRICT;

CREATE TABLE IF NOT EXISTS t3_thread_titles (
  instance TEXT NOT NULL, thread_id TEXT NOT NULL, title TEXT NOT NULL,
  PRIMARY KEY (instance, thread_id),
  FOREIGN KEY (instance, thread_id) REFERENCES t3_threads
) STRICT;

CREATE TABLE IF NOT EXISTS t3_runs (
  instance TEXT NOT NULL, thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
  requested_ms INTEGER, started_ms INTEGER, completed_ms INTEGER, status TEXT NOT NULL,
  PRIMARY KEY (instance, thread_id, run_id),
  FOREIGN KEY (instance, thread_id) REFERENCES t3_threads
) STRICT;

CREATE TABLE IF NOT EXISTS t3_pr_links (
  instance TEXT NOT NULL, thread_id TEXT NOT NULL, repository TEXT NOT NULL,
  pr_number INTEGER NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL, owning INTEGER NOT NULL,
  PRIMARY KEY (instance, thread_id, repository, pr_number),
  FOREIGN KEY (instance, thread_id) REFERENCES t3_threads
) STRICT;

CREATE TABLE IF NOT EXISTS codex_rollouts (
  instance TEXT NOT NULL, session_id TEXT NOT NULL, line_count INTEGER NOT NULL,
  malformed_count INTEGER NOT NULL, orphan_count INTEGER NOT NULL,
  PRIMARY KEY (instance, session_id)
) STRICT;

CREATE TABLE IF NOT EXISTS t3_codex_links (
  t3_instance TEXT NOT NULL, thread_id TEXT NOT NULL,
  codex_instance TEXT NOT NULL, session_id TEXT NOT NULL,
  PRIMARY KEY (t3_instance, thread_id, codex_instance, session_id),
  FOREIGN KEY (codex_instance, session_id) REFERENCES codex_rollouts
) STRICT;

CREATE TABLE IF NOT EXISTS codex_calls (
  instance TEXT NOT NULL, session_id TEXT NOT NULL, call_id TEXT NOT NULL,
  source_line INTEGER NOT NULL, tool TEXT NOT NULL, started_ms INTEGER, ended_ms INTEGER,
  launched_async INTEGER NOT NULL, async_observed_end_ms INTEGER, terminal_call_id TEXT,
  ambiguous INTEGER NOT NULL,
  PRIMARY KEY (instance, session_id, call_id),
  FOREIGN KEY (instance, session_id) REFERENCES codex_rollouts
) STRICT;

CREATE TABLE IF NOT EXISTS codex_reasoning (
  instance TEXT NOT NULL, session_id TEXT NOT NULL, source_line INTEGER NOT NULL, observed_ms INTEGER NOT NULL,
  PRIMARY KEY (instance, session_id, source_line),
  FOREIGN KEY (instance, session_id) REFERENCES codex_rollouts
) STRICT;

CREATE TABLE IF NOT EXISTS codex_reasoning_inputs (
  instance TEXT NOT NULL, session_id TEXT NOT NULL, source_line INTEGER NOT NULL, result_call_id TEXT NOT NULL,
  PRIMARY KEY (instance, session_id, source_line),
  FOREIGN KEY (instance, session_id, source_line) REFERENCES codex_reasoning
) STRICT;

CREATE TABLE IF NOT EXISTS codex_commands (
  instance TEXT NOT NULL, session_id TEXT NOT NULL, call_id TEXT NOT NULL, command TEXT NOT NULL,
  PRIMARY KEY (instance, session_id, call_id),
  FOREIGN KEY (instance, session_id, call_id) REFERENCES codex_calls
) STRICT;

CREATE TABLE IF NOT EXISTS codex_categories (
  instance TEXT NOT NULL, session_id TEXT NOT NULL, call_id TEXT NOT NULL, categories TEXT NOT NULL,
  PRIMARY KEY (instance, session_id, call_id),
  FOREIGN KEY (instance, session_id, call_id) REFERENCES codex_calls
) STRICT;

CREATE TABLE IF NOT EXISTS codex_command_mixes (
  instance TEXT NOT NULL, session_id TEXT NOT NULL, call_id TEXT NOT NULL,
  file_count INTEGER NOT NULL, git_count INTEGER NOT NULL, build_count INTEGER NOT NULL,
  push_count INTEGER NOT NULL, seconds REAL NOT NULL,
  PRIMARY KEY (instance, session_id, call_id),
  FOREIGN KEY (instance, session_id, call_id) REFERENCES codex_calls
) STRICT;

CREATE TABLE IF NOT EXISTS codex_wait_coverage (
  instance TEXT NOT NULL, session_id TEXT NOT NULL,
  PRIMARY KEY (instance, session_id),
  FOREIGN KEY (instance, session_id) REFERENCES codex_rollouts
) STRICT;

CREATE TABLE IF NOT EXISTS codex_wait_attribution (
  instance TEXT NOT NULL, session_id TEXT NOT NULL, call_id TEXT NOT NULL,
  cell_id TEXT, cell_status TEXT NOT NULL, cell_launch_call_id TEXT,
  PRIMARY KEY (instance, session_id, call_id),
  FOREIGN KEY (instance, session_id, call_id) REFERENCES codex_calls,
  FOREIGN KEY (instance, session_id, cell_launch_call_id) REFERENCES codex_calls
) STRICT;

CREATE TABLE IF NOT EXISTS codex_process_receipts (
  instance TEXT NOT NULL, session_id TEXT NOT NULL, call_id TEXT NOT NULL,
  result_call_id TEXT, receipt_source_line INTEGER, process_handle TEXT, receipt_handle TEXT,
  process_status TEXT NOT NULL, process_launch_call_id TEXT, process_category TEXT,
  receipt_kind TEXT NOT NULL, receipt_seconds REAL, exit_code INTEGER,
  repository TEXT, run_id TEXT, head_sha TEXT, attempt TEXT,
  poll_started_ms INTEGER, poll_result_ms INTEGER,
  PRIMARY KEY (instance, session_id, call_id),
  FOREIGN KEY (instance, session_id, call_id) REFERENCES codex_calls,
  FOREIGN KEY (instance, session_id, result_call_id) REFERENCES codex_calls,
  FOREIGN KEY (instance, session_id, process_launch_call_id) REFERENCES codex_calls
) STRICT;

CREATE INDEX IF NOT EXISTS codex_process_workflow
ON codex_process_receipts(repository, run_id, head_sha, attempt, poll_started_ms);

CREATE VIEW IF NOT EXISTS actions_wait_facts AS
SELECT repository, run_id, head_sha, attempt, 1 AS identity_exact,
       poll_started_ms AS started_ms, poll_result_ms AS ended_ms
FROM codex_process_receipts WHERE poll_started_ms IS NOT NULL;

CREATE TABLE IF NOT EXISTS github_prs (
  repository TEXT NOT NULL, pr_number INTEGER NOT NULL, state TEXT NOT NULL,
  opened_at INTEGER NOT NULL, merged_at INTEGER, merge_sha TEXT,
  first_commit_at INTEGER, first_commit_sha TEXT, commits_complete INTEGER NOT NULL,
  first_review_at INTEGER, first_review_id INTEGER, reviews_complete INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repository, pr_number)
) STRICT;

CREATE TABLE IF NOT EXISTS github_pr_titles (
  repository TEXT NOT NULL, pr_number INTEGER NOT NULL, title TEXT NOT NULL,
  PRIMARY KEY (repository, pr_number),
  FOREIGN KEY (repository, pr_number) REFERENCES github_prs
) STRICT;

CREATE TABLE IF NOT EXISTS github_pr_ci (
  repository TEXT NOT NULL, pr_number INTEGER NOT NULL, run_id INTEGER NOT NULL, started_at INTEGER NOT NULL,
  PRIMARY KEY (repository, pr_number),
  FOREIGN KEY (repository, pr_number) REFERENCES github_prs
) STRICT;

CREATE TABLE IF NOT EXISTS github_release_observations (
  repository TEXT NOT NULL, pr_number INTEGER NOT NULL, release_id INTEGER NOT NULL,
  channel TEXT NOT NULL, checked_at INTEGER NOT NULL, merge_sha TEXT NOT NULL,
  source_sha TEXT NOT NULL, tag TEXT NOT NULL, tag_matches INTEGER NOT NULL,
  published_at INTEGER NOT NULL, asset_id INTEGER NOT NULL, http_status INTEGER NOT NULL,
  bytes INTEGER NOT NULL, accessible INTEGER NOT NULL, ancestry TEXT NOT NULL, shipped INTEGER NOT NULL,
  dispatch_run INTEGER NOT NULL, dispatched_at INTEGER NOT NULL,
  PRIMARY KEY (repository, pr_number, release_id, channel, checked_at, merge_sha,
               source_sha, tag, tag_matches, published_at, asset_id, http_status, bytes, accessible, ancestry, shipped,
               dispatch_run, dispatched_at),
  FOREIGN KEY (repository, pr_number) REFERENCES github_prs
) STRICT;

CREATE TABLE IF NOT EXISTS git_change_scans(
  repository TEXT PRIMARY KEY, revision TEXT NOT NULL, commits_scanned INTEGER NOT NULL,
  truncated INTEGER NOT NULL, shallow INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS git_changed_files(
  repository TEXT NOT NULL REFERENCES git_change_scans(repository),
  rank INTEGER NOT NULL, path TEXT, path_base64 TEXT, commits INTEGER NOT NULL,
  PRIMARY KEY (repository, rank),
  CHECK ((path IS NULL) <> (path_base64 IS NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS git_change_inventory(
  repository TEXT PRIMARY KEY REFERENCES git_change_scans(repository),
  paths TEXT
) STRICT;

CREATE VIEW IF NOT EXISTS codex_spans AS
SELECT instance, session_id, call_id, source_line, tool, 'tool_envelope' AS clock,
       started_ms, ended_ms, NULL AS terminal_call_id
FROM codex_calls
UNION ALL
SELECT instance, session_id, call_id, source_line, tool, 'async_cell',
       started_ms, async_observed_end_ms, terminal_call_id
FROM codex_calls WHERE launched_async = 1;

CREATE VIEW IF NOT EXISTS open_delivery_threads AS
SELECT DISTINCT thread.instance, thread.thread_id, thread.status, thread.created_ms, thread.origin
FROM t3_threads thread
JOIN t3_pr_links link USING (instance, thread_id)
WHERE link.owning = 1 AND link.state = 'open' AND thread.settled = 0;

CREATE TABLE IF NOT EXISTS codex_rollout_imports (
  instance TEXT NOT NULL, source_key TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT,
  parent_thread_id TEXT, history_start_ordinal INTEGER, file_bytes INTEGER, read_bytes INTEGER NOT NULL, complete_lines INTEGER NOT NULL,
  inherited_lines INTEGER NOT NULL, unassigned_lines INTEGER NOT NULL,
  malformed_lines INTEGER NOT NULL, oversized_lines INTEGER NOT NULL,
  cutoff_lines INTEGER NOT NULL, cutoff_bytes INTEGER NOT NULL,
  PRIMARY KEY (instance, source_key)
) STRICT;

CREATE TABLE IF NOT EXISTS codex_rollout_quality (
  instance TEXT NOT NULL, session_id TEXT NOT NULL, source_key TEXT NOT NULL,
  first_observed_ms INTEGER, last_observed_ms INTEGER,
  missing_start INTEGER NOT NULL, missing_end INTEGER NOT NULL, missing_async_end INTEGER NOT NULL,
  ambiguous_calls INTEGER NOT NULL, mix_candidates INTEGER NOT NULL, mix_receipts INTEGER NOT NULL,
  mixed_calls INTEGER NOT NULL, mixed_without_receipt INTEGER NOT NULL,
  PRIMARY KEY (instance, session_id),
  FOREIGN KEY (instance, session_id) REFERENCES codex_rollouts
) STRICT;

CREATE TABLE IF NOT EXISTS codex_kernel_captures (
  capture TEXT PRIMARY KEY, instance TEXT NOT NULL, session_id TEXT NOT NULL,
  call_id TEXT NOT NULL, source_line INTEGER NOT NULL, started_ms INTEGER NOT NULL, trace_json TEXT NOT NULL,
  UNIQUE (instance, session_id, call_id)
) STRICT;

CREATE TABLE IF NOT EXISTS codex_otel_spans (
  instance TEXT NOT NULL, trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT,
  operation TEXT NOT NULL, start_ns TEXT NOT NULL, end_ns TEXT NOT NULL, status_code INTEGER NOT NULL,
  conversation_id TEXT, turn_id TEXT, call_id TEXT, fingerprint TEXT NOT NULL,
  PRIMARY KEY (instance, trace_id, span_id)
) STRICT;

CREATE TABLE IF NOT EXISTS codex_otel_span_events (
  instance TEXT NOT NULL, trace_id TEXT NOT NULL, span_id TEXT NOT NULL, event_index INTEGER NOT NULL,
  event TEXT NOT NULL, observed_ns TEXT NOT NULL, conversation_id TEXT, turn_id TEXT, call_id TEXT,
  reported_duration_ms INTEGER, success INTEGER,
  PRIMARY KEY (instance, trace_id, span_id, event_index),
  FOREIGN KEY (instance, trace_id, span_id) REFERENCES codex_otel_spans
) STRICT;

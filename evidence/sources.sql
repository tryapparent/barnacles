CREATE TABLE IF NOT EXISTS t3_threads (
  instance TEXT NOT NULL, thread_id TEXT NOT NULL, created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL, status TEXT NOT NULL, origin TEXT NOT NULL,
  settled INTEGER NOT NULL, captured_run_count INTEGER NOT NULL,
  PRIMARY KEY (instance, thread_id)
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

CREATE TABLE IF NOT EXISTS github_prs (
  repository TEXT NOT NULL, pr_number INTEGER NOT NULL, state TEXT NOT NULL,
  opened_at INTEGER NOT NULL, merged_at INTEGER, merge_sha TEXT,
  first_commit_at INTEGER, first_commit_sha TEXT, commits_complete INTEGER NOT NULL,
  first_review_at INTEGER, first_review_id INTEGER, reviews_complete INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repository, pr_number)
) STRICT;

CREATE TABLE IF NOT EXISTS github_releases (
  repository TEXT NOT NULL, release_id INTEGER NOT NULL, channel TEXT NOT NULL, tag TEXT NOT NULL,
  source_sha TEXT NOT NULL, tag_matches INTEGER NOT NULL, published_at INTEGER, asset_id INTEGER,
  PRIMARY KEY (repository, release_id, channel)
) STRICT;

CREATE TABLE IF NOT EXISTS github_pr_ci (
  repository TEXT NOT NULL, pr_number INTEGER NOT NULL, run_id INTEGER NOT NULL, started_at INTEGER NOT NULL,
  PRIMARY KEY (repository, pr_number),
  FOREIGN KEY (repository, pr_number) REFERENCES github_prs
) STRICT;

CREATE TABLE IF NOT EXISTS github_asset_checks (
  repository TEXT NOT NULL, release_id INTEGER NOT NULL, channel TEXT NOT NULL, checked_at INTEGER NOT NULL,
  asset_id INTEGER, http_status INTEGER, bytes INTEGER, accessible INTEGER NOT NULL,
  PRIMARY KEY (repository, release_id, channel, checked_at),
  FOREIGN KEY (repository, release_id, channel) REFERENCES github_releases
) STRICT;

CREATE TABLE IF NOT EXISTS github_release_dispatch (
  repository TEXT NOT NULL, release_id INTEGER NOT NULL, channel TEXT NOT NULL, run_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (repository, release_id, channel),
  FOREIGN KEY (repository, release_id, channel) REFERENCES github_releases
) STRICT;

CREATE TABLE IF NOT EXISTS github_release_proofs (
  repository TEXT NOT NULL, pr_number INTEGER NOT NULL, release_id INTEGER NOT NULL,
  channel TEXT NOT NULL, checked_at INTEGER NOT NULL, merge_sha TEXT,
  ancestry TEXT NOT NULL, shipped INTEGER NOT NULL,
  PRIMARY KEY (repository, pr_number, release_id, channel, checked_at),
  FOREIGN KEY (repository, pr_number) REFERENCES github_prs,
  FOREIGN KEY (repository, release_id, channel, checked_at) REFERENCES github_asset_checks
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

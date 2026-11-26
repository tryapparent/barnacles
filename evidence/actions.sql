CREATE TABLE IF NOT EXISTS action_attempts (
  repository TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  workflow_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  created_at INTEGER,
  started_at INTEGER,
  source_updated INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  job_count INTEGER NOT NULL,
  PRIMARY KEY (repository, run_id, attempt)
) STRICT;

CREATE TABLE IF NOT EXISTS action_jobs (
  repository TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  created_at INTEGER,
  prior_execution INTEGER NOT NULL,
  queue_end INTEGER,
  execution_start INTEGER,
  execution_end INTEGER,
  PRIMARY KEY (repository, run_id, attempt, job_id),
  FOREIGN KEY (repository, run_id, attempt)
    REFERENCES action_attempts ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS action_steps (
  repository TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  step_number INTEGER NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  PRIMARY KEY (repository, run_id, attempt, job_id, step_number),
  FOREIGN KEY (repository, run_id, attempt, job_id)
    REFERENCES action_jobs ON DELETE CASCADE
) STRICT;

CREATE VIEW IF NOT EXISTS action_occupancy AS
WITH spans AS (
  SELECT repository, run_id, attempt, label AS operation,
         'queue' AS clock, queue_end - created_at AS seconds
  FROM action_jobs
  UNION ALL
  SELECT repository, run_id, attempt, label,
         'execution', execution_end - execution_start
  FROM action_jobs
  UNION ALL
  SELECT repository, run_id, attempt, label,
         'step', completed_at - started_at
  FROM action_steps
)
SELECT spans.repository, workflow_id, clock, operation,
       count(seconds) AS count, avg(seconds) AS mean_seconds,
       sum(seconds) AS total_seconds, count(*) - count(seconds) AS unmeasured_count
FROM spans
JOIN action_attempts USING (repository, run_id, attempt)
GROUP BY spans.repository, workflow_id, clock, operation;

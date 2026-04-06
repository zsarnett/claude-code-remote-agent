CREATE SCHEMA IF NOT EXISTS tasks;

CREATE TABLE tasks.items (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  session_name TEXT,
  channel_id TEXT,
  parent_id INTEGER REFERENCES tasks.items(id) ON DELETE CASCADE,
  dispatch_id INTEGER REFERENCES audit.dispatches(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_status ON tasks.items (status);
CREATE INDEX idx_tasks_session ON tasks.items (session_name);
CREATE INDEX idx_tasks_parent ON tasks.items (parent_id);
CREATE INDEX idx_tasks_updated ON tasks.items (updated_at DESC);

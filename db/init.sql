-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Memory schema: 3-tier semantic memory
CREATE SCHEMA IF NOT EXISTS memory;

-- Episodic memory: session transcripts and outcomes
CREATE TABLE memory.episodes (
  id SERIAL PRIMARY KEY,
  session_name TEXT NOT NULL,
  channel_id TEXT,
  summary TEXT NOT NULL,
  outcome TEXT,
  cost NUMERIC,
  duration_secs INTEGER,
  tokens_used INTEGER,
  tools_used TEXT[],
  files_touched TEXT[],
  embedding vector(384),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Semantic memory: accumulated facts with contradiction detection
CREATE TABLE memory.facts (
  id SERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  category TEXT NOT NULL,
  source_session TEXT,
  embedding vector(384),
  superseded_by INTEGER REFERENCES memory.facts(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  superseded_at TIMESTAMPTZ
);

-- Procedural memory: learned workflows
CREATE TABLE memory.procedures (
  id SERIAL PRIMARY KEY,
  trigger_desc TEXT NOT NULL,
  steps TEXT NOT NULL,
  source_session TEXT,
  embedding vector(384),
  use_count INTEGER DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for memory schema
CREATE INDEX idx_episodes_embedding ON memory.episodes
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
CREATE INDEX idx_facts_embedding ON memory.facts
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);
CREATE INDEX idx_procedures_embedding ON memory.procedures
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

CREATE INDEX idx_facts_content_fts ON memory.facts
  USING GIN (to_tsvector('english', content));
CREATE INDEX idx_facts_active ON memory.facts (superseded_by)
  WHERE superseded_by IS NULL;
CREATE INDEX idx_episodes_created ON memory.episodes (created_at DESC);

-- Audit schema: dispatch and session tracking
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE audit.dispatches (
  id SERIAL PRIMARY KEY,
  session_name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  channel_id TEXT,
  message_preview TEXT,
  dispatched_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE audit.session_runs (
  id SERIAL PRIMARY KEY,
  session_name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ DEFAULT now(),
  stop_reason TEXT,
  context_percent INTEGER,
  tokens_used INTEGER,
  model TEXT,
  cost_estimate NUMERIC,
  facts_extracted INTEGER DEFAULT 0,
  corrections_extracted INTEGER DEFAULT 0
);

-- Migrations tracking table
CREATE TABLE IF NOT EXISTS public._migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ DEFAULT now()
);

/**
 * Checkpoint and handoff management for session continuity.
 * Checkpoints are stored as agent memories in LanceDB with
 * special metadata for structured retrieval.
 */

import crypto from "node:crypto";
import { embed } from "./embedder.js";
import type { MemoryRecord } from "./types.js";

/** Structured checkpoint data. */
export interface CheckpointData {
  /** What the agent is currently working on */
  working_on: string;
  /** Current blockers or stuck points */
  blockers: string[];
  /** Recent decisions made during this session */
  recent_decisions: string[];
  /** Open questions needing answers */
  open_questions: string[];
  /** Session name (e.g., "hub", "project-foo") */
  session?: string;
  /** Working directory */
  cwd?: string;
}

/** Structured handoff/sleep data. */
export interface HandoffData {
  /** Summary of what was accomplished */
  summary: string;
  /** Next steps for whoever picks this up */
  next_steps: string[];
  /** Unresolved blockers */
  blockers: string[];
  /** Session name */
  session?: string;
  /** Working directory */
  cwd?: string;
}

/**
 * Convert checkpoint data into a text representation for embedding
 * and a metadata object for structured retrieval.
 */
export function checkpointToRecord(data: CheckpointData): {
  text: string;
  metadata: Record<string, unknown>;
} {
  const parts: string[] = [];
  parts.push(`Working on: ${data.working_on}`);

  if (data.blockers.length > 0) {
    parts.push(`Blockers: ${data.blockers.join("; ")}`);
  }

  if (data.recent_decisions.length > 0) {
    parts.push(`Decisions: ${data.recent_decisions.join("; ")}`);
  }

  if (data.open_questions.length > 0) {
    parts.push(`Open questions: ${data.open_questions.join("; ")}`);
  }

  return {
    text: parts.join("\n"),
    metadata: {
      type: "checkpoint",
      session: data.session ?? "",
      cwd: data.cwd ?? "",
      blockers: data.blockers,
      recent_decisions: data.recent_decisions,
      open_questions: data.open_questions,
    },
  };
}

/**
 * Convert handoff data into a text representation for embedding
 * and a metadata object for structured retrieval.
 */
export function handoffToRecord(data: HandoffData): {
  text: string;
  metadata: Record<string, unknown>;
} {
  const parts: string[] = [];
  parts.push(`Summary: ${data.summary}`);

  if (data.next_steps.length > 0) {
    parts.push(`Next steps: ${data.next_steps.join("; ")}`);
  }

  if (data.blockers.length > 0) {
    parts.push(`Blockers: ${data.blockers.join("; ")}`);
  }

  return {
    text: parts.join("\n"),
    metadata: {
      type: "handoff",
      session: data.session ?? "",
      cwd: data.cwd ?? "",
      next_steps: data.next_steps,
      blockers: data.blockers,
    },
  };
}

/**
 * Create a MemoryRecord from checkpoint or handoff data.
 */
export async function createCheckpointRecord(
  textContent: string,
  metadata: Record<string, unknown>,
  importance: number
): Promise<MemoryRecord> {
  const now = Date.now();
  const vector = await embed(textContent);

  return {
    id: crypto.randomUUID(),
    text: textContent,
    vector,
    source: "agent",
    source_path: "",
    category: "episodic",
    tags: `checkpoint, ${metadata.type as string}`,
    importance,
    access_count: 0,
    created_at: now,
    updated_at: now,
    last_accessed: now,
    file_hash: "",
    metadata: JSON.stringify(metadata),
  };
}

/**
 * Parse metadata from a MemoryRecord to extract checkpoint/handoff fields.
 */
export function parseCheckpointMetadata(
  record: MemoryRecord
): Record<string, unknown> {
  try {
    return JSON.parse(record.metadata);
  } catch {
    return {};
  }
}

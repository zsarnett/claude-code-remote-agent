/**
 * Observation management for the Memory MCP Server.
 * Observations are stored as a flat markdown file (source of truth)
 * AND indexed in LanceDB for semantic search.
 * The flat file is watched by chokidar and re-indexed on change.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export type ObservationPriority = "red" | "yellow" | "green";

export interface Observation {
  timestamp: string;
  priority: ObservationPriority;
  text: string;
  session?: string;
}

/**
 * Default path for the observations file.
 * Can be overridden by MEMORY_OBSERVATIONS_PATH env var.
 */
export function getObservationsPath(): string {
  return (
    process.env.MEMORY_OBSERVATIONS_PATH ??
    join(homedir(), ".claude", "memory", "observations.md")
  );
}

/**
 * Parse the observations.md file into structured observations.
 * File format:
 * ---
 * # Observations
 * ---
 * - [2026-03-24T12:00:00Z] [red] Some important observation {session: hub}
 * - [2026-03-24T12:01:00Z] [yellow] Less important observation
 */
export function parseObservations(content: string): Observation[] {
  const observations: Observation[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- [")) continue;

    // Pattern: - [TIMESTAMP] [PRIORITY] TEXT {session: NAME}
    const match = trimmed.match(
      /^- \[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]\s+\[(red|yellow|green)\]\s+(.+)$/
    );
    if (!match) continue;

    const [, timestamp, priority, rest] = match;
    let text = rest;
    let session: string | undefined;

    // Extract optional session tag from the end
    const sessionMatch = text.match(/\s*\{session:\s*(.+?)\}\s*$/);
    if (sessionMatch) {
      session = sessionMatch[1];
      text = text.slice(0, text.length - sessionMatch[0].length).trim();
    }

    observations.push({
      timestamp,
      priority: priority as ObservationPriority,
      text,
      session,
    });
  }

  return observations;
}

/**
 * Format a single observation as a markdown line.
 */
export function formatObservation(obs: Observation): string {
  const sessionTag = obs.session ? ` {session: ${obs.session}}` : "";
  return `- [${obs.timestamp}] [${obs.priority}] ${obs.text}${sessionTag}`;
}

/**
 * Append an observation to the observations.md file.
 * Creates the file with a header if it doesn't exist.
 */
export async function appendObservation(obs: Observation): Promise<void> {
  const filePath = getObservationsPath();
  await mkdir(dirname(filePath), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist yet, start with header
    existing = "# Observations\n\nPriority: red = important/keep until resolved, yellow = ~14 days, green = ~7 days\n\n";
  }

  const line = formatObservation(obs);

  // Append the observation
  const updated = existing.trimEnd() + "\n" + line + "\n";
  await writeFile(filePath, updated, "utf-8");
}

/**
 * Read all observations from the file.
 */
export async function readObservations(): Promise<Observation[]> {
  const filePath = getObservationsPath();
  try {
    const content = await readFile(filePath, "utf-8");
    return parseObservations(content);
  } catch {
    return [];
  }
}

/**
 * Get observations filtered by priority and/or time window.
 */
export function filterObservations(
  observations: Observation[],
  options: {
    priority?: ObservationPriority;
    sinceHours?: number;
    session?: string;
  }
): Observation[] {
  let filtered = observations;

  if (options.priority) {
    filtered = filtered.filter((o) => o.priority === options.priority);
  }

  if (options.sinceHours) {
    const cutoff = Date.now() - options.sinceHours * 60 * 60 * 1000;
    filtered = filtered.filter((o) => {
      const ts = new Date(o.timestamp).getTime();
      return ts >= cutoff;
    });
  }

  if (options.session) {
    filtered = filtered.filter((o) => o.session === options.session);
  }

  return filtered;
}

/** Decay thresholds in hours for each priority level. */
const OBSERVATION_DECAY_HOURS: Record<ObservationPriority, number | null> = {
  red: null, // Never auto-prune -- keep until manually resolved
  yellow: 14 * 24, // ~14 days
  green: 7 * 24, // ~7 days
};

/**
 * Result of a prune operation.
 */
export interface PruneResult {
  /** Number of observations removed */
  pruned: number;
  /** Number of observations kept */
  kept: number;
  /** The pruned observation texts (for reporting) */
  prunedTexts: string[];
}

/**
 * Prune expired observations from the flat file based on decay thresholds.
 * - red: never pruned (keep until manually resolved)
 * - yellow: pruned after ~14 days
 * - green: pruned after ~7 days
 *
 * Rewrites the observations file with only the surviving entries.
 * Returns stats about what was pruned.
 */
export async function pruneObservations(
  now?: number
): Promise<PruneResult> {
  const currentTime = now ?? Date.now();
  const allObs = await readObservations();

  const kept: Observation[] = [];
  const pruned: Observation[] = [];

  for (const obs of allObs) {
    const maxAge = OBSERVATION_DECAY_HOURS[obs.priority];

    // Red observations never decay
    if (maxAge === null) {
      kept.push(obs);
      continue;
    }

    const obsTime = new Date(obs.timestamp).getTime();
    const ageHours = (currentTime - obsTime) / (1000 * 60 * 60);

    if (ageHours > maxAge) {
      pruned.push(obs);
    } else {
      kept.push(obs);
    }
  }

  // Rewrite the file with surviving observations only
  if (pruned.length > 0) {
    const filePath = getObservationsPath();
    const header =
      "# Observations\n\nPriority: red = important/keep until resolved, yellow = ~14 days, green = ~7 days\n\n";
    const lines = kept.map(formatObservation).join("\n");
    const content = header + (lines ? lines + "\n" : "");
    await writeFile(filePath, content, "utf-8");
  }

  return {
    pruned: pruned.length,
    kept: kept.length,
    prunedTexts: pruned.map((o) => `[${o.priority}] ${o.text}`),
  };
}

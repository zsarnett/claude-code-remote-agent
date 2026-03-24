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
      /^- \[(\d{4}-\d{2}-\d{2}T[\d:]+Z?)\]\s+\[(red|yellow|green)\]\s+(.+)$/
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

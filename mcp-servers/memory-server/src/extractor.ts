/**
 * Observation auto-extraction from free text.
 * Uses rule-based pattern matching to identify decisions, blockers,
 * preferences, patterns, and other notable items from session text.
 * Each extracted observation gets an auto-assigned priority and importance score.
 */

import type { ObservationPriority } from "./observations.js";

/** An extracted observation from text analysis. */
export interface ExtractedObservation {
  text: string;
  priority: ObservationPriority;
  importance: number;
  /** The rule that matched */
  rule: string;
}

/** A pattern rule for extraction. */
interface ExtractionRule {
  /** Rule name for tracing */
  name: string;
  /** Regex pattern to match against text */
  pattern: RegExp;
  /** Priority to assign */
  priority: ObservationPriority;
  /** Base importance score */
  importance: number;
  /** Optional transform to clean the extracted text */
  transform?: (match: RegExpMatchArray, fullSentence: string) => string;
}

/**
 * Extraction rules ordered by priority (highest first).
 * Each rule matches a pattern in text and assigns a priority + importance.
 */
const EXTRACTION_RULES: ExtractionRule[] = [
  // Decisions (high importance -- these are durable)
  {
    name: "decision",
    pattern: /\b(?:decided|decision|we(?:'ll| will) go with|chose|choosing|settled on|going with)\b/i,
    priority: "red",
    importance: 0.9,
  },
  // Blockers (high importance -- need resolution)
  {
    name: "blocker",
    pattern: /\b(?:blocked|blocker|stuck|can(?:'t|not) (?:proceed|continue|move forward)|waiting on|depends on|dependency)\b/i,
    priority: "red",
    importance: 0.85,
  },
  // Bugs and errors (high importance)
  {
    name: "bug",
    pattern: /\b(?:bug|error|crash|failure|broken|regression|fix(?:ed)?)\b/i,
    priority: "red",
    importance: 0.8,
  },
  // Preferences (medium importance -- inform future sessions)
  {
    name: "preference",
    pattern: /\b(?:prefer|preference|always use|never use|should always|should never|convention|standard)\b/i,
    priority: "yellow",
    importance: 0.7,
  },
  // Learned something (medium importance)
  {
    name: "learning",
    pattern: /\b(?:learned|discovered|found out|turns out|realized|TIL|note to self|important(?:ly)?)\b/i,
    priority: "yellow",
    importance: 0.65,
  },
  // Architecture or design choices (medium-high)
  {
    name: "architecture",
    pattern: /\b(?:architecture|design(?:ed)?|refactor(?:ed)?|pattern|approach|strategy|tradeoff|trade-off)\b/i,
    priority: "yellow",
    importance: 0.7,
  },
  // TODO / follow-up items
  {
    name: "todo",
    pattern: /\b(?:TODO|FIXME|HACK|follow[- ]up|need(?:s)? to|should (?:also |later )?(?:add|fix|update|change|refactor|implement))\b/i,
    priority: "yellow",
    importance: 0.6,
  },
  // Patterns noticed (lower importance)
  {
    name: "pattern",
    pattern: /\b(?:pattern|noticed|observation|trend|recurring|consistently|keep seeing)\b/i,
    priority: "green",
    importance: 0.5,
  },
  // Completed work (informational)
  {
    name: "completed",
    pattern: /\b(?:completed|finished|done|shipped|deployed|merged|released)\b/i,
    priority: "green",
    importance: 0.4,
  },
];

/**
 * Split text into sentences for analysis.
 * Handles common abbreviations and edge cases.
 */
export function splitSentences(text: string): string[] {
  // Replace common abbreviations that use periods
  const cleaned = text
    .replace(/\be\.g\./gi, "e_g_")
    .replace(/\bi\.e\./gi, "i_e_")
    .replace(/\betc\./gi, "etc_")
    .replace(/\bvs\./gi, "vs_")
    .replace(/\bdr\./gi, "dr_")
    .replace(/\bmr\./gi, "mr_")
    .replace(/\bms\./gi, "ms_");

  // Split on sentence boundaries
  const raw = cleaned.split(/(?<=[.!?])\s+|\n+/);

  // Restore abbreviations and clean up
  return raw
    .map((s) =>
      s
        .replace(/e_g_/gi, "e.g.")
        .replace(/i_e_/gi, "i.e.")
        .replace(/etc_/gi, "etc.")
        .replace(/vs_/gi, "vs.")
        .replace(/dr_/gi, "dr.")
        .replace(/mr_/gi, "mr.")
        .replace(/ms_/gi, "ms.")
        .trim()
    )
    .filter((s) => s.length >= 10); // Ignore very short fragments
}

/**
 * Extract observations from free text using rule-based pattern matching.
 * Scans each sentence against the extraction rules and returns matches.
 *
 * Deduplication: if the same sentence matches multiple rules, only the
 * highest-priority (highest importance) match is kept.
 */
export function extractObservations(text: string): ExtractedObservation[] {
  const sentences = splitSentences(text);
  const seen = new Map<string, ExtractedObservation>();

  for (const sentence of sentences) {
    for (const rule of EXTRACTION_RULES) {
      if (rule.pattern.test(sentence)) {
        const key = sentence.toLowerCase().trim();

        // Keep the highest-importance match for each sentence
        const existing = seen.get(key);
        if (!existing || rule.importance > existing.importance) {
          seen.set(key, {
            text: sentence,
            priority: rule.priority,
            importance: rule.importance,
            rule: rule.name,
          });
        }

        // Only match the first (highest priority) rule per sentence
        // since rules are ordered by priority
        break;
      }
    }
  }

  return Array.from(seen.values());
}

/**
 * Get the list of extraction rule names (for debugging/stats).
 */
export function getExtractionRuleNames(): string[] {
  return EXTRACTION_RULES.map((r) => r.name);
}

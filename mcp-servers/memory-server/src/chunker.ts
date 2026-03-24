/**
 * Markdown-aware chunking for vault file indexing.
 * Parses YAML frontmatter, splits on headers, and keeps chunks
 * under ~2000 characters (~500 tokens).
 */

const MAX_CHUNK_SIZE = 2000;

/**
 * Parse YAML frontmatter from markdown content.
 * Frontmatter is delimited by --- at the start of the file.
 * Returns the frontmatter key-value pairs and the remaining body.
 */
export function parseFrontmatter(
  content: string
): { frontmatter: Record<string, string>; body: string } {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmBlock = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();

  const frontmatter: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();

    // Strip surrounding quotes if present
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

interface Section {
  header: string;
  level: number;
  content: string;
}

/**
 * Split markdown body into sections based on ## and ### headers.
 */
function splitOnHeaders(body: string): Section[] {
  const lines = body.split("\n");
  const sections: Section[] = [];
  let currentHeader = "";
  let currentLevel = 0;
  let currentContent: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^## (.+)/);
    const h3Match = line.match(/^### (.+)/);

    if (h2Match || h3Match) {
      // Flush previous section
      if (currentContent.length > 0 || currentHeader) {
        sections.push({
          header: currentHeader,
          level: currentLevel,
          content: currentContent.join("\n").trim(),
        });
      }

      if (h2Match) {
        currentHeader = h2Match[1].trim();
        currentLevel = 2;
      } else if (h3Match) {
        currentHeader = h3Match[1].trim();
        currentLevel = 3;
      }
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  // Flush last section
  if (currentContent.length > 0 || currentHeader) {
    sections.push({
      header: currentHeader,
      level: currentLevel,
      content: currentContent.join("\n").trim(),
    });
  }

  return sections;
}

/**
 * Split a long text into sub-chunks of at most MAX_CHUNK_SIZE characters,
 * breaking at paragraph boundaries where possible.
 */
function splitLongText(text: string): string[] {
  if (text.length <= MAX_CHUNK_SIZE) {
    return [text];
  }

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > MAX_CHUNK_SIZE) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }

      // If a single paragraph exceeds MAX_CHUNK_SIZE, hard split it
      if (para.length > MAX_CHUNK_SIZE) {
        let remaining = para;
        while (remaining.length > MAX_CHUNK_SIZE) {
          chunks.push(remaining.slice(0, MAX_CHUNK_SIZE));
          remaining = remaining.slice(MAX_CHUNK_SIZE);
        }
        if (remaining) {
          current = remaining;
        }
      } else {
        current = para;
      }
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Chunk a markdown file into indexable pieces.
 * Returns an array of chunks with text content and metadata.
 *
 * For small files (< MAX_CHUNK_SIZE), returns a single chunk.
 * For larger files, splits on ## and ### headers, keeping each
 * chunk under MAX_CHUNK_SIZE.
 */
export function chunkMarkdown(
  content: string,
  filePath: string
): Array<{ text: string; metadata: Record<string, string> }> {
  const { frontmatter, body } = parseFrontmatter(content);

  const baseMetadata: Record<string, string> = {
    ...frontmatter,
    source_path: filePath,
  };

  // Small files: return a single chunk
  if (content.length < MAX_CHUNK_SIZE) {
    return [
      {
        text: body || content,
        metadata: { ...baseMetadata, chunk_index: "0" },
      },
    ];
  }

  const sections = splitOnHeaders(body);
  const chunks: Array<{ text: string; metadata: Record<string, string> }> = [];
  let chunkIndex = 0;

  // Track parent h2 header for providing context to h3 chunks
  let parentH2Header = "";

  for (const section of sections) {
    if (section.level === 2) {
      parentH2Header = section.header;
    }

    // Build the text for this section
    let sectionText = "";
    if (section.header) {
      // Prepend parent header for h3 sections
      if (section.level === 3 && parentH2Header) {
        sectionText = `## ${parentH2Header}\n### ${section.header}\n\n${section.content}`;
      } else {
        const prefix = "#".repeat(section.level || 2);
        sectionText = `${prefix} ${section.header}\n\n${section.content}`;
      }
    } else {
      sectionText = section.content;
    }

    // Split if the section itself is too long
    const subChunks = splitLongText(sectionText);

    for (const text of subChunks) {
      if (!text.trim()) continue;

      chunks.push({
        text,
        metadata: {
          ...baseMetadata,
          chunk_index: String(chunkIndex),
          ...(section.header ? { section_header: section.header } : {}),
        },
      });
      chunkIndex++;
    }
  }

  // If no chunks were produced (empty file), return at least one
  if (chunks.length === 0) {
    return [
      {
        text: body || content,
        metadata: { ...baseMetadata, chunk_index: "0" },
      },
    ];
  }

  return chunks;
}

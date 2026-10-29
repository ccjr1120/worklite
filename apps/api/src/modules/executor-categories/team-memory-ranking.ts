// Lexical executor-memory ranking shared by the projection prompt and the role memory
// tools. It intentionally stays deterministic and dependency-free: no embeddings,
// no model calls, and the same input always ranks the same way.

export type RankableTeamMemory = {
  id: string;
  repositoryId: string | null;
  role?: string | null;
  content: string;
  updatedAt?: Date | string | null;
};

export type MemoryRepositoryName = { memoryRepositoryId: string; name: string };

export const TEAM_MEMORY_INDEX_ENTRIES = 15;
export const TEAM_MEMORY_INDEX_CHARS = 1500;
export const TEAM_MEMORY_TITLE_CHARS = 100;

const ASCII_TOKEN = /[a-z0-9]+/g;
const CJK_RUN = /[㐀-鿿]+/g;

/**
 * One-line memory title: the first non-empty line with list/heading markers removed.
 * The index never carries full content; roles read it with team_memory_read.
 */
export function memoryTitle(content: string): string {
  const line = content.split('\n').map((value) => value.trim()).find(Boolean) ?? '';
  const title = line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return title.length > TEAM_MEMORY_TITLE_CHARS ? `${title.slice(0, TEAM_MEMORY_TITLE_CHARS - 1)}…` : title;
}

/**
 * Basic lexical tokens. Latin words are used whole; CJK runs contribute the run
 * itself plus overlapping bigrams so a short goal still matches related memories.
 */
export function memoryQueryTokens(text: string | undefined): string[] {
  const lowered = (text ?? '').toLowerCase();
  if (!lowered.trim()) return [];
  const tokens = new Set<string>();
  for (const word of lowered.match(ASCII_TOKEN) ?? []) {
    if (word.length >= 2) tokens.add(word);
  }
  for (const run of lowered.match(CJK_RUN) ?? []) {
    if (run.length <= 4) tokens.add(run);
    for (let index = 0; index + 2 <= run.length; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return [...tokens];
}

export type RankedTeamMemory<T extends RankableTeamMemory> = T & { score: number; title: string };

/**
 * Ranks memories by lexical overlap with the Run goal and the scoped repository
 * names. Memories that match nothing keep their captured order (newest first).
 */
export function rankTeamMemories<T extends RankableTeamMemory>(
  memories: readonly T[],
  options: { goal?: string; repositories?: readonly MemoryRepositoryName[]; query?: string } = {},
): Array<RankedTeamMemory<T>> {
  const repositoryNames = new Map((options.repositories ?? []).map((repository) => [repository.memoryRepositoryId, repository.name]));
  const tokens = memoryQueryTokens([options.goal, options.query, ...repositoryNames.values()].filter(Boolean).join(' '));
  const ranked = memories.map((memory, index) => {
    const title = memoryTitle(memory.content);
    const loweredContent = memory.content.toLowerCase();
    const loweredTitle = title.toLowerCase();
    const repositoryName = memory.repositoryId ? repositoryNames.get(memory.repositoryId)?.toLowerCase() : undefined;
    let score = 0;
    for (const token of tokens) {
      if (loweredTitle.includes(token)) score += 4;
      const occurrences = countOccurrences(loweredContent, token);
      if (occurrences > 0) score += Math.min(occurrences, 4);
      if (repositoryName && repositoryName.includes(token)) score += 2;
    }
    return { memory, index, score, title };
  });
  return ranked
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ memory, score, title }) => ({ ...memory, score, title }));
}

/**
 * A bounded index handed to every v11 role that is not the initially addressed
 * one: entry count plus one-line titles, never full content.
 */
export function buildTeamMemoryIndex(
  memories: readonly RankableTeamMemory[],
  options: { goal?: string; repositories?: readonly MemoryRepositoryName[] } = {},
): string[] {
  const lines: string[] = [];
  let total = 0;
  const ranked = rankTeamMemories(memories.filter((memory) => !memory.role), options);
  for (const memory of ranked) {
    if (lines.length >= TEAM_MEMORY_INDEX_ENTRIES) break;
    const repositoryName = memory.repositoryId
      ? options.repositories?.find((repository) => repository.memoryRepositoryId === memory.repositoryId)?.name
      : undefined;
    const title = memory.title || memory.id;
    const line = `- ${repositoryName ? `[${repositoryName}] ` : '[executor] '}${title}`;
    if (total + line.length > TEAM_MEMORY_INDEX_CHARS) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

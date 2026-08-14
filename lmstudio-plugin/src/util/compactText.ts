export interface CompactionMetadata {
  strategy: string;
  maxChars: number;
  originalLength: number;
  outputLength: number;
  omittedChars: number;
}

export interface TextCompactionResult {
  text: string;
  compacted: boolean;
  compaction?: CompactionMetadata;
}

export interface TextCompactionOptions {
  maxChars: number;
  label?: string;
  hardCap?: number;
}

const DEFAULT_HARD_CAP = 50_000;
const MIN_LIMIT = 1_000;

export function normalizeTextLimit(
  value: unknown,
  fallback: number,
  hardCap: number = DEFAULT_HARD_CAP,
): number {
  const n = Number(value);
  const base = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.max(MIN_LIMIT, Math.min(Math.floor(base), hardCap));
}

function takeStart(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const chunk = text.slice(0, maxChars);
  const cuts = [
    chunk.lastIndexOf("\n\n"),
    chunk.lastIndexOf(". "),
    chunk.lastIndexOf("\n"),
    chunk.lastIndexOf(" "),
  ].filter((n) => n > maxChars * 0.55);
  const cut = cuts.length ? Math.max(...cuts) : -1;
  return cut > 0 ? chunk.slice(0, cut + 1) : chunk;
}

function takeEnd(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const chunk = text.slice(text.length - maxChars);
  const candidates = ["\n\n", ". ", "\n", " "]
    .map((needle) => chunk.indexOf(needle))
    .filter((n) => n >= 0 && n < maxChars * 0.45);
  const cut = candidates.length ? Math.min(...candidates) : -1;
  return cut >= 0 ? chunk.slice(cut + 1) : chunk;
}

function splitPassages(text: string): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 60);

  if (paragraphs.length > 1) return paragraphs;

  return text
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length >= 60);
}

function scorePassage(text: string, index: number): number {
  const len = text.length;
  let score = 0;
  if (len >= 120 && len <= 900) score += 8;
  if (/^\s*(#{1,6}\s+|[A-Z][^.!?]{8,90}$)/.test(text)) score += 5;
  if (/\b(\d{4}|\d+(?:\.\d+)?%|\$\d+|v?\d+\.\d+)\b/.test(text)) score += 4;
  if (/https?:\/\/|www\.|@[\w.-]+/.test(text)) score += 3;
  if (/\b(summary|result|important|warning|error|limit|pricing|install|usage|version|release|security|privacy|context|token)\b/i.test(text)) {
    score += 3;
  }
  score += Math.min(len, 600) / 300;
  return score - index * 0.01;
}

function selectMiddlePassages(text: string, maxChars: number): string {
  if (maxChars < 200 || !text.trim()) return "";

  const passages = splitPassages(text);
  if (!passages.length) return takeStart(text.trim(), maxChars);

  const ranked = passages
    .map((text, index) => ({ text, index, score: scorePassage(text, index) }))
    .sort((a, b) => b.score - a.score);

  const picked: Array<{ text: string; index: number }> = [];
  let used = 0;
  for (const p of ranked) {
    const addition = p.text.length + (picked.length ? 2 : 0);
    if (used + addition > maxChars) continue;
    picked.push({ text: p.text, index: p.index });
    used += addition;
    if (used >= maxChars * 0.85) break;
  }

  if (!picked.length) return takeStart(passages[0] || text.trim(), maxChars);

  return picked
    .sort((a, b) => a.index - b.index)
    .map((p) => p.text)
    .join("\n\n");
}

function fitHeadTail(text: string, prefix: string, maxChars: number): string {
  const marker = "\n\n[...content omitted...]\n\n";
  const budget = Math.max(200, maxChars - prefix.length - marker.length);
  const headBudget = Math.max(100, Math.floor(budget * 0.65));
  const tailBudget = Math.max(80, budget - headBudget);
  const out = prefix + takeStart(text, headBudget).trimEnd() + marker + takeEnd(text, tailBudget).trimStart();
  return out.length <= maxChars ? out : out.slice(0, maxChars);
}

export function compactText(input: string, options: TextCompactionOptions): TextCompactionResult {
  const originalLength = input.length;
  const maxChars = normalizeTextLimit(options.maxChars, options.maxChars, options.hardCap);
  if (originalLength <= maxChars) {
    return { text: input, compacted: false };
  }

  const label = options.label || "content";
  const prefix = `[${label} compacted for context: ${originalLength} chars -> <=${maxChars} chars.]\n\n`;
  const separator = "\n\n[...earlier content omitted...]\n\n";
  const middleHeader = "\n\n[Key middle passages]\n";
  const tailSeparator = "\n\n[...later content omitted...]\n\n";
  const contentBudget = Math.max(
    300,
    maxChars - prefix.length - separator.length - middleHeader.length - tailSeparator.length,
  );
  const headBudget = Math.max(250, Math.floor(contentBudget * 0.45));
  const tailBudget = Math.max(180, Math.floor(contentBudget * 0.2));
  const middleBudget = Math.max(0, contentBudget - headBudget - tailBudget);

  const head = takeStart(input, headBudget).trimEnd();
  const tail = takeEnd(input, tailBudget).trimStart();
  const middleStart = Math.min(head.length, input.length);
  const middleEnd = Math.max(middleStart, input.length - tail.length);
  const middle = selectMiddlePassages(input.slice(middleStart, middleEnd), middleBudget);

  let output = prefix + head + separator;
  if (middle) output += middleHeader + middle + tailSeparator;
  output += tail;

  if (output.length > maxChars) output = fitHeadTail(input, prefix, maxChars);

  return {
    text: output,
    compacted: true,
    compaction: {
      strategy: middle ? "extractive-head-middle-tail" : "head-tail",
      maxChars,
      originalLength,
      outputLength: output.length,
      omittedChars: Math.max(0, originalLength - output.length),
    },
  };
}

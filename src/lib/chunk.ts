/**
 * Split a markdown brief into overlapping windows for embedding. Paragraph
 * boundaries are preferred so a chunk stays semantically whole; the overlap
 * keeps a fact that straddles a boundary retrievable from either side.
 */
export function chunkMarkdown(
  markdown: string,
  { size = 1200, overlap = 150 }: { size?: number; overlap?: number } = {}
): string[] {
  const normalized = markdown.replace(/\r/g, "").trim();
  if (!normalized) return [];
  if (normalized.length <= size) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = trimmed.length > overlap ? trimmed.slice(-overlap) : trimmed;
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > size) {
      flush();
      for (let i = 0; i < paragraph.length; i += size - overlap) {
        chunks.push(paragraph.slice(i, i + size).trim());
      }
      current = "";
      continue;
    }
    if (current && current.length + paragraph.length + 2 > size) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }

  const tail = current.trim();
  if (tail && tail !== chunks[chunks.length - 1]) chunks.push(tail);

  return chunks.filter((c) => c.length > 0);
}

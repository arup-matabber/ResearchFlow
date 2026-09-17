import { dot } from "./inference";
import type { MemoryChunk, MemoryHit } from "../types";

/**
 * Long-term memory sits behind this interface so the backing store is a
 * deployment decision rather than an application one.
 */
export interface MemoryStore {
  upsert(chunks: MemoryChunk[]): Promise<void>;
  search(queryEmbedding: number[], topK: number): Promise<MemoryHit[]>;
}

type SqlFn = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => T[];

/** Guard against an unbounded scan if the archive grows past demo scale. */
const MAX_SCANNED_CHUNKS = 2000;

/**
 * Default store: embeddings live as BLOBs in the Durable Object's own SQLite,
 * beside the conversation they came from, and similarity is computed in JS.
 *
 * At this corpus size the scan is exact and effectively instant, and it means
 * the repository clones and runs with no resource provisioning at all. See
 * `VectorizeStore` for the swap that matters once the archive outgrows it.
 */
export class SqliteVectorStore implements MemoryStore {
  private readonly sql: SqlFn;

  constructor(sql: SqlFn) {
    this.sql = sql;
  }

  async upsert(chunks: MemoryChunk[]): Promise<void> {
    for (const chunk of chunks) {
      const blob = new Float32Array(chunk.embedding).buffer;
      this.sql`
        INSERT INTO brief_chunks (brief_id, topic, text, embedding)
        VALUES (${chunk.briefId}, ${chunk.topic}, ${chunk.text}, ${blob})
      `;
    }
  }

  async search(queryEmbedding: number[], topK: number): Promise<MemoryHit[]> {
    const rows = this.sql<{
      brief_id: string;
      topic: string;
      text: string;
      embedding: ArrayBuffer;
    }>`
      SELECT brief_id, topic, text, embedding
      FROM brief_chunks
      ORDER BY rowid DESC
      LIMIT ${MAX_SCANNED_CHUNKS}
    `;

    return rows
      .map((row) => ({
        briefId: row.brief_id,
        topic: row.topic,
        text: row.text,
        score: dot(queryEmbedding, Array.from(new Float32Array(row.embedding)))
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

/**
 * Structural shape of a Vectorize binding, declared locally so this file
 * compiles whether or not an index is configured.
 */
interface VectorizeLike {
  upsert(
    vectors: {
      id: string;
      values: number[];
      metadata?: Record<string, string>;
    }[]
  ): Promise<unknown>;
  query(
    vector: number[],
    options: { topK: number; returnMetadata?: string | boolean }
  ): Promise<{
    matches: { id: string; score: number; metadata?: Record<string, string> }[];
  }>;
}

/**
 * Drop-in replacement for `SqliteVectorStore` once the archive outgrows an
 * exact scan. Enabling it is a binding in `wrangler.jsonc` plus one line in the
 * agent — no caller changes. See README, "Swapping in Vectorize".
 */
export class VectorizeStore implements MemoryStore {
  #index: VectorizeLike;

  constructor(index: VectorizeLike) {
    this.#index = index;
  }

  async upsert(chunks: MemoryChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.#index.upsert(
      chunks.map((chunk, i) => ({
        id: `${chunk.briefId}:${i}`,
        values: chunk.embedding,
        metadata: {
          briefId: chunk.briefId,
          topic: chunk.topic,
          // Vectorize caps metadata at 10 KiB per vector.
          text: chunk.text.slice(0, 4000)
        }
      }))
    );
  }

  async search(queryEmbedding: number[], topK: number): Promise<MemoryHit[]> {
    const { matches } = await this.#index.query(queryEmbedding, {
      topK,
      returnMetadata: "all"
    });

    return matches.map((match) => ({
      briefId: match.metadata?.briefId ?? match.id,
      topic: match.metadata?.topic ?? "",
      text: match.metadata?.text ?? "",
      score: match.score
    }));
  }
}

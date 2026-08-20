import { createHash } from "node:crypto";
import OpenAI from "openai";
import { pool } from "@workspace/db";
import { logger } from "../../lib/logger.js";
import { JARVIS_SOURCE_DOCUMENTS } from "./jarvisSourceCorpus.js";
import type { JarvisKnowledgeChunk, JarvisRagHit, JarvisSourceDocument } from "./jarvisSourceTypes.js";

const PROXY_BASE_URL = process.env.PROXY_API_BASE_URL || "https://api.proxyapi.ru/openai/v1";
const EMBEDDING_MODEL = process.env.JARVIS_EMBEDDING_MODEL || "text-embedding-3-small";
const AI_ENABLED = process.env.AI_ENABLED !== "false";
const EMBEDDING_DIMENSIONS = 1536;
const CHUNK_TARGET = 1250;
const CHUNK_MAX = 1850;
const CHUNK_OVERLAP_PARAGRAPHS = 1;

let initialized = false;
let vectorReady = false;
let embeddingClient: OpenAI | null = null;
let warmingPromise: Promise<void> | null = null;

function getEmbeddingClient(): OpenAI | null {
  if (!AI_ENABLED) return null;
  const key = process.env.PROXY_API_KEY || process.env.PROXY_API_TOKEN;
  if (!key) return null;
  if (!embeddingClient) embeddingClient = new OpenAI({ apiKey: key, baseURL: PROXY_BASE_URL });
  return embeddingClient;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeParagraphs(content: string): string[] {
  return content
    .replace(/\r/g, "")
    .split(/\n+/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

function looksLikeHeading(value: string): boolean {
  if (value.length > 150) return false;
  return /^(?:\d+[.)]?\s+|шаг\s+\d+|день\s+\d+|ошибка\s*\d*|тип\s+\d+|итог|вывод|главная мысль|назначение|домашняя работа|мини-чеклист|follow-up|структура|что важно|что делать|как |почему |когда |рабочая схема|правильный вопрос|подготовка)/iu.test(value);
}

function slugPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/giu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "chunk";
}

export function chunkSourceDocument(doc: JarvisSourceDocument): JarvisKnowledgeChunk[] {
  const paragraphs = normalizeParagraphs(doc.content);
  const chunks: JarvisKnowledgeChunk[] = [];
  let buffer: string[] = [];
  let heading = doc.title;
  let currentLength = 0;

  const flush = () => {
    if (!buffer.length) return;
    const text = buffer.join("\n").trim();
    if (text.length >= 100) {
      const index = chunks.length + 1;
      chunks.push({
        id: `${doc.id}:${index}:${slugPart(heading)}`,
        documentId: doc.id,
        source: doc.source,
        title: doc.title,
        heading,
        sourceType: doc.sourceType,
        authority: doc.authority,
        verified: doc.verified,
        riskLevel: doc.riskLevel,
        content: text,
      });
    }
    const overlap = buffer.slice(-CHUNK_OVERLAP_PARAGRAPHS);
    buffer = overlap;
    currentLength = overlap.reduce((sum, item) => sum + item.length + 1, 0);
  };

  for (const paragraph of paragraphs) {
    if (looksLikeHeading(paragraph)) {
      if (currentLength >= 500) flush();
      heading = paragraph;
    }

    const projected = currentLength + paragraph.length + 1;
    if (buffer.length && projected > CHUNK_MAX) flush();
    buffer.push(paragraph);
    currentLength += paragraph.length + 1;

    if (currentLength >= CHUNK_TARGET && /[.!?»:)]$/u.test(paragraph)) flush();
  }
  flush();

  return chunks;
}

async function ensureBaseSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jarvis_knowledge_documents (
      id TEXT PRIMARY KEY,
      source_name TEXT NOT NULL,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL,
      authority INTEGER NOT NULL,
      verified BOOLEAN NOT NULL,
      risk_level TEXT NOT NULL,
      checksum TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS jarvis_knowledge_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES jarvis_knowledge_documents(id) ON DELETE CASCADE,
      source_name TEXT NOT NULL,
      title TEXT NOT NULL,
      heading TEXT NOT NULL,
      source_type TEXT NOT NULL,
      authority INTEGER NOT NULL,
      verified BOOLEAN NOT NULL,
      risk_level TEXT NOT NULL,
      content TEXT NOT NULL,
      checksum TEXT NOT NULL,
      search_vector TSVECTOR GENERATED ALWAYS AS (
        to_tsvector('russian', coalesce(title, '') || ' ' || coalesce(heading, '') || ' ' || coalesce(content, ''))
      ) STORED,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS jarvis_knowledge_chunks_fts_idx
    ON jarvis_knowledge_chunks USING GIN(search_vector)
  `);

  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await pool.query(`
      ALTER TABLE jarvis_knowledge_chunks
      ADD COLUMN IF NOT EXISTS embedding vector(${EMBEDDING_DIMENSIONS})
    `);
    vectorReady = true;
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS jarvis_knowledge_chunks_embedding_hnsw_idx
        ON jarvis_knowledge_chunks USING hnsw (embedding vector_cosine_ops)
      `);
    } catch (err) {
      logger.warn({ err }, "Jarvis RAG HNSW index unavailable; vector scan will still work");
    }
  } catch (err) {
    vectorReady = false;
    logger.warn({ err }, "pgvector unavailable; Jarvis RAG will use lexical retrieval until vector is available");
  }
}

async function seedSourceDocument(doc: JarvisSourceDocument): Promise<number> {
  const documentChecksum = sha256(JSON.stringify({
    title: doc.title,
    sourceType: doc.sourceType,
    authority: doc.authority,
    verified: doc.verified,
    riskLevel: doc.riskLevel,
    content: doc.content,
  }));

  await pool.query(
    `INSERT INTO jarvis_knowledge_documents
      (id, source_name, title, source_type, authority, verified, risk_level, checksum, active, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,NOW())
     ON CONFLICT (id) DO UPDATE SET
       source_name = EXCLUDED.source_name,
       title = EXCLUDED.title,
       source_type = EXCLUDED.source_type,
       authority = EXCLUDED.authority,
       verified = EXCLUDED.verified,
       risk_level = EXCLUDED.risk_level,
       checksum = EXCLUDED.checksum,
       active = TRUE,
       updated_at = NOW()`,
    [doc.id, doc.source, doc.title, doc.sourceType, doc.authority, doc.verified, doc.riskLevel, documentChecksum],
  );

  const chunks = chunkSourceDocument(doc);
  const liveIds: string[] = [];
  for (const chunk of chunks) {
    liveIds.push(chunk.id);
    const checksum = sha256(chunk.content);
    const existing = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM jarvis_knowledge_chunks WHERE id = $1`,
      [chunk.id],
    );
    const unchanged = existing.rows[0]?.checksum === checksum;

    if (vectorReady) {
      await pool.query(
        `INSERT INTO jarvis_knowledge_chunks
          (id, document_id, source_name, title, heading, source_type, authority, verified, risk_level, content, checksum, embedding, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,NOW())
         ON CONFLICT (id) DO UPDATE SET
           document_id = EXCLUDED.document_id,
           source_name = EXCLUDED.source_name,
           title = EXCLUDED.title,
           heading = EXCLUDED.heading,
           source_type = EXCLUDED.source_type,
           authority = EXCLUDED.authority,
           verified = EXCLUDED.verified,
           risk_level = EXCLUDED.risk_level,
           content = EXCLUDED.content,
           checksum = EXCLUDED.checksum,
           embedding = CASE WHEN jarvis_knowledge_chunks.checksum = EXCLUDED.checksum
                            THEN jarvis_knowledge_chunks.embedding ELSE NULL END,
           updated_at = NOW()`,
        [chunk.id, chunk.documentId, chunk.source, chunk.title, chunk.heading, chunk.sourceType, chunk.authority, chunk.verified, chunk.riskLevel, chunk.content, checksum],
      );
    } else {
      await pool.query(
        `INSERT INTO jarvis_knowledge_chunks
          (id, document_id, source_name, title, heading, source_type, authority, verified, risk_level, content, checksum, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (id) DO UPDATE SET
           document_id = EXCLUDED.document_id,
           source_name = EXCLUDED.source_name,
           title = EXCLUDED.title,
           heading = EXCLUDED.heading,
           source_type = EXCLUDED.source_type,
           authority = EXCLUDED.authority,
           verified = EXCLUDED.verified,
           risk_level = EXCLUDED.risk_level,
           content = EXCLUDED.content,
           checksum = EXCLUDED.checksum,
           updated_at = NOW()`,
        [chunk.id, chunk.documentId, chunk.source, chunk.title, chunk.heading, chunk.sourceType, chunk.authority, chunk.verified, chunk.riskLevel, chunk.content, checksum],
      );
    }

    if (unchanged) continue;
  }

  if (liveIds.length) {
    await pool.query(
      `DELETE FROM jarvis_knowledge_chunks
       WHERE document_id = $1 AND NOT (id = ANY($2::text[]))`,
      [doc.id, liveIds],
    );
  }
  return chunks.length;
}

async function seedCorpus(): Promise<void> {
  let chunks = 0;
  for (const doc of JARVIS_SOURCE_DOCUMENTS) {
    chunks += await seedSourceDocument(doc);
  }

  const ids = JARVIS_SOURCE_DOCUMENTS.map((doc) => doc.id);
  if (ids.length) {
    await pool.query(
      `UPDATE jarvis_knowledge_documents SET active = FALSE, updated_at = NOW()
       WHERE NOT (id = ANY($1::text[]))`,
      [ids],
    );
  }
  logger.info({ documents: JARVIS_SOURCE_DOCUMENTS.length, chunks, vectorReady }, "Jarvis RAG corpus seeded");
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const client = getEmbeddingClient();
  if (!client) throw new Error("Embedding API is not configured");
  const result = await client.embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  return result.data.map((item) => item.embedding);
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export async function warmJarvisEmbeddings(): Promise<void> {
  if (!vectorReady || !getEmbeddingClient()) return;
  if (warmingPromise) return warmingPromise;

  warmingPromise = (async () => {
    try {
      while (true) {
        const result = await pool.query<{ id: string; title: string; heading: string; content: string }>(
          `SELECT id, title, heading, content
           FROM jarvis_knowledge_chunks
           WHERE embedding IS NULL
           ORDER BY authority DESC, id ASC
           LIMIT 32`,
        );
        if (!result.rows.length) break;

        const inputs = result.rows.map((row) => `${row.title}\n${row.heading}\n${row.content}`.slice(0, 7000));
        const vectors = await embedTexts(inputs);
        for (let index = 0; index < result.rows.length; index += 1) {
          const vector = vectors[index];
          if (!vector?.length) continue;
          await pool.query(
            `UPDATE jarvis_knowledge_chunks SET embedding = $2::vector, updated_at = NOW() WHERE id = $1`,
            [result.rows[index].id, vectorLiteral(vector)],
          );
        }
      }
      logger.info("Jarvis RAG embeddings are warm");
    } catch (err) {
      logger.error({ err, model: EMBEDDING_MODEL }, "Jarvis RAG embedding warmup failed; lexical search remains active");
    }
  })().finally(() => {
    warmingPromise = null;
  });

  return warmingPromise;
}

export async function initJarvisRag(): Promise<void> {
  if (initialized) return;
  await ensureBaseSchema();
  await seedCorpus();
  initialized = true;
  void warmJarvisEmbeddings();
}

type DbHit = {
  id: string;
  document_id: string;
  source_name: string;
  title: string;
  heading: string;
  source_type: string;
  authority: number;
  verified: boolean;
  risk_level: string;
  content: string;
  score: number;
};

function dbHitToKnowledge(row: DbHit): JarvisKnowledgeChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    source: row.source_name,
    title: row.title,
    heading: row.heading,
    sourceType: row.source_type,
    authority: row.authority,
    verified: row.verified,
    riskLevel: row.risk_level,
    content: row.content,
  };
}

async function lexicalSearch(query: string, limit = 18): Promise<DbHit[]> {
  const result = await pool.query<DbHit>(
    `SELECT c.id, c.document_id, c.source_name, c.title, c.heading, c.source_type,
            c.authority, c.verified, c.risk_level, c.content,
            ts_rank_cd(c.search_vector, plainto_tsquery('russian', $1))::float8 AS score
     FROM jarvis_knowledge_chunks c
     JOIN jarvis_knowledge_documents d ON d.id = c.document_id
     WHERE d.active = TRUE
       AND c.search_vector @@ plainto_tsquery('russian', $1)
     ORDER BY score DESC, c.authority DESC
     LIMIT $2`,
    [query.slice(0, 2000), limit],
  );
  return result.rows;
}

async function semanticSearch(query: string, limit = 18): Promise<DbHit[]> {
  if (!vectorReady || !getEmbeddingClient()) return [];
  try {
    const [embedding] = await embedTexts([query.slice(0, 7000)]);
    if (!embedding?.length) return [];
    const result = await pool.query<DbHit>(
      `SELECT c.id, c.document_id, c.source_name, c.title, c.heading, c.source_type,
              c.authority, c.verified, c.risk_level, c.content,
              (1 - (c.embedding <=> $1::vector))::float8 AS score
       FROM jarvis_knowledge_chunks c
       JOIN jarvis_knowledge_documents d ON d.id = c.document_id
       WHERE d.active = TRUE AND c.embedding IS NOT NULL
       ORDER BY c.embedding <=> $1::vector
       LIMIT $2`,
      [vectorLiteral(embedding), limit],
    );
    return result.rows;
  } catch (err) {
    logger.warn({ err }, "Jarvis semantic retrieval failed; using lexical retrieval only");
    return [];
  }
}

function authorityBoost(authority: number, verified: boolean, sourceType: string): number {
  let score = Math.max(0, Math.min(100, authority)) / 1000;
  if (verified) score += 0.025;
  if (sourceType === "methodology") score += 0.03;
  if (sourceType === "examples") score -= 0.02;
  return score;
}

export async function retrieveJarvisRag(query: string, limit = 8): Promise<JarvisRagHit[]> {
  await initJarvisRag();
  const [lexical, semantic] = await Promise.all([
    lexicalSearch(query),
    semanticSearch(query),
  ]);

  const merged = new Map<string, JarvisRagHit>();
  const add = (row: DbHit, rank: number, kind: "lexical" | "semantic") => {
    const base = dbHitToKnowledge(row);
    const existing = merged.get(row.id) || {
      ...base,
      lexicalScore: 0,
      semanticScore: 0,
      fusedScore: authorityBoost(base.authority, base.verified, base.sourceType),
    };
    if (kind === "lexical") existing.lexicalScore = row.score || 0;
    else existing.semanticScore = row.score || 0;
    existing.fusedScore += 1 / (60 + rank + 1);
    if (kind === "semantic") existing.fusedScore += Math.max(0, row.score || 0) * 0.025;
    if (kind === "lexical") existing.fusedScore += Math.max(0, row.score || 0) * 0.02;
    merged.set(row.id, existing);
  };

  lexical.forEach((row, rank) => add(row, rank, "lexical"));
  semantic.forEach((row, rank) => add(row, rank, "semantic"));

  return [...merged.values()]
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .slice(0, limit);
}

export function renderRagContext(hits: JarvisRagHit[]): string {
  if (!hits.length) return "Подходящих подтверждённых фрагментов базы не найдено.";
  return hits.map((hit, index) => {
    const trust = `${hit.sourceType}; authority=${hit.authority}; verified=${hit.verified}; risk=${hit.riskLevel}`;
    return `SOURCE ${index + 1} [${hit.id}]\nДокумент: ${hit.title}\nРаздел: ${hit.heading}\nФайл: ${hit.source}\nМетаданные: ${trust}\n${hit.content}`;
  }).join("\n\n---\n\n");
}

export function isVectorRagReady(): boolean {
  return vectorReady;
}

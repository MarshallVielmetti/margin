import { z } from "zod";

// AI cards and source locators are guidance. Only source/vault reads register
// evidence; loading preparation never claims to have inspected its sources.
export function createKnowledgeTools({ knowledge, sourceIds }) {
  const tool = (name, description, schema, execute) => ({
    name,
    description,
    schema,
    execute: async (args, context = {}) => {
      context.signal?.throwIfAborted();
      const input = schema.parse(args);
      await knowledge.refresh();
      context.signal?.throwIfAborted();
      return execute(input);
    },
  });
  const identity = z
    .string()
    .regex(/^kn_[a-zA-Z0-9_-]+$/)
    .max(100);
  return [
    tool(
      "knowledge.search",
      "Discover retained knowledge skills across the configured vault/library, including preparation from other sessions. Descriptions, coverage, and freshness are discovery only. Direct vault search remains available for unlinked notes.",
      z
        .object({
          query: z.string().trim().min(1).max(1200),
          limit: z.number().int().min(1).max(20).default(8),
        })
        .strict(),
      ({ query, limit }) => knowledge.search(query, { limit, sourceIds }),
    ),
    tool(
      "knowledge.load",
      "Progressively load a skill overview or one meaningful unit. AI guidance is unverified; stale prose is withheld. Source pointers do not count as inspected evidence; read the named source/note before citing it.",
      z
        .object({
          entityId: identity,
          unitId: z.string().max(100).optional(),
          maxChars: z.number().int().min(200).max(10000).default(4000),
        })
        .strict(),
      (input) => knowledge.load(input.entityId, { ...input, sourceIds }),
    ),
    tool(
      "knowledge.children",
      "Traverse explicit note/MOC routes under depth, fan-out, node and character limits. Cycles terminate; ambiguous links remain unresolved. Parent loading never loads descendant prose. Use knowledge.connections for separate AI proposals.",
      z
        .object({
          entityId: identity,
          query: z.string().max(1200).default(""),
          depth: z.number().int().min(1).max(3).default(1),
          fanOut: z.number().int().min(1).max(12).default(6),
          maxNodes: z.number().int().min(1).max(30).default(20),
          maxChars: z.number().int().min(500).max(10000).default(6000),
        })
        .strict(),
      (input) => knowledge.children(input.entityId, { ...input, sourceIds }),
    ),
    tool(
      "knowledge.connections",
      "Load bounded persistent cross-paper/note comparison proposals and human corrections or rejections. Acceptance does not verify mathematics. Inspect evidence on both sides before applying a relation, and respect retained corrections.",
      z
        .object({
          entityId: identity,
          limit: z.number().int().min(1).max(8).default(4),
        })
        .strict(),
      (input) => knowledge.connections(input.entityId, { ...input, sourceIds }),
    ),
  ];
}

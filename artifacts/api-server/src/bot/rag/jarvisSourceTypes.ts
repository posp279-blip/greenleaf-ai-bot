export type JarvisSourceDocument = {
  id: string;
  source: string;
  title: string;
  sourceType: "methodology" | "examples" | "company_fact" | "product_catalog" | "reference" | string;
  authority: number;
  verified: boolean;
  riskLevel: "low" | "medium" | "high" | string;
  content: string;
};

export type JarvisKnowledgeChunk = {
  id: string;
  documentId: string;
  source: string;
  title: string;
  heading: string;
  sourceType: string;
  authority: number;
  verified: boolean;
  riskLevel: string;
  content: string;
};

export type JarvisRagHit = JarvisKnowledgeChunk & {
  lexicalScore: number;
  semanticScore: number;
  fusedScore: number;
};

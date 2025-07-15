import { z } from 'zod';

// Chunk reference schema for embedding status
export const ChunkReferenceSchema = z.object({
  chunkId: z.string().uuid(),
  chunkIndex: z.number().int().nonnegative(),
  s3_path_embedding: z.string(),
  s3_path_content: z.string()
});

// Embedding summary schema
export const EmbeddingSummarySchema = z.object({
  totalChunks: z.number().int().positive(),
  model: z.string(),
  totalTokens: z.number().int().nonnegative()
});

// Original document reference schema (simplified)
export const OriginalDocumentReferenceSchema = z.object({
  bucketName: z.string(),
  objectKey: z.string(),
  contentType: z.string(),
  fileSize: z.number().int().nonnegative()
});

// Main embedding status schema (the complete data structure stored in S3)
export const EmbeddingStatusSchema = z.object({
  documentId: z.string(),
  processingId: z.string(),
  originalDocument: OriginalDocumentReferenceSchema,
  summary: EmbeddingSummarySchema,
  chunkReferences: z.array(ChunkReferenceSchema),
  embeddingTimestamp: z.string().datetime(),
  embeddingModel: z.string(),
  status: z.enum(['completed', 'failed', 'processing']),
  error: z.string().optional() // For failed status
});

/**
 * Schema for S3 object metadata used to track embedding status
 * This metadata is attached to embedding objects in S3
 */
export const S3EmbeddingMetadataSchema = z.object({
  'processing-status': z.enum(['completed', 'failed', 'processing']).describe('Current embedding status'),
  'document-id': z.string().min(1).describe('Original document identifier'),
  'processing-id': z.string().uuid().describe('Unique processing operation identifier'),
  'embedding-count': z.string().refine(val => !isNaN(parseInt(val)), 'Must be a valid number string').describe('Number of embeddings created'),
  'schema-version': z.string().min(1).describe('Schema version used for this embedding'),
  'embedding-time-ms': z.string().refine(val => !isNaN(parseInt(val)), 'Must be a valid number string').describe('Embedding generation time in milliseconds'),
  'total-tokens': z.string().refine(val => !isNaN(parseInt(val)), 'Must be a valid number string').describe('Total tokens processed'),
  'embedding-model': z.string().min(1).describe('Model used for embedding generation'),
  'created-at': z.string().optional().describe('ISO timestamp when object was created'),
  'content-type': z.literal('application/json').optional().describe('Content type of the stored object')
}).describe('S3 object metadata for embedding tracking');

/**
 * TypeScript type for S3 embedding metadata
 */
export type S3EmbeddingMetadata = z.infer<typeof S3EmbeddingMetadataSchema>;

/**
 * Helper function to create strongly-typed S3 embedding metadata
 */
export function createS3EmbeddingMetadata(
  documentId: string,
  processingId: string,
  embeddingCount: number,
  schemaVersion: string,
  embeddingTimeMs: number,
  totalTokens: number,
  embeddingModel: string,
  status: 'completed' | 'failed' | 'processing' = 'completed'
): S3EmbeddingMetadata {
  return {
    'processing-status': status,
    'document-id': documentId,
    'processing-id': processingId,
    'embedding-count': embeddingCount.toString(),
    'schema-version': schemaVersion,
    'embedding-time-ms': embeddingTimeMs.toString(),
    'total-tokens': totalTokens.toString(),
    'embedding-model': embeddingModel,
    'created-at': new Date().toISOString(),
    'content-type': 'application/json'
  };
}

/**
 * Validation helper function for S3 embedding metadata
 */
export function validateS3EmbeddingMetadata(data: unknown): {
  success: boolean;
  data?: S3EmbeddingMetadata;
  error?: string;
} {
  try {
    const validatedData = S3EmbeddingMetadataSchema.parse(data);
    return { success: true, data: validatedData };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: `S3 embedding metadata validation failed: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      };
    }
    return { success: false, error: String(error) };
  }
}

/**
 * Validation helper function for runtime validation of embedding status
 */
export function validateEmbeddingStatus(data: unknown): {
  success: boolean;
  data?: EmbeddingStatus;
  error?: string;
} {
  try {
    const validatedData = EmbeddingStatusSchema.parse(data);
    return { success: true, data: validatedData };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: `Embedding status validation failed: ${error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`
      };
    }
    return { success: false, error: String(error) };
  }
}

// Export TypeScript types
export type ChunkReference = z.infer<typeof ChunkReferenceSchema>;
export type EmbeddingSummary = z.infer<typeof EmbeddingSummarySchema>;
export type OriginalDocumentReference = z.infer<typeof OriginalDocumentReferenceSchema>;
export type EmbeddingStatus = z.infer<typeof EmbeddingStatusSchema>;

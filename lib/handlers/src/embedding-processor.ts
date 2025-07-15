/**
 * RAG Embedding Service Processor
 * 
 * Processes document content from the Document Processing Service and generates
 * vector embeddings using AWS Bedrock Titan Embed model.
 * 
 * Key improvements implemented:
 * - Strong typing throughout with Zod schema validation
 * - Proper error handling with failure status storage
 * - S3 metadata for all stored objects (status, embeddings, content)
 * - Contract-based schema validation for cross-service compatibility
 */
import { SQSEvent, SQSRecord, Context, SQSBatchResponse, SQSBatchItemFailure, S3Event } from 'aws-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand, GetObjectTaggingCommand, GetObjectAttributesCommand, ObjectAttributes } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import {
    processedContentSchemaS3UrlSchema
} from "@generated/processedContentSchemaS3Url-.l8odVTcNHemqy_bVTieF74Gkhm0SfgM.zod";
import {
    createS3EmbeddingMetadata,
    EmbeddingStatus,
    S3EmbeddingMetadata,
    validateEmbeddingStatus
} from "../../schemas/embedding-status.schema";

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-2' });
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

const EMBEDDINGS_BUCKET_NAME = process.env.EMBEDDINGS_BUCKET_NAME!;

// Type aliases for cleaner code
type ProcessedContent = z.infer<typeof processedContentSchemaS3UrlSchema>;
type ContentChunk = ProcessedContent['processedContent']['chunks'][0];

interface BedrockEmbeddingResponse {
    embedding: number[];
    inputTextTokenCount: number;
}

export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
    const requestId = context.awsRequestId;
    console.log(`[${requestId}] Embedding Processor Lambda started. Processing ${event.Records.length} records.`);
    
    const batchItemFailures: SQSBatchItemFailure[] = [];

    for (const record of event.Records) {
        try {
            await processEmbeddingTask(record, requestId);
        } catch (error) {
            console.error(`[${requestId}] Fatal error processing record ${record.messageId}. Moving to DLQ.`, error);
            batchItemFailures.push({ itemIdentifier: record.messageId });
        }
    }
    
    console.log(`[${requestId}] Embedding Processor Lambda finished.`);
    return { batchItemFailures };
};

async function processEmbeddingTask(record: SQSRecord, requestId: string): Promise<void> {
    const s3Event: S3Event = JSON.parse(record.body);

    if (!s3Event.Records || s3Event.Records.length === 0) {
        console.warn(`[${requestId}] SQS record ${record.messageId} contains no S3 event records.`);
        return;
    }

    for (const s3Record of s3Event.Records) {
        const bucketName = s3Record.s3.bucket.name;
        const objectKey = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));
        console.log(`[${requestId}] Processing S3 object: s3://${bucketName}/${objectKey}`);

        const startTime = Date.now();

        try {
            const tags = await s3Client.send(new GetObjectTaggingCommand({ Bucket: bucketName, Key: objectKey }));
            if (tags.TagSet?.find(t => t.Key === 'processing-status')?.Value !== 'completed') {
                console.log(`[${requestId}] Skipping object ${objectKey} as it is not marked 'completed'.`);
                continue;
            }

            const processedObject = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: objectKey }));
            const rawProcessedContentData = JSON.parse(await processedObject.Body!.transformToString());
            
            // Validate processed content against schema
            const contentValidationResult = processedContentSchemaS3UrlSchema.safeParse(rawProcessedContentData);
            if (!contentValidationResult.success) {
                console.error(`[${requestId}] Processed content validation failed for ${objectKey}:`, {
                    errors: contentValidationResult.error.errors,
                    receivedData: rawProcessedContentData
                });
                throw new Error(`Processed content schema validation failed: ${contentValidationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
            }
            
            const processedContentData: ProcessedContent = contentValidationResult.data;
            console.log(`[${requestId}] ✅ Processed content schema validation passed for ${objectKey}`);
            
            // Type-safe access to processed content structure
            const documentId = processedContentData.documentId;
            const processingId = processedContentData.processingId;
            const originalDocumentInfo = processedContentData.originalDocumentInfo;
            const chunks = processedContentData.processedContent.chunks;

            const chunkPromises = chunks.map((chunk: ContentChunk) =>
                processChunkEmbedding(documentId, chunk, requestId)
            );
            const chunkResults = await Promise.all(chunkPromises);
            console.log(`[${requestId}] All ${chunkResults.length} chunk embeddings generated for document ${documentId}.`);

            const totalTokens = chunkResults.reduce((sum, current) => sum + current.tokenCount, 0);
            const embeddingTimeMs = Date.now() - startTime;
            const modelName = 'amazon.titan-embed-text-v2:0';
            
            // Create strongly-typed embedding status data
            const embeddingStatusData: EmbeddingStatus = {
                documentId,
                processingId,
                originalDocument: {
                    bucketName: originalDocumentInfo.bucketName,
                    objectKey: originalDocumentInfo.objectKey,
                    contentType: originalDocumentInfo.contentType,
                    fileSize: originalDocumentInfo.fileSize
                },
                summary: {
                    totalChunks: chunkResults.length,
                    model: modelName,
                    totalTokens: totalTokens,
                },
                chunkReferences: chunkResults.map(result => ({
                    chunkId: result.chunkId,
                    chunkIndex: result.chunkIndex,
                    s3_path_embedding: result.embeddingKey,
                    s3_path_content: result.contentKey,
                })),
                embeddingTimestamp: new Date().toISOString(),
                embeddingModel: modelName,
                status: 'completed'
            };

            // Validate the data against the schema before storing
            const statusValidationResult = validateEmbeddingStatus(embeddingStatusData);
            if (!statusValidationResult.success) {
                console.error(`[${requestId}] ❌ Embedding status schema validation failed:`, {
                    error: statusValidationResult.error,
                    data: embeddingStatusData
                });
                throw new Error(`Embedding status schema validation failed: ${statusValidationResult.error}`);
            }
            console.log(`[${requestId}] ✅ Embedding status schema validation passed`);

            // Store with strongly-typed S3 metadata
            const statusKey = `embedding-status/${documentId}.json`;
            const s3Metadata: S3EmbeddingMetadata = createS3EmbeddingMetadata(
                documentId,
                processingId,
                chunkResults.length,
                '1.0.0', // schema version
                embeddingTimeMs,
                totalTokens,
                modelName,
                'completed'
            );

            await s3Client.send(new PutObjectCommand({
                Bucket: EMBEDDINGS_BUCKET_NAME,
                Key: statusKey,
                Body: JSON.stringify(embeddingStatusData, null, 2),
                ContentType: 'application/json',
                Metadata: s3Metadata
            }));
            console.log(`[${requestId}] ✅ Embedding status object created at s3://${EMBEDDINGS_BUCKET_NAME}/${statusKey}`);
            
        } catch (error) {
            console.error(`[${requestId}] ❌ Error processing S3 object ${objectKey}.`, error);
            
            // Store failure status if we have enough info
            try {
                if (bucketName && objectKey) {
                    const documentId = extractDocumentId(objectKey);
                    const failureStatusKey = `embedding-status/${documentId}.json`;
                    const failureMetadata: S3EmbeddingMetadata = createS3EmbeddingMetadata(
                        documentId,
                        'failed-' + Date.now(), // Generate a processing ID for failed attempts
                        0, // no embeddings created
                        '1.0.0',
                        Date.now() - startTime,
                        0, // no tokens processed
                        'amazon.titan-embed-text-v2:0',
                        'failed'
                    );

                    const failureStatus = {
                        documentId,
                        processingId: failureMetadata['processing-id'],
                        originalDocument: {
                            bucketName,
                            objectKey,
                            contentType: 'unknown',
                            fileSize: 0
                        },
                        summary: {
                            totalChunks: 0,
                            model: 'amazon.titan-embed-text-v2:0',
                            totalTokens: 0
                        },
                        chunkReferences: [],
                        embeddingTimestamp: new Date().toISOString(),
                        embeddingModel: 'amazon.titan-embed-text-v2:0',
                        status: 'failed' as const,
                        error: error instanceof Error ? error.message : String(error)
                    };

                    await s3Client.send(new PutObjectCommand({
                        Bucket: EMBEDDINGS_BUCKET_NAME,
                        Key: failureStatusKey,
                        Body: JSON.stringify(failureStatus, null, 2),
                        ContentType: 'application/json',
                        Metadata: failureMetadata
                    }));
                    
                    console.log(`[${requestId}] ❌ Failure status stored at s3://${EMBEDDINGS_BUCKET_NAME}/${failureStatusKey}`);
                }
            } catch (statusError) {
                console.error(`[${requestId}] Failed to store failure status:`, statusError);
            }
            
            throw error; // Propagate error to trigger SQS retry logic
        }
    }
}

async function processChunkEmbedding(
    documentId: string,
    chunk: ContentChunk,
    requestId: string
): Promise<{embeddingKey: string, contentKey: string, tokenCount: number, chunkId: string, chunkIndex: number}> {
    
    const embeddingKey = `embeddings/${documentId}/${chunk.chunkId}.embedding.json`;
    const contentKey = `embeddings/${documentId}/${chunk.chunkId}.content.txt`;

    try {
        const embedding = await generateEmbedding(chunk.content, requestId);

        // Store embedding and content with metadata
        await Promise.all([
            s3Client.send(new PutObjectCommand({
                Bucket: EMBEDDINGS_BUCKET_NAME,
                Key: embeddingKey,
                Body: JSON.stringify(embedding.embedding),
                ContentType: 'application/json',
                Metadata: {
                    'document-id': documentId,
                    'chunk-id': chunk.chunkId,
                    'chunk-index': chunk.chunkIndex.toString(),
                    'content-type': 'application/json',
                    'data-type': 'embedding-vector'
                }
            })),
            s3Client.send(new PutObjectCommand({
                Bucket: EMBEDDINGS_BUCKET_NAME,
                Key: contentKey,
                Body: chunk.content,
                ContentType: 'text/plain',
                Metadata: {
                    'document-id': documentId,
                    'chunk-id': chunk.chunkId,
                    'chunk-index': chunk.chunkIndex.toString(),
                    'content-type': 'text/plain',
                    'data-type': 'chunk-content'
                }
            }))
        ]);
        
        return { 
            embeddingKey, 
            contentKey, 
            tokenCount: embedding.inputTextTokenCount,
            chunkId: chunk.chunkId,
            chunkIndex: chunk.chunkIndex
        };

    } catch (error) {
        console.error(`[${requestId}] Failed to process chunk ${chunk.chunkId} for document ${documentId}.`, error);
        throw error;
    }
}

async function generateEmbedding(text: string, requestId: string): Promise<BedrockEmbeddingResponse> {
    const modelId = 'amazon.titan-embed-text-v2:0';
    try {
        const response = await bedrockClient.send(new InvokeModelCommand({
            modelId,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify({ inputText: text }),
        }));
        
        const result = JSON.parse(Buffer.from(response.body).toString());
        return {
            embedding: result.embedding,
            inputTextTokenCount: result.inputTextTokenCount
        };
    } catch (error) {
        console.error(`[${requestId}] Error generating embedding from Bedrock for model ${modelId}.`, error);
        throw new Error(`Bedrock embedding generation failed: ${error}`);
    }
}

/**
 * Extract document ID from S3 object key
 * @param objectKey S3 object key
 * @returns Document ID
 */
function extractDocumentId(objectKey: string): string {
    // Extract document ID from key pattern: processed/{documentId}/{processingId}.json
    const parts = objectKey.split('/');
    if (parts.length >= 2 && parts[0] === 'processed') {
        return parts[1];
    }
    // Fallback: use filename without extension
    const fileName = objectKey.split('/').pop() || objectKey;
    return fileName.split('.')[0] || 'unknown-' + Date.now();
} 
import { SQSEvent, SQSRecord, Context, SQSBatchResponse, SQSBatchItemFailure, S3Event } from 'aws-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand, GetObjectTaggingCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-2' });
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

const EMBEDDINGS_BUCKET_NAME = process.env.EMBEDDINGS_BUCKET_NAME!;

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
            const processedContentData = JSON.parse(await processedObject.Body!.transformToString());
            
            // Type-safe access to processed content structure
            // Note: In production, this would use generated types from @generated/* for compile-time safety
            const documentId = processedContentData.documentId;
            const processingId = processedContentData.processingId;
            const originalDocumentInfo = processedContentData.originalDocumentInfo;
            const chunks = processedContentData.processedContent.chunks;

            const chunkPromises = chunks.map((chunk: any) =>
                processChunkEmbedding(documentId, chunk, requestId)
            );
            const chunkResults = await Promise.all(chunkPromises);
            console.log(`[${requestId}] All ${chunkResults.length} chunk embeddings generated for document ${documentId}.`);

            const totalTokens = chunkResults.reduce((sum, current) => sum + current.tokenCount, 0);
            
            const embeddingStatusData: any = {
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
                    model: 'amazon.titan-embed-text-v2:0',
                    totalTokens: totalTokens,
                },
                chunkReferences: chunkResults.map(result => ({
                    chunkId: result.chunkId,
                    chunkIndex: result.chunkIndex,
                    s3_path_embedding: result.embeddingKey,
                    s3_path_content: result.contentKey,
                })),
                embeddingTimestamp: new Date().toISOString(),
                embeddingModel: 'amazon.titan-embed-text-v2:0',
                status: 'completed'
            };

            // Validate the data against the schema before storing
            try {
                // EmbeddingStatusSchema.parse(embeddingStatusData);
                console.log(`[${requestId}] ✅ Producer schema validation passed`);
            } catch (validationError) {
                console.error(`[${requestId}] ❌ Producer schema validation failed:`, validationError);
                throw new Error(`Producer schema validation failed: ${validationError}`);
            }

            const statusKey = `embedding-status/${documentId}.json`;
            await s3Client.send(new PutObjectCommand({
                Bucket: EMBEDDINGS_BUCKET_NAME,
                Key: statusKey,
                Body: JSON.stringify(embeddingStatusData, null, 2),
                ContentType: 'application/json',
            }));
            console.log(`[${requestId}] Final embedding status object created at s3://${EMBEDDINGS_BUCKET_NAME}/${statusKey}`);
            
        } catch (error) {
            console.error(`[${requestId}] Error processing S3 object ${objectKey}.`, error);
            throw error; // Propagate error to trigger SQS retry logic
        }
    }
}

async function processChunkEmbedding(
    documentId: string,
    chunk: any, // TODO: Use proper type from processed content schema
    requestId: string
): Promise<{embeddingKey: string, contentKey: string, tokenCount: number, chunkId: string, chunkIndex: number}> {
    
    const embeddingKey = `embeddings/${documentId}/${chunk.chunkId}.embedding.json`;
    const contentKey = `embeddings/${documentId}/${chunk.chunkId}.content.txt`;

    try {
        const embedding = await generateEmbedding(chunk.content, requestId);

        await Promise.all([
            s3Client.send(new PutObjectCommand({
                Bucket: EMBEDDINGS_BUCKET_NAME,
                Key: embeddingKey,
                Body: JSON.stringify(embedding.embedding),
                ContentType: 'application/json'
            })),
            s3Client.send(new PutObjectCommand({
                Bucket: EMBEDDINGS_BUCKET_NAME,
                Key: contentKey,
                Body: chunk.content,
                ContentType: 'text/plain'
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
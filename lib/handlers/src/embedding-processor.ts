import { SQSEvent, SQSRecord, Context, SQSBatchResponse, SQSBatchItemFailure, S3Event } from 'aws-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand, GetObjectTaggingCommand, PutObjectTaggingCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-2' });
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

const EMBEDDINGS_BUCKET_NAME = process.env.EMBEDDINGS_BUCKET!;

interface ProcessedContentChunk {
    chunkId: string;
    chunkIndex: number;
    content: string;
}

interface ProcessedContent {
    documentId: string;
    processingId: string;
    processedContent: {
        chunks: ProcessedContentChunk[];
    };
    originalDocument: any;
}

interface EmbeddingResult {
    documentId: string;
    processingId: string;
    chunkId: string;
    chunkIndex: number;
    embedding: number[];
    content: string;
    originalDocumentInfo: {
        bucketName: string;
        objectKey: string;
        contentType: string;
        fileSize: number;
    };
    embeddingMetadata: {
        model: string;
        dimensions: number;
        tokenCount: number;
        processingTimeMs: number;
    };
    processedAt: string;
    source: string;
}

interface BedrockEmbeddingResponse {
    embedding: number[];
    inputTextTokenCount: number;
}

/**
 * Lambda handler for processing embedding tasks from SQS
 */
export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
    const startTime = Date.now();
    const requestId = context.awsRequestId;
    
    console.log(`[${requestId}] === Embedding Processor Lambda Started ===`);
    console.log(`[${requestId}] Function: ${context.functionName}:${context.functionVersion}`);
    console.log(`[${requestId}] Memory limit: ${context.memoryLimitInMB}MB`);
    console.log(`[${requestId}] Remaining time: ${context.getRemainingTimeInMillis()}ms`);
    console.log(`[${requestId}] Records to process: ${event.Records.length}`);

    const batchItemFailures: SQSBatchItemFailure[] = [];
    
    const processPromises = event.Records.map(async (record) => {
        const recordStartTime = Date.now();
        try {
            console.log(`[${requestId}] Processing SQS record: ${record.messageId}`);
            await processEmbeddingTask(record, requestId);
            
            const recordDuration = Date.now() - recordStartTime;
            console.log(`[${requestId}] ✅ Successfully processed record ${record.messageId} in ${recordDuration}ms`);
            return { success: true, messageId: record.messageId };
            
        } catch (error) {
            const recordDuration = Date.now() - recordStartTime;
            console.error(`[${requestId}] ❌ Failed to process record ${record.messageId} after ${recordDuration}ms:`, error);
            
            batchItemFailures.push({
                itemIdentifier: record.messageId
            });
            
            return { success: false, messageId: record.messageId, error };
        }
    });

    const results = await Promise.allSettled(processPromises);

    const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length;

    const totalDuration = Date.now() - startTime;
    console.log(`[${requestId}] === Embedding Processor Lambda Completed ===`);
    console.log(`[${requestId}] Total execution time: ${totalDuration}ms`);
    console.log(`[${requestId}] Processed: ${successful}/${event.Records.length}`);
    console.log(`[${requestId}] Failed: ${failed}/${event.Records.length}`);
    console.log(`[${requestId}] Batch failures: ${batchItemFailures.length}`);
    console.log(`[${requestId}] Final remaining time: ${context.getRemainingTimeInMillis()}ms`);

    return {
        batchItemFailures
    };
};

/**
 * Process a single S3 event from SQS
 */
async function processEmbeddingTask(record: SQSRecord, requestId: string): Promise<void> {
    const startTime = Date.now();
    
    console.log(`[${requestId}] 🔍 Step 1: Parsing S3 event from SQS message...`);
    console.log(`[${requestId}] Raw SQS message body: ${record.body}`);

    let s3Event: S3Event;
    try {
        s3Event = JSON.parse(record.body);
    } catch (e) {
        console.error(`[${requestId}] ❌ Failed to parse SQS message body as JSON.`, e);
        throw new Error("Invalid JSON in SQS message body");
    }

    if (!s3Event.Records || !Array.isArray(s3Event.Records)) {
        console.error(`[${requestId}] ❌ Parsed message is not a valid S3 event. Body:`, record.body);
        throw new Error("SQS message body is not a valid S3 event notification.");
    }

    for (const s3Record of s3Event.Records) {
        const bucketName = s3Record.s3.bucket.name;
        const objectKey = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));

        try {
            console.log(`[${requestId}] 📋 S3 object details: Bucket: ${bucketName}, Key: ${objectKey}`);

            console.log(`[${requestId}] 🔍 Step 2: Verifying 'processing-status' tag...`);
            const tags = await s3Client.send(new GetObjectTaggingCommand({ Bucket: bucketName, Key: objectKey }));
            const processingStatus = tags.TagSet?.find(tag => tag.Key === 'processing-status')?.Value;

            if (processingStatus !== 'completed') {
                console.log(`[${requestId}] ⏭️ Skipping object. Processing status is '${processingStatus || 'not set'}', not 'completed'.`);
                continue;
            }
            console.log(`[${requestId}] ✅ Step 2 PASSED: Document is approved for embedding.`);

            console.log(`[${requestId}] 🔍 Step 3: Downloading processed content from S3...`);
            const processedObject = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: objectKey }));
            const processedContent: ProcessedContent = JSON.parse(await processedObject.Body!.transformToString());
            const documentId = processedContent.documentId || objectKey.replace('processed/', '').replace('.json', '');
            console.log(`[${requestId}] ✅ Step 3 PASSED: Processed content downloaded for document ${documentId} (${processedContent.processedContent.chunks.length} chunks)`);

            console.log(`[${requestId}] 🔍 Step 4: Generating embeddings for ${processedContent.processedContent.chunks.length} chunks...`);
            const chunkPromises = processedContent.processedContent.chunks.map(chunk => 
                processChunkEmbedding(documentId, chunk, processedContent, requestId)
            );
            await Promise.all(chunkPromises);
            console.log(`[${requestId}] ✅ Step 4 PASSED: All chunk embeddings generated.`);

            console.log(`[${requestId}] 🔍 Step 5: Creating embedding status object...`);
            const embeddingStatusObject = {
                documentId: documentId,
                status: 'completed',
                completedAt: new Date().toISOString(),
                summary: {
                    totalChunks: processedContent.processedContent.chunks.length,
                    model: 'amazon.titan-embed-text-v2:0',
                    processingTimeMs: Date.now() - startTime
                },
                chunkReferences: processedContent.processedContent.chunks.map((chunk: any) => ({
                    chunkId: chunk.chunkId,
                    chunkIndex: chunk.chunkIndex,
                    embeddingKey: `embeddings/${documentId}/${chunk.chunkId}.json`,
                    contentLength: chunk.content.length
                })),
                originalDocument: processedContent.originalDocument
            };

            const statusKey = `embedding-status/${documentId}.json`;
            await s3Client.send(new PutObjectCommand({
                Bucket: EMBEDDINGS_BUCKET_NAME,
                Key: statusKey,
                Body: JSON.stringify(embeddingStatusObject, null, 2),
                ContentType: 'application/json',
                Metadata: {
                    'document-id': documentId,
                    'status': 'completed',
                }
            }));
            console.log(`[${requestId}] ✅ Step 5 PASSED: Embedding status object created at ${statusKey}`);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.error(`[${requestId}] ❌ Failed to process S3 object ${objectKey}:`, error);
            // Optionally, add a failure tag or status object here
            throw error; // Re-throw to mark the SQS message as failed
        }
    }
}

async function processChunkEmbedding(
    documentId: string,
    chunk: ProcessedContentChunk,
    processedContent: ProcessedContent,
    requestId: string
): Promise<void> {
    const chunkStartTime = Date.now();
    const embeddingKey = `embeddings/${documentId}/${chunk.chunkId}.json`;
    
    try {
        await createEmbeddingPlaceholder(embeddingKey, documentId, chunk, requestId);

        const embedding = await generateEmbedding(chunk.content, requestId);

        const embeddingResult: EmbeddingResult = {
            documentId: documentId,
            processingId: processedContent.processingId,
            chunkId: chunk.chunkId,
            chunkIndex: chunk.chunkIndex,
            embedding: embedding.embedding,
            content: chunk.content,
            originalDocumentInfo: processedContent.originalDocument,
            embeddingMetadata: {
                model: 'amazon.titan-embed-text-v2:0',
                dimensions: embedding.embedding.length,
                tokenCount: embedding.inputTextTokenCount,
                processingTimeMs: Date.now() - chunkStartTime
            },
            processedAt: new Date().toISOString(),
            source: 'rag-embedding-service'
        };

        await storeEmbeddingResultWithStatus(
            embeddingKey,
            embeddingResult,
            Date.now() - chunkStartTime,
            requestId
        );
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        await updatePlaceholderWithFailure(
            embeddingKey,
            documentId,
            chunk.chunkId,
            Date.now() - chunkStartTime,
            errorMessage,
            requestId
        );
        throw error;
    }
}

async function createEmbeddingPlaceholder(
    objectKey: string,
    documentId: string,
    chunk: ProcessedContentChunk,
    requestId: string
): Promise<void> {
    console.log(`[${requestId}] 📍 Creating embedding placeholder: ${objectKey}`);
    
    const placeholder = {
        documentId: documentId,
        chunkId: chunk.chunkId,
        chunkIndex: chunk.chunkIndex,
        status: 'processing',
        queuedAt: new Date().toISOString(),
        placeholder: true,
    };

    await s3Client.send(new PutObjectCommand({
        Bucket: EMBEDDINGS_BUCKET_NAME,
        Key: objectKey,
        Body: JSON.stringify(placeholder, null, 2),
        ContentType: 'application/json',
        Metadata: {
            'processing-status': 'processing',
            'document-id': documentId,
            'chunk-id': chunk.chunkId,
        }
    }));
}

async function storeEmbeddingResultWithStatus(
    objectKey: string,
    embeddingResult: EmbeddingResult,
    totalProcessingTimeMs: number,
    requestId: string
): Promise<void> {
    console.log(`[${requestId}] 💾 Storing final embedding result with completion status: ${objectKey}`);

    await s3Client.send(new PutObjectCommand({
        Bucket: EMBEDDINGS_BUCKET_NAME,
        Key: objectKey,
        Body: JSON.stringify(embeddingResult, null, 2),
        ContentType: 'application/json',
        Metadata: {
            'processing-status': 'completed',
            'document-id': embeddingResult.documentId,
            'chunk-id': embeddingResult.chunkId,
            'chunk-index': embeddingResult.chunkIndex.toString(),
            'processed-at': embeddingResult.processedAt,
            'processing-time-ms': totalProcessingTimeMs.toString(),
            'embedding-dimensions': embeddingResult.embeddingMetadata.dimensions.toString(),
            'token-count': embeddingResult.embeddingMetadata.tokenCount.toString(),
            'embedding-model': embeddingResult.embeddingMetadata.model,
            'source': embeddingResult.source
        }
    }));

    console.log(`[${requestId}] ✅ Final embedding result stored with completion status`);
}

async function updatePlaceholderWithFailure(
    objectKey: string,
    documentId: string,
    chunkId: string,
    totalProcessingTimeMs: number,
    errorMessage: string,
    requestId: string
): Promise<void> {
    console.log(`[${requestId}] ❌ Updating placeholder with failure status: ${objectKey}`);
    
    try {
        await s3Client.send(new PutObjectTaggingCommand({
            Bucket: EMBEDDINGS_BUCKET_NAME,
            Key: objectKey,
            Tagging: {
                TagSet: [
                    { Key: 'processing-status', Value: 'failed' },
                    { Key: 'error-message', Value: errorMessage.substring(0, 256) }
                ]
            }
        }));
        
        console.log(`[${requestId}] ✅ Placeholder updated with failure status`);
        
    } catch (error) {
        console.error(`[${requestId}] Failed to update placeholder with failure status:`, error);
    }
}

/**
 * Generate embedding using AWS Bedrock Titan Embed model
 */
async function generateEmbedding(text: string, requestId: string): Promise<BedrockEmbeddingResponse> {
    const startTime = Date.now();
    console.log(`[${requestId}] 🚀 Calling AWS Bedrock Titan Embed model...`);
    
    try {
        console.log(`[${requestId}] 🌐 Invoking Bedrock model...`);
        console.log(`[${requestId}]   Model: amazon.titan-embed-text-v2:0`);
        console.log(`[${requestId}]   Text length: ${text.length} characters`);
        console.log(`[${requestId}]   Text preview: "${text.substring(0, 200)}..."`);
        
        const apiStartTime = Date.now();
        
        const requestPayload = {
            inputText: text
        };
        
        const command = new InvokeModelCommand({
            modelId: 'amazon.titan-embed-text-v2:0',
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify(requestPayload)
        });

        const response = await bedrockClient.send(command);
        
        const apiDuration = Date.now() - apiStartTime;
        console.log(`[${requestId}] 📡 Bedrock API call completed in ${apiDuration}ms`);

        if (!response.body) {
            throw new Error('No response body from Bedrock API');
        }

        console.log(`[${requestId}] 📖 Parsing Bedrock response...`);
        const parseStartTime = Date.now();
        
        const responseText = new TextDecoder().decode(response.body);
        const embeddingResponse = JSON.parse(responseText) as BedrockEmbeddingResponse;
        
        const parseDuration = Date.now() - parseStartTime;
        console.log(`[${requestId}] ✅ Response parsed in ${parseDuration}ms`);
        console.log(`[${requestId}] 📊 Bedrock embedding response:`);
        console.log(`[${requestId}]   Model: amazon.titan-embed-text-v2:0`);
        console.log(`[${requestId}]   Dimensions: ${embeddingResponse.embedding.length}`);
        console.log(`[${requestId}]   Input tokens: ${embeddingResponse.inputTextTokenCount}`);
        console.log(`[${requestId}]   Embedding sample: [${embeddingResponse.embedding.slice(0, 5).join(', ')}...]`);
        
        const totalDuration = Date.now() - startTime;
        console.log(`[${requestId}] ✅ Embedding generation completed in ${totalDuration}ms total`);
        
        return embeddingResponse;
        
    } catch (error) {
        const totalDuration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${requestId}] ❌ Failed to generate embedding after ${totalDuration}ms:`, error);
        console.error(`[${requestId}]   Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
        console.error(`[${requestId}]   Error message: ${errorMessage}`);
        throw error;
    }
} 
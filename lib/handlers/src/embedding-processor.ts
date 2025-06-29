import { SQSEvent, SQSRecord, Context, SQSBatchResponse, SQSBatchItemFailure, S3Event } from 'aws-lambda';
import { S3Client, PutObjectCommand, PutObjectTaggingCommand, GetObjectCommand, GetObjectTaggingCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-2' });
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

const EMBEDDINGS_BUCKET_NAME = process.env.EMBEDDINGS_BUCKET!;

interface EmbeddingTaskMessage {
    documentId: string;
    processingId: string;
    chunkId: string;
    chunkIndex: number;
    content: string;
    originalDocumentInfo: {
        bucketName: string;
        objectKey: string;
        contentType: string;
        fileSize: number;
    };
    timestamp: number;
    source: string;
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
            const chunkId = await processEmbeddingTask(record, requestId);
            
            const recordDuration = Date.now() - recordStartTime;
            console.log(`[${requestId}] ✅ Successfully processed record ${record.messageId} (chunk: ${chunkId}) in ${recordDuration}ms`);
            return { success: true, messageId: record.messageId, chunkId };
            
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
 * Process a single embedding task from SQS (S3 tagging event)
 */
async function processEmbeddingTask(record: SQSRecord, requestId: string): Promise<string> {
    const startTime = Date.now();
    
    try {
        console.log(`[${requestId}] 🔍 Step 1: Parsing S3 tagging event from SQS...`);
        const s3Event: S3Event = JSON.parse(record.body);

        for (const s3Record of s3Event.Records) {
            const bucketName = s3Record.s3.bucket.name;
            const objectKey = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));

            console.log(`[${requestId}] ✅ Step 1 PASSED: S3 event parsed successfully`);
            console.log(`[${requestId}] 📋 S3 object details:`);
            console.log(`[${requestId}]   Bucket: ${bucketName}`);
            console.log(`[${requestId}]   Object key: ${objectKey}`);

            // Step 2: Check if this is a processed document ready for embedding
            console.log(`[${requestId}] 🔍 Step 2: Checking processing-status tag...`);
            const tags = await s3Client.send(new GetObjectTaggingCommand({ Bucket: bucketName, Key: objectKey }));
            const processingStatus = tags.TagSet?.find(tag => tag.Key === 'processing-status')?.Value;

            if (processingStatus !== 'completed') {
                console.log(`[${requestId}] ⏭️ Skipping object. Processing status is '${processingStatus || 'not set'}', not 'completed'.`);
                continue;
            }

            console.log(`[${requestId}] ✅ Step 2 PASSED: Document is ready for embedding`);

            // Step 3: Download and parse the processed content
            console.log(`[${requestId}] 🔍 Step 3: Downloading processed content...`);
            const processedObject = await s3Client.send(new GetObjectCommand({ Bucket: bucketName, Key: objectKey }));
            const processedContent = JSON.parse(await processedObject.Body!.transformToString());

            const documentId = processedContent.documentId || objectKey.replace('processed/', '').replace('.json', '');
            console.log(`[${requestId}] ✅ Step 3 PASSED: Processed content downloaded (${processedContent.chunks.length} chunks)`);

            // Step 4: Process each chunk for embedding
            console.log(`[${requestId}] 🔍 Step 4: Processing ${processedContent.chunks.length} chunks for embedding...`);
            
            for (const chunk of processedContent.chunks) {
                await processChunkEmbedding(bucketName, objectKey, documentId, chunk, processedContent, requestId);
            }

            // Step 5: Create embedding status object with summary metadata
            console.log(`[${requestId}] 🔍 Step 5: Creating embedding status object...`);
            
            const embeddingStatusObject = {
                documentId: documentId,
                status: 'completed',
                completedAt: new Date().toISOString(),
                summary: {
                    totalChunks: processedContent.chunks.length,
                    totalDimensions: processedContent.chunks.length * 1024, // Assuming Titan embed dimensions
                    model: 'amazon.titan-embed-text-v2:0',
                    processingTimeMs: Date.now() - startTime
                },
                chunkReferences: processedContent.chunks.map((chunk: any) => ({
                    chunkId: chunk.chunkId,
                    chunkIndex: chunk.chunkIndex,
                    embeddingKey: `embeddings/${documentId}/${chunk.chunkId}.json`,
                    contentLength: chunk.content.length
                })),
                originalDocument: {
                    bucketName: bucketName,
                    objectKey: objectKey,
                    documentId: documentId
                }
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
                    'total-chunks': processedContent.chunks.length.toString(),
                    'completed-at': new Date().toISOString()
                }
            }));

            const totalDuration = Date.now() - startTime;
            console.log(`[${requestId}] ✅ Step 5 PASSED: Embedding status object created`);
            console.log(`[${requestId}] ✅ Document embedding completed successfully in ${totalDuration}ms`);
            console.log(`[${requestId}]   Document: ${documentId}`);
            console.log(`[${requestId}]   Chunks processed: ${processedContent.chunks.length}`);
            console.log(`[${requestId}]   Status object: ${statusKey}`);
        }

        return 'completed';
        
    } catch (error) {
        const totalDuration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${requestId}] ❌ Failed to process embedding task after ${totalDuration}ms:`, error);
        
        throw error;
    }
}

/**
 * Process a single chunk for embedding
 */
async function processChunkEmbedding(
    bucketName: string,
    objectKey: string,
    documentId: string,
    chunk: any,
    processedContent: any,
    requestId: string
): Promise<void> {
    const startTime = Date.now();
    
    try {
        console.log(`[${requestId}] 🔍 Processing chunk ${chunk.chunkIndex} for embedding...`);
        
        const embeddingKey = `embeddings/${documentId}/${chunk.chunkId}.json`;
        await createEmbeddingPlaceholder(embeddingKey, chunk, documentId, requestId);
        
        const embeddingStartTime = Date.now();
        const embedding = await generateEmbedding(chunk.content, requestId);
        const embeddingDuration = Date.now() - embeddingStartTime;
        
        const embeddingResult: EmbeddingResult = {
            documentId: documentId,
            processingId: processedContent.processingId || 'unknown',
            chunkId: chunk.chunkId,
            chunkIndex: chunk.chunkIndex,
            embedding: embedding.embedding,
            content: chunk.content,
            originalDocumentInfo: processedContent.originalDocument || {
                bucketName: bucketName,
                objectKey: objectKey.replace('processed/', ''),
                contentType: 'unknown',
                fileSize: 0
            },
            embeddingMetadata: {
                model: 'amazon.titan-embed-text-v2:0',
                dimensions: embedding.embedding.length,
                tokenCount: embedding.inputTextTokenCount,
                processingTimeMs: embeddingDuration
            },
            processedAt: new Date().toISOString(),
            source: 'rag-embedding-service'
        };

        await storeEmbeddingResultWithStatus(
            embeddingKey,
            embeddingResult,
            Date.now() - startTime,
            requestId
        );

        const totalDuration = Date.now() - startTime;
        console.log(`[${requestId}] ✅ Chunk ${chunk.chunkIndex} embedding completed in ${totalDuration}ms`);
        
    } catch (error) {
        const totalDuration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${requestId}] ❌ Failed to process chunk ${chunk.chunkIndex} after ${totalDuration}ms:`, error);
        
        const embeddingKey = `embeddings/${documentId}/${chunk.chunkId}.json`;
        await updatePlaceholderWithFailure(
            embeddingKey,
            documentId,
            chunk.chunkId,
            totalDuration,
            errorMessage,
            requestId
        );
        
        throw error;
    }
}

async function createEmbeddingPlaceholder(
    objectKey: string,
    chunk: any,
    documentId: string,
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
        taskInfo: {
            contentLength: chunk.content.length,
            source: 'rag-embedding-service'
        }
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
            'chunk-index': chunk.chunkIndex.toString(),
            'placeholder': 'true',
            'queued-at': new Date().toISOString(),
            'content-length': chunk.content.length.toString(),
            'source': 'rag-embedding-service'
        }
    }));
    
    console.log(`[${requestId}] ✅ Embedding placeholder created with immediate status visibility`);
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
            'placeholder': 'false',
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
                    { Key: 'document-id', Value: documentId },
                    { Key: 'chunk-id', Value: chunkId },
                    { Key: 'placeholder', Value: 'true' },
                    { Key: 'failed-at', Value: new Date().toISOString() },
                    { Key: 'processing-time-ms', Value: totalProcessingTimeMs.toString() },
                    { Key: 'error-message', Value: errorMessage.substring(0, 1000) },
                    { Key: 'embedding-source', Value: 'embedding-processor' }
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
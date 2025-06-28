import { SQSEvent, SQSRecord, Context, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { S3Client, PutObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
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
 * Process a single embedding task from SQS
 */
async function processEmbeddingTask(record: SQSRecord, requestId: string): Promise<string> {
    const startTime = Date.now();
    
    try {
        console.log(`[${requestId}] 🔍 Step 1: Parsing SQS message...`);
        const embeddingTask: EmbeddingTaskMessage = JSON.parse(record.body);
        
        console.log(`[${requestId}] ✅ Step 1 PASSED: Message parsed successfully`);
        console.log(`[${requestId}] 📋 Embedding task details:`);
        console.log(`[${requestId}]   Document ID: ${embeddingTask.documentId}`);
        console.log(`[${requestId}]   Processing ID: ${embeddingTask.processingId}`);
        console.log(`[${requestId}]   Chunk ID: ${embeddingTask.chunkId}`);
        console.log(`[${requestId}]   Chunk index: ${embeddingTask.chunkIndex}`);
        console.log(`[${requestId}]   Content length: ${embeddingTask.content.length} chars`);
        console.log(`[${requestId}]   Content preview: "${embeddingTask.content.substring(0, 100)}..."`);
        console.log(`[${requestId}]   Original document: ${embeddingTask.originalDocumentInfo.bucketName}/${embeddingTask.originalDocumentInfo.objectKey}`);
        console.log(`[${requestId}]   Source: ${embeddingTask.source}`);

        const embeddingKey = `embeddings/${embeddingTask.documentId}/${embeddingTask.chunkId}.json`;
        await createEmbeddingPlaceholder(embeddingKey, embeddingTask, requestId);

        console.log(`[${requestId}] 🔍 Step 2: Generating embedding via AWS Bedrock...`);
        
        const embeddingStartTime = Date.now();
        const embedding = await generateEmbedding(embeddingTask.content, requestId);
        const embeddingDuration = Date.now() - embeddingStartTime;

        console.log(`[${requestId}] ✅ Step 2 PASSED: Embedding generated in ${embeddingDuration}ms`);
        console.log(`[${requestId}]   Model: amazon.titan-embed-text-v2:0`);
        console.log(`[${requestId}]   Dimensions: ${embedding.embedding.length}`);
        console.log(`[${requestId}]   Token count: ${embedding.inputTextTokenCount}`);

        console.log(`[${requestId}] 🔍 Step 3: Creating embedding result object...`);

        const embeddingResult: EmbeddingResult = {
            documentId: embeddingTask.documentId,
            processingId: embeddingTask.processingId,
            chunkId: embeddingTask.chunkId,
            chunkIndex: embeddingTask.chunkIndex,
            embedding: embedding.embedding,
            content: embeddingTask.content,
            originalDocumentInfo: embeddingTask.originalDocumentInfo,
            embeddingMetadata: {
                model: 'amazon.titan-embed-text-v2:0',
                dimensions: embedding.embedding.length,
                tokenCount: embedding.inputTextTokenCount,
                processingTimeMs: embeddingDuration
            },
            processedAt: new Date().toISOString(),
            source: embeddingTask.source
        };

        console.log(`[${requestId}] ✅ Step 3 PASSED: Embedding result created`);
        console.log(`[${requestId}] 🔍 Step 4: Storing embedding result with completion status...`);

        await storeEmbeddingResultWithStatus(
            embeddingKey,
            embeddingResult,
            Date.now() - startTime,
            requestId
        );

        const totalDuration = Date.now() - startTime;
        console.log(`[${requestId}] ✅ Step 4 PASSED: Embedding result stored`);
        console.log(`[${requestId}] ✅ Embedding task completed successfully in ${totalDuration}ms`);
        console.log(`[${requestId}]   Chunk: ${embeddingTask.chunkIndex} (${embedding.embedding.length}D, ${embedding.inputTextTokenCount} tokens)`);
        
        return embeddingResult.chunkId;
        
    } catch (error) {
        const totalDuration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${requestId}] ❌ Failed to process embedding task after ${totalDuration}ms:`, error);
        
        const embeddingTask = JSON.parse(record.body);
        const embeddingKey = `embeddings/${embeddingTask.documentId}/${embeddingTask.chunkId}.json`;
        await updatePlaceholderWithFailure(
            embeddingKey,
            embeddingTask.documentId,
            embeddingTask.chunkId,
            totalDuration,
            errorMessage,
            requestId
        );
        
        throw error;
    }
}

async function createEmbeddingPlaceholder(
    objectKey: string,
    embeddingTask: EmbeddingTaskMessage,
    requestId: string
): Promise<void> {
    console.log(`[${requestId}] 📍 Creating embedding placeholder: ${objectKey}`);
    
    const placeholder = {
        documentId: embeddingTask.documentId,
        chunkId: embeddingTask.chunkId,
        chunkIndex: embeddingTask.chunkIndex,
        status: 'processing',
        queuedAt: new Date().toISOString(),
        placeholder: true,
        taskInfo: {
            processingId: embeddingTask.processingId,
            contentLength: embeddingTask.content.length,
            originalDocumentInfo: embeddingTask.originalDocumentInfo,
            source: embeddingTask.source
        }
    };

    await s3Client.send(new PutObjectCommand({
        Bucket: EMBEDDINGS_BUCKET_NAME,
        Key: objectKey,
        Body: JSON.stringify(placeholder, null, 2),
        ContentType: 'application/json',
        Metadata: {
            'processing-status': 'processing',
            'document-id': embeddingTask.documentId,
            'chunk-id': embeddingTask.chunkId,
            'chunk-index': embeddingTask.chunkIndex.toString(),
            'placeholder': 'true',
            'queued-at': new Date().toISOString(),
            'content-length': embeddingTask.content.length.toString(),
            'processing-id': embeddingTask.processingId,
            'source': embeddingTask.source
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
        await s3Client.send(new CopyObjectCommand({
            Bucket: EMBEDDINGS_BUCKET_NAME,
            Key: objectKey,
            CopySource: `${EMBEDDINGS_BUCKET_NAME}/${objectKey}`,
            Metadata: {
                'processing-status': 'failed',
                'document-id': documentId,
                'chunk-id': chunkId,
                'placeholder': 'true',
                'failed-at': new Date().toISOString(),
                'processing-time-ms': totalProcessingTimeMs.toString(),
                'error-message': errorMessage.substring(0, 1000),
                'embedding-source': 'embedding-processor'
            },
            MetadataDirective: 'REPLACE'
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
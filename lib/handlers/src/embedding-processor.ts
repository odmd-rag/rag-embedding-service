import { SQSEvent, SQSRecord, Context } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { createHash } from 'crypto';

// Initialize AWS clients
const s3Client = new S3Client({});
const bedrockClient = new BedrockRuntimeClient({});

// Environment variables
const EMBEDDINGS_BUCKET_NAME = process.env.EMBEDDINGS_BUCKET_NAME!;
const EMBEDDING_STATUS_BUCKET_NAME = process.env.EMBEDDING_STATUS_BUCKET_NAME!;

// Interfaces
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
export const handler = async (event: SQSEvent, context: Context): Promise<void> => {
    const startTime = Date.now();
    const requestId = context.awsRequestId;
    
    console.log(`[${requestId}] === Embedding Processor Started ===`);
    console.log(`[${requestId}] Function: ${context.functionName}:${context.functionVersion}`);
    console.log(`[${requestId}] Memory limit: ${context.memoryLimitInMB}MB`);
    console.log(`[${requestId}] Remaining time: ${context.getRemainingTimeInMillis()}ms`);
    console.log(`[${requestId}] Processing ${event.Records.length} SQS messages`);

    const results = [];
    
    for (const [index, record] of event.Records.entries()) {
        const recordStartTime = Date.now();
        console.log(`\n[${requestId}] 📄 Processing SQS record ${index + 1}/${event.Records.length}: ${record.messageId}`);
        console.log(`[${requestId}]   Receipt handle: ${record.receiptHandle.substring(0, 20)}...`);
        console.log(`[${requestId}]   Message attributes:`, JSON.stringify(record.messageAttributes, null, 2));
        console.log(`[${requestId}]   Approximate receive count: ${record.attributes.ApproximateReceiveCount}`);
        console.log(`[${requestId}]   Sent timestamp: ${new Date(parseInt(record.attributes.SentTimestamp)).toISOString()}`);
        
        try {
            const result = await processEmbeddingTask(record, requestId);
            results.push(result);
            
            const recordDuration = Date.now() - recordStartTime;
            console.log(`[${requestId}] ✅ Successfully processed record ${index + 1} in ${recordDuration}ms`);
            console.log(`[${requestId}]   Result: ${result}`);
            
        } catch (error) {
            const recordDuration = Date.now() - recordStartTime;
            console.error(`[${requestId}] ❌ Failed to process SQS record ${record.messageId} after ${recordDuration}ms:`, error);
            console.error(`[${requestId}]   Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
            console.error(`[${requestId}]   Error message: ${error instanceof Error ? error.message : 'Unknown error'}`);
            // Let the message go to DLQ by throwing
            throw error;
        }
    }

    const totalDuration = Date.now() - startTime;
    console.log(`[${requestId}] ✅ Embedding processing complete. Processed ${results.length}/${event.Records.length} messages in ${totalDuration}ms`);
};

/**
 * Process a single embedding task from SQS
 */
async function processEmbeddingTask(record: SQSRecord, requestId: string): Promise<string> {
    const startTime = Date.now();
    console.log(`[${requestId}] 🔍 Step 1: Parsing SQS message body...`);
    
    try {
        // Parse the message body
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
        console.log(`[${requestId}]   Content type: ${embeddingTask.originalDocumentInfo.contentType}`);
        console.log(`[${requestId}]   File size: ${embeddingTask.originalDocumentInfo.fileSize} bytes`);
        console.log(`[${requestId}]   Source: ${embeddingTask.source}`);
        console.log(`[${requestId}]   Timestamp: ${new Date(embeddingTask.timestamp).toISOString()}`);

        console.log(`[${requestId}] 🔍 Step 2: Generating embedding via AWS Bedrock...`);
        
        // Generate embedding using AWS Bedrock
        const embeddingStartTime = Date.now();
        const embedding = await generateEmbedding(embeddingTask.content, requestId);
        const embeddingDuration = Date.now() - embeddingStartTime;

        console.log(`[${requestId}] ✅ Step 2 PASSED: Embedding generated in ${embeddingDuration}ms`);
        console.log(`[${requestId}]   Model: amazon.titan-embed-text-v1`);
        console.log(`[${requestId}]   Dimensions: ${embedding.embedding.length}`);
        console.log(`[${requestId}]   Token count: ${embedding.inputTextTokenCount}`);

        console.log(`[${requestId}] 🔍 Step 3: Creating embedding result object...`);

        // Create embedding result
        const embeddingResult: EmbeddingResult = {
            documentId: embeddingTask.documentId,
            processingId: embeddingTask.processingId,
            chunkId: embeddingTask.chunkId,
            chunkIndex: embeddingTask.chunkIndex,
            embedding: embedding.embedding,
            content: embeddingTask.content,
            originalDocumentInfo: embeddingTask.originalDocumentInfo,
            embeddingMetadata: {
                model: 'amazon.titan-embed-text-v1',
                dimensions: embedding.embedding.length,
                tokenCount: embedding.inputTextTokenCount,
                processingTimeMs: embeddingDuration
            },
            processedAt: new Date().toISOString(),
            source: embeddingTask.source
        };

        console.log(`[${requestId}] ✅ Step 3 PASSED: Embedding result created`);
        console.log(`[${requestId}] 🔍 Step 4: Storing embedding result in S3...`);

        // Store embedding result in S3
        await storeEmbeddingResult(embeddingResult, requestId);

        const totalDuration = Date.now() - startTime;
        console.log(`[${requestId}] ✅ Step 4 PASSED: Embedding result stored`);
        console.log(`[${requestId}] ✅ Embedding task completed successfully in ${totalDuration}ms`);
        console.log(`[${requestId}]   Chunk: ${embeddingTask.chunkIndex} (${embedding.embedding.length}D, ${embedding.inputTextTokenCount} tokens)`);
        
        return embeddingResult.chunkId;
        
    } catch (error) {
        const totalDuration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${requestId}] ❌ Failed to process embedding task after ${totalDuration}ms:`, error);
        console.error(`[${requestId}]   Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
        console.error(`[${requestId}]   Error message: ${errorMessage}`);
        throw error;
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
        console.log(`[${requestId}]   Model: amazon.titan-embed-text-v1`);
        console.log(`[${requestId}]   Text length: ${text.length} characters`);
        console.log(`[${requestId}]   Text preview: "${text.substring(0, 200)}..."`);
        
        const apiStartTime = Date.now();
        
        // Prepare the request payload for Titan Embed
        const requestPayload = {
            inputText: text
        };
        
        const command = new InvokeModelCommand({
            modelId: 'amazon.titan-embed-text-v1',
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
        
        // Parse the response body (it's a Uint8Array)
        const responseText = new TextDecoder().decode(response.body);
        const embeddingResponse = JSON.parse(responseText) as BedrockEmbeddingResponse;
        
        const parseDuration = Date.now() - parseStartTime;
        console.log(`[${requestId}] ✅ Response parsed in ${parseDuration}ms`);
        console.log(`[${requestId}] 📊 Bedrock embedding response:`);
        console.log(`[${requestId}]   Model: amazon.titan-embed-text-v1`);
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

/**
 * Store embedding result in S3
 */
async function storeEmbeddingResult(embeddingResult: EmbeddingResult, requestId: string): Promise<void> {
    try {
        // Generate timestamp-hash key for the embedding
        const timestamp = new Date().toISOString();
        const hashInput = `${timestamp}${embeddingResult.chunkId}${embeddingResult.documentId}`;
        const hash = createHash('sha256').update(hashInput).digest('hex');
        const objectKey = `${timestamp}-${hash}.json`;

        console.log(`[${requestId}] Storing embedding result: ${objectKey}`);

        // Store in embeddings bucket
        await s3Client.send(new PutObjectCommand({
            Bucket: EMBEDDINGS_BUCKET_NAME,
            Key: objectKey,
            Body: JSON.stringify(embeddingResult, null, 2),
            ContentType: 'application/json',
            Metadata: {
                'document-id': embeddingResult.documentId,
                'processing-id': embeddingResult.processingId,
                'chunk-id': embeddingResult.chunkId,
                'chunk-index': embeddingResult.chunkIndex.toString(),
                'embedding-dimensions': embeddingResult.embeddingMetadata.dimensions.toString(),
                'token-count': embeddingResult.embeddingMetadata.tokenCount.toString(),
                'source': embeddingResult.source
            }
        }));

        // Store status in status bucket (for monitoring/tracking)
        const statusKey = `${timestamp}-${hash}-status.json`;
        const statusData = {
            documentId: embeddingResult.documentId,
            processingId: embeddingResult.processingId,
            chunkId: embeddingResult.chunkId,
            chunkIndex: embeddingResult.chunkIndex,
            status: 'completed',
            embeddingDimensions: embeddingResult.embeddingMetadata.dimensions,
            tokenCount: embeddingResult.embeddingMetadata.tokenCount,
            processingTimeMs: embeddingResult.embeddingMetadata.processingTimeMs,
            processedAt: embeddingResult.processedAt,
            embeddingObjectKey: objectKey
        };

        await s3Client.send(new PutObjectCommand({
            Bucket: EMBEDDING_STATUS_BUCKET_NAME,
            Key: statusKey,
            Body: JSON.stringify(statusData, null, 2),
            ContentType: 'application/json',
            Metadata: {
                'document-id': embeddingResult.documentId,
                'chunk-id': embeddingResult.chunkId,
                'status': 'completed'
            }
        }));

        console.log(`[${requestId}] ✅ Stored embedding result and status in S3`);
        
    } catch (error) {
        console.error(`[${requestId}] ❌ Failed to store embedding result:`, error);
        throw error;
    }
} 
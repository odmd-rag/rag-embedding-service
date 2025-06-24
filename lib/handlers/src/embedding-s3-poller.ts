import { Context } from 'aws-lambda';
import { S3Client, ListObjectsV2Command, GetObjectCommand, ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
// import { createHash } from 'crypto'; // Unused for now

// Initialize AWS clients
const s3Client = new S3Client({});
const dynamoClient = new DynamoDBClient({});
const sqsClient = new SQSClient({});

// Environment variables
const PROCESSED_CONTENT_BUCKET_NAME = process.env.PROCESSED_CONTENT_BUCKET_NAME!;
const EMBEDDINGS_BUCKET_NAME = process.env.EMBEDDINGS_BUCKET_NAME!;
const CHECKPOINT_TABLE_NAME = process.env.CHECKPOINT_TABLE_NAME!;
const EMBEDDING_QUEUE_URL = process.env.EMBEDDING_QUEUE_URL!;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '1000');
const SERVICE_ID = process.env.SERVICE_ID || 'embedding-processor-1';

// Interfaces
interface CheckpointRecord {
    serviceId: string;
    lastProcessedTimestamp: string;
    lastProcessedKey: string;
    updatedAt: string;
}

interface ProcessedContentData {
    documentId: string;
    processingId: string;
    originalDocumentInfo: {
        bucketName: string;
        objectKey: string;
        contentType: string;
        fileSize: number;
    };
    processedContent: {
        extractedText: string;
        chunks: Array<{
            chunkId: string;
            chunkIndex: number;
            content: string;
            startOffset: number;
            endOffset: number;
        }>;
        metadata: {
            totalChunks: number;
            averageChunkSize: number;
            chunkingStrategy: string;
            language: string;
            processingTimeMs: number;
            originalTextLength: number;
        };
    };
    processedAt: string;
    source: string;
}

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
    source: 'processed-content-polling';
}

/**
 * Lambda handler for polling processed content S3 bucket
 * Polls for new processed content files and sends chunks to embedding queue
 */
export const handler = async (event: any, context: Context): Promise<void> => {
    const startTime = Date.now();
    const requestId = context.awsRequestId;
    
    console.log(`[${requestId}] === Processed Content S3 Poller Started ===`);
    console.log(`[${requestId}] Function: ${context.functionName}:${context.functionVersion}`);
    console.log(`[${requestId}] Memory limit: ${context.memoryLimitInMB}MB`);
    console.log(`[${requestId}] Remaining time: ${context.getRemainingTimeInMillis()}ms`);
    console.log(`[${requestId}] Batch size: ${BATCH_SIZE}`);

    try {
        // Get current checkpoint
        const checkpoint = await getCheckpoint();
        console.log(`[${requestId}] Current checkpoint:`, checkpoint);

        // List new processed content files from S3
        const newObjects = await listNewProcessedContent(checkpoint);
        console.log(`[${requestId}] Found ${newObjects.length} new processed content files`);

        if (newObjects.length === 0) {
            console.log(`[${requestId}] No new processed content files to process`);
            return;
        }

        let processedCount = 0;
        let skippedCount = 0;
        let lastContiguousKey: string | null = null;
        let lastContiguousTimestamp: string | null = null;
        let hitNonProcessableFile = false;

        // Process files sequentially to maintain order
        for (const [index, obj] of newObjects.entries()) {
            const objectStartTime = Date.now();
            console.log(`\n[${requestId}] 📄 Processing object ${index + 1}/${newObjects.length}: ${obj.Key}`);
            console.log(`[${requestId}]   Size: ${obj.Size} bytes (${(obj.Size! / 1024 / 1024).toFixed(2)}MB)`);
            console.log(`[${requestId}]   Last Modified: ${obj.LastModified}`);
            console.log(`[${requestId}]   ETag: ${obj.ETag}`);
            
            try {
                console.log(`[${requestId}] 🔍 Step 1: Downloading processed content from ${obj.Key}...`);

                // Download and parse processed content
                const processedContentData = await downloadProcessedContent(obj.Key!, requestId);
                
                console.log(`[${requestId}] ✅ Step 1 PASSED: Downloaded processed content`);
                console.log(`[${requestId}]   Document ID: ${processedContentData.documentId}`);
                console.log(`[${requestId}]   Processing ID: ${processedContentData.processingId}`);
                console.log(`[${requestId}]   Total chunks: ${processedContentData.processedContent.metadata.totalChunks}`);
                console.log(`[${requestId}]   Average chunk size: ${processedContentData.processedContent.metadata.averageChunkSize}`);
                console.log(`[${requestId}]   Chunking strategy: ${processedContentData.processedContent.metadata.chunkingStrategy}`);
                console.log(`[${requestId}]   Language: ${processedContentData.processedContent.metadata.language}`);
                
                console.log(`[${requestId}] 🔍 Step 2: Sending ${processedContentData.processedContent.chunks.length} chunks to embedding queue...`);
                
                // Send chunks to embedding queue
                await sendChunksToEmbeddingQueue(processedContentData, requestId);
                
                processedCount++;
                lastContiguousKey = obj.Key!;
                lastContiguousTimestamp = extractTimestampFromKey(obj.Key!);

                const objectDuration = Date.now() - objectStartTime;
                console.log(`[${requestId}] ✅ Successfully processed ${obj.Key} in ${objectDuration}ms`);
                console.log(`[${requestId}]   Sent ${processedContentData.processedContent.chunks.length} chunks to embedding queue`);
                
            } catch (error) {
                const objectDuration = Date.now() - objectStartTime;
                console.error(`[${requestId}] ❌ Failed to process ${obj.Key} after ${objectDuration}ms:`, error);
                console.error(`[${requestId}]   Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
                console.error(`[${requestId}]   Error message: ${error instanceof Error ? error.message : 'Unknown error'}`);
                hitNonProcessableFile = true;
                break;
            }
        }

        // Update checkpoint only to the last contiguous processed file
        if (processedCount > 0 && lastContiguousKey) {
            await updateCheckpoint(lastContiguousTimestamp!, lastContiguousKey);
            console.log(`[${requestId}] 📍 Updated checkpoint to: ${lastContiguousTimestamp} (contiguous processing)`);
        }

        const totalDuration = Date.now() - startTime;
        console.log(`[${requestId}] ✅ Processed content polling complete. Processed ${processedCount}/${newObjects.length} files in ${totalDuration}ms`);

    } catch (error) {
        console.error(`[${requestId}] ❌ Processed content polling failed:`, error);
        throw error;
    }
};

/**
 * Get the current checkpoint from DynamoDB
 */
async function getCheckpoint(): Promise<CheckpointRecord | null> {
    try {
        const response = await dynamoClient.send(new GetItemCommand({
            TableName: CHECKPOINT_TABLE_NAME,
            Key: marshall({ serviceId: SERVICE_ID })
        }));

        if (!response.Item) {
            console.log('📍 No existing checkpoint found, starting from beginning');
            return null;
        }

        return unmarshall(response.Item) as CheckpointRecord;
    } catch (error) {
        console.error('❌ Failed to get checkpoint:', error);
        throw error;
    }
}

/**
 * Update the checkpoint in DynamoDB
 */
async function updateCheckpoint(timestamp: string, objectKey: string): Promise<void> {
    try {
        const record: CheckpointRecord = {
            serviceId: SERVICE_ID,
            lastProcessedTimestamp: timestamp,
            lastProcessedKey: objectKey,
            updatedAt: new Date().toISOString()
        };

        await dynamoClient.send(new PutItemCommand({
            TableName: CHECKPOINT_TABLE_NAME,
            Item: marshall(record)
        }));
    } catch (error) {
        console.error('❌ Failed to update checkpoint:', error);
        throw error;
    }
}

/**
 * List new processed content files from S3 starting from the checkpoint
 */
async function listNewProcessedContent(checkpoint: CheckpointRecord | null): Promise<any[]> {
    try {
        const listParams: any = {
            Bucket: PROCESSED_CONTENT_BUCKET_NAME,
            MaxKeys: BATCH_SIZE
        };

        // If we have a checkpoint, start listing from after the last processed key
        if (checkpoint?.lastProcessedKey) {
            listParams.StartAfter = checkpoint.lastProcessedKey;
        }

        const response: ListObjectsV2CommandOutput = await s3Client.send(
            new ListObjectsV2Command(listParams)
        );

        if (!response.Contents || response.Contents.length === 0) {
            return [];
        }

        // Filter objects to only include JSON files with timestamp-hash format
        const filteredObjects = response.Contents.filter(obj => {
            if (!obj.Key || !isTimestampHashKey(obj.Key)) {
                return false;
            }

            // If we have a checkpoint, only include objects newer than checkpoint
            if (checkpoint?.lastProcessedTimestamp) {
                const objTimestamp = extractTimestampFromKey(obj.Key);
                return objTimestamp > checkpoint.lastProcessedTimestamp;
            }

            return true;
        });

        // Sort by timestamp to ensure sequential processing
        filteredObjects.sort((a, b) => {
            const timestampA = extractTimestampFromKey(a.Key!);
            const timestampB = extractTimestampFromKey(b.Key!);
            return timestampA.localeCompare(timestampB);
        });

        return filteredObjects;
    } catch (error) {
        console.error('❌ Failed to list processed content objects:', error);
        throw error;
    }
}

/**
 * Check if the key follows the timestamp-hash format for processed content
 */
function isTimestampHashKey(key: string): boolean {
    // Format: [ISO timestamp]-[sha hash].json
    // Example: 2025-01-15T10:30:45.123Z-a1b2c3d4e5f6....json
    const timestampHashPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[a-f0-9]{64}\.json$/;
    return timestampHashPattern.test(key);
}

/**
 * Extract timestamp from the object key
 */
function extractTimestampFromKey(key: string): string {
    // Key format: [ISO timestamp]-[hash].json
    const parts = key.split('-');
    if (parts.length < 4) {
        throw new Error(`Invalid key format: ${key}`);
    }
    
    // Reconstruct ISO timestamp: YYYY-MM-DDTHH:MM:SS.sssZ
    return `${parts[0]}-${parts[1]}-${parts[2]}`;
}

/**
 * Download and parse processed content from S3
 */
async function downloadProcessedContent(objectKey: string, requestId: string): Promise<ProcessedContentData> {
    const startTime = Date.now();
    console.log(`[${requestId}] 📥 Downloading processed content from s3://${PROCESSED_CONTENT_BUCKET_NAME}/${objectKey}`);
    
    try {
        const response = await s3Client.send(new GetObjectCommand({
            Bucket: PROCESSED_CONTENT_BUCKET_NAME,
            Key: objectKey
        }));

        const downloadDuration = Date.now() - startTime;
        console.log(`[${requestId}] ✅ S3 GetObject completed in ${downloadDuration}ms`);
        console.log(`[${requestId}]   Content-Type: ${response.ContentType}`);
        console.log(`[${requestId}]   Content-Length: ${response.ContentLength}`);
        console.log(`[${requestId}]   Last-Modified: ${response.LastModified}`);
        console.log(`[${requestId}]   ETag: ${response.ETag}`);

        if (!response.Body) {
            throw new Error('No content body in S3 response');
        }

        console.log(`[${requestId}] 📖 Reading content stream...`);
        const streamStartTime = Date.now();

        // Read the stream
        const streamToString = (stream: any): Promise<string> => {
            return new Promise((resolve, reject) => {
                const chunks: Uint8Array[] = [];
                stream.on('data', (chunk: Uint8Array) => chunks.push(chunk));
                stream.on('error', reject);
                stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
            });
        };

        const contentString = await streamToString(response.Body);
        const streamDuration = Date.now() - streamStartTime;
        
        console.log(`[${requestId}] ✅ Stream read completed in ${streamDuration}ms`);
        console.log(`[${requestId}]   Content size: ${contentString.length} characters (${(contentString.length / 1024).toFixed(2)}KB)`);
        
        console.log(`[${requestId}] 🔍 Parsing JSON content...`);
        const parseStartTime = Date.now();
        
        // Parse JSON content
        const processedContentData: ProcessedContentData = JSON.parse(contentString);
        const parseDuration = Date.now() - parseStartTime;
        
        console.log(`[${requestId}] ✅ JSON parsing completed in ${parseDuration}ms`);
        console.log(`[${requestId}] 📊 Processed content summary:`);
        console.log(`[${requestId}]   Document ID: ${processedContentData.documentId}`);
        console.log(`[${requestId}]   Processing ID: ${processedContentData.processingId}`);
        console.log(`[${requestId}]   Total chunks: ${processedContentData.processedContent.chunks.length}`);
        console.log(`[${requestId}]   Extracted text length: ${processedContentData.processedContent.extractedText.length} chars`);
        console.log(`[${requestId}]   Average chunk size: ${processedContentData.processedContent.metadata.averageChunkSize}`);
        console.log(`[${requestId}]   Chunking strategy: ${processedContentData.processedContent.metadata.chunkingStrategy}`);
        console.log(`[${requestId}]   Language: ${processedContentData.processedContent.metadata.language}`);
        console.log(`[${requestId}]   Processing time: ${processedContentData.processedContent.metadata.processingTimeMs}ms`);
        console.log(`[${requestId}]   Processed at: ${processedContentData.processedAt}`);
        console.log(`[${requestId}]   Source: ${processedContentData.source}`);
        
        const totalDuration = Date.now() - startTime;
        console.log(`[${requestId}] ✅ Download and parse completed in ${totalDuration}ms total`);
        
        return processedContentData;
    } catch (error) {
        const totalDuration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${requestId}] ❌ Failed to download processed content ${objectKey} after ${totalDuration}ms:`, error);
        console.error(`[${requestId}]   Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
        console.error(`[${requestId}]   Error message: ${errorMessage}`);
        throw error;
    }
}

/**
 * Send chunks to embedding queue for processing
 */
async function sendChunksToEmbeddingQueue(processedContentData: ProcessedContentData, requestId: string): Promise<void> {
    const startTime = Date.now();
    const totalChunks = processedContentData.processedContent.chunks.length;
    
    console.log(`[${requestId}] 📤 Sending ${totalChunks} chunks to embedding queue: ${EMBEDDING_QUEUE_URL}`);
    
    try {
        let sentCount = 0;
        
        // Send each chunk as a separate message to the embedding queue
        for (const [index, chunk] of processedContentData.processedContent.chunks.entries()) {
            const chunkStartTime = Date.now();
            
            console.log(`[${requestId}] 📤 Sending chunk ${index + 1}/${totalChunks}: ${chunk.chunkId}`);
            console.log(`[${requestId}]   Chunk index: ${chunk.chunkIndex}`);
            console.log(`[${requestId}]   Content length: ${chunk.content.length} chars`);
            console.log(`[${requestId}]   Start offset: ${chunk.startOffset}`);
            console.log(`[${requestId}]   End offset: ${chunk.endOffset}`);
            
            const embeddingTask: EmbeddingTaskMessage = {
                documentId: processedContentData.documentId,
                processingId: processedContentData.processingId,
                chunkId: chunk.chunkId,
                chunkIndex: chunk.chunkIndex,
                content: chunk.content,
                originalDocumentInfo: processedContentData.originalDocumentInfo,
                timestamp: Date.now(),
                source: 'processed-content-polling'
            };

            console.log(`[${requestId}] 📋 Embedding task message:`, JSON.stringify({
                ...embeddingTask,
                content: `${embeddingTask.content.substring(0, 100)}...` // Truncate content for logging
            }, null, 2));

            await sqsClient.send(new SendMessageCommand({
                QueueUrl: EMBEDDING_QUEUE_URL,
                MessageBody: JSON.stringify(embeddingTask),
                MessageAttributes: {
                    'documentId': {
                        DataType: 'String',
                        StringValue: processedContentData.documentId
                    },
                    'chunkIndex': {
                        DataType: 'Number',
                        StringValue: chunk.chunkIndex.toString()
                    },
                    'processingId': {
                        DataType: 'String',
                        StringValue: processedContentData.processingId
                    }
                }
            }));
            
            sentCount++;
            const chunkDuration = Date.now() - chunkStartTime;
            console.log(`[${requestId}] ✅ Chunk ${index + 1} sent successfully in ${chunkDuration}ms`);
        }
        
        const totalDuration = Date.now() - startTime;
        console.log(`[${requestId}] ✅ Successfully sent all ${sentCount}/${totalChunks} chunks to embedding queue in ${totalDuration}ms`);
        console.log(`[${requestId}]   Average time per chunk: ${Math.round(totalDuration / sentCount)}ms`);
        
    } catch (error) {
        const totalDuration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`[${requestId}] ❌ Failed to send chunks to embedding queue after ${totalDuration}ms:`, error);
        console.error(`[${requestId}]   Error type: ${error instanceof Error ? error.constructor.name : typeof error}`);
        console.error(`[${requestId}]   Error message: ${errorMessage}`);
        throw error;
    }
} 
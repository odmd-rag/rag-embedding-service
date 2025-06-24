import { SQSEvent, SQSRecord, Context } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Initialize AWS clients
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

// Environment variables
const EMBEDDING_STATUS_BUCKET = process.env.EMBEDDING_STATUS_BUCKET || '';

interface FailedEmbeddingTask {
    documentId: string;
    processingId: string;
    chunkId: string;
    chunkIndex: number;
    content: string;
    originalDocumentInfo: any;
    timestamp: number;
    source: string;
    errorInfo: {
        errorMessage: string;
        errorType: string;
        receiveCount: number;
        firstFailureTime: string;
        lastFailureTime: string;
        totalFailures: number;
    };
}

export const handler = async (
    event: SQSEvent,
    context: Context
): Promise<{ statusCode: number; processedCount: number }> => {
    const startTime = Date.now();
    const requestId = context.awsRequestId;
    
    console.log(`[${requestId}] === DLQ Handler Lambda Started ===`);
    console.log(`[${requestId}] Function: ${context.functionName}:${context.functionVersion}`);
    console.log(`[${requestId}] Memory limit: ${context.memoryLimitInMB}MB`);
    console.log(`[${requestId}] Remaining time: ${context.getRemainingTimeInMillis()}ms`);
    console.log(`[${requestId}] Records to process: ${event.Records.length}`);

    let processedCount = 0;

    // Process each DLQ record
    for (const record of event.Records) {
        const recordStartTime = Date.now();
        try {
            console.log(`[${requestId}] Processing DLQ record: ${record.messageId}`);
            await processFailedMessage(record, requestId);
            processedCount++;
            
            const recordDuration = Date.now() - recordStartTime;
            console.log(`[${requestId}] ✅ Successfully processed DLQ record ${record.messageId} in ${recordDuration}ms`);
            
        } catch (error) {
            const recordDuration = Date.now() - recordStartTime;
            console.error(`[${requestId}] ❌ Failed to process DLQ record ${record.messageId} after ${recordDuration}ms:`, error);
            
            // For DLQ processing, we don't want to throw errors that would cause reprocessing
            // Instead, log the failure and continue
        }
    }

    const totalDuration = Date.now() - startTime;
    console.log(`[${requestId}] === DLQ Handler Lambda Completed ===`);
    console.log(`[${requestId}] Total execution time: ${totalDuration}ms`);
    console.log(`[${requestId}] Processed: ${processedCount}/${event.Records.length}`);
    console.log(`[${requestId}] Final remaining time: ${context.getRemainingTimeInMillis()}ms`);

    return {
        statusCode: 200,
        processedCount
    };
};

async function processFailedMessage(record: SQSRecord, requestId: string): Promise<void> {
    try {
        console.log(`[${requestId}] Parsing failed embedding task...`);
        const originalTask = JSON.parse(record.body);
        
        console.log(`[${requestId}] Failed Task Details:`);
        console.log(`[${requestId}]   Document ID: ${originalTask.documentId}`);
        console.log(`[${requestId}]   Chunk ID: ${originalTask.chunkId}`);
        console.log(`[${requestId}]   Chunk Index: ${originalTask.chunkIndex}`);
        console.log(`[${requestId}]   Content Length: ${originalTask.content?.length || 0} chars`);
        console.log(`[${requestId}]   Receive Count: ${record.attributes.ApproximateReceiveCount}`);

        // Create failure record
        const failedTask: FailedEmbeddingTask = {
            ...originalTask,
            errorInfo: {
                errorMessage: 'Message exceeded maximum retry attempts',
                errorType: 'MAX_RETRIES_EXCEEDED',
                receiveCount: parseInt(record.attributes.ApproximateReceiveCount || '0'),
                firstFailureTime: record.attributes.SentTimestamp 
                    ? new Date(parseInt(record.attributes.SentTimestamp)).toISOString()
                    : new Date().toISOString(),
                lastFailureTime: new Date().toISOString(),
                totalFailures: parseInt(record.attributes.ApproximateReceiveCount || '0')
            }
        };

        // Store failure record in S3 for analysis
        console.log(`[${requestId}] Storing failure record in S3...`);
        await storeFailureRecord(failedTask, requestId);

        // TODO: Could also:
        // - Send to SNS for alerting
        // - Store in DynamoDB for failure tracking
        // - Trigger manual review workflow
        // - Attempt alternative processing logic

        console.log(`[${requestId}] DLQ processing completed for ${originalTask.chunkId}`);
        
    } catch (error) {
        console.error(`[${requestId}] Failed to process DLQ message:`, error);
        throw error;
    }
}

async function storeFailureRecord(failedTask: FailedEmbeddingTask, requestId: string): Promise<void> {
    if (!EMBEDDING_STATUS_BUCKET) {
        console.warn(`[${requestId}] No status bucket configured - skipping failure record storage`);
        return;
    }

    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const key = `failed-embeddings/${timestamp}-${failedTask.documentId}-${failedTask.chunkId}.json`;
        
        await s3Client.send(new PutObjectCommand({
            Bucket: EMBEDDING_STATUS_BUCKET,
            Key: key,
            Body: JSON.stringify(failedTask, null, 2),
            ContentType: 'application/json',
            Metadata: {
                'document-id': failedTask.documentId,
                'chunk-id': failedTask.chunkId,
                'chunk-index': failedTask.chunkIndex.toString(),
                'error-type': failedTask.errorInfo.errorType,
                'receive-count': failedTask.errorInfo.receiveCount.toString()
            }
        }));

        console.log(`[${requestId}] ✅ Stored failure record: s3://${EMBEDDING_STATUS_BUCKET}/${key}`);
        
    } catch (error) {
        console.error(`[${requestId}] Failed to store failure record:`, error);
        throw error;
    }
} 
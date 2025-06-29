import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { S3Client, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

const EMBEDDINGS_BUCKET = process.env.EMBEDDINGS_BUCKET!;
const PROCESSED_CONTENT_BUCKET = process.env.PROCESSED_CONTENT_BUCKET!;

interface DocumentStatus {
    documentId: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    stage: 'embedding';
    timestamp: string;
    metadata?: {
        processingTime?: number;
        errorMessage?: string;
        embeddingCount?: number;
        vectorDimensions?: number;
        embeddingModel?: string;
        isPlaceholder?: boolean;
        chunkId?: string;
        chunkIndex?: number;
    };
}

interface EmbeddingMetadata {
    documentId: string;
    embeddingModel: string;
    vectorDimensions: number;
    embeddingCount: number;
    processingStartTime: string;
    processingEndTime: string;
    processingDurationMs: number;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const requestId = event.requestContext.requestId;
    
    try {
        const documentId = event.pathParameters?.documentId;
        
        if (!documentId) {
            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'X-Request-Id': requestId
                },
                body: JSON.stringify({ 
                    error: 'Missing documentId parameter',
                    requestId 
                })
            };
        }
        
        console.log(`[${requestId}] Checking embedding status for document: ${documentId}`);
        
        const status = await getDocumentEmbeddingStatus(documentId, requestId);
        
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'X-Request-Id': requestId,
                'X-Processing-Time': Date.now().toString()
            },
            body: JSON.stringify(status)
        };
        
    } catch (error) {
        console.error(`[${requestId}] Error checking document embedding status:`, error);
        
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'X-Request-Id': requestId
            },
            body: JSON.stringify({ 
                error: 'Internal server error', 
                requestId,
                message: error instanceof Error ? error.message : 'Unknown error'
            })
        };
    }
};

async function getDocumentEmbeddingStatus(documentId: string, requestId: string): Promise<DocumentStatus> {
    const startTime = Date.now();
    
    // 1. Check for final "completed" status object
    const finalStatus = await getFinalEmbeddingStatus(documentId, requestId);
    if (finalStatus) {
        return {
            documentId,
            status: 'completed',
            stage: 'embedding',
            timestamp: finalStatus.completedAt,
            metadata: {
                ...finalStatus.summary,
                processingTime: Date.now() - startTime,
            }
        };
    }

    // 2. Check if currently processing (any chunk exists)
    const isProcessing = await isEmbeddingInProgress(documentId, requestId);
    if (isProcessing) {
        return {
            documentId,
            status: 'processing',
            stage: 'embedding',
            timestamp: new Date().toISOString(),
            metadata: {
                processingTime: Date.now() - startTime,
            }
        };
    }

    // 3. Check if the prerequisite (processed content) is ready
    const isReadyForEmbedding = await checkProcessedContentIsReady(documentId, requestId);
    if (isReadyForEmbedding) {
        return {
            documentId,
            status: 'pending',
            stage: 'embedding',
            timestamp: new Date().toISOString(),
            metadata: {
                errorMessage: 'Document processed, embedding is pending.',
                processingTime: Date.now() - startTime,
            }
        };
    }

    // 4. If nothing else, it's pending upstream processing
    return {
        documentId,
        status: 'pending',
        stage: 'embedding',
        timestamp: new Date().toISOString(),
        metadata: {
            errorMessage: 'Upstream document processing has not completed yet.',
            processingTime: Date.now() - startTime,
        }
    };
}

async function getFinalEmbeddingStatus(documentId: string, requestId: string): Promise<any | null> {
    const statusKey = `embedding-status/${documentId}.json`;
    try {
        const command = new GetObjectCommand({
            Bucket: EMBEDDINGS_BUCKET,
            Key: statusKey,
        });
        const response = await s3Client.send(command);
        const statusData = JSON.parse(await response.Body!.transformToString());
        if (statusData.status === 'completed') {
            console.log(`[${requestId}] Found final 'completed' status object for ${documentId}`);
            return statusData;
        }
        return null;
    } catch (error: any) {
        if (error.name !== 'NotFound') {
            console.error(`[${requestId}] Error fetching final status object for ${documentId}:`, error);
        }
        return null;
    }
}

async function isEmbeddingInProgress(documentId: string, requestId: string): Promise<boolean> {
    try {
        const listCommand = new ListObjectsV2Command({
            Bucket: EMBEDDINGS_BUCKET,
            Prefix: `embeddings/${documentId}/`,
            MaxKeys: 1,
        });
        const response = await s3Client.send(listCommand);
        const hasChunks = (response.Contents || []).length > 0;
        if (hasChunks) {
            console.log(`[${requestId}] Found existing embedding chunks for ${documentId}, status is 'processing'.`);
        }
        return hasChunks;
    } catch (error) {
        console.error(`[${requestId}] Error listing embedding chunks for ${documentId}:`, error);
        return false;
    }
}

async function checkProcessedContentIsReady(documentId: string, requestId: string): Promise<boolean> {
    const objectKey = `processed/${documentId}.json`;
    try {
        const command = new HeadObjectCommand({
            Bucket: PROCESSED_CONTENT_BUCKET,
            Key: objectKey,
        });
        const response = await s3Client.send(command);
        const processingStatus = response.Metadata?.['processing-status'];
        const isReady = processingStatus === 'completed';
        if(isReady) {
            console.log(`[${requestId}] Upstream processed content for ${documentId} is ready.`);
        }
        return isReady;
    } catch (error: any) {
        if (error.name !== 'NotFound') {
            console.error(`[${requestId}] Error checking processed content for ${documentId}:`, error);
        }
        return false;
    }
} 
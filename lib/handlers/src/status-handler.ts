import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });

const EMBEDDINGS_BUCKET = process.env.EMBEDDINGS_BUCKET!;
const EMBEDDING_STATUS_BUCKET = process.env.EMBEDDING_STATUS_BUCKET!;
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
    
    try {
        // Check if embeddings have been generated (exists in embeddings bucket)
        const embeddingsKey = `embeddings/${documentId}.json`;
        const embeddingsExist = await checkS3ObjectExists(EMBEDDINGS_BUCKET, embeddingsKey, requestId);
        
        if (embeddingsExist) {
            // Embeddings are complete - get metadata
            console.log(`[${requestId}] Document ${documentId} found in embeddings bucket`);
            
            const metadata = await getEmbeddingMetadata(documentId, requestId);
            
            return {
                documentId,
                status: 'completed',
                stage: 'embedding',
                timestamp: new Date().toISOString(),
                metadata: {
                    processingTime: metadata?.processingDurationMs,
                    embeddingCount: metadata?.embeddingCount,
                    vectorDimensions: metadata?.vectorDimensions,
                    embeddingModel: metadata?.embeddingModel
                }
            };
        }
        
        // Check if there's an embedding error
        const errorStatus = await checkEmbeddingError(documentId, requestId);
        if (errorStatus) {
            return errorStatus;
        }
        
        // Check if processed content exists (prerequisite for embedding)
        const processedContentExists = await checkProcessedContentExists(documentId, requestId);
        
        if (processedContentExists) {
            // Processed content exists but embeddings not generated yet
            console.log(`[${requestId}] Document ${documentId} has processed content but embeddings not generated yet`);
            
            return {
                documentId,
                status: 'processing',
                stage: 'embedding',
                timestamp: new Date().toISOString(),
                metadata: {
                    processingTime: Date.now() - startTime
                }
            };
        } else {
            // Processed content doesn't exist - document processing not complete
            console.log(`[${requestId}] Document ${documentId} processed content not found`);
            
            return {
                documentId,
                status: 'pending',
                stage: 'embedding',
                timestamp: new Date().toISOString(),
                metadata: {
                    errorMessage: 'Document processing not complete yet - no processed content available for embedding'
                }
            };
        }
        
    } catch (error) {
        console.error(`[${requestId}] Error checking embedding status for ${documentId}:`, error);
        
        return {
            documentId,
            status: 'failed',
            stage: 'embedding',
            timestamp: new Date().toISOString(),
            metadata: {
                errorMessage: `Embedding status check failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            }
        };
    }
}

async function checkS3ObjectExists(bucketName: string, key: string, requestId: string): Promise<boolean> {
    try {
        await s3Client.send(new HeadObjectCommand({
            Bucket: bucketName,
            Key: key
        }));
        
        console.log(`[${requestId}] Object exists: s3://${bucketName}/${key}`);
        return true;
        
    } catch (error: any) {
        if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
            console.log(`[${requestId}] Object not found: s3://${bucketName}/${key}`);
            return false;
        }
        
        console.error(`[${requestId}] Error checking object existence s3://${bucketName}/${key}:`, error);
        throw error;
    }
}

async function getEmbeddingMetadata(documentId: string, requestId: string): Promise<EmbeddingMetadata | null> {
    try {
        const embeddingsKey = `embeddings/${documentId}.json`;
        
        const command = new HeadObjectCommand({
            Bucket: EMBEDDINGS_BUCKET,
            Key: embeddingsKey
        });
        
        const response = await s3Client.send(command);
        
        // Extract metadata from S3 object metadata
        const metadata: EmbeddingMetadata = {
            documentId,
            embeddingModel: response.Metadata?.['embedding-model'] || 'amazon.titan-embed-text-v1',
            vectorDimensions: parseInt(response.Metadata?.['vector-dimensions'] || '1536'),
            embeddingCount: parseInt(response.Metadata?.['embedding-count'] || '0'),
            processingStartTime: response.Metadata?.['processing-start-time'] || new Date().toISOString(),
            processingEndTime: response.Metadata?.['processing-end-time'] || new Date().toISOString(),
            processingDurationMs: parseInt(response.Metadata?.['processing-duration-ms'] || '0')
        };
        
        console.log(`[${requestId}] Retrieved embedding metadata for document ${documentId}:`, metadata);
        return metadata;
        
    } catch (error) {
        console.error(`[${requestId}] Error getting embedding metadata for ${documentId}:`, error);
        return null;
    }
}

async function checkEmbeddingError(documentId: string, requestId: string): Promise<DocumentStatus | null> {
    try {
        // Check for error status files in embedding status bucket
        const errorKey = `errors/${documentId}.json`;
        const errorExists = await checkS3ObjectExists(EMBEDDING_STATUS_BUCKET, errorKey, requestId);
        
        if (errorExists) {
            console.log(`[${requestId}] Found embedding error status for document ${documentId}`);
            
            // Get error details from metadata
            const command = new HeadObjectCommand({
                Bucket: EMBEDDING_STATUS_BUCKET,
                Key: errorKey
            });
            
            const response = await s3Client.send(command);
            
            return {
                documentId,
                status: 'failed',
                stage: 'embedding',
                timestamp: new Date().toISOString(),
                metadata: {
                    errorMessage: response.Metadata?.['error-message'] || 'Embedding generation failed',
                    processingTime: parseInt(response.Metadata?.['processing-duration-ms'] || '0')
                }
            };
        }
        
        return null;
        
    } catch (error) {
        console.error(`[${requestId}] Error checking embedding error for ${documentId}:`, error);
        return null;
    }
}

async function checkProcessedContentExists(documentId: string, requestId: string): Promise<boolean> {
    try {
        // Check for processed content file
        const processedContentKey = `processed/${documentId}.json`;
        const exists = await checkS3ObjectExists(PROCESSED_CONTENT_BUCKET, processedContentKey, requestId);
        
        console.log(`[${requestId}] Processed content exists check for ${documentId}: ${exists}`);
        return exists;
        
    } catch (error) {
        console.error(`[${requestId}] Error checking processed content existence for ${documentId}:`, error);
        return false;
    }
} 
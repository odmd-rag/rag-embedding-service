import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

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
    
    try {
        const embeddingStatus = await findDocumentEmbeddingStatus(documentId, requestId);
        
        if (embeddingStatus) {
            return embeddingStatus;
        }
        
        const processedContentExists = await checkProcessedContentExists(documentId, requestId);
        
        if (processedContentExists) {
            console.log(`[${requestId}] Document ${documentId} processed but embeddings not started`);
            
            return {
                documentId,
                status: 'pending',
                stage: 'embedding',
                timestamp: new Date().toISOString(),
                metadata: {
                    processingTime: Date.now() - startTime,
                    errorMessage: 'Document processed but embedding generation not started yet'
                }
            };
        } else {
            console.log(`[${requestId}] Document ${documentId} not yet processed`);
            
            return {
                documentId,
                status: 'pending',
                stage: 'embedding',
                timestamp: new Date().toISOString(),
                metadata: {
                    errorMessage: 'Document not yet processed - prerequisite for embedding generation'
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

async function findDocumentEmbeddingStatus(documentId: string, requestId: string): Promise<DocumentStatus | null> {
    try {
        const embeddingKeys = [
            `embeddings/${documentId}/chunk-0.json`,
            `embeddings/${documentId}/chunk-1.json`,
            `embeddings/${documentId}/chunk-2.json`
        ];
        
        for (const embeddingKey of embeddingKeys) {
            try {
                const response = await s3Client.send(new HeadObjectCommand({
                    Bucket: EMBEDDINGS_BUCKET,
                    Key: embeddingKey
                }));
                
                const processingStatus = response.Metadata?.['processing-status'] || 'unknown';
                const isPlaceholder = response.Metadata?.['placeholder'] === 'true';
                const chunkId = response.Metadata?.['chunk-id'] || 'unknown';
                const chunkIndex = parseInt(response.Metadata?.['chunk-index'] || '0');
                
                console.log(`[${requestId}] Found embedding object: ${embeddingKey}`);
                console.log(`[${requestId}]   Processing status: ${processingStatus}`);
                console.log(`[${requestId}]   Is placeholder: ${isPlaceholder}`);
                console.log(`[${requestId}]   Chunk ID: ${chunkId}`);
                
                if (processingStatus === 'completed' && !isPlaceholder) {
                    return {
                        documentId,
                        status: 'completed',
                        stage: 'embedding',
                        timestamp: response.Metadata?.['processed-at'] || new Date().toISOString(),
                        metadata: {
                            processingTime: parseInt(response.Metadata?.['processing-time-ms'] || '0'),
                            vectorDimensions: parseInt(response.Metadata?.['embedding-dimensions'] || '0'),
                            embeddingModel: response.Metadata?.['embedding-model'] || 'amazon.titan-embed-text-v2:0',
                            isPlaceholder: false,
                            chunkId: chunkId,
                            chunkIndex: chunkIndex
                        }
                    };
                } else if (processingStatus === 'failed') {
                    return {
                        documentId,
                        status: 'failed',
                        stage: 'embedding',
                        timestamp: response.Metadata?.['failed-at'] || new Date().toISOString(),
                        metadata: {
                            processingTime: parseInt(response.Metadata?.['processing-time-ms'] || '0'),
                            errorMessage: response.Metadata?.['error-message'] || 'Embedding generation failed',
                            isPlaceholder: true,
                            chunkId: chunkId,
                            chunkIndex: chunkIndex
                        }
                    };
                } else if (processingStatus === 'processing' && isPlaceholder) {
                    return {
                        documentId,
                        status: 'processing',
                        stage: 'embedding',
                        timestamp: response.Metadata?.['queued-at'] || new Date().toISOString(),
                        metadata: {
                            processingTime: Date.now() - new Date(response.Metadata?.['queued-at'] || new Date().toISOString()).getTime(),
                            isPlaceholder: true,
                            chunkId: chunkId,
                            chunkIndex: chunkIndex
                        }
                    };
                }
                
            } catch (error: any) {
                if (error.name === 'NotFound') {
                    continue;
                } else {
                    throw error;
                }
            }
        }
        
        return null;
        
    } catch (error) {
        console.error(`[${requestId}] Error finding embedding status for ${documentId}:`, error);
        throw error;
    }
}

async function checkProcessedContentExists(documentId: string, requestId: string): Promise<boolean> {
    try {
        const processedContentKey = `processed/${documentId}.json`;
        
        const response = await s3Client.send(new HeadObjectCommand({
            Bucket: PROCESSED_CONTENT_BUCKET,
            Key: processedContentKey
        }));
        
        const processingStatus = response.Metadata?.['processing-status'] || 'unknown';
        const isPlaceholder = response.Metadata?.['placeholder'] === 'true';
        
        const exists = processingStatus === 'completed' && !isPlaceholder;
        
        console.log(`[${requestId}] Processed content exists check for ${documentId}: ${exists}`);
        console.log(`[${requestId}]   Processing status: ${processingStatus}, Is placeholder: ${isPlaceholder}`);
        
        return exists;
        
    } catch (error: any) {
        if (error.name === 'NotFound') {
            console.log(`[${requestId}] Processed content not found for ${documentId}`);
            return false;
        }
        
        console.error(`[${requestId}] Error checking processed content existence for ${documentId}:`, error);
        throw error;
    }
} 
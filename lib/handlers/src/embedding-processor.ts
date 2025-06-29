import { SQSEvent, SQSRecord, Context, SQSBatchResponse, SQSBatchItemFailure, S3Event } from 'aws-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand, GetObjectTaggingCommand, PutObjectTaggingCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'crypto';

const s3Client = new S3Client();
const bedrockClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-2' });

const EMBEDDINGS_BUCKET = process.env.EMBEDDINGS_BUCKET!;

interface ProcessedContent {
    documentId: string;
    chunks: { content: string }[];
}

interface Embedding {
    chunkId: string;
    vector: number[];
}

export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
    const batchItemFailures: SQSBatchItemFailure[] = [];

    for (const record of event.Records) {
        try {
            await processDocument(record, context.awsRequestId);
        } catch (error) {
            console.error(`[${context.awsRequestId}] ❌ Failed to process record ${record.messageId}:`, error);
            batchItemFailures.push({ itemIdentifier: record.messageId });
        }
    }

    return { batchItemFailures };
};

async function processDocument(record: SQSRecord, requestId: string): Promise<void> {
    const startTime = Date.now();
    const { bucketName, objectKey, documentId } = parseS3Event(record);
    
    try {
        console.log(`[${requestId}] 🔍 Starting embedding processing for s3://${bucketName}/${objectKey}`);

        // Step 1: Verify the 'processing-status' tag
        const tags = await s3Client.send(new GetObjectTaggingCommand({ Bucket: bucketName, Key: objectKey }));
        const processingStatus = tags.TagSet?.find(tag => tag.Key === 'processing-status')?.Value;
        if (processingStatus !== 'completed') {
            console.log(`[${requestId}] ⏭️ Skipping document. Processing status is '${processingStatus || 'not set'}'.`);
            return;
        }
        console.log(`[${requestId}] ✅ Document approved for embedding.`);

        const placeholderKey = `embeddings/${documentId}.json`;
        await createProcessingPlaceholder(placeholderKey, documentId, bucketName, objectKey, requestId);

        const processedContent = await downloadProcessedContent(bucketName, objectKey, requestId);
        const textsToEmbed = processedContent.chunks.map(chunk => chunk.content);
        
        console.log(`[${requestId}] 🔍 Generating embeddings for ${textsToEmbed.length} chunks...`);
        const embeddings = await generateEmbeddings(textsToEmbed, requestId);
        
        await storeEmbeddingsAndTag(placeholderKey, documentId, processedContent, embeddings, Date.now() - startTime, requestId);

        console.log(`[${requestId}] ✅ Document embedding completed and tagged successfully.`);
        
    } catch (error) {
        const totalDuration = Date.now() - startTime;
        console.error(`[${requestId}] ❌ Failed to process document after ${totalDuration}ms:`, error);
        
        const placeholderKey = `embeddings/${documentId}.json`;
        await updatePlaceholderWithFailure(placeholderKey, documentId, error instanceof Error ? error.message : 'Unknown error', requestId);
        
        throw error;
    }
}

function parseS3Event(record: SQSRecord): { bucketName: string, objectKey: string, documentId: string } {
    const s3Event: S3Event = JSON.parse(record.body);
    const s3Record = s3Event.Records[0];
    const bucketName = s3Record.s3.bucket.name;
    const objectKey = decodeURIComponent(s3Record.s3.object.key.replace(/\+/g, ' '));
    const documentId = objectKey.split('/').pop()?.replace('.json', '') || `unknown-id-${randomUUID()}`;
    return { bucketName, objectKey, documentId };
}

async function createProcessingPlaceholder(objectKey: string, documentId: string, sourceBucket: string, sourceKey: string, requestId: string): Promise<void> {
    const placeholder = { documentId, status: 'processing', startedAt: new Date().toISOString(), source: { bucket: sourceBucket, key: sourceKey } };
    await s3Client.send(new PutObjectCommand({
        Bucket: EMBEDDINGS_BUCKET,
        Key: objectKey,
        Body: JSON.stringify(placeholder, null, 2),
        ContentType: 'application/json'
    }));
    await s3Client.send(new PutObjectTaggingCommand({
        Bucket: EMBEDDINGS_BUCKET,
        Key: objectKey,
        Tagging: { TagSet: [{ Key: 'embedding-status', Value: 'processing' }] }
    }));
}

async function downloadProcessedContent(bucketName: string, objectKey: string, requestId: string): Promise<ProcessedContent> {
    const command = new GetObjectCommand({ Bucket: bucketName, Key: objectKey });
    const response = await s3Client.send(command);
    return JSON.parse(await response.Body!.transformToString());
}

async function generateEmbeddings(texts: string[], requestId: string): Promise<Embedding[]> {
    const embeddings: Embedding[] = [];
    for (const text of texts) {
        const command = new InvokeModelCommand({
            modelId: 'amazon.titan-embed-text-v2:0',
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({ inputText: text }),
        });
        const response = await bedrockClient.send(command);
        embeddings.push({
            chunkId: randomUUID(),
            vector: JSON.parse(new TextDecoder().decode(response.body)).embedding,
        });
    }
    return embeddings;
}

async function storeEmbeddingsAndTag(objectKey: string, documentId: string, originalContent: ProcessedContent, embeddings: Embedding[], durationMs: number, requestId: string): Promise<void> {
    const finalData = {
        documentId, status: 'completed', completedAt: new Date().toISOString(),
        processingTimeMs: durationMs, embeddingModel: 'amazon.titan-embed-text-v2:0',
        originalChunks: originalContent.chunks, embeddings,
    };
    await s3Client.send(new PutObjectCommand({
        Bucket: EMBEDDINGS_BUCKET,
        Key: objectKey,
        Body: JSON.stringify(finalData, null, 2),
        ContentType: 'application/json'
    }));
    await s3Client.send(new PutObjectTaggingCommand({
        Bucket: EMBEDDINGS_BUCKET,
        Key: objectKey,
        Tagging: { TagSet: [{ Key: 'embedding-status', Value: 'completed' }, { Key: 'document-id', Value: documentId }] }
    }));
}

async function updatePlaceholderWithFailure(objectKey: string, documentId: string, errorMessage: string, requestId: string): Promise<void> {
    const failureRecord = { documentId, status: 'failed', failedAt: new Date().toISOString(), error: errorMessage };
    await s3Client.send(new PutObjectCommand({
        Bucket: EMBEDDINGS_BUCKET,
        Key: objectKey,
        Body: JSON.stringify(failureRecord, null, 2),
        ContentType: 'application/json'
    }));
    await s3Client.send(new PutObjectTaggingCommand({
        Bucket: EMBEDDINGS_BUCKET,
        Key: objectKey,
        Tagging: { TagSet: [{ Key: 'embedding-status', Value: 'failed' }, { Key: 'error-message', Value: errorMessage.substring(0, 255) }] }
    }));
} 
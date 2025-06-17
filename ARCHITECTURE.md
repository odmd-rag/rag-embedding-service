# RAG Embedding Service - Architecture

## Overview

The RAG Embedding Service is a serverless AWS service that generates vector embeddings from processed document chunks using OpenAI's embedding models. It uses S3 polling for reliable data ingestion and SQS for scalable processing.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                            RAG Embedding Service                                    │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│  ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐                │
│  │   EventBridge   │    │  S3 Processed    │    │   DynamoDB      │                │
│  │   Scheduler     │───▶│  Content Bucket  │◀───│  Checkpoint     │                │
│  │  (1 minute)     │    │                  │    │  Table          │                │
│  └─────────────────┘    └──────────────────┘    └─────────────────┘                │
│           │                        │                        ▲                      │
│           │                        │                        │                      │
│           ▼                        ▼                        │                      │
│  ┌─────────────────┐    ┌──────────────────┐               │                      │
│  │ S3 Poller       │    │                  │               │                      │
│  │ Lambda          │───▶│   SQS Queue      │               │                      │
│  │                 │    │ (Embedding Tasks)│               │                      │
│  └─────────────────┘    └──────────────────┘               │                      │
│           │                        │                        │                      │
│           │                        │                        │                      │
│           └────────────────────────┼────────────────────────┘                      │
│                                    │                                               │
│                                    ▼                                               │
│                          ┌──────────────────┐                                     │
│                          │ Embedding        │                                     │
│                          │ Processor        │                                     │
│                          │ Lambda           │                                     │
│                          └──────────────────┘                                     │
│                                    │                                               │
│                                    ▼                                               │
│                          ┌──────────────────┐                                     │
│                          │   OpenAI API     │                                     │
│                          │  (Embeddings)    │                                     │
│                          └──────────────────┘                                     │
│                                    │                                               │
│                                    ▼                                               │
│  ┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐                │
│  │ S3 Embeddings   │    │ S3 Embedding     │    │   SQS Dead      │                │
│  │ Bucket          │◀───│ Status Bucket    │    │ Letter Queue    │                │
│  │                 │    │                  │    │                 │                │
│  └─────────────────┘    └──────────────────┘    └─────────────────┘                │
│           │                                                                        │
│           │                                                                        │
└───────────┼────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                        Vector Storage Service                                      │
│                           (Downstream)                                             │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. S3 Poller Lambda

**Purpose**: Polls the processed content S3 bucket for new files and queues embedding tasks.

**Trigger**: EventBridge scheduled rule (every 1 minute)

**Key Features**:
- **Checkpoint-based Processing**: Uses DynamoDB to track last processed file
- **Contiguous Processing**: Only updates checkpoint after successful processing to maintain order
- **Batch Processing**: Configurable batch size for optimal performance
- **Error Handling**: Stops processing on first error to prevent gaps

**Processing Flow**:
1. Retrieve current checkpoint from DynamoDB
2. List new files in S3 bucket since checkpoint
3. For each file:
   - Download and parse JSON content
   - Extract individual chunks
   - Send each chunk as SQS message to embedding queue
4. Update checkpoint to last successfully processed file

**Memory**: 1024 MB
**Timeout**: 15 minutes
**Concurrency**: 1 (to ensure sequential processing)

### 2. Embedding Processor Lambda

**Purpose**: Generates embeddings for text chunks using OpenAI API.

**Trigger**: SQS messages from embedding queue

**Key Features**:
- **OpenAI Integration**: Uses `text-embedding-3-small` model
- **Batch Processing**: Processes up to 10 messages per invocation
- **Retry Logic**: 3 retries with exponential backoff via SQS
- **Result Storage**: Stores embeddings as JSON files in S3

**Processing Flow**:
1. Receive batch of embedding tasks from SQS
2. For each task:
   - Extract text content from chunk
   - Call OpenAI embeddings API
   - Generate 1536-dimensional vector
   - Store result in S3 embeddings bucket
3. Messages are automatically deleted from queue on success

**Memory**: 2048 MB
**Timeout**: 15 minutes
**Batch Size**: 10 messages
**Max Batching Window**: 5 seconds

### 3. SQS Queue

**Purpose**: Decouples S3 polling from embedding generation for scalability.

**Configuration**:
- **Visibility Timeout**: 15 minutes (matches Lambda timeout)
- **Message Retention**: 14 days
- **Dead Letter Queue**: 3 max receive count
- **Batch Size**: 10 messages per Lambda invocation

**Message Format**:
```json
{
  "documentId": "uuid",
  "processingId": "uuid", 
  "chunkId": "uuid",
  "chunkIndex": 0,
  "content": "text content to embed",
  "originalDocumentInfo": { ... },
  "timestamp": 1704110400000,
  "source": "processed-content-polling"
}
```

### 4. DynamoDB Checkpoint Table

**Purpose**: Tracks processing progress for reliable S3 polling.

**Schema**:
- **Partition Key**: `serviceId` (string) - e.g., "embedding-processor-1"
- **Attributes**:
  - `lastProcessedTimestamp`: ISO timestamp of last processed file
  - `lastProcessedKey`: S3 key of last processed file
  - `updatedAt`: When checkpoint was last updated

**Billing Mode**: Pay-per-request

### 5. S3 Buckets

#### Embeddings Bucket
- **Purpose**: Stores generated embedding JSON files
- **Naming**: `rag-embeddings-{account}-{region}`
- **Access**: Vector storage service reads from this bucket

#### Embedding Status Bucket
- **Purpose**: Stores processing status and metrics
- **Naming**: `rag-embedding-status-{account}-{region}`
- **Access**: Monitoring and debugging

## Data Flow

### Input: Processed Content

Files in S3 processed content bucket with format:
```
{timestamp}-{hash}.json
```

Content structure:
```json
{
  "documentId": "uuid",
  "processingId": "uuid",
  "processedContent": {
    "chunks": [
      {
        "chunkId": "uuid",
        "chunkIndex": 0,
        "content": "text to embed",
        "startOffset": 0,
        "endOffset": 1000
      }
    ],
    "metadata": { ... }
  },
  "originalDocumentInfo": { ... }
}
```

### Output: Embeddings

Files in S3 embeddings bucket with format:
```
{timestamp}-{documentId}-{chunkId}.json
```

Content structure:
```json
{
  "documentId": "uuid",
  "chunkId": "uuid", 
  "embedding": [0.1, 0.2, 0.3, ...], // 1536 dimensions
  "content": "original text",
  "embeddingMetadata": {
    "model": "text-embedding-3-small",
    "dimensions": 1536,
    "tokenCount": 245,
    "processingTimeMs": 1200
  },
  "processedAt": "2024-01-01T12:00:05Z"
}
```

## Scaling Characteristics

### Horizontal Scaling

**S3 Poller**:
- Single instance ensures sequential processing
- Can process up to 1000 files per minute (configurable)
- Scales by increasing batch size or polling frequency

**Embedding Processor**:
- Auto-scales based on SQS queue depth
- Up to 1000 concurrent executions (AWS default)
- Each execution processes 10 chunks (configurable)

### Performance Metrics

**Throughput**:
- S3 Poller: ~1000 files/minute
- Embedding Processor: ~10,000 chunks/minute (with 1000 concurrent executions)

**Latency**:
- File-to-Queue: ~1 minute (polling interval)
- Queue-to-Embedding: ~2-5 seconds (OpenAI API call)
- End-to-end: ~1-2 minutes per chunk

**Cost Optimization**:
- Pay-per-execution Lambda pricing
- No idle costs (serverless)
- Efficient OpenAI token usage

## Error Handling

### S3 Poller Errors

**File Parse Errors**:
- Log error and skip file
- Do not update checkpoint
- Manual intervention required

**S3 Access Errors**:
- Retry with exponential backoff
- Alert on persistent failures
- Check IAM permissions

**SQS Send Errors**:
- Retry individual chunks
- Log failed chunks for manual processing
- Monitor queue depth

### Embedding Processor Errors

**OpenAI API Errors**:
- Rate limiting: Exponential backoff
- Invalid input: Log and send to DLQ
- Network errors: Retry via SQS

**S3 Write Errors**:
- Retry with backoff
- Log for manual reprocessing
- Monitor bucket permissions

**Memory Errors**:
- Reduce batch size
- Increase Lambda memory
- Monitor large chunks

## Security

### IAM Roles

**S3 Poller Role**:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetObject"
      ],
      "Resource": [
        "arn:aws:s3:::rag-processed-content-*",
        "arn:aws:s3:::rag-processed-content-*/*"
      ]
    },
    {
      "Effect": "Allow", 
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem"
      ],
      "Resource": "arn:aws:dynamodb:*:*:table/rag-embedding-checkpoints-*"
    },
    {
      "Effect": "Allow",
      "Action": "sqs:SendMessage",
      "Resource": "arn:aws:sqs:*:*:rag-embedding-queue-*"
    }
  ]
}
```

**Embedding Processor Role**:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": [
        "arn:aws:s3:::rag-embeddings-*/*",
        "arn:aws:s3:::rag-embedding-status-*/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue", 
      "Resource": "arn:aws:secretsmanager:*:*:secret:rag/openai-api-key*"
    }
  ]
}
```

### Secrets Management

**OpenAI API Key**:
- Stored in AWS Secrets Manager
- Secret name: `rag/openai-api-key`
- Accessed only by embedding processor
- Cached in Lambda memory for performance

### Network Security

**No VPC Required**:
- All services are AWS managed
- HTTPS for all API calls
- No custom networking needed

**Cross-Service Access**:
- S3 bucket policies for downstream services
- Principal-based access control
- Account-level isolation

## Monitoring

### CloudWatch Metrics

**Custom Metrics**:
- `EmbeddingService.FilesProcessed`: Files processed per poller invocation
- `EmbeddingService.ChunksQueued`: Chunks sent to SQS queue
- `EmbeddingService.EmbeddingsGenerated`: Successful embeddings created
- `EmbeddingService.OpenAIErrors`: Failed OpenAI API calls
- `EmbeddingService.ProcessingLag`: Time between file creation and processing

**AWS Metrics**:
- Lambda invocations, duration, errors
- SQS queue depth, messages sent/received
- DynamoDB read/write capacity
- S3 request metrics

### Alarms

**Critical Alarms**:
- S3 Poller failures (> 5 in 15 minutes)
- High SQS queue depth (> 10,000 messages)
- OpenAI API error rate (> 10% in 5 minutes)
- DLQ message count (> 100 messages)

**Warning Alarms**:
- Processing lag (> 10 minutes)
- Lambda memory usage (> 80%)
- OpenAI token usage (approaching limits)

### Logging

**Structured Logging**:
```json
{
  "timestamp": "2024-01-01T12:00:00Z",
  "requestId": "uuid",
  "level": "INFO",
  "service": "embedding-service",
  "component": "s3-poller",
  "message": "Processing object 1/15",
  "metadata": {
    "objectKey": "2024-01-01T12:00:02.123Z-abc123.json",
    "fileSize": 1048576,
    "chunkCount": 72
  }
}
```

**Log Retention**: 7 days (configurable)

## Disaster Recovery

### Backup Strategy

**DynamoDB Checkpoint Table**:
- Point-in-time recovery enabled
- Cross-region backup for production
- Daily snapshots

**S3 Buckets**:
- Versioning enabled
- Cross-region replication for production
- Lifecycle policies for cost optimization

### Recovery Procedures

**Checkpoint Loss**:
1. Identify last known good checkpoint
2. Reset checkpoint to safe timestamp
3. Reprocess files from that point
4. Monitor for duplicates downstream

**Complete Service Failure**:
1. Deploy service to backup region
2. Restore checkpoint from backup
3. Update DNS/routing if needed
4. Resume processing

**Data Corruption**:
1. Identify scope of corruption
2. Stop processing affected timeframe
3. Regenerate embeddings from source
4. Validate downstream consistency

## Future Enhancements

### Performance Optimizations

**Parallel Processing**:
- Multiple S3 poller instances with partition keys
- Parallel embedding generation within documents
- Batch OpenAI API calls

**Caching**:
- Redis cache for frequently accessed embeddings
- CDN for static embedding data
- Lambda provisioned concurrency

### Feature Additions

**Multi-Model Support**:
- Support for different embedding models
- A/B testing of embedding quality
- Model versioning and migration

**Real-time Processing**:
- S3 event notifications for immediate processing
- WebSocket for real-time status updates
- Stream processing for high-volume scenarios

**Enhanced Monitoring**:
- Embedding quality metrics
- Cost tracking and optimization
- Performance benchmarking 
# RAG Embedding Service - Architecture

## Overview

The RAG Embedding Service is a serverless AWS service that generates vector embeddings from processed document chunks using AWS Bedrock's Titan Embed model. It uses S3 event notifications for immediate processing triggers and SQS dynamic batching for scalable processing.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                            RAG Embedding Service                                    │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                     │
│                           ┌──────────────────┐                                     │
│                           │  S3 Processed    │                                     │
│                           │  Content Bucket  │                                     │
│                           │(Event Triggered) │                                     │
│                           └──────────────────┘                                     │
│                                    │                                               │
│                                    │ S3 Event Notification                        │
│                                    │ (Immediate)                                   │
│                                    ▼                                               │
│                           ┌──────────────────┐                                     │
│                           │   SQS Queue      │                                     │
│                           │(Dynamic Batching)│                                     │
│                           └──────────────────┘                                     │
│                                    │                                               │
│                                    │ Batch Processing                              │
│                                    ▼                                               │
│                          ┌──────────────────┐                                     │
│                          │ Embedding        │                                     │
│                          │ Processor        │                                     │
│                          │ Lambda           │                                     │
│                          └──────────────────┘                                     │
│                                    │                                               │
│                                    ▼                                               │
│                          ┌──────────────────┐                                     │
│                          │ AWS Bedrock API  │                                     │
│                          │ (Titan Embed)    │                                     │
│                          └──────────────────┘                                     │
│                                    │                                               │
│                                    ▼                                               │
│  ┌─────────────────┐                                       ┌─────────────────┐     │
│  │ S3 Embeddings   │                                       │   SQS Dead      │     │
│  │ Bucket          │◀──────────────────────────────────────│ Letter Queue    │     │
│  │                 │                                       │                 │     │
│  └─────────────────┘                                       └─────────────────┘     │
│           │                                                                        │
│           │ S3 Event Notification                                                 │
└───────────┼────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                        Vector Storage Service                                      │
│                           (Downstream)                                             │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. S3 Event Notifications

**Purpose**: Immediate triggering when processed content files are created in S3.

**Trigger**: S3 Object Created events (instant processing)

**Key Features**:
- **Zero Latency**: Events fire immediately when files are created
- **No Polling Overhead**: Eliminated scheduled Lambda executions
- **Automatic Scaling**: SQS dynamic batching handles volume spikes
- **Reliable Delivery**: S3 event notifications guarantee delivery

**Processing Flow**:
1. Document processing service creates processed content file
2. S3 automatically sends event notification to SQS queue
3. SQS dynamically batches messages for optimal Lambda utilization
4. Lambda processes batches with parallel execution
5. Individual failures retry independently

**Memory**: No dedicated poller Lambda - eliminated
**Latency**: 0-20 seconds (vs 0-5 minutes with polling)
**Cost**: Pay only when files are processed

### 2. Embedding Processor Lambda

**Purpose**: Generates embeddings for text chunks using AWS Bedrock Titan Embed API.

**Trigger**: SQS messages with dynamic batching

**Key Features**:
- **AWS Bedrock Integration**: Uses `amazon.titan-embed-text-v2:0` model
- **Dynamic Batching**: AWS automatically optimizes batch sizes
- **Individual Retries**: Failed items retry independently with `reportBatchItemFailures`
- **Result Storage**: Stores embeddings as JSON files in S3

**Processing Flow**:
1. Receive dynamically batched messages from SQS
2. Process multiple chunks in parallel (max 5 concurrent)
3. For each chunk:
   - Extract text content
   - Call AWS Bedrock embeddings API
   - Generate 1024-dimensional vector
   - Store result in S3 embeddings bucket
4. Return batch response with individual failure tracking

**Memory**: 1024 MB
**Timeout**: 5 minutes
**Dynamic Batch Size**: 1-1000 messages (AWS managed)
**Max Batching Window**: 20 seconds

### 3. SQS Queue with Dynamic Batching

**Purpose**: Receives S3 events and optimally batches them for Lambda processing.

**Configuration**:
- **Visibility Timeout**: 5 minutes (matches Lambda timeout)
- **Message Retention**: 14 days
- **Dead Letter Queue**: 3 max receive count
- **Dynamic Batching**: AWS automatically adjusts batch sizes
- **Max Concurrency**: 8 Lambda executions

**Message Format**:
```json
{
  "Records": [
    {
      "s3": {
        "bucket": {
          "name": "rag-processed-content-account-region"
        },
        "object": {
          "key": "processed/timestamp-hash.json"
        }
      }
    }
  ]
}
```

### 4. Dead Letter Queue (DLQ)

**Purpose**: Handles failed embedding processing with retry mechanisms.

**Configuration**:
- **Max Receive Count**: 3 retries before DLQ
- **DLQ Handler**: Processes failed messages for analysis
- **Retention**: 14 days for failure investigation
- **Alerting**: CloudWatch alarms on DLQ messages

### 5. S3 Buckets

#### Embeddings Bucket
- **Purpose**: Stores generated embedding JSON files
- **Naming**: `rag-embeddings-{account}-{region}`
- **Access**: Vector storage service consumes via event notifications

#### Processed Content Bucket (Input)
- **Purpose**: Receives processed content from document processing service
- **Event Configuration**: Object Created → SQS notifications
- **File Pattern**: `processed/*.json`

## Data Flow

### Input: S3 Event Notification

Immediate event when processed content is created:
```json
{
  "Records": [
    {
      "eventSource": "aws:s3",
      "eventName": "ObjectCreated:Put",
      "s3": {
        "bucket": {
          "name": "rag-processed-content-account-region"
        },
        "object": {
          "key": "processed/2024-01-01T12:00:00Z-abc123.json"
        }
      }
    }
  ]
}
```

### Processing: Content Extraction

Lambda downloads and processes S3 object:
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

Files in S3 embeddings bucket:
```json
{
  "documentId": "uuid",
  "chunkId": "uuid", 
  "embedding": [0.1, 0.2, 0.3, ...], // 1024 dimensions
  "content": "original text",
  "embeddingMetadata": {
    "model": "amazon.titan-embed-text-v2:0",
    "dimensions": 1024,
    "tokenCount": 245,
    "processingTimeMs": 800
  },
  "processedAt": "2024-01-01T12:00:05Z",
  "source": "s3-event-notification"
}
```

## Scaling Characteristics

### Event-Driven Scaling

**S3 Event Notifications**:
- Infinite scalability - no polling bottlenecks
- Immediate processing start (vs 1-minute polling delay)
- No resource consumption when idle

**Embedding Processor**:
- Auto-scales based on SQS message volume
- Dynamic batching optimizes Lambda utilization
- Up to 8 concurrent executions (configurable)
- Each execution processes 1-1000 chunks (AWS managed)

### Performance Metrics

**Throughput**:
- Event Notifications: Unlimited (instant S3 event delivery)
- Embedding Processor: ~8,000 chunks/minute (with 8 concurrent executions)
- Dynamic scaling handles volume spikes automatically

**Latency**:
- Event-to-Queue: ~1-5 seconds (S3 event notification)
- Queue-to-Processing: 0-20 seconds (dynamic batching window)
- Processing-to-Output: ~200-500ms (Bedrock API call)
- End-to-end: ~20-45 seconds per chunk (vs 1-5 minutes with polling)

**Cost Optimization**:
- 95% reduction in Lambda executions (no constant polling)
- Pay only for actual document processing
- AWS Bedrock ~90% cheaper than OpenAI API
- Dynamic batching optimizes compute utilization

## Error Handling

### S3 Event Processing Errors

**File Access Errors**:
- Individual retry via `reportBatchItemFailures`
- Failed items go to DLQ after 3 attempts
- Successful items in batch continue processing

**Bedrock API Errors**:
- Individual chunk retries (not entire batch)
- DLQ handler processes persistent failures
- CloudWatch alarms on error patterns

### Dead Letter Queue Processing

**DLQ Handler Features**:
- Analyzes failed message patterns
- Detailed error logging for debugging
- Manual reprocessing capabilities
- Failure metrics for monitoring

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
# RAG Embedding Service

**Production-ready serverless service** for cost-effective text embedding generation using **AWS Bedrock's Titan Embed models**.

## Architecture Overview

The RAG Embedding Service is a **serverless AWS service** that generates vector embeddings from processed document chunks using **AWS Bedrock Titan Embed models**. It leverages hierarchical IAM role naming for secure cross-service access and uses S3 polling for reliable data ingestion. The embeddings are stored in S3 and consumed by the **Vector Storage Service**, which manages the vector database operations.

### Key Components

1. **S3 Poller Lambda** (`EmbS3PollerHandler`): Monitors document processing bucket for new content
2. **SQS Queue** (`EmbProcessingQueue`): Decouples polling from processing for reliable message handling  
3. **Embedding Processor Lambda** (`EmbProcessorHandler`): Generates embeddings via **AWS Bedrock API**, stores results in S3
4. **DLQ Handler** (`EmbDlqHandler`): Processes failed embedding attempts with error analysis
5. **Status Tracking**: Separate S3 bucket for processing status and monitoring

### Technology Stack

- **AWS Bedrock**: AI service for **Titan Embed text-v2** model access
- **AWS Lambda**: Serverless compute for stateless embedding generation
- **Amazon S3**: Storage for embeddings and processing status
- **Amazon SQS**: Message queuing for reliable processing
- **Amazon DynamoDB**: Checkpoint tracking for S3 polling
- **Amazon EventBridge**: Scheduled S3 polling every minute

## Embedding Model Details

### AWS Bedrock Titan Embed v2
- **Model ID**: `amazon.titan-embed-text-v2:0`
- **Dimensions**: 1024 (optimized for cost and performance)
- **Max Input**: 8,192 tokens per request
- **Cost**: ~90% cheaper than OpenAI API
- **Latency**: Typically 200-500ms per request
- **Integration**: Native AWS IAM, no API keys required

### Why Bedrock vs OpenAI?
- ✅ **Cost Optimization**: Significantly lower per-token costs
- ✅ **Zero External Dependencies**: No internet egress or API key management
- ✅ **Better Security**: IAM-based permissions, no secret keys
- ✅ **Regional Deployment**: No cross-region API calls
- ✅ **AWS Integration**: Native CloudWatch monitoring and logging

## 🏗️ Architecture Overview

### **Data Flow**

```
Document Processing Service → Processed Content S3 Bucket → EventBridge Scheduler → S3 Poller Lambda → SQS Queue → Embedding Processor Lambda → Embeddings S3 Bucket → Vector Storage Service
                                                ↓                                           ↓                                              ↓
                                         DynamoDB Checkpoint Table                   Dead Letter Queue                    Status API (WebUI Integration)
```

### **NOT** Connected to Home Vector Server

**Important**: The embedding service does **NOT** directly connect to the home vector server. The data flow is:

1. **Embedding Service** → Stores embeddings in S3
2. **Vector Storage Service** → Reads embeddings from S3 → Stores in vector database (which could be the home vector server)

The **home-vector-server** is a separate development tool, not part of the main ondemandenv.dev pipeline.

## 🎯 OndemandEnv Integration

This service follows OndemandEnv platform patterns:

### **Contract Dependencies**
- **Consumes**: Processed content from `rag-document-processing-service`
- **Produces**: Embeddings for `rag-vector-storage-service`

### **Contract Implementation**
```typescript
// Consuming from document processing service
const processedContentBucketName = myEnver.processedContentSubscription.getSharedValue(this);

// Producing for vector storage service
new OdmdShareOut(this, new Map([
    [myEnver.embeddingStorage.embeddingsBucket, embeddingsBucket.bucketName],
    [myEnver.embeddingStorage.embeddingStatusBucket, embeddingStatusBucket.bucketName],
    [myEnver.statusApi.statusApiEndpoint, `https://${this.apiDomain}/status`],
]));
```

## 🚀 Features

### **Embedding Generation**
- **AWS Bedrock Integration**: Uses `amazon.titan-embed-text-v2:0` model for high-quality embeddings
- **Batch Processing**: Processes multiple chunks in parallel with configurable batch sizes
- **Checkpoint Recovery**: Resumes processing from last checkpoint after failures
- **Cost Optimization**: Efficient token usage and no external API costs

### **Serverless Benefits**
- **No VPC**: Pure Lambda functions for maximum scalability
- **Cost Effective**: Pay-per-execution pricing with automatic scaling
- **High Availability**: Multi-AZ deployment with built-in redundancy
- **Auto Scaling**: Handles varying workloads automatically

### **Reliability Features**
- **3-Retry Logic**: SQS-based retry with exponential backoff
- **Dead Letter Queue**: Persistent storage for failed embedding tasks
- **Progress Tracking**: DynamoDB checkpoint system for reliable processing
- **Error Handling**: Comprehensive error categorization and recovery

## 🛠️ Development

### **Prerequisites**
```bash
# Node.js 22+ and npm
node --version  # >= 22.0.0
npm --version

# AWS CDK CLI
npm install -g aws-cdk
cdk --version   # >= 2.110.0

# AWS Bedrock Access
# Ensure your AWS account has Bedrock enabled in the target region
```

### **Setup**
```bash
# Install dependencies
npm install

# Build handlers project
npm run build:handlers

# Build main project
npm run build
```

### **Deploy**
```bash
# Configure AWS credentials
aws configure

# Deploy to development environment
npx cdk deploy --require-approval never

# Check deployment status
npx cdk diff
```

## 📊 Processing Flow

### **1. S3 Polling**
The S3 Poller Lambda runs every minute to check for new processed content files:

```typescript
// Polls for files matching pattern: YYYY-MM-DDTHH:mm:ss.sssZ-{hash}.json
const newObjects = await listNewProcessedContent(checkpoint);
```

### **2. Content Processing**
For each processed content file:

```json
{
  "documentId": "uuid",
  "processingId": "uuid", 
  "originalDocumentInfo": {
    "bucketName": "ingestion-bucket",
    "objectKey": "documents/file.pdf",
    "contentType": "application/pdf",
    "fileSize": 1048576
  },
  "processedContent": {
    "extractedText": "",
    "chunks": [
      {
        "chunkId": "uuid",
        "chunkIndex": 0,
        "content": "First chunk content...",
        "startOffset": 0,
        "endOffset": 1000
      }
    ],
    "metadata": {
      "totalChunks": 5,
      "averageChunkSize": 950,
      "chunkingStrategy": "SENTENCE_BOUNDARY",
      "language": "en",
      "processingTimeMs": 2500,
      "originalTextLength": 4750
    }
  },
  "processedAt": "2024-01-01T12:00:02Z",
  "source": "document-processing"
}
```

### **3. Embedding Task Creation**
Each chunk becomes an embedding task:

```json
{
  "documentId": "uuid",
  "processingId": "uuid",
  "chunkId": "uuid", 
  "chunkIndex": 0,
  "content": "First chunk content...",
  "originalDocumentInfo": { ... },
  "timestamp": 1704110400000,
  "source": "processed-content-polling"
}
```

### **4. Embedding Generation**
The Embedding Processor Lambda:
- Uses AWS Bedrock Titan Embed v2 model
- Calls Bedrock API with chunk content via IAM role
- Generates 1024-dimensional embedding vectors

### **5. Result Storage**
Embeddings are stored in S3 as JSON files:

```json
{
  "documentId": "uuid",
  "processingId": "uuid", 
  "chunkId": "uuid",
  "chunkIndex": 0,
  "embedding": [0.1, 0.2, 0.3, ...], // 1024 dimensions
  "content": "First chunk content...",
  "originalDocumentInfo": { ... },
  "embeddingMetadata": {
    "model": "amazon.titan-embed-text-v2:0",
    "dimensions": 1024,
    "tokenCount": 245,
    "processingTimeMs": 800
  },
  "processedAt": "2024-01-01T12:00:05Z",
  "source": "processed-content-polling"
}
```

## 🔧 Configuration

### **Environment Variables**

#### **S3 Poller Lambda**
```bash
PROCESSED_CONTENT_BUCKET_NAME=rag-processed-content-account-region
EMBEDDINGS_BUCKET_NAME=rag-embeddings-account-region
EMBEDDING_QUEUE_URL=https://sqs.region.amazonaws.com/account/rag-embedding-processing-queue-account-region
CHECKPOINT_TABLE_NAME=rag-embedding-checkpoint-account-region
BATCH_SIZE=50
SERVICE_ID=embedding-processor-1
AWS_ACCOUNT_ID=123456789012
```

#### **Embedding Processor Lambda**
```bash
EMBEDDINGS_BUCKET_NAME=rag-embeddings-account-region
EMBEDDING_STATUS_BUCKET_NAME=rag-embedding-status-account-region
AWS_ACCOUNT_ID=123456789012
```

### **AWS Bedrock Configuration**
```typescript
const embeddingModel = 'amazon.titan-embed-text-v2:0'; // 1024 dimensions
const maxTokens = 8192; // Model limit
const apiTimeout = 30000; // 30 seconds
```

### **Polling Configuration**
```typescript
const pollingInterval = 1; // minute
const batchSize = 50; // files per batch
const checkpointStrategy = 'contiguous'; // Only update on successful processing
```

## 📈 Monitoring & Observability

### **CloudWatch Metrics**
- **ProcessedContentFiles**: Number of files processed per invocation
- **EmbeddingTasksQueued**: Number of chunks sent to embedding queue
- **EmbeddingGenerationTime**: Time to generate embeddings
- **BedrockAPIErrors**: Failed API calls to Bedrock
- **CheckpointLag**: Time between file creation and processing

### **CloudWatch Logs**
Structured logging with request IDs for tracing:

```
[REQUEST_ID] === Processed Content S3 Poller Started ===
[REQUEST_ID] Found 15 new processed content files
[REQUEST_ID] 📄 Processing object 1/15: 2024-01-01T12:00:02.123Z-abc123.json
[REQUEST_ID] ✅ Successfully processed 15/15 files in 2500ms
```

### **DynamoDB Checkpoint Table**
```json
{
  "serviceId": "embedding-processor-1",
  "lastProcessedTimestamp": "2024-01-01T12:00:02.123Z",
  "lastProcessedKey": "2024-01-01T12:00:02.123Z-abc123.json",
  "updatedAt": "2024-01-01T12:00:05.456Z"
}
```

## 🔒 Security

### **IAM Permissions**

#### **S3 Poller Lambda** (`EmbS3PollerRole`)
- `s3:ListBucket` on processed content bucket
- `s3:GetObject` on processed content bucket
- `dynamodb:GetItem`, `dynamodb:PutItem` on checkpoint table
- `sqs:SendMessage` on embedding queue

#### **Embedding Processor Lambda** (`EmbProcessorRole`)
- `s3:PutObject` on embeddings bucket
- `s3:PutObject` on embedding status bucket
- `bedrock:InvokeModel` on Titan Embed model

### **Cross-Service Access**
```typescript
// Bucket policy for vector storage service access
embeddingsBucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'AllowVectorStorageServiceAccess',
    effect: iam.Effect.ALLOW,
    principals: [new iam.AccountPrincipal(this.account)],
    actions: ['s3:GetObject', 's3:ListBucket'],
    resources: [embeddingsBucket.bucketArn, `${embeddingsBucket.bucketArn}/*`],
    conditions: {
        'StringLike': {
            'aws:PrincipalArn': [
                `arn:aws:iam::${this.account}:role/RagVectorStorageStack-EmbeddingPoller*`,
                `arn:aws:iam::${this.account}:role/RagVectorStorageStack-VectorProcessor*`
            ]
        }
    }
}));
```

## 🧪 Testing

### **Unit Tests**
```bash
# Run all tests
npm test

# Run specific test suite
npm test -- --testNamePattern="embedding-processor"

# Run with coverage
npm test -- --coverage
```

### **Integration Tests**
```bash
# Test S3 polling functionality
npm run test:integration:poller

# Test embedding generation
npm run test:integration:embeddings

# Test end-to-end flow
npm run test:e2e
```

## 🚨 Troubleshooting

### **Common Issues**

#### **No Files Being Processed**
```bash
# Check if processed content bucket has files
aws s3 ls s3://rag-processed-content-{account}-{region}/

# Check checkpoint table
aws dynamodb get-item --table-name rag-embedding-checkpoint-{account}-{region} \
  --key '{"serviceId": {"S": "embedding-processor-1"}}'

# Check S3 poller logs
aws logs tail /aws/lambda/rag-embedding-s3-poller-{account}-{region}
```

#### **Bedrock API Errors**
```bash
# Check embedding processor logs
aws logs tail /aws/lambda/rag-embedding-processor-{account}-{region}

# Verify Bedrock access in region
aws bedrock list-foundation-models --region {region}

# Monitor API rate limits
aws cloudwatch get-metric-statistics --namespace AWS/Lambda \
  --metric-name Errors --dimensions Name=FunctionName,Value=rag-embedding-processor-{account}-{region}
```

#### **High Memory Usage**
```bash
# Monitor Lambda memory usage
aws cloudwatch get-metric-statistics --namespace AWS/Lambda \
  --metric-name MemoryUtilization --dimensions Name=FunctionName,Value=rag-embedding-processor-{account}-{region}

# Check for large chunks in processed content
aws s3api head-object --bucket rag-processed-content-{account}-{region} --key {object-key}
```

## 🔄 Deployment Pipeline

### **Development**
```bash
# Local development
npm run build:handlers
npm run build
npm test
npx cdk diff

# Deploy to dev environment
npx cdk deploy --profile dev
```

### **Production**
```bash
# Build and test
npm run build:handlers
npm run build
npm test

# Deploy to production
npx cdk deploy --profile prod --require-approval never
```

## 📊 CDK Construct Naming Convention

All CDK constructs use the "Emb" prefix for consistency:

- **Tables**: `EmbCheckpointTable`
- **Queues**: `EmbProcessingQueue`, `EmbProcessingDlq`
- **Buckets**: `EmbBucket`, `EmbStatusBucket`
- **Lambda Functions**: `EmbS3PollerHandler`, `EmbProcessorHandler`, `EmbDlqHandler`
- **IAM Roles**: `EmbS3PollerRole`, `EmbProcessorRole`, `EmbDlqRole`
- **API Gateway**: `EmbApi`, `EmbStatusHandler`
- **CloudWatch Alarms**: `EmbDlqAlarm`, `EmbProcessorErrorAlarm`

This naming convention ensures clear identification of resources and maintains consistency across the service.

## 🔗 Related Services

- **Document Processing Service**: Provides processed content input
- **Vector Storage Service**: Consumes embeddings output
- **ContractsLib RAG**: Defines service contracts and dependencies
- **User Auth**: Provides JWT authentication for status API

## License

This project is licensed under the MIT License. 
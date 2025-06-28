# RAG Embedding Service

**Production-ready serverless service** for cost-effective text embedding generation using **AWS Bedrock's Titan Embed models**.

## 🚀 Key Services

1. **Embedding Processor Lambda** (`EmbProcessorHandler`): Processes embedding generation from SQS messages
2. **Status Handler Lambda** (`EmbStatusHandler`): Provides HTTP API for status tracking
3. **DLQ Handler Lambda** (`EmbDlqHandler`): Handles failed processing messages

## 🛠️ Technology Stack

- **AWS Lambda**: Serverless compute for stateless embedding generation  
- **Amazon S3**: Storage for embeddings and processing status
- **Amazon SQS**: Message queuing for reliable processing with dynamic batching
- **AWS S3 Event Notifications**: Immediate triggering on new processed content

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

### **Data Flow (Event-Driven)**

```
Document Processing Service → Processed Content S3 Bucket → S3 Event Notification → SQS Queue → Embedding Processor Lambda → Embeddings S3 Bucket → Vector Storage Service
                                                                                          ↓                                              ↓
                                                                                   Dead Letter Queue                    Status API (WebUI Integration)
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
- **Event-Driven Processing**: Immediate processing via S3 event notifications with zero polling delay
- **Cost Optimization**: Efficient token usage and no external API costs

### **Serverless Benefits**
- **No VPC**: Pure Lambda functions for maximum scalability
- **Cost Effective**: Pay-per-execution pricing with automatic scaling
- **High Availability**: Multi-AZ deployment with built-in redundancy
- **Auto Scaling**: Handles varying workloads automatically

### **Reliability Features**
- **3-Retry Logic**: SQS-based retry with exponential backoff
- **Dead Letter Queue**: Persistent storage for failed embedding tasks
- **Batch Processing**: Parallel processing with configurable concurrency limits
- **Error Handling**: Comprehensive error categorization and recovery
- **Individual Retries**: Failed items retry independently using `reportBatchItemFailures`

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

### **1. S3 Event Notifications**
When new processed content files are created, S3 immediately sends notifications to SQS:

```typescript
// S3 triggers immediate notifications for files matching pattern: processed/*.json
// No polling delay - immediate processing when files are created
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

#### **Event-Driven Architecture**
*No environment variables needed for S3 polling - events trigger automatically*

#### **Embedding Processor Lambda**
```bash
EMBEDDINGS_BUCKET_NAME=rag-embeddings-account-region
AWS_ACCOUNT_ID=123456789012
```

### **AWS Bedrock Configuration**
```typescript
const embeddingModel = 'amazon.titan-embed-text-v2:0'; // 1024 dimensions
const maxTokens = 8192; // Model limit
const apiTimeout = 30000; // 30 seconds
```

### **Dynamic Batching Configuration**
```typescript
// SQS event source with dynamic batching
batchSize: 1,                               // Minimum (AWS scales up automatically)
maxBatchingWindow: cdk.Duration.seconds(20), // Max delay for processing
maxConcurrency: 8,                          // Parallel lambda control
reportBatchItemFailures: true,              // Individual failure handling
```

## 📈 Monitoring & Observability

### **CloudWatch Metrics**
- **EmbeddingTasksProcessed**: Number of chunks processed per invocation
- **EmbeddingGenerationTime**: Time to generate embeddings
- **BedrockAPIErrors**: Failed API calls to Bedrock
- **BatchProcessingTime**: Time to process SQS message batches

### **CloudWatch Logs**
Structured logging with request IDs for tracing:

```
[REQUEST_ID] === Embedding Processor Lambda Started ===
[REQUEST_ID] Records to process: 5
[REQUEST_ID] 📄 Processing SQS record 1/5: messageId-abc123
[REQUEST_ID] ✅ Successfully processed 5/5 records in 2500ms
```

## 🔒 Security

### **IAM Permissions**

#### **Embedding Processor Lambda** (`EmbProcessorRole`)
- `s3:GetObject` on processed content bucket (source files)
- `s3:PutObject` on embeddings bucket
- `bedrock:InvokeModel` on Titan Embed model
- `sqs:ReceiveMessage`, `sqs:DeleteMessage` on embedding queue

#### **Status Handler Lambda** (`EmbStatusRole`)
- `s3:GetObject` on processed content bucket
- `s3:GetObject` on embeddings bucket

### **Cross-Service Access**
```typescript
// Bucket policy for vector storage service access
embeddingsBucket.addToResourcePolicy(new iam.PolicyStatement({
    sid: 'AllowVectorStorageServiceAccess',
    effect: iam.Effect.ALLOW,
    principals: [new iam.AccountPrincipal(this.account)],
    actions: ['s3:GetObject', 's3:ListBucket'],
    resources: [embeddingsBucket.bucketArn, `${embeddingsBucket.bucketArn}/*`],
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
# Test event-driven processing
npm run test:integration:event-driven

# Test embedding generation
npm run test:integration:embeddings

# Test end-to-end flow
npm run test:e2e
```

### **Test event-driven functionality**
```bash
# Test event-driven functionality
npm run test:integration:event-driven
```

## 🚨 Troubleshooting

### **Common Issues**

#### **No Files Being Processed**
```bash
# Check if processed content bucket has files
aws s3 ls s3://rag-processed-content-{account}-{region}/

# Check SQS queue for pending messages
aws sqs get-queue-attributes --queue-url https://sqs.{region}.amazonaws.com/{account}/rag-embedding-processing-queue-{account}-{region}

# Check embedding processor logs
aws logs tail /aws/lambda/rag-embedding-processor-{account}-{region}
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

- **Queues**: `EmbProcessingQueue`, `EmbProcessingDlq`
- **Buckets**: `EmbBucket`
- **Lambda Functions**: `EmbProcessorHandler`, `EmbDlqHandler`, `EmbStatusHandler`
- **IAM Roles**: `EmbProcessorRole`, `EmbDlqRole`, `EmbStatusRole`
- **API Gateway**: `EmbApi`
- **CloudWatch Alarms**: `EmbDlqAlarm`, `EmbProcessorErrorAlarm`

This naming convention ensures clear identification of resources and maintains consistency across the service.

## 🔗 Related Services

- **Document Processing Service**: Provides processed content input
- **Vector Storage Service**: Consumes embeddings output
- **ContractsLib RAG**: Defines service contracts and dependencies
- **User Auth**: Provides JWT authentication for status API

## License

This project is licensed under the MIT License.
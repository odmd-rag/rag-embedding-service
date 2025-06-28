# RAG Embedding Service Lambda Handlers

This is a TypeScript project containing all Lambda function handlers for the RAG Embedding Service.

## Structure

- `src/` - TypeScript source code for Lambda handlers
  - `embedding-processor.ts` - Processes embedding generation from SQS messages (event-driven)
  - `status-handler.ts` - Provides HTTP status API for document tracking
  - `dlq-handler.ts` - Handles failed messages from dead letter queues

## Development

### Prerequisites

- Node.js 18+
- TypeScript 5.6+

### Setup

```bash
npm install
```

### Build

```bash
npm run build
```

### Development Mode

```bash
npm run dev
```

### Linting

```bash
npm run lint
```

### Testing

```bash
npm run test
```

### Clean

```bash
npm run clean
```

## Dependencies

- **AWS SDK v3** - For AWS service interactions (S3, SQS, DynamoDB, Bedrock)
- **AWS Lambda Powertools** - For structured logging, metrics, and tracing
- **TypeScript** - Type safety and modern JavaScript features

## Deployment

These handlers are deployed as part of the main RAG Embedding Service CDK stack. The CDK stack references the compiled JavaScript from the `dist/` directory. 
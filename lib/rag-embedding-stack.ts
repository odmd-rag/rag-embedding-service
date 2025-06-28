import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import {HttpJwtAuthorizer} from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import {Certificate, CertificateValidation} from "aws-cdk-lib/aws-certificatemanager";
import {ARecord, HostedZone, RecordTarget} from "aws-cdk-lib/aws-route53";
import {ApiGatewayv2DomainProperties} from "aws-cdk-lib/aws-route53-targets";

import {NodejsFunction} from 'aws-cdk-lib/aws-lambda-nodejs';
import {RagEmbeddingEnver} from '@odmd-rag/contracts-lib-rag';
import {OdmdShareOut} from '@ondemandenv/contracts-lib-base';
import {StackProps} from "aws-cdk-lib";


export class RagEmbeddingStack extends cdk.Stack {
    readonly httpApi: apigatewayv2.HttpApi;
    readonly apiDomain: string;

    readonly zoneName: string;
    readonly hostedZoneId: string;

    constructor(scope: Construct, myEnver: RagEmbeddingEnver, props: StackProps) {
        const id = myEnver.getRevStackNames()[0];
        super(scope, id, {...props, crossRegionReferences: props.env!.region !== 'us-east-1'});

        this.hostedZoneId = 'Z01450892FNOJJT5BBBRU';
        this.zoneName = 'rag-ws1.root.ondemandenv.link';

        const apiSubdomain = ('eb-api.' + myEnver.targetRevision.value + '.' + myEnver.owner.buildId).toLowerCase()
        this.apiDomain = `${apiSubdomain}.${this.zoneName}`;

        // === CONSUMING from document processing service via OndemandEnv contracts ===
        const processedContentBucketName = myEnver.processedContentSubscription.getSharedValue(this);

        // === BEDROCK PERMISSIONS (No secrets needed - uses IAM roles) ===
        // Bedrock is fully integrated with AWS IAM, no API keys required!

        // === DYNAMODB TABLE FOR CHECKPOINT TRACKING ===
        const checkpointTable = new dynamodb.Table(this, 'EmbCheckpointTable', {
            tableName: `rag-embedding-checkpoint-${this.account}-${this.region}`,
            partitionKey: {name: 'serviceId', type: dynamodb.AttributeType.STRING},
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true
            },
        });

        // === SQS QUEUES FOR EMBEDDING PROCESSING ===

        // Dead Letter Queue for failed embedding attempts
        const embeddingProcessingDlq = new sqs.Queue(this, 'EmbProcessingDlq', {
            queueName: `rag-embedding-processing-dlq-${this.account}-${this.region}`,
            retentionPeriod: cdk.Duration.days(14),
        });

        // Main embedding processing queue
        const embeddingProcessingQueue = new sqs.Queue(this, 'EmbProcessingQueue', {
            queueName: `rag-embedding-processing-queue-${this.account}-${this.region}`,
            visibilityTimeout: cdk.Duration.minutes(15), // Lambda timeout limit
            retentionPeriod: cdk.Duration.days(7),
            deadLetterQueue: {
                queue: embeddingProcessingDlq,
                maxReceiveCount: 3  // 3 retry attempts before DLQ
            }
        });

        // === S3 BUCKETS FOR EMBEDDINGS STORAGE ===

        // S3 bucket for embeddings (consumed by vector storage service)
        const embeddingsBucket = new s3.Bucket(this, 'EmbEmbeddingsBucket', {
            bucketName: `rag-embeddings-${this.account}-${this.region}`,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            versioned: true,
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        // === LAMBDA FUNCTIONS ===

        // S3 poller Lambda (polls processed content bucket for new files)
        const s3PollerHandler = new NodejsFunction(this, 'EmbS3PollerHandler', {
            functionName: `rag-embedding-s3-poller-${this.account}-${this.region}`,
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'handler',
            entry: 'lib/handlers/src/embedding-s3-poller.ts',
            timeout: cdk.Duration.minutes(15),
            memorySize: 1024,
            logRetention: logs.RetentionDays.ONE_WEEK,
            role: new iam.Role(this, 'EmbS3PollerRole', {
                path: '/rag/embedding/',                                                   // ← Hierarchical path
                roleName: `s3-poller-${this.account}-${this.region}`,                    // ← Role name only
                assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
                managedPolicies: [
                    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
                ]
            }),
            environment: {
                PROCESSED_CONTENT_BUCKET_NAME: processedContentBucketName,
                EMBEDDINGS_BUCKET_NAME: embeddingsBucket.bucketName,
                EMBEDDING_QUEUE_URL: embeddingProcessingQueue.queueUrl,
                CHECKPOINT_TABLE_NAME: checkpointTable.tableName,
                BATCH_SIZE: '50', // Process 50 files per execution
                SERVICE_ID: 'embedding-processor-1',
                AWS_ACCOUNT_ID: this.account,
            },
            // reservedConcurrentExecutions: 1, // Ensure sequential processing
        });

        // Embedding processor Lambda (processes SQS messages, calls Bedrock API)
        const embeddingProcessorHandler = new NodejsFunction(this, 'EmbEmbeddingProcessorHandler', {
            functionName: `rag-embedding-processor-${this.account}-${this.region}`,
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'handler',
            entry: 'lib/handlers/src/embedding-processor.ts',
            timeout: cdk.Duration.minutes(5),
            memorySize: 1024,
            logRetention: logs.RetentionDays.ONE_WEEK,
            environment: {
                EMBEDDINGS_BUCKET: embeddingsBucket.bucketName,
                AWS_ACCOUNT_ID: this.account,
            },
        });

        // DLQ handler Lambda (processes failed messages)
        const dlqHandlerHandler = new NodejsFunction(this, 'EmbDlqHandler', {
            functionName: `rag-embedding-dlq-handler-${this.account}-${this.region}`,
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'handler',
            entry: 'lib/handlers/src/dlq-handler.ts',
            timeout: cdk.Duration.seconds(30),
            memorySize: 512,
            logRetention: logs.RetentionDays.ONE_WEEK,
            role: new iam.Role(this, 'EmbDlqRole', {
                path: '/rag/embedding/',                                                 // ← Hierarchical path
                roleName: `dlq-handler-${this.account}-${this.region}`,                 // ← Role name only
                assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
                managedPolicies: [
                    iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
                ]
            }),
            environment: {
                EMBEDDINGS_BUCKET_NAME: embeddingsBucket.bucketName,
                AWS_ACCOUNT_ID: this.account,
            },
        });

        // Status handler Lambda
        const statusHandler = new NodejsFunction(this, 'EmbStatusHandler', {
            entry: __dirname + '/handlers/src/status-handler.ts',
            runtime: lambda.Runtime.NODEJS_22_X,
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            projectRoot: __dirname + '/handlers',
            depsLockFilePath: __dirname + '/handlers/package-lock.json',
            environment: {
                EMBEDDINGS_BUCKET: embeddingsBucket.bucketName,
                PROCESSED_CONTENT_BUCKET: processedContentBucketName,
            },
        });

        // === EVENTBRIDGE SCHEDULED RULE FOR S3 POLLING ===
        const s3PollingRule = new events.Rule(this, 'EmbS3PollingRule', {
            ruleName: `rag-embedding-s3-polling-${this.account}-${this.region}`,
            description: 'Triggers S3 poller Lambda every minute',
            schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
        });

        s3PollingRule.addTarget(new targets.LambdaFunction(s3PollerHandler));

        // === SQS EVENT SOURCES FOR LAMBDA FUNCTIONS ===

        // Main embedding processing queue
        embeddingProcessorHandler.addEventSource(new lambdaEventSources.SqsEventSource(embeddingProcessingQueue, {
            batchSize: 10, // Process up to 10 embedding tasks at once
            maxBatchingWindow: cdk.Duration.seconds(5),
        }));

        // DLQ processing
        dlqHandlerHandler.addEventSource(new lambdaEventSources.SqsEventSource(embeddingProcessingDlq, {
            batchSize: 1, // Process DLQ messages one at a time
        }));

        // === IAM PERMISSIONS ===

        // S3 poller permissions
        s3.Bucket.fromBucketName(this, 'EmbProcessedContentBucket', processedContentBucketName)
            .grantRead(s3PollerHandler);
        embeddingProcessingQueue.grantSendMessages(s3PollerHandler);
        checkpointTable.grantReadWriteData(s3PollerHandler);

        // Embedding processor permissions
        embeddingsBucket.grantReadWrite(embeddingProcessorHandler);
        embeddingProcessingQueue.grantConsumeMessages(embeddingProcessorHandler);

        // Add Bedrock permissions for embedding generation
        embeddingProcessorHandler.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel'
            ],
            resources: [
                `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`
            ]
        }));

        // DLQ handler permissions
        embeddingProcessingDlq.grantConsumeMessages(dlqHandlerHandler);

        // Grant permissions to read from processed content bucket
        const processedContentS3Bucket = s3.Bucket.fromBucketName(this, 'EmbProcessedContentBucketRef', processedContentBucketName);
        processedContentS3Bucket.grantRead(embeddingProcessorHandler);
        processedContentS3Bucket.grantRead(statusHandler);

        embeddingsBucket.grantRead(statusHandler);

        // === ONDEMANDENV SHARE OUT (PRODUCING) - Moved to end of constructor ===

        // === CLOUDWATCH ALARMS (Optional) ===

        // Alarm for DLQ messages
        const dlqAlarm = embeddingProcessingDlq.metricApproximateNumberOfMessagesVisible()
            .createAlarm(this, 'EmbDlqAlarm', {
                threshold: 5,
                evaluationPeriods: 2,
                alarmDescription: 'Embedding processing DLQ has messages',
            });

        // Alarm for embedding processor errors
        const processorErrorAlarm = embeddingProcessorHandler.metricErrors()
            .createAlarm(this, 'EmbProcessorErrorAlarm', {
                threshold: 10,
                evaluationPeriods: 2,
                alarmDescription: 'High error rate in embedding processor',
            });

        // === STACK OUTPUTS ===
        new cdk.CfnOutput(this, 'EmbBucketName', {
            value: embeddingsBucket.bucketName,
            description: 'S3 bucket containing generated embeddings',
        });

        new cdk.CfnOutput(this, 'EmbProcessingQueueUrl', {
            value: embeddingProcessingQueue.queueUrl,
            description: 'SQS queue for embedding processing tasks',
        });

        new cdk.CfnOutput(this, 'EmbCheckpointTableName', {
            value: checkpointTable.tableName,
            description: 'DynamoDB table for S3 polling checkpoints',
        });

        const ingestionEnver = myEnver.processedContentSubscription.producer.owner.ingestionEnver

        // CORS configuration
        const allowedOrigins = ['http://localhost:5173'];
        const webUiDomain = `https://up.${ingestionEnver.targetRevision.value}.${ingestionEnver.owner.buildId}.${this.zoneName}`.toLowerCase();
        allowedOrigins.push(`https://${webUiDomain}`);

        const clientId = ingestionEnver.authProviderClientId.getSharedValue(this);
        const providerName = ingestionEnver.authProviderName.getSharedValue(this);

        // HTTP API Gateway with JWT authentication
        this.httpApi = new apigatewayv2.HttpApi(this, 'EmbApi', {
            apiName: 'RAG Embedding Service',
            description: 'HTTP API for RAG embedding service status with JWT authentication',
            defaultAuthorizer: new HttpJwtAuthorizer('Auth',
                `https://${providerName}`,
                {jwtAudience: [clientId]}
            ),
            corsPreflight: {
                allowOrigins: allowedOrigins,
                allowMethods: [apigatewayv2.CorsHttpMethod.GET, apigatewayv2.CorsHttpMethod.OPTIONS],
                allowHeaders: [
                    'Content-Type',
                    'X-Amz-Date',
                    'Authorization',
                    'X-Api-Key',
                    'X-Amz-Security-Token',
                    'X-Amz-User-Agent',
                    'Host',
                    'Cache-Control',
                    'Pragma'
                ],
                allowCredentials: false,
                exposeHeaders: ['Date', 'X-Amzn-ErrorType'],
                maxAge: cdk.Duration.hours(1),
            },
        });

        // Status endpoint
        this.httpApi.addRoutes({
            path: '/status/{documentId}',
            methods: [apigatewayv2.HttpMethod.GET],
            integration: new apigatewayv2Integrations.HttpLambdaIntegration('EmbStatusIntegration', statusHandler),
        });

        // Set up custom domain for API Gateway
        const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'EmbApiHostedZone', {
            hostedZoneId: this.hostedZoneId,
            zoneName: this.zoneName,
        });

        const domainName = new apigatewayv2.DomainName(this, 'EmbApiDomainName', {
            domainName: this.apiDomain,
            certificate: new Certificate(this, 'EmbApiCertificate', {
                domainName: this.apiDomain,
                validation: CertificateValidation.fromDns(hostedZone),
            }),
        });

        new apigatewayv2.ApiMapping(this, 'EmbApiMapping', {
            api: this.httpApi,
            domainName: domainName,
        });

        new ARecord(this, 'EmbApiAliasRecord', {
            zone: hostedZone,
            target: RecordTarget.fromAlias(
                new ApiGatewayv2DomainProperties(
                    domainName.regionalDomainName,
                    domainName.regionalHostedZoneId
                )
            ),
            recordName: apiSubdomain,
        });

        // === OUTPUTS ===

        new cdk.CfnOutput(this, 'EmbApiEndpoint', {
            value: `https://${this.apiDomain}`,
            exportName: `${this.stackName}-EmbApiEndpoint`,
        });

        // OndemandEnv Producers - Share values with other services
        new OdmdShareOut(
            this, new Map([
                // S3 bucket resources for downstream services
                [myEnver.embeddingStorage.embeddingsBucket, embeddingsBucket.bucketName],

                // Status API endpoint for WebUI tracking
                [myEnver.statusApi.statusApiEndpoint, `https://${this.apiDomain}/status`],
            ])
        );
    }
} 
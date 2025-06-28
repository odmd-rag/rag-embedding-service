import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
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

        const processedContentBucketName = myEnver.processedContentSubscription.getSharedValue(this);

        const embeddingProcessingDlq = new sqs.Queue(this, 'EmbProcessingDlq', {
            retentionPeriod: cdk.Duration.days(14),
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        const embeddingProcessingQueue = new sqs.Queue(this, 'EmbProcessingQueue', {
            visibilityTimeout: cdk.Duration.minutes(15),
            receiveMessageWaitTime: cdk.Duration.seconds(20),
            retentionPeriod: cdk.Duration.days(14),
            removalPolicy: cdk.RemovalPolicy.RETAIN,

            deadLetterQueue: {
                queue: embeddingProcessingDlq,
                maxReceiveCount: 3
            }
        });

        const embeddingsBucket = new s3.Bucket(this, 'EmbEmbeddingsBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            versioned: true,
            publicReadAccess: false,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        });

        const embeddingProcessorHandler = new NodejsFunction(this, 'EmbEmbeddingProcessorHandler', {
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

        const dlqHandlerHandler = new NodejsFunction(this, 'EmbDlqHandler', {
            runtime: lambda.Runtime.NODEJS_22_X,
            handler: 'handler',
            entry: 'lib/handlers/src/dlq-handler.ts',
            timeout: cdk.Duration.seconds(30),
            memorySize: 512,
            logRetention: logs.RetentionDays.ONE_WEEK,
            role: new iam.Role(this, 'EmbDlqRole', {
                path: '/rag/embedding/',
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

        const processedContentBucket = s3.Bucket.fromBucketName(this, 'EmbProcessedContentBucket', processedContentBucketName);

        processedContentBucket.addEventNotification(
            s3.EventType.OBJECT_CREATED,
            new s3n.SqsDestination(embeddingProcessingQueue),
            {
                prefix: 'processed/',
                suffix: '.json'
            }
        );

        embeddingProcessorHandler.addEventSource(new lambdaEventSources.SqsEventSource(embeddingProcessingQueue, {
            batchSize: 1000,
            maxBatchingWindow: cdk.Duration.seconds(5),
            maxConcurrency: 8,
            reportBatchItemFailures: true,
        }));

        dlqHandlerHandler.addEventSource(new lambdaEventSources.SqsEventSource(embeddingProcessingDlq, {
            batchSize: 100,
            maxBatchingWindow: cdk.Duration.seconds(20),
            maxConcurrency: 8,
            reportBatchItemFailures: true,
        }));

        embeddingsBucket.grantReadWrite(embeddingProcessorHandler);
        embeddingProcessingQueue.grantConsumeMessages(embeddingProcessorHandler);

        embeddingProcessorHandler.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel'
            ],
            resources: [
                `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`
            ]
        }));

        embeddingProcessingDlq.grantConsumeMessages(dlqHandlerHandler);

        const processedContentS3Bucket = s3.Bucket.fromBucketName(this, 'EmbProcessedContentBucketRef', processedContentBucketName);
        processedContentS3Bucket.grantRead(embeddingProcessorHandler);
        processedContentS3Bucket.grantRead(statusHandler);

        embeddingsBucket.grantRead(statusHandler);

        const dlqAlarm = embeddingProcessingDlq.metricApproximateNumberOfMessagesVisible()
            .createAlarm(this, 'EmbDlqAlarm', {
                threshold: 5,
                evaluationPeriods: 2,
                alarmDescription: 'Embedding processing DLQ has messages',
            });

        const processorErrorAlarm = embeddingProcessorHandler.metricErrors()
            .createAlarm(this, 'EmbProcessorErrorAlarm', {
                threshold: 10,
                evaluationPeriods: 2,
                alarmDescription: 'High error rate in embedding processor',
            });

        new cdk.CfnOutput(this, 'EmbBucketName', {
            value: embeddingsBucket.bucketName,
            description: 'S3 bucket containing generated embeddings',
        });

        new cdk.CfnOutput(this, 'EmbProcessingQueueUrl', {
            value: embeddingProcessingQueue.queueUrl,
            description: 'SQS queue for embedding processing tasks',
        });

        const ingestionEnver = myEnver.processedContentSubscription.producer.owner.ingestionEnver

        // CORS configuration
        const allowedOrigins = ['http://localhost:5173'];
        const webUiDomain = `https://up.${ingestionEnver.targetRevision.value}.${ingestionEnver.owner.buildId}.${this.zoneName}`.toLowerCase();
        allowedOrigins.push(`https://${webUiDomain}`);

        const clientId = ingestionEnver.authProviderClientId.getSharedValue(this);
        const providerName = ingestionEnver.authProviderName.getSharedValue(this);

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

        this.httpApi.addRoutes({
            path: '/status/{documentId}',
            methods: [apigatewayv2.HttpMethod.GET],
            integration: new apigatewayv2Integrations.HttpLambdaIntegration('EmbStatusIntegration', statusHandler),
        });

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

        new cdk.CfnOutput(this, 'EmbApiEndpoint', {
            value: `https://${this.apiDomain}`,
            exportName: `${this.stackName}-EmbApiEndpoint`,
        });

        new OdmdShareOut(
            this, new Map([
                [myEnver.embeddingStorage.embeddingsBucket, embeddingsBucket.bucketName],

                // Status API endpoint for WebUI tracking
                [myEnver.statusApi.statusApiEndpoint, `https://${this.apiDomain}/status`],
            ])
        );
    }
} 
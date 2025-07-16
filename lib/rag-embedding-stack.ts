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
import {StackProps} from "aws-cdk-lib";
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { EmbeddingStatusSchema } from './schemas/embedding-status.schema';
import {OdmdShareOut, OdmdCrossRefProducer} from "@ondemandenv/contracts-lib-base";
import {GetParameterCommand, SSMClient} from "@aws-sdk/client-ssm";
import {Bucket} from "aws-cdk-lib/aws-s3";
import {Role} from "aws-cdk-lib/aws-iam";
import {AwsCustomResource, PhysicalResourceId} from "aws-cdk-lib/custom-resources";
import {zodToJsonSchema} from "zod-to-json-schema";
import {ZodObject} from "zod";


export class RagEmbeddingStack extends cdk.Stack {

    readonly apiDomain: string;

    readonly zoneName: string;
    readonly hostedZoneId: string;
    readonly myEnver: RagEmbeddingEnver;
    readonly apiSubdomain:string

    constructor(scope: Construct, myEnver: RagEmbeddingEnver, props: StackProps) {
        const id = myEnver.getRevStackNames()[0];
        super(scope, id, {...props, crossRegionReferences: props.env!.region !== 'us-east-1'});
        this.myEnver = myEnver

        this.hostedZoneId = 'Z01450892FNOJJT5BBBRU';
        this.zoneName = 'rag-ws1.root.ondemandenv.link';

        this.apiSubdomain = ('eb-api.' + myEnver.targetRevision.value + '.' + myEnver.owner.buildId).toLowerCase()
        this.apiDomain = `${this.apiSubdomain}.${this.zoneName}`;
    }
    async render(){

        const processedContentBucketName = this.myEnver.processedContentSubscription.getSharedValue(this);

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
                EMBEDDINGS_BUCKET_NAME: embeddingsBucket.bucketName,
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
            new s3n.SqsDestination(embeddingProcessingQueue)
            // Note: Filtering for processing-status=completed will be handled in Lambda
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

        // Grant S3 tagging permissions
        embeddingProcessorHandler.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3:PutObjectTagging',
                's3:GetObjectTagging'
            ],
            resources: [embeddingsBucket.arnForObjects('*')]
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

        const ingestionEnver = this.myEnver.processedContentSubscription.producer.owner.ingestionEnver

        // CORS configuration
        const allowedOrigins = ['http://localhost:5173'];
        const webUiDomain = `https://up.${ingestionEnver.targetRevision.value}.${ingestionEnver.owner.buildId}.${this.zoneName}`.toLowerCase();
        allowedOrigins.push(`https://${webUiDomain}`);

        const clientId = ingestionEnver.authProviderClientId.getSharedValue(this);
        const providerName = ingestionEnver.authProviderName.getSharedValue(this);

        const httpApi = new apigatewayv2.HttpApi(this, 'EmbApi', {
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

        httpApi.addRoutes({
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
            api: httpApi,
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
            recordName: this.apiSubdomain,
        });

        new cdk.CfnOutput(this, 'EmbApiEndpoint', {
            value: `https://${this.apiDomain}`,
            exportName: `${this.stackName}-EmbApiEndpoint`,
        });
        const schemaS3Url = await this.deploySchema( EmbeddingStatusSchema, this.myEnver.embeddingStorage.embeddingStatusSchemaS3Url )

        new OdmdShareOut(
            this, new Map([
                [this.myEnver.embeddingStorage, embeddingsBucket.bucketName],
                [this.myEnver.embeddingStorage.embeddingStatusSchemaS3Url, schemaS3Url],

                // Status API endpoint for WebUI tracking
                [this.myEnver.statusApi.statusApiEndpoint, `https://${this.apiDomain}/status`],
            ])
        );
    }

    private async deploySchema(schema: ZodObject<any>, urlPrd: OdmdCrossRefProducer<typeof this.myEnver>) {
        const gitSha = execSync('git rev-parse HEAD').toString().trim();
        const schemaFileName = `${urlPrd.node.id}.json`;

        const tempSchemaDir = path.join(__dirname, '..', 'cdk.out', 'schemas');
        fs.mkdirSync(tempSchemaDir, {recursive: true});
        const tempSchemaPath = path.join(tempSchemaDir, schemaFileName);
        fs.writeFileSync(tempSchemaPath, JSON.stringify(zodToJsonSchema(schema), null, 2));

        const parameterName = urlPrd.owner.artifactPrefixSsm.substring(0, urlPrd.owner.artifactPrefixSsm.length - this.account.length - 1);

        const ssm = new SSMClient()
        const bucketResp = await ssm.send(new GetParameterCommand({Name: parameterName}))

        const artBucket = Bucket.fromBucketName(this, 'artBucket', bucketResp.Parameter!.Value!);

        const buildRole = Role.fromRoleArn(this, 'currentRole', urlPrd.owner.buildRoleArn);
        const deployment = new BucketDeployment(this, 'DocumentMetadataSchemaDeployment', {
            sources: [Source.asset(tempSchemaDir)],
            destinationBucket: artBucket,
            destinationKeyPrefix: `${this.account}`,
            retainOnDelete: true,
            prune: false,
            role: buildRole,
        });
        const s3ObjKey = this.account + '/' + schemaFileName;

        const getObjectVersion = new AwsCustomResource(this, 'GetObjectVersion', {
            onUpdate: {
                service: 'S3',
                action: 'listObjectVersions',
                parameters: {
                    Bucket: bucketResp.Parameter!.Value!,
                    Prefix: s3ObjKey,
                },
                physicalResourceId: PhysicalResourceId.of('versioning_' + gitSha),
            },
            role: buildRole
        });
        getObjectVersion.node.addDependency(deployment);

        const addObjectTags = new AwsCustomResource(this, 'AddObjectTags', {
            onUpdate: {
                service: 'S3',
                action: 'putObjectTagging',
                parameters: {
                    Bucket: bucketResp.Parameter!.Value!,
                    Key: s3ObjKey,
                    VersionId: getObjectVersion.getResponseField('Versions.0.VersionId'),
                    Tagging: {
                        TagSet: [
                            {Key: 'gitsha', Value: gitSha},
                        ],
                    },
                },
                physicalResourceId: PhysicalResourceId.of('gitSha_' + gitSha),
            },
            role: buildRole
        });
        addObjectTags.node.addDependency(deployment);

        // return artBucket.bucketArn + '/' + Fn.select(0, bd.objectKeys); => arn:aws:s3:::odmd-build-ragingest-ragingestartifactse23a694f-8mgcyxvb7dyf/0b3bdd2050cd5d3e69f7f3e6e344f1c0818e60b4a2dd7e948825813e9aa7a003.zip

        //s3://odmd-build-ragingest-ragingestartifactse23a694f-8mgcyxvb7dyf/366920167720/store-schema-cfe2746c7b310aea3de0d38c60b16393dfe7ad54.json@2
        return 's3://' + artBucket.bucketName + '/' + s3ObjKey + '@' + getObjectVersion.getResponseField('Versions.0.VersionId')
    }
} 
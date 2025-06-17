#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RagEmbeddingStack } from '../lib/rag-embedding-stack';
import { RagContracts } from '@odmd-rag/contracts-lib-rag';

async function main() {
    const app = new cdk.App();

    // Initialize RAG contracts
    const ragContracts = new RagContracts(app);

    // Get the embedding service Envers from contracts
    const embeddingDev = ragContracts.ragEmbeddingBuild.dev;
    const embeddingProd = ragContracts.ragEmbeddingBuild.prod;

    // Determine which environment to deploy based on CDK context or environment variables
    const targetEnv = app.node.tryGetContext('env') || process.env.TARGET_ENV || 'dev';

    let targetEnver;
    if (targetEnv === 'prod' || targetEnv === 'production') {
        targetEnver = embeddingProd;
    } else {
        targetEnver = embeddingDev;
    }

    console.log(`Deploying RAG Embedding Service to ${targetEnv} environment`);
    console.log(`Target Account: ${targetEnver.targetAWSAccountID}`);
    console.log(`Target Region: ${targetEnver.targetAWSRegion}`);

    // Create the stack using the OndemandEnv contract pattern
    new RagEmbeddingStack(app, targetEnver, {
        env: {
            account: targetEnver.targetAWSAccountID,
            region: targetEnver.targetAWSRegion,
        },
        description: `RAG Embedding Service - ${targetEnv} environment`,
        tags: {
            'ondemandenv:service': 'rag-embedding',
            'ondemandenv:environment': targetEnv,
            'ondemandenv:managed': 'true'
        }
    });
}

// Execute async main function
main().catch((error) => {
    console.error('Error in main function:', error);
    process.exit(1);
}); 
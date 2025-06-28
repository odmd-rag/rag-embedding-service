#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { RagEmbeddingStack } from '../lib/rag-embedding-stack';
import { RagContracts } from '@odmd-rag/contracts-lib-rag';

async function main() {
    const app = new cdk.App();

    const ragContracts = new RagContracts(app);

    const embeddingDev = ragContracts.ragEmbeddingBuild.dev;
    const embeddingProd = ragContracts.ragEmbeddingBuild.prod;

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

main().catch((error) => {
    console.error('Error in main function:', error);
    process.exit(1);
}); 
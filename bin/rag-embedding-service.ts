#!/usr/bin/env node

import * as cdk from 'aws-cdk-lib';
import {RagEmbeddingStack} from '../lib/rag-embedding-stack';
import {RagContracts, RagEmbeddingEnver} from '@odmd-rag/contracts-lib-rag';
import {StackProps} from "aws-cdk-lib";

const app = new cdk.App();

async function main() {
    const buildRegion = process.env.CDK_DEFAULT_REGION;
    const buildAccount = process.env.CDK_DEFAULT_ACCOUNT;
    if (!buildRegion || !buildAccount) {
        throw new Error("buildRegion>" + buildRegion + "; buildAccount>" + buildAccount);
    }

    const props = {
        env: {
            account: buildAccount,
            region: buildRegion
        }
    } as StackProps;

    new RagContracts(app);

    const targetEnver = RagContracts.inst.getTargetEnver() as RagEmbeddingEnver

    const mainstack = new RagEmbeddingStack(app, targetEnver, props);
    await mainstack.render()
}

main().catch((error) => {
    console.error('Error in main function:', error);
    process.exit(1);
}); 
#!/bin/bash

# RAG Document Processing Service Build Script

set -e

echo "Building RAG Document Processing Service..."

# Ensure we're in the correct directory
cd "$(dirname "$0")/.."

# Check for required environment variables
if [ -z "$AWS_REGION" ]; then
    export AWS_REGION="us-east-1"
    echo "Using default AWS region: $AWS_REGION"
fi

# Install main dependencies
echo "Installing main dependencies..."
npm install

# Build the handlers
echo "Building Lambda handlers..."
cd lib/handlers
npm install
npm run build
cd ../..

# Build TypeScript
echo "Building TypeScript..."
npx tsc

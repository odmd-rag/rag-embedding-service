#!/bin/bash

# RAG Rag embedding Service Build Script

set -ex

echo "Building RAG Rag embedding Service..."

# Ensure we're in the correct directory
cd "$(dirname "$0")/.."

# Check for required environment variables
if [ -z "$AWS_REGION" ]; then
    export AWS_REGION="us-east-1"
    echo "Using default AWS region: $AWS_REGION"
fi

# Build the handlers
echo "Building Lambda handlers..."
cd lib/handlers
npm install
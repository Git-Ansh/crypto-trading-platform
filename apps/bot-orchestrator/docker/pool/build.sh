#!/bin/bash
# Build and push the FreqTrade Pool Container image
# Usage: ./build.sh [tag]

set -e

# Default tag
TAG="${1:-latest}"
IMAGE_NAME="freqtrade-pool"

echo "========================================"
echo " Building FreqTrade Pool Container"
echo " Image: ${IMAGE_NAME}:${TAG}"
echo "========================================"

# Build the image
docker build -t ${IMAGE_NAME}:${TAG} .

echo ""
echo "========================================"
echo " Build complete!"
echo " Image: ${IMAGE_NAME}:${TAG}"
echo "========================================"
echo ""
echo "To test the image:"
echo "  docker run -d --name test-pool ${IMAGE_NAME}:${TAG}"
echo "  docker exec test-pool supervisorctl status"
echo "  docker stop test-pool && docker rm test-pool"
echo ""
echo "To push to a registry:"
echo "  docker tag ${IMAGE_NAME}:${TAG} your-registry/${IMAGE_NAME}:${TAG}"
echo "  docker push your-registry/${IMAGE_NAME}:${TAG}"

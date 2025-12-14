#!/bin/bash

# CI Validation Script
# This script simulates the GitHub Actions CI pipeline locally

set -e  # Exit on error

echo "🔍 Validating CI Pipeline Locally"
echo "=================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Check Node.js version
echo "1️⃣  Checking Node.js version..."
NODE_VERSION=$(node -v)
echo "   Node version: $NODE_VERSION"
if [[ ! "$NODE_VERSION" =~ ^v22\. ]]; then
    echo -e "${YELLOW}   ⚠️  Warning: CI uses Node 22.x, you're using $NODE_VERSION${NC}"
fi
echo ""

# Step 2: Install dependencies
echo "2️⃣  Installing dependencies..."
npm ci --quiet
echo -e "${GREEN}   ✅ Dependencies installed${NC}"
echo ""

# Step 3: Run unit tests
echo "3️⃣  Running unit tests..."
if npm test; then
    echo -e "${GREEN}   ✅ Unit tests passed${NC}"
else
    echo -e "${RED}   ❌ Unit tests failed${NC}"
    exit 1
fi
echo ""

# Step 4: Start test server in background
echo "4️⃣  Starting test server..."
npm run dev:test > /dev/null 2>&1 &
TEST_SERVER_PID=$!
echo "   Test server PID: $TEST_SERVER_PID"

# Wait for server to be ready
echo "   Waiting for server to start..."
for i in {1..30}; do
    if curl -s http://localhost:3000/tester.html > /dev/null 2>&1; then
        echo -e "${GREEN}   ✅ Test server is ready${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}   ❌ Test server failed to start${NC}"
        kill $TEST_SERVER_PID 2>/dev/null || true
        exit 1
    fi
    sleep 1
done
echo ""

# Step 5: Run e2e tests
echo "5️⃣  Running E2E tests..."
if npm run test:e2e; then
    echo -e "${GREEN}   ✅ E2E tests passed${NC}"
else
    echo -e "${RED}   ❌ E2E tests failed${NC}"
    kill $TEST_SERVER_PID 2>/dev/null || true
    exit 1
fi
echo ""

# Cleanup: Stop test server
echo "6️⃣  Cleaning up..."
kill $TEST_SERVER_PID 2>/dev/null || true
echo -e "${GREEN}   ✅ Test server stopped${NC}"
echo ""

# Final summary
echo "=================================="
echo -e "${GREEN}🎉 All CI checks passed!${NC}"
echo "Your code is ready to be pushed."
echo ""

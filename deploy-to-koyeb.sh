#!/bin/bash

# Deployment script for Puppeteer Audit Service to Koyeb
# Usage: ./deploy-to-koyeb.sh YOUR_GITHUB_USERNAME

if [ $# -eq 0 ]; then
    echo "Usage: $0 <github_username>"
    echo "Example: $0 johndoe"
    exit 1
fi

GITHUB_USERNAME=$1
SERVICE_NAME="audit-service"
APP_NAME="puppeteer-audit-service"

echo "🚀 Deploying Puppeteer Audit Service to Koyeb..."
echo "Repository: github.com/$GITHUB_USERNAME/puppeteer-audit-service"

# Check if secret exists, create if not
echo "📦 Checking secrets..."
if ! koyeb secret list | grep -q "audit-secret-key"; then
    echo "Creating audit-secret-key secret..."
    read -s -p "Enter your API secret key: " SECRET_KEY
    echo
    koyeb secret create audit-secret-key --value "$SECRET_KEY"
else
    echo "✅ Secret audit-secret-key already exists"
fi

# Delete existing service if it exists
echo "🗑️  Cleaning up existing service..."
koyeb service delete $SERVICE_NAME 2>/dev/null || echo "No existing service to delete"

# Wait a moment for cleanup
sleep 5

# Deploy the service
echo "🚢 Deploying service..."
koyeb service create \
  --app $APP_NAME \
  --git github.com/$GITHUB_USERNAME/puppeteer-audit-service \
  --git-branch main \
  --git-build-command "npm ci && npm run build" \
  --git-run-command "npm start" \
  --port 8080:http \
  --region fra \
  --instance-type small \
  --env NODE_ENV=production \
  --env API_SECRET_KEY=@audit-secret-key \
  --env CHROME_EXECUTABLE_PATH=/usr/bin/chromium \
  --env PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  --health-check-path /health \
  --health-check-grace-period 300s \
  --min-scale 1 \
  --max-scale 2 \
  $SERVICE_NAME

echo "✅ Deployment initiated!"
echo "🔍 Monitor deployment status with: koyeb service describe $SERVICE_NAME"
echo "📊 View logs with: koyeb service logs $SERVICE_NAME"

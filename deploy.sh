#!/bin/bash

# Deployment script for Koyeb Puppeteer Service
# This script helps deploy the puppeteer audit service to Koyeb

echo "🚀 Koyeb Puppeteer Service Deployment"
echo "===================================="

# Check if koyeb CLI is installed
if ! command -v koyeb &> /dev/null; then
    echo "❌ Koyeb CLI is not installed. Please install it first:"
    echo "   curl -fsSL https://cli.koyeb.com/install.sh | bash"
    exit 1
fi

# Check if logged in
if ! koyeb auth list-tokens &> /dev/null; then
    echo "❌ Not logged in to Koyeb. Please run: koyeb auth login"
    exit 1
fi

# Check if secret exists
echo "🔐 Checking if API secret exists..."
if ! koyeb secrets list | grep -q "audit-secret-key"; then
    echo "❌ Secret 'audit-secret-key' not found. Creating it..."
    read -s -p "Enter your API secret key: " SECRET_VALUE
    echo
    koyeb secret create audit-secret-key --value "$SECRET_VALUE"
    echo "✅ Secret created successfully"
else
    echo "✅ Secret 'audit-secret-key' already exists"
fi

# Create or update the app
echo "📱 Creating/updating app..."
if ! koyeb app list | grep -q "puppeteer-audit-service"; then
    koyeb app create puppeteer-audit-service
    echo "✅ App 'puppeteer-audit-service' created"
else
    echo "✅ App 'puppeteer-audit-service' already exists"
fi

# Deploy the service
echo "🔨 Deploying service..."
echo "Note: This will deploy from the current directory using archive upload"

# Build and deploy
koyeb service create audit-service \
    --app puppeteer-audit-service \
    --archive . \
    --archive-builder docker \
    --env NODE_ENV=production \
    --env API_SECRET_KEY="{{secret.audit-secret-key}}" \
    --env CHROME_EXECUTABLE_PATH=/usr/bin/chromium \
    --env PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    --env PORT=8080 \
    --ports 8080:http \
    --regions fra \
    --instance-type small \
    --checks 8080:http:/health \
    --checks-grace-period 8080=180 \
    --min-scale 1 \
    --max-scale 3 \
    --autoscaling-average-cpu 80 \
    --autoscaling-concurrent-requests 10 \
    --wait

if [ $? -eq 0 ]; then
    echo "✅ Service deployed successfully!"
    echo ""
    echo "📊 Service Information:"
    koyeb service list | grep audit-service
    echo ""
    echo "🔗 To view logs:"
    echo "   koyeb service logs audit-service"
    echo ""
    echo "🌐 Your service should be accessible at:"
    echo "   https://[SERVICE-URL]/"
    echo ""
    echo "🩺 Health check endpoint:"
    echo "   https://[SERVICE-URL]/health"
else
    echo "❌ Deployment failed. Check the logs:"
    echo "   koyeb service logs audit-service -t build"
fi

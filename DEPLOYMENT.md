# 🚀 Deploy Puppeteer Service to Koyeb

## ✅ Local Testing Completed Successfully!
- Health endpoint: ✅ Working
- Audit functionality: ✅ Working (tested with example.com)
- PDF generation: ✅ Working (generated test-report.pdf)
- Authentication: ✅ Working

## 📋 Deployment Steps

### 1. Install Koyeb CLI
Visit: https://github.com/koyeb/koyeb-cli/releases/latest
Download the macOS binary and install it:

```bash
# Manual installation
curl -LO https://github.com/koyeb/koyeb-cli/releases/latest/download/koyeb-darwin-amd64
chmod +x koyeb-darwin-amd64
sudo mv koyeb-darwin-amd64 /usr/local/bin/koyeb
```

### 2. Login to Koyeb
```bash
koyeb auth login
```

### 3. Create Secrets (IMPORTANT)
```bash
# Generate secure secrets for production
koyeb secret create WEBHOOK_SECRET "$(openssl rand -hex 32)"
koyeb secret create API_KEY "$(openssl rand -hex 32)"
koyeb secret create CALLBACK_URL "https://your-app.vercel.app/api/audits/callback"
```

### 4. Deploy the Service
```bash
cd /Users/matthewmuchesko/Documents/meizo814/meizo/services/puppeteer-service
koyeb app deploy
```

## 🔐 Production Environment Variables

Your koyeb.yaml is already configured to use these secrets:
- `WEBHOOK_SECRET`: ${WEBHOOK_SECRET}
- `API_KEY`: ${API_KEY}  
- `CALLBACK_URL`: ${CALLBACK_URL}

## 🎯 Next Steps After Deployment

1. **Get your service URL**: `https://your-app-name.koyeb.app`
2. **Test the deployed service**:
   ```bash
   curl https://your-app-name.koyeb.app/health
   ```
3. **Update your main app's environment variables**:
   ```bash
   PUPPETEER_SERVICE_URL=https://your-app-name.koyeb.app
   PUPPETEER_API_KEY=your-generated-api-key
   PUPPETEER_WEBHOOK_SECRET=your-generated-webhook-secret
   ```

## 📊 Expected Performance
- **Cold start**: ~10-15 seconds
- **Warm requests**: <5 seconds for audits
- **Auto-scaling**: 0-3 instances
- **Cost**: $0 when idle, ~$10-20/month moderate usage

Your service is ready for production deployment! 🚀

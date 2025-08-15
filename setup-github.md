# Setup GitHub Repository

## Step 1: Create GitHub Repository
1. Go to https://github.com/new
2. Repository name: `puppeteer-audit-service`
3. Make it Public (so Koyeb can access it)
4. Don't initialize with README, .gitignore, or license (we already have these)
5. Click "Create repository"

## Step 2: Connect Local Repository
After creating the GitHub repository, run these commands:

```bash
# Add the GitHub repository as remote origin
git remote add origin https://github.com/YOUR_USERNAME/puppeteer-audit-service.git

# Push your code to GitHub
git branch -M main
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

## Step 3: Deploy to Koyeb
Once the code is on GitHub, you can deploy to Koyeb using:

```bash
koyeb service create \
  --app puppeteer-audit-service \
  --git github.com/YOUR_USERNAME/puppeteer-audit-service \
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
  audit-service
```

Or you can use the GitHub integration in the Koyeb dashboard.

# Puppeteer Audit & PDF Service

A containerized service that provides website auditing (using Lighthouse) and PDF generation capabilities using Puppeteer. Designed for deployment on Koyeb.

## Features

- **Website Auditing**: Lighthouse-powered performance, SEO, accessibility, and best practices audits
- **PDF Generation**: Generate PDFs from HTML content or URLs
- **Secure API**: HMAC signature verification and API key authentication
- **Scalable**: Auto-scaling with zero-downtime deployments
- **Health Monitoring**: Built-in health checks and status endpoints

## API Endpoints

### Health & Status
- `GET /health` - Service health check
- `GET /health/ready` - Service readiness check

### Audit Services
- `POST /api/audit/start` - Start a website audit
- `GET /api/audit/status/:jobId` - Get audit status

### PDF Services
- `POST /api/pdf/generate` - Generate PDF from HTML content
- `POST /api/pdf/generate-from-url` - Generate PDF from URL

## Quick Start

### 1. Local Development

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env with your configuration

# Start development server
npm run dev

# Or build and run
npm run build
npm start
```

### 2. Docker Development

```bash
# Build Docker image
docker build -t puppeteer-service .

# Run container
docker run -p 8080:8080 \
  -e WEBHOOK_SECRET=your-secret \
  -e API_KEY=your-api-key \
  -e CALLBACK_URL=https://your-app.com/api/audits/callback \
  puppeteer-service
```

### 3. Deploy to Koyeb

```bash
# Install Koyeb CLI
npm install -g @koyeb/cli

# Login to Koyeb
koyeb auth login

# Set environment variables in Koyeb dashboard or CLI:
koyeb secret create WEBHOOK_SECRET "your-webhook-secret"
koyeb secret create API_KEY "your-api-key" 
koyeb secret create CALLBACK_URL "https://your-app.vercel.app/api/audits/callback"

# Deploy
koyeb app deploy
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `PORT` | Server port | `8080` |
| `WEBHOOK_SECRET` | HMAC signature secret | Required |
| `API_KEY` | API authentication key | Required |
| `CALLBACK_URL` | Webhook callback URL | Required |
| `CHROME_EXECUTABLE_PATH` | Chrome binary path | `/usr/bin/chromium` |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | Skip Puppeteer Chromium download | `true` |
| `MAX_CONCURRENT_JOBS` | Maximum concurrent audit jobs | `3` |
| `REQUEST_TIMEOUT` | Request timeout (ms) | `300000` |
| `MEMORY_LIMIT` | Memory limit (MB) | `512` |

## API Usage Examples

### Start an Audit

```bash
curl -X POST https://your-service.koyeb.app/api/audit/start \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "websiteUrl": "https://example.com",
    "priority": 5,
    "options": {
      "mobile": false,
      "includeScreenshot": true
    }
  }'
```

### Generate PDF from HTML

```bash
curl -X POST https://your-service.koyeb.app/api/pdf/generate \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "jobId": "550e8400-e29b-41d4-a716-446655440001",
    "htmlContent": "<html><body><h1>Report</h1></body></html>",
    "options": {
      "format": "A4",
      "orientation": "portrait"
    }
  }' \
  --output report.pdf
```

### Generate PDF from URL

```bash
curl -X POST https://your-service.koyeb.app/api/pdf/generate-from-url \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "url": "https://example.com",
    "options": {
      "format": "A4",
      "printBackground": true
    }
  }' \
  --output webpage.pdf
```

## Integration with Main App

### 1. API Client

Create an API client in your main application:

```typescript
// packages/audit-client/index.ts
import crypto from 'crypto';

export class AuditClient {
  constructor(
    private serviceUrl: string,
    private apiKey: string,
    private webhookSecret: string
  ) {}

  async startAudit(data: {
    jobId: string;
    websiteUrl: string;
    options?: any;
  }) {
    const response = await fetch(`${this.serviceUrl}/api/audit/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey
      },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      throw new Error(`Audit start failed: ${response.statusText}`);
    }

    return response.json();
  }

  verifyCallback(body: string, signature: string): boolean {
    const expectedSignature = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(body)
      .digest('hex');
    
    const providedSignature = signature.replace('sha256=', '');
    
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(providedSignature, 'hex')
    );
  }
}
```

### 2. Callback Handler

Update your callback endpoint to handle results:

```typescript
// app/api/audits/callback/route.ts
import { auditClient } from '@/lib/audit-client';
import { auditService } from '@repo/database';

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get('x-signature');
  
  if (!signature || !auditClient.verifyCallback(body, signature)) {
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }
  
  const data = JSON.parse(body);
  
  // Update audit in database
  await auditService.processCallback(data);
  
  return Response.json({ success: true });
}
```

## Deployment Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Your App      │    │  Koyeb Service   │    │   Database      │
│   (Vercel)      │────│  (Puppeteer)     │    │   (PlanetScale) │
│                 │    │                  │    │                 │
│ ┌─────────────┐ │    │ ┌──────────────┐ │    │ ┌─────────────┐ │
│ │ Audit API   │─┼────┼─│ Lighthouse   │ │    │ │ Audit Jobs  │ │
│ │ PDF API     │─┼────┼─│ PDF Gen      │ │    │ │ Results     │ │
│ │ Callback    │─┼────┼─│ Webhooks     │ │    │ │ Reports     │ │
│ └─────────────┘ │    │ └──────────────┘ │    │ └─────────────┘ │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## Performance & Scaling

- **Auto-scaling**: Scales from 0 to 3 instances based on demand
- **Memory efficient**: 512MB memory limit with cleanup after each job
- **Concurrent jobs**: Handles up to 3 concurrent audits per instance
- **Cold start**: ~10-15 seconds for new instances
- **Request timeout**: 5 minutes for complex audits

## Security

- **API Key authentication** for all endpoints
- **HMAC signature verification** for webhook callbacks
- **Rate limiting** (100 requests per 15 minutes per IP)
- **Input validation** with Zod schemas
- **Secure headers** with Helmet.js

## Monitoring

- Health checks every 30 seconds
- Request/response logging
- Error tracking and reporting
- Memory and CPU usage monitoring through Koyeb dashboard

## Cost Optimization

- **Pay-per-use**: Only pay when processing requests
- **Auto-scale to zero**: No costs during idle periods
- **Resource limits**: Controlled memory and CPU usage
- **Request batching**: Process multiple URLs efficiently

## Troubleshooting

### Common Issues

1. **Chrome/Chromium not found**: Ensure `CHROME_EXECUTABLE_PATH` is correct
2. **Memory issues**: Reduce `MAX_CONCURRENT_JOBS` or increase instance size
3. **Timeout errors**: Increase `REQUEST_TIMEOUT` for slow websites
4. **Callback failures**: Verify `CALLBACK_URL` and network connectivity

### Logs

Check Koyeb logs for debugging:

```bash
koyeb app logs puppeteer-audit-service
```

#!/usr/bin/env node

import crypto from 'crypto';

const BASE_URL = 'https://puppeteer-audit-service-meizo-a4e1146c.koyeb.app';
const SECRET_KEY = '6afe24f3b10d77a42ec30db83722a34fe4b99d75ed652a48687859b7fa8db492';

function createSignature(payload) {
  return crypto.createHmac('sha256', SECRET_KEY).update(payload).digest('hex');
}

async function testEndpoint(endpoint, method = 'GET', data = null) {
  const url = `${BASE_URL}${endpoint}`;
  console.log(`\n🧪 Testing ${method} ${url}`);
  
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
    }
  };

  if (data) {
    const payload = JSON.stringify(data);
    const signature = createSignature(payload);
    options.headers['X-Signature'] = `sha256=${signature}`;
    options.body = payload;
  }

  try {
    const response = await fetch(url, options);
    const result = await response.text();
    
    console.log(`📊 Status: ${response.status}`);
    console.log(`📄 Response: ${result.substring(0, 200)}${result.length > 200 ? '...' : ''}`);
    
    return { status: response.status, body: result };
  } catch (error) {
    console.log(`❌ Error: ${error.message}`);
    return { error: error.message };
  }
}

async function main() {
  console.log('🚀 Testing Puppeteer Service Endpoints\n');

  // Test health endpoint
  await testEndpoint('/health');

  // Test audit endpoint with simple URL
  await testEndpoint('/api/audit/start', 'POST', {
    url: 'https://example.com'
  });

  // Test PDF endpoint  
  await testEndpoint('/api/pdf/generate', 'POST', {
    html: '<h1>Test PDF</h1><p>This is a test</p>'
  });

  console.log('\n✅ Tests completed!');
}

main().catch(console.error);

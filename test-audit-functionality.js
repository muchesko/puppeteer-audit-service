#!/usr/bin/env node

import crypto from 'crypto';

const BASE_URL = 'https://puppeteer-audit-service-meizo-a4e1146c.koyeb.app';
const SECRET_KEY = '6afe24f3b10d77a42ec30db83722a34fe4b99d75ed652a48687859b7fa8db492';

function createSignature(payload) {
  return crypto.createHmac('sha256', SECRET_KEY).update(payload).digest('hex');
}

async function testAudit() {
  console.log('🧪 Testing SEO Audit Functionality\n');

  // Start an audit
  const auditData = { url: 'https://example.com' };
  const payload = JSON.stringify(auditData);
  const signature = createSignature(payload);

  console.log('📝 Starting audit for:', auditData.url);
  
  const startResponse = await fetch(`${BASE_URL}/api/audit/start`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature': `sha256=${signature}`
    },
    body: payload
  });

  const startResult = await startResponse.json();
  console.log('✅ Audit started:', startResult);

  if (startResult.jobId) {
    // Wait a bit for processing
    console.log('\n⏳ Waiting 10 seconds for audit to complete...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Check status
    console.log('📊 Checking audit status...');
    const statusResponse = await fetch(`${BASE_URL}/api/audit/status/${startResult.jobId}`, {
      headers: {
        'X-Signature': `sha256=${createSignature('')}`
      }
    });

    const statusResult = await statusResponse.json();
    console.log('📈 Status result:', statusResult);
  }
}

testAudit().catch(console.error);

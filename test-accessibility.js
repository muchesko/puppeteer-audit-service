#!/usr/bin/env node

import crypto from 'crypto';

const KOYEB_BASE_URL = 'https://puppeteer-audit-service-meizo-a4e1146c.koyeb.app';
const API_SECRET_KEY = '6afe24f3b10d77a42ec30db83722a34fe4b99d75ed652a48687859b7fa8db492';

function generateSignature(body, secret) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

const testUrl = 'https://example.com';
console.log('🚀 Testing accessibility scoring with:', testUrl);

async function testAccessibility() {
  try {
    // Start audit
    const requestBody = {
        url: testUrl,
        options: {
            mobile: false,
            screenshot: false
        }
    };

    const body = JSON.stringify(requestBody);
    const signature = generateSignature(body, API_SECRET_KEY);

    const startResponse = await fetch(`${KOYEB_BASE_URL}/api/audit/start`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Signature': `sha256=${signature}`
      },
      body: body
    });
    
    const startData = await startResponse.json();
    console.log('✅ Audit started:', startData);
    
    if (!startData.jobId) {
      throw new Error('No job ID received');
    }
    
    const jobId = startData.jobId;
    
    // Poll for results
    const pollResults = async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 6000)); // Wait 6 seconds
        
        const resultResponse = await fetch(`${KOYEB_BASE_URL}/api/audit/status/${jobId}`, {
            headers: {
                'X-Signature': `sha256=${generateSignature('{}', API_SECRET_KEY)}`
            }
        });
        const result = await resultResponse.json();
        
        console.log(`📊 Check ${i + 1}: Status = ${result.status}`);
        
        if (result.status === 'COMPLETED') {
          console.log('🎉 Final Results:');
          console.log({
            jobId: result.jobId,
            performance: result.results?.performanceScore,
            seo: result.results?.seoScore,
            accessibility: result.results?.accessibilityScore,
            bestPractices: result.results?.bestPracticesScore,
            loadTime: result.results?.metrics?.loadTime
          });
          return;
        } else if (result.status === 'FAILED') {
          console.log('❌ Audit failed:', result.error);
          return;
        }
      }
      
      console.log('⏰ Timeout waiting for results');
    };
    
    await pollResults();
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testAccessibility();

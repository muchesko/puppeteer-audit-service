const crypto = require('crypto');

const API_SECRET_KEY = '6afe24f3b10d77a42ec30db83722a34fe4b99d75ed652a48687859b7fa8db492';
const BASE_URL = 'https://puppeteer-audit-service-meizo-a4e1146c.koyeb.app';

function generateSignature(payload) {
  return crypto
    .createHmac('sha256', API_SECRET_KEY)
    .update(payload)
    .digest('hex');
}

async function testAuditEndpoint() {
  console.log('\n=== Testing Audit Endpoint ===');
  
  const auditPayload = {
    url: 'https://example.com',
    priority: 5,
    options: {
      mobile: false,
      desktop: true,
      screenshot: true
    }
  };
  
  const body = JSON.stringify(auditPayload);
  const signature = generateSignature(body);
  
  try {
    const response = await fetch(`${BASE_URL}/api/audit/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': `sha256=${signature}`
      },
      body: body
    });
    
    const result = await response.json();
    console.log('Audit Response Status:', response.status);
    console.log('Audit Response:', result);
    
    if (result.jobId) {
      // Test status endpoint
      setTimeout(async () => {
        try {
          const statusResponse = await fetch(`${BASE_URL}/api/audit/status/${result.jobId}`, {
            headers: {
              'X-Signature': `sha256=${generateSignature('')}`
            }
          });
          const statusResult = await statusResponse.json();
          console.log('Status Response:', statusResult);
        } catch (error) {
          console.error('Status check error:', error.message);
        }
      }, 2000);
    }
    
  } catch (error) {
    console.error('Audit test error:', error.message);
  }
}

async function testPDFEndpoint() {
  console.log('\n=== Testing PDF Endpoint ===');
  
  const pdfPayload = {
    html: '<html><body><h1>Test PDF Generation</h1><p>This is a test document.</p></body></html>',
    options: {
      format: 'A4',
      orientation: 'portrait',
      printBackground: true
    }
  };
  
  const body = JSON.stringify(pdfPayload);
  const signature = generateSignature(body);
  
  try {
    const response = await fetch(`${BASE_URL}/api/pdf/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': `sha256=${signature}`
      },
      body: body
    });
    
    console.log('PDF Response Status:', response.status);
    console.log('PDF Response Headers:', Object.fromEntries(response.headers.entries()));
    
    if (response.ok) {
      console.log('PDF generated successfully!');
      console.log('Content-Type:', response.headers.get('content-type'));
    } else {
      const errorResult = await response.text();
      console.log('PDF Error Response:', errorResult);
    }
    
  } catch (error) {
    console.error('PDF test error:', error.message);
  }
}

async function testPDFFromURL() {
  console.log('\n=== Testing PDF from URL Endpoint ===');
  
  const urlPayload = {
    url: 'https://example.com',
    options: {
      format: 'A4',
      printBackground: true
    }
  };
  
  const body = JSON.stringify(urlPayload);
  const signature = generateSignature(body);
  
  try {
    const response = await fetch(`${BASE_URL}/api/pdf/generate-from-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': `sha256=${signature}`
      },
      body: body
    });
    
    console.log('PDF from URL Response Status:', response.status);
    
    if (response.ok) {
      console.log('PDF from URL generated successfully!');
      console.log('Content-Type:', response.headers.get('content-type'));
    } else {
      const errorResult = await response.text();
      console.log('PDF from URL Error Response:', errorResult);
    }
    
  } catch (error) {
    console.error('PDF from URL test error:', error.message);
  }
}

async function runTests() {
  console.log('Testing updated API endpoints with new schema...');
  
  await testAuditEndpoint();
  await testPDFEndpoint();
  await testPDFFromURL();
  
  console.log('\n=== Tests Complete ===');
}

runTests().catch(console.error);

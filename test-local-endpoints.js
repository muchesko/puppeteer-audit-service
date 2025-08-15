import crypto from 'crypto';

// Test local service endpoints
const API_SECRET_KEY = '6afe24f3b10d77a42ec30db83722a34fe4b99d75ed652a48687859b7fa8db492';
const SERVICE_URL = 'http://localhost:8081';

function createSignature(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64');
}

async function testAuditEndpoint() {
  console.log('=== Testing Audit Endpoint ===');
  
  const testData = JSON.stringify({
    jobId: crypto.randomUUID(),
    websiteUrl: 'https://example.com',
    priority: 5,
    options: {
      mobile: false,
      includeScreenshot: true,
      customUserAgent: 'Test-Agent'
    }
  });
  
  const signature = createSignature(testData, API_SECRET_KEY);
  
  try {
    const response = await fetch(`${SERVICE_URL}/api/audit/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature
      },
      body: testData
    });
    
    console.log(`Status: ${response.status}`);
    const responseText = await response.text();
    console.log(`Response: ${responseText}`);
    
    if (response.ok) {
      console.log('✅ Audit endpoint working!');
      return true;
    } else {
      console.log('❌ Audit endpoint failed');
      return false;
    }
  } catch (error) {
    console.error('Error testing audit endpoint:', error);
    return false;
  }
}

async function testPDFEndpoint() {
  console.log('\n=== Testing PDF Endpoint ===');
  
  const testData = JSON.stringify({
    jobId: crypto.randomUUID(),
    htmlContent: '<html><body><h1>Test PDF</h1><p>This is a test PDF generation.</p></body></html>',
    options: {
      format: 'A4',
      orientation: 'portrait',
      margin: {
        top: '1cm',
        right: '1cm',
        bottom: '1cm',
        left: '1cm'
      },
      printBackground: true
    }
  });
  
  const signature = createSignature(testData, API_SECRET_KEY);
  
  try {
    const response = await fetch(`${SERVICE_URL}/api/pdf/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature
      },
      body: testData
    });
    
    console.log(`Status: ${response.status}`);
    console.log(`Content-Type: ${response.headers.get('content-type')}`);
    
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      console.log(`PDF Size: ${buffer.byteLength} bytes`);
      console.log('✅ PDF endpoint working!');
      return true;
    } else {
      const responseText = await response.text();
      console.log(`Response: ${responseText}`);
      console.log('❌ PDF endpoint failed');
      return false;
    }
  } catch (error) {
    console.error('Error testing PDF endpoint:', error);
    return false;
  }
}

async function testPDFFromURLEndpoint() {
  console.log('\n=== Testing PDF from URL Endpoint ===');
  
  const testData = JSON.stringify({
    url: 'https://example.com',
    options: {
      format: 'A4',
      orientation: 'portrait'
    }
  });
  
  const signature = createSignature(testData, API_SECRET_KEY);
  
  try {
    const response = await fetch(`${SERVICE_URL}/api/pdf/generate-from-url`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature
      },
      body: testData
    });
    
    console.log(`Status: ${response.status}`);
    console.log(`Content-Type: ${response.headers.get('content-type')}`);
    
    if (response.ok) {
      const buffer = await response.arrayBuffer();
      console.log(`PDF Size: ${buffer.byteLength} bytes`);
      console.log('✅ PDF from URL endpoint working!');
      return true;
    } else {
      const responseText = await response.text();
      console.log(`Response: ${responseText}`);
      console.log('❌ PDF from URL endpoint failed');
      return false;
    }
  } catch (error) {
    console.error('Error testing PDF from URL endpoint:', error);
    return false;
  }
}

async function runAllTests() {
  console.log('Testing all endpoints locally...\n');
  
  const auditResult = await testAuditEndpoint();
  const pdfResult = await testPDFEndpoint();
  const pdfUrlResult = await testPDFFromURLEndpoint();
  
  console.log('\n=== Test Summary ===');
  console.log(`Audit endpoint: ${auditResult ? '✅' : '❌'}`);
  console.log(`PDF endpoint: ${pdfResult ? '✅' : '❌'}`);
  console.log(`PDF from URL endpoint: ${pdfUrlResult ? '✅' : '❌'}`);
  
  if (auditResult && pdfResult && pdfUrlResult) {
    console.log('\n🎉 All endpoints are working! Ready to deploy.');
  } else {
    console.log('\n⚠️  Some endpoints have issues. Check the logs above.');
  }
}

runAllTests();

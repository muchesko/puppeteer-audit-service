import crypto from 'crypto';

const KOYEB_BASE_URL = 'https://puppeteer-audit-service-meizo-a4e1146c.koyeb.app';
const API_SECRET_KEY = '6afe24f3b10d77a42ec30db83722a34fe4b99d75ed652a48687859b7fa8db492';

function generateSignature(body, secret) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function testFastSite() {
    // Use a very simple, fast-loading site
    const requestBody = {
        url: 'https://example.com', // Simple static site
        options: {
            mobile: false,
            screenshot: false
        }
    };

    const body = JSON.stringify(requestBody);
    const signature = generateSignature(body, API_SECRET_KEY);

    console.log('🚀 Testing with ultra-fast site (httpbin.org)...');
    console.log('📱 URL:', requestBody.url);

    try {
        const response = await fetch(`${KOYEB_BASE_URL}/api/audit/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Signature': `sha256=${signature}`
            },
            body: body
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }

        const result = await response.json();
        console.log('✅ Audit started:', result);

        if (result.jobId) {
            console.log(`⏳ Waiting for audit completion (Job ID: ${result.jobId})...`);
            
            // Poll for completion with longer timeout
            for (let i = 0; i < 30; i++) { // 3 minutes max
                await new Promise(resolve => setTimeout(resolve, 6000)); // Wait 6 seconds

                try {
                    const statusResponse = await fetch(`${KOYEB_BASE_URL}/api/audit/status/${result.jobId}`, {
                        headers: {
                            'X-Signature': `sha256=${generateSignature('{}', API_SECRET_KEY)}`
                        }
                    });

                    if (statusResponse.ok) {
                        const statusData = await statusResponse.json();
                        console.log(`📊 Status check ${i + 1}:`, statusData);

                        if (statusData.status === 'COMPLETED') {
                            console.log('🎉 Audit completed successfully!');
                            console.log('📈 Full Results:', JSON.stringify(statusData, null, 2));
                            return;
                        } else if (statusData.status === 'FAILED') {
                            console.log('❌ Audit failed:', statusData.error);
                            return;
                        }
                    } else {
                        console.log(`⚠️  Status check ${i + 1} failed: ${statusResponse.status}`);
                    }
                } catch (error) {
                    console.log(`⚠️  Status check ${i + 1} error:`, error.message);
                }
            }

            console.log('⏰ Timeout waiting for audit completion');
        }

    } catch (error) {
        console.error('❌ Test failed:', error.message);
    }
}

testFastSite();

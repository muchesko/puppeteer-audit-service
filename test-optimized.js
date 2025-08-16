import crypto from 'crypto';

const KOYEB_BASE_URL = 'https://puppeteer-audit-service-meizo-a4e1146c.koyeb.app';
const API_KEY = 'test-api-key';
const API_SECRET_KEY = 'default-secret'; // This is what the config uses as default

function generateSignature(body, secret) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function testOptimizedAudit() {
    const requestBody = {
        url: 'https://example.com',
        options: {
            mobile: false,
            includeScreenshot: false
        }
    };

    const body = JSON.stringify(requestBody);
    const signature = generateSignature(body, API_SECRET_KEY);

    console.log('🚀 Starting optimized audit test with memory fixes...');
    console.log('📱 URL:', requestBody.url);

    try {
        const response = await fetch(`${KOYEB_BASE_URL}/api/audit/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Signature': `sha256=${signature}`,
                'X-API-Key': API_KEY
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
            
            // Poll for completion
            for (let i = 0; i < 20; i++) { // 2 minutes max
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
                            console.log('📈 Results:', statusData);
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

testOptimizedAudit();

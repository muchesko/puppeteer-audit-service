import crypto from 'crypto';

const KOYEB_BASE_URL = 'https://puppeteer-audit-service-meizo-a4e1146c.koyeb.app';

function generateSignature(body, secret) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function testWithSecret(secret, secretName) {
    const requestBody = {
        url: 'https://example.com',
        options: {
            mobile: false,
            screenshot: false
        }
    };

    const body = JSON.stringify(requestBody);
    const signature = generateSignature(body, secret);

    console.log(`🔑 Testing with secret "${secretName}": ${secret}`);

    try {
        const response = await fetch(`${KOYEB_BASE_URL}/api/audit/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Signature': `sha256=${signature}`
            },
            body: body
        });

        if (response.ok) {
            const result = await response.json();
            console.log(`✅ Success with secret "${secretName}":`, result);
            return true;
        } else {
            const errorText = await response.text();
            console.log(`❌ Failed with secret "${secretName}": HTTP ${response.status}: ${errorText}`);
            return false;
        }
    } catch (error) {
        console.log(`❌ Error with secret "${secretName}":`, error.message);
        return false;
    }
}

async function testSecrets() {
    console.log('🧪 Testing different secrets to find the correct one...\n');
    
    const secrets = [
        'default-secret',
        'default-api-key', 
        'test-api-key',
        'test-webhook-secret',
        '', // empty string
        'meizo-secret',
        'puppeteer-secret'
    ];

    for (const secret of secrets) {
        const success = await testWithSecret(secret, secret || '(empty)');
        if (success) {
            console.log(`\n🎉 Found working secret: "${secret}"`);
            break;
        }
        console.log(''); // spacing
    }
}

testSecrets();

import crypto from 'crypto';

const LOCAL_BASE_URL = 'http://localhost:8080';
const API_SECRET_KEY = '6afe24f3b10d77a42ec30db83722a34fe4b99d75ed652a48687859b7fa8db492';

function generateSignature(body, secret) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function testLocalBestPractices() {
    console.log('🚀 Testing LOCAL service with our new best practices implementation...');
    console.log('📱 URL: https://example.com');
    
    // Test with a very simple, fast site first
    const requestBody = {
        url: 'https://example.com', // Very simple static site
        options: {
            mobile: false,
            screenshot: false
        }
    };

    const body = JSON.stringify(requestBody);
    const signature = generateSignature(body, API_SECRET_KEY);

    try {
        // Start audit
        const response = await fetch(`${LOCAL_BASE_URL}/api/audit`, {
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

        const startResult = await response.json();
        console.log('✅ Audit started:', startResult);

        const jobId = startResult.jobId;
        let attempts = 0;
        const maxAttempts = 30; // 1 minute max

        console.log(`⏳ Waiting for audit completion (Job ID: ${jobId})...`);

        while (attempts < maxAttempts) {
            attempts++;
            
            // Check status
            const statusResponse = await fetch(`${LOCAL_BASE_URL}/api/audit/${jobId}/status`, {
                headers: {
                    'X-Signature': `sha256=${generateSignature('{}', API_SECRET_KEY)}`
                }
            });
            
            const statusResult = await statusResponse.json();
            console.log(`📊 Status check ${attempts}:`, statusResult);
            
            if (statusResult.status === 'COMPLETED') {
                console.log('🎉 Audit completed successfully!');
                
                // Get full results
                const resultsResponse = await fetch(`${LOCAL_BASE_URL}/api/audit/${jobId}`, {
                    headers: {
                        'X-Signature': `sha256=${generateSignature('{}', API_SECRET_KEY)}`
                    }
                });
                
                const fullResults = await resultsResponse.json();
                
                console.log('📈 Best Practices Results:');
                console.log(`   Overall Score: ${fullResults.results.bestPracticesScore}/100`);
                console.log(`   Number of Checks: ${fullResults.results.categoryDetails.bestPractices.items.length}`);
                
                console.log('\n📋 Detailed Best Practices Checks:');
                fullResults.results.categoryDetails.bestPractices.items.forEach((item, index) => {
                    const statusIcon = item.status === 'PASS' ? '✅' : item.status === 'WARNING' ? '⚠️' : '❌';
                    console.log(`   ${statusIcon} ${item.title}: ${item.value} (${item.status})`);
                    console.log(`      ${item.description}`);
                });
                
                // Check if we're using the new implementation
                const hasNewFeatures = fullResults.results.categoryDetails.bestPractices.items.some(
                    item => item.title.includes('Deprecated HTML') || 
                           item.title.includes('Doctype') || 
                           item.title.includes('Mixed Content')
                );
                
                if (hasNewFeatures) {
                    console.log('\n🎉 SUCCESS: New best practices implementation is working!');
                    console.log(`   ✨ Enhanced score: ${fullResults.results.bestPracticesScore}/100`);
                    console.log(`   ✨ Comprehensive checks: ${fullResults.results.categoryDetails.bestPractices.items.length} items`);
                } else {
                    console.log('\n⚠️  WARNING: Still using old placeholder implementation');
                    console.log('   Expected new checks like "Deprecated HTML Elements", "HTML5 Doctype", etc.');
                }
                
                break;
            } else if (statusResult.status === 'FAILED') {
                console.error('❌ Audit failed:', statusResult.error || 'Unknown error');
                break;
            }
            
            // Wait 2 seconds before next check
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        if (attempts >= maxAttempts) {
            console.error('❌ Audit timed out after', maxAttempts * 2, 'seconds');
        }

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        throw error;
    }
}

// Run the test
testLocalBestPractices().catch(error => {
    console.error('Fatal error:', error.message);
    process.exit(1);
});

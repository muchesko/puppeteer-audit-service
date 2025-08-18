import crypto from 'crypto';

const KOYEB_BASE_URL = 'https://puppeteer-audit-service-meizo-a4e1146c.koyeb.app';
const API_SECRET_KEY = '6afe24f3b10d77a42ec30db83722a34fe4b99d75ed652a48687859b7fa8db492';

function generateSignature(body, secret) {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function testMuchesko() {
    // Test with muchesko.com
    const requestBody = {
        url: 'https://muchesko.com',
        options: {
            mobile: false,
            screenshot: true // Let's get a screenshot too
        }
    };

    const body = JSON.stringify(requestBody);
    const signature = generateSignature(body, API_SECRET_KEY);

    console.log('🚀 Testing muchesko.com...');
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
            
            // Poll for completion 
            for (let i = 0; i < 25; i++) { // 2.5 minutes max
                await new Promise(resolve => setTimeout(resolve, 6000)); // Wait 6 seconds

                try {
                    const statusResponse = await fetch(`${KOYEB_BASE_URL}/api/audit/status/${result.jobId}`, {
                        headers: {
                            'X-Signature': `sha256=${generateSignature('{}', API_SECRET_KEY)}`
                        }
                    });

                    if (statusResponse.ok) {
                        const statusData = await statusResponse.json();
                        console.log(`📊 Status check ${i + 1}:`, {
                            status: statusData.status,
                            timestamp: statusData.timestamp,
                            ...(statusData.results && {
                                performance: statusData.results.performanceScore,
                                seo: statusData.results.seoScore,
                                accessibility: statusData.results.accessibilityScore,
                                bestPractices: statusData.results.bestPracticesScore,
                                loadTime: statusData.results.metrics?.loadTime
                            })
                        });

                        if (statusData.status === 'COMPLETED') {
                            console.log('🎉 Audit completed successfully!');
                            console.log('\n📈 FINAL RESULTS:');
                            console.log('==================');
                            console.log(`🚀 Performance Score: ${statusData.results.performanceScore}/100`);
                            console.log(`🔍 SEO Score: ${statusData.results.seoScore}/100`);
                            console.log(`♿ Accessibility Score: ${statusData.results.accessibilityScore}/100`);
                            console.log(`✅ Best Practices Score: ${statusData.results.bestPracticesScore}/100`);
                            console.log(`⏱️  Load Time: ${statusData.results.metrics?.loadTime}ms`);
                            console.log(`📄 Pages Crawled: ${statusData.results.pagesCrawled}`);
                            
                            if (statusData.results.screenshot) {
                                console.log('📸 Screenshot captured successfully');
                            }
                            
                            if (statusData.results.issues && statusData.results.issues.length > 0) {
                                console.log('\n⚠️  Issues found:', statusData.results.issues.length);
                                statusData.results.issues.forEach((issue, idx) => {
                                    console.log(`  ${idx + 1}. [${issue.type}] ${issue.title}`);
                                });
                            } else {
                                console.log('\n✨ No issues found!');
                            }
                            
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

testMuchesko();

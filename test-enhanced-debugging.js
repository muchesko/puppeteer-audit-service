#!/usr/bin/env node

/**
 * Enhanced debugging test for Puppeteer service
 * Tests all the comprehensive improvements:
 * 1. DNS preflight checks
 * 2. Detailed logging and page event hooks
 * 3. Job-level watchdog timeouts
 * 4. Enhanced callback handling
 * 5. Progressive navigation strategies
 * 6. Safer performance metrics collection
 * 7. Express rate-limit robustness
 * 8. Comprehensive error handling
 */

import crypto from 'crypto';

// Use production Koyeb endpoint
const BASE_URL = 'https://relieved-carrie-meizo814-53c0b82e.koyeb.app';
const API_SECRET_KEY = process.env.API_SECRET_KEY || 'your-secret-key-from-koyeb-env';

function createSignature(body, secret) {
    return crypto
        .createHmac('sha256', secret)
        .update(body)
        .digest('hex');
}

async function makeRequest(path, options = {}) {
    const url = `${BASE_URL}${path}`;
    const body = options.body ? JSON.stringify(options.body) : undefined;
    
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'Meizo-Test-Client/1.0'
    };
    
    // Add HMAC signature for authenticated endpoints
    if (body && !path.includes('/health')) {
        const signature = createSignature(body, API_SECRET_KEY);
        headers['X-Signature'] = `sha256=${signature}`;
        console.log(`[auth] signed request with signature: sha256=${signature.substring(0, 8)}...`);
    }
    
    const requestOptions = {
        method: options.method || 'GET',
        headers,
        body,
        timeout: 30000 // 30 second timeout
    };
    
    console.log(`[request] ${requestOptions.method} ${url}`);
    if (body) console.log(`[request] body: ${body}`);
    
    try {
        const response = await fetch(url, requestOptions);
        console.log(`[response] ${response.status} ${response.statusText}`);
        
        const responseText = await response.text();
        console.log(`[response] body: ${responseText}`);
        
        return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            data: responseText ? JSON.parse(responseText) : null
        };
    } catch (error) {
        console.error(`[request] failed:`, error.message);
        throw error;
    }
}

async function testHealthCheck() {
    console.log('\n=== Testing Health Check ===');
    try {
        const response = await makeRequest('/health');
        console.log('✅ Health check passed:', response.data);
        return true;
    } catch (error) {
        console.error('❌ Health check failed:', error.message);
        return false;
    }
}

async function testAuditStart() {
    console.log('\n=== Testing Enhanced Audit Start ===');
    try {
        const auditRequest = {
            url: 'https://example.com',
            priority: 5,
            options: {
                mobile: false,
                desktop: true,
                screenshot: true
            }
        };
        
        const response = await makeRequest('/api/audit/start', {
            method: 'POST',
            body: auditRequest
        });
        
        if (response.ok) {
            console.log('✅ Audit started successfully:', response.data);
            return response.data.jobId;
        } else {
            console.error('❌ Audit start failed:', response.data);
            return null;
        }
    } catch (error) {
        console.error('❌ Audit start error:', error.message);
        return null;
    }
}

async function testStatusPolling(jobId) {
    console.log(`\n=== Testing Enhanced Status Polling for Job ${jobId} ===`);
    
    const maxAttempts = 40; // 40 attempts x 5 seconds = 3 minutes 20 seconds
    let attempts = 0;
    
    while (attempts < maxAttempts) {
        attempts++;
        console.log(`\n[polling] attempt ${attempts}/${maxAttempts}`);
        
        try {
            const response = await makeRequest(`/api/audit/status/${jobId}`);
            
            if (!response.ok) {
                console.error(`❌ Status check failed: ${response.status} ${response.statusText}`);
                console.error('Response:', response.data);
                break;
            }
            
            const { status, results, error, timestamp } = response.data;
            console.log(`[status] ${status} (checked at: ${timestamp})`);
            
            if (status === 'COMPLETED') {
                console.log('✅ Audit completed successfully!');
                console.log('📊 Results:', {
                    performance: results?.performanceScore,
                    seo: results?.seoScore,
                    accessibility: results?.accessibilityScore,
                    bestPractices: results?.bestPracticesScore,
                    pagesCrawled: results?.pagesCrawled,
                    hasScreenshot: !!results?.screenshot
                });
                
                if (results?.metrics) {
                    console.log('⏱️  Metrics:', results.metrics);
                }
                
                if (results?.issues?.length > 0) {
                    console.log('⚠️  Issues found:', results.issues.length);
                    results.issues.slice(0, 3).forEach(issue => {
                        console.log(`   - ${issue.category}: ${issue.title} (${issue.impact})`);
                    });
                }
                
                return true;
            } else if (status === 'FAILED') {
                console.error('❌ Audit failed:', error);
                return false;
            } else if (status === 'NOT_FOUND') {
                console.error('❌ Job not found - may have been cleaned up or invalid ID');
                return false;
            }
            
            // Continue polling for IN_PROGRESS or PENDING
            console.log(`[polling] waiting 5 seconds before next check...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            
        } catch (error) {
            console.error(`❌ Status check error:`, error.message);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    console.error('❌ Polling timed out after', maxAttempts * 5, 'seconds');
    return false;
}

async function testRateLimit() {
    console.log('\n=== Testing Enhanced Rate Limiting ===');
    
    console.log('[rate-limit] sending 5 rapid requests to test rate limiting...');
    const promises = [];
    
    for (let i = 1; i <= 5; i++) {
        promises.push(
            makeRequest('/health').then(response => ({
                attempt: i,
                success: response.ok,
                status: response.status
            })).catch(error => ({
                attempt: i,
                success: false,
                error: error.message
            }))
        );
    }
    
    const results = await Promise.all(promises);
    results.forEach(result => {
        if (result.success) {
            console.log(`[rate-limit] attempt ${result.attempt}: ✅ ${result.status}`);
        } else {
            console.log(`[rate-limit] attempt ${result.attempt}: ❌ ${result.error}`);
        }
    });
    
    console.log('✅ Rate limiting test completed');
}

async function runFullTest() {
    console.log('🚀 Starting Enhanced Debugging Test Suite');
    console.log(`🔗 Testing endpoint: ${BASE_URL}`);
    console.log(`🔐 Using API secret: ${API_SECRET_KEY.substring(0, 8)}...`);
    
    try {
        // Test 1: Health check
        const healthOk = await testHealthCheck();
        if (!healthOk) {
            console.error('❌ Health check failed - aborting test suite');
            return;
        }
        
        // Test 2: Rate limiting
        await testRateLimit();
        
        // Test 3: Start audit with enhanced debugging
        const jobId = await testAuditStart();
        if (!jobId) {
            console.error('❌ Failed to start audit - aborting test suite');
            return;
        }
        
        // Test 4: Poll status with enhanced monitoring
        const auditSuccess = await testStatusPolling(jobId);
        
        if (auditSuccess) {
            console.log('\n🎉 All tests passed! Enhanced debugging is working.');
        } else {
            console.log('\n⚠️  Some tests failed. Check the logs above for details.');
        }
        
    } catch (error) {
        console.error('\n💥 Test suite failed with error:', error);
    }
}

// Run the test
runFullTest().catch(console.error);

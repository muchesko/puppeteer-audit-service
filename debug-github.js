import { AuditService } from './src/services/auditService.js';

const auditService = new AuditService();

async function testGitHub() {
    try {
        console.log('Starting direct GitHub audit test...');
        
        const request = {
            jobId: 'test-github-' + Date.now(),
            websiteUrl: 'https://github.com',
            options: {
                mobile: false,
                includeScreenshot: false
            }
        };

        console.log('Starting audit...');
        await auditService.startAudit(request);

        // Wait and check status
        for (let i = 0; i < 30; i++) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            const status = await auditService.getAuditStatus(request.jobId);
            const details = await auditService.getAuditDetails(request.jobId);
            
            console.log(`Status check ${i + 1}: ${status}`);
            
            if (status === 'COMPLETED') {
                console.log('✅ Success!', details);
                break;
            } else if (status === 'FAILED') {
                console.log('❌ Failed:', details);
                break;
            }
        }

    } catch (error) {
        console.error('Error during test:', error);
    } finally {
        await auditService.cleanup();
    }
}

testGitHub();

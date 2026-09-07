const { execSync } = require('child_process');
const result = execSync('tsc -p .\\', { cwd: 'C:\\Users\\Ajinkya\\AJ\\Files\\Github projects\\CodeSense - AI Powered DSA Problem Solving Helper', stdio: 'inherit' });
process.exit(result.status);
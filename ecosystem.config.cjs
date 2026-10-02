const path = require('path');
const tsxCli = path.join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const nextCli = path.join(__dirname, 'node_modules', 'next', 'dist', 'bin', 'next');

module.exports = {
  apps: [
    {
      name: 'ai4es-api',
      cwd: __dirname,
      script: tsxCli,
      args: 'server/api/index.ts',
      interpreter: 'node',
      windowsHide: true,
      max_memory_restart: '1500M',
      env: {
        AI4ES_ROLE: 'api',
        AI4ES_USE_JOB_QUEUE: '1',
        API_PORT: '4000',
        API_HOST: '127.0.0.1'
      }
    },
    {
      name: 'ai4es-worker',
      cwd: __dirname,
      script: tsxCli,
      args: 'server/worker/index.ts',
      interpreter: 'node',
      windowsHide: true,
      max_memory_restart: '2000M',
      env: {
        AI4ES_ROLE: 'worker',
        AI4ES_USE_JOB_QUEUE: '0'
      }
    },
    {
      name: 'ai4es-web',
      cwd: __dirname,
      script: nextCli,
      args: 'start --hostname=:: -p 3000',
      interpreter: 'node',
      windowsHide: true,
      max_memory_restart: '1000M',
      env: {
        AI4ES_SPLIT: '1',
        AI4ES_API_URL: 'http://127.0.0.1:4000',
        PORT: '3000'
      }
    }
  ]
};
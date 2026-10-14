'use strict';
// pm2 process file. Run as the host's admin user:
//   sudo pm2 start ecosystem.config.js && sudo pm2 save
module.exports = {
  apps: [
    {
      name: 'llm-manager',
      script: 'server.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      env: {
        LLM_API_HOST: '0.0.0.0',
        LLM_API_PORT: '8790',
        // Pin the bearer token across restarts (otherwise one is generated per boot):
        // LLM_API_TOKEN: 'replace-me',
        SWEEP_INTERVAL_MS: String(25 * 60 * 1000), // liveness sweep every 25 min
        REFRESH_MIN_AGE_MS: String(5 * 60 * 1000), // status cache older than this triggers bg refresh
        STOP_GRACE_MS: '10000',
        ENABLE_GPU_PROBE: 'auto', // auto | on | off
        // '1' => also stop tracked LLM processes when the API shuts down (default: off —
        // LLMs survive API restarts and are re-adopted from /proc on boot):
        // STOP_CHILDREN_ON_SHUTDOWN: '1',
      },
      out_file: 'logs/api-out.log',
      err_file: 'logs/api-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      time: true,
    },
  ],
};

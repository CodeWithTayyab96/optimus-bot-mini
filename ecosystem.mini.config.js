/**
 * pm2 process configuration for Optimus Mini.
 *
 * Use this when the host already runs pm2, or when you prefer pm2 over systemd.
 * It is the Mini equivalent of ecosystem.config.js: one process, no PO-token
 * provider, no extra apps.
 *
 *   pm2 start ecosystem.mini.config.js
 *   pm2 save
 *   pm2 startup            # generate the boot service (run the printed command)
 *
 * Log rotation: pm2 writes to ./logs/pm2-*.log. Install pm2-logrotate and cap
 * it, or rely on the bot's own rotating log (logs/mini.log, ~6 MB ceiling):
 *
 *   pm2 install pm2-logrotate
 *   pm2 set pm2-logrotate:max_size 2M
 *   pm2 set pm2-logrotate:retain 2
 */
module.exports = {
    apps: [
        {
            name: 'optimus-mini',
            script: 'mini.js',
            cwd: __dirname,
            // Cap the V8 heap below the RSS ceiling so the process fails soft.
            node_args: '--max-old-space-size=160',
            autorestart: true,
            // Crash-loop breaker: pm2 counts a restart only if the process died
            // before min_uptime, and stops after max_restarts. Without min_uptime
            // a process that dies instantly is never counted and restarts forever.
            min_uptime: '30s',
            max_restarts: 6,
            restart_delay: 5000,
            // pm2 restarts the app if RSS passes this (mirrors MAX_RSS_MB).
            max_memory_restart: '200M',
            kill_timeout: 12000,
            wait_ready: false,
            env: {
                NODE_ENV: 'production',
                OPTIMUS_MINI: '1',
            },
            out_file: './logs/pm2-out.log',
            error_file: './logs/pm2-error.log',
            merge_logs: true,
            time: true,
        },
    ],
};

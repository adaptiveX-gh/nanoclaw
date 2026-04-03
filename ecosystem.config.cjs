module.exports = {
  apps: [
    {
      name: 'nanoclaw',
      script: 'dist/index.js',
      cwd: __dirname,
      node_args: '--enable-source-maps',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // Ensure bot containers survive nanoclaw restarts (--restart=unless-stopped)
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

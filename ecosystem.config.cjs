module.exports = {
  apps: [
    {
      name: 'promptwar',
      script: 'server.js',
      cwd: '/Users/aryanagr/Documents/promptwar',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      watch: false,
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      }
    }
  ]
};

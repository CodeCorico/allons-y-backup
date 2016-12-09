'use strict';

var path = require('path');

module.exports = {
  name: 'Allons-y Backup',
  enabled: !process.env.BACKUP || process.env.BACKUP == 'true' || false,
  fork: true,
  forkCount: 1,
  forkMaxRestarts: 10,
  watch: '*-backup.js',
  module: require(path.resolve(__dirname, 'backup-cron.js'))
};

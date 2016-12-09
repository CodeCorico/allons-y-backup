'use strict';

var path = require('path');

module.exports = {
  liveCommands: [!process.env.BACKUP || process.env.BACKUP == 'true' ? {
    commands: 'backup',
    description: 'execute the backup task immediately',
    action: require(path.resolve(__dirname, 'backup-live-commands.js'))
  } : null]
};


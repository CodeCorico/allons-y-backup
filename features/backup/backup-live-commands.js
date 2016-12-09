'use strict';

module.exports = function($allonsy) {
  $allonsy.outputInfo('► backup:\n');

  $allonsy.sendMessage({
    event: 'call(backup/start)'
  });
};

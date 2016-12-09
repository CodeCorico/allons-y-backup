'use strict';

module.exports = function($allonsy, $glob, $done) {

  var path = require('path'),
      async = require('async'),
      fs = require('fs-extra'),
      TarGz = require('tar.gz'),
      scp2 = require('scp2'),
      Ssh2 = require('ssh2'),

      HOURS = parseInt(process.env.BACKUP_HOUR || 3, 10),
      BACKUP_PATH = path.resolve('./backup'),
      BACKUP_KEEP_DAYS = parseInt(process.env.BACKUP_KEEP_DAYS || 30, 10),
      BACKUP_NAME = process.env.BACKUP_NAME + '.tar.gz',

      _backupTimeout = null,
      _tasks = [],
      _backupFiles = $allonsy.findInFeaturesSync('*-backup.js');

  fs.ensureDirSync(BACKUP_PATH);

  $allonsy.on('message', function(args) {
    if (args.event == 'call(backup/start)') {
      clearTimeout(_backupTimeout);
      _backup();
    }
  });

  function _elaspedTime(startDate) {
    var endDate = new Date(),
        time = (endDate.getTime() - startDate.getTime()) / 1000,
        hours   = Math.floor(time / 3600),
        minutes = Math.floor((time - (hours * 3600)) / 60),
        seconds = Math.floor(time - (hours * 3600) - (minutes * 60));

    return ((hours ? hours + 'h' : '') + (minutes ? ' ' + minutes + 'min' : '') + (seconds ? ' ' + seconds + 's' : '')).trim();
  }

  function _done(startDate, notFinished) {
    $allonsy.outputInfo('[done:backup]► (' +
      startDate.getDate() + '/' + (startDate.getMonth() + 1) + '/' + startDate.getFullYear() + ' ' +
      startDate.getHours() + ':' + startDate.getMinutes() +
    ') Backed up [' + _tasks.length + ' tasks] [in ' + _elaspedTime(startDate) + ']' +
    (notFinished ? ' ! Not finished !' : ''));

    _backupClock();
  }

  function _doneError(startDate, err) {
    $allonsy.outputError('Backup Error:', err);

    _done();
  }

  function _ssh2command(client, command, callback) {
    client.exec(command, function(err, stream) {
      if (err) {
        return callback(err);
      }

      var dataResult = '',
          dataError = '';

      stream
        .on('close', function() {
          callback(dataError || null, dataResult);
        })
        .on('data', function(data) {
          dataResult += data;
        })
        .stderr.on('data', function(data) {
          dataError += data;

          callback(data);
        });
    });
  }

  function _ssh2RemoveFile(ssh2Config, client, list, callback) {
    var file = list.shift();

    _ssh2command(client, 'rm "' + ssh2Config.path + '/' + file + '"', function(err) {
      if (err) {
        $allonsy.outputWarning('Backup: rm "' + ssh2Config.path + '/' + file + '"', err);
      }

      callback();
    });
  }

  function _backup() {
    var startDate = new Date(),
        activeTask = 0,
        files = [];

    async.eachSeries(_tasks, function(task, nextTask) {
      activeTask++;

      $allonsy.outputInfo('[working:backup]► Backup: execute task... [' + activeTask + '/' + _tasks.length + ' tasks]');

      DependencyInjection.injector.controller.invoke(null, task, {
        controller: {
          $backupPath: function() {
            return BACKUP_PATH;
          },

          $addDestination: function() {
            return function(file) {
              files.push(file);
            };
          },

          $done: function() {
            return nextTask;
          }
        }
      });

    }, function() {
      if (!files.length) {
        $allonsy.outputWarning('► No file to compress for the Backup process');

        return _backupClock();
      }

      $allonsy.outputInfo('[working:backup]► Backup: files compression... [' + _tasks.length + ' tasks]');

      var tempDir = 'temp-' + Math.round(Math.random() * 100000),
          tempPath = path.join(BACKUP_PATH, tempDir);

      fs.ensureDirSync(tempPath);

      async.eachSeries(files, function(file, nextFile) {
        fs.move(file, path.join(tempPath, file.split(path.sep).pop()), nextFile);
      }, function() {

        var date = new Date();

        date = [date.getFullYear(), date.getMonth(), date.getDate(), '-', date.getHours(), date.getMinutes()];

        for (var i = 0; i < date.length; i++) {
          if (typeof date[i] == 'number' && date[i] < 10) {
            date[i] = '0' + date[i];
          }
        }

        var backupFile = BACKUP_NAME.replace(/{date}/g, date.join('')),
            backupPath = path.join(BACKUP_PATH, backupFile);

        new TarGz({}, {
          fromBase: true
        }).compress(tempPath, backupPath, function(err) {
          if (err) {
            return _doneError(startDate, err);
          }

          fs.removeSync(tempPath);

          if (BACKUP_KEEP_DAYS !== 0) {
            $allonsy.outputInfo('[working:backup]► Backup: clear the local files overflow... [' + _tasks.length + ' tasks]');

            var backupFiles = $glob.sync(path.join(BACKUP_PATH, BACKUP_NAME.replace(/{date}/g, '*')));

            backupFiles.sort();

            while (backupFiles.length > BACKUP_KEEP_DAYS) {
              fs.removeSync(backupFiles.shift());
            }
          }

          if (!process.env.BACKUP_EXPORT || process.env.BACKUP_EXPORT != 'true') {
            return _done(startDate);
          }

          $allonsy.outputInfo('[working:backup]► Backup: export compressed file... [' + _tasks.length + ' tasks]');

          scp2.scp(backupPath, process.env.BACKUP_SERVER, function(err) {
            if (err) {
              return _doneError(startDate, err);
            }

            var ssh2Client = null;

            async.waterfall([function(nextDaysFunction) {
              if (BACKUP_KEEP_DAYS === 0) {
                return nextDaysFunction();
              }

              $allonsy.outputInfo('[working:backup]► Backup: clear the server files overflow... [' + _tasks.length + ' tasks]');

              ssh2Client = new Ssh2();

              var ssh2Config = scp2.Client.prototype.parse(process.env.BACKUP_SERVER);

              ssh2Client
                .on('ready', function() {

                  ssh2Client.sftp(function(err, sftp) {
                    if (err) {
                      return _doneError(startDate, err);
                    }

                    sftp.readdir(ssh2Config.path, function(err, list) {
                      if (err) {
                        return _doneError(startDate, err);
                      }

                      if (!list || list.length <= BACKUP_KEEP_DAYS) {
                        return nextDaysFunction();
                      }

                      list = list
                        .map(function(item) {
                          return item.filename;
                        })
                        .sort();

                      async.waterfall(new Array(list.length - BACKUP_KEEP_DAYS).fill(function(nextRemoveFunction) {
                        _ssh2RemoveFile(ssh2Config, ssh2Client, list, nextRemoveFunction);
                      }), function() {
                        nextDaysFunction();
                      });
                    });
                  });
                })
                .connect(ssh2Config);

            }, function() {
              if (ssh2Client) {
                ssh2Client.end();
              }

              if (!process.env.BACKUP_KEEP_LOCAL || process.env.BACKUP_KEEP_LOCAL != 'false') {
                return _done(startDate);
              }

              $allonsy.outputInfo('[working:backup]► Backup: delete the local backup... [' + _tasks.length + ' tasks]');

              fs.removeSync(backupPath);

              _done(startDate);
            }]);
          });
        });
      });
    });
  }

  function _backupClock() {
    clearTimeout(_backupTimeout);

    var date = new Date(),
        nextDate = new Date(),
        hours = date.getHours();

    if (hours >= HOURS) {
      nextDate.setDate(nextDate.getDate() + 1);
    }

    nextDate.setHours(HOURS);
    nextDate.setMinutes(0);
    nextDate.setSeconds(0);
    nextDate.setMilliseconds(0);

    _backupTimeout = setTimeout(_backup, nextDate.getTime() - date.getTime());
  }

  function _close() {
    $allonsy.outputWarning('► No task found for the Backup process');

    $done();

    process.exit();
  }

  if (!_backupFiles.length) {
    return _close();
  }

  async.eachSeries(_backupFiles, function(file, nextFile) {
    DependencyInjection.injector.controller.invoke(null, require(path.resolve(file)), {
      controller: {
        $task: function() {
          return function(func) {
            _tasks.push(func);
          };
        },

        $done: function() {
          return nextFile;
        }
      }
    });
  }, function() {
    if (!_tasks.length) {
      return _close();
    }

    _backupClock();
  });

  $done();
};

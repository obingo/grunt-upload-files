/*
 * grunt-upload
 * http://pay.qq.com/
 *
 * Copyright (c) 2013 Bingo(xsbchen@tencent.com)
 * Licensed under the MIT license.
 */

module.exports = function(grunt) {
  'use strict';

  var FTPClient = require('ftp');
  var path = require('path');
  var http = require('http');
  var url = require('url');
  var fs = require('fs');
  var helper = {};

  grunt.registerMultiTask('upload', '文件上传任务', function() {
    var done = this.async();
    var doneCount = this.files.length;

    this.files.forEach(function(filePair) {
      if (filePair.src.length <= 0) {
        grunt.log.ok('No file to upload.');
        done();
        return true;
      }

      var target = url.parse(grunt.template.process(filePair.target));
      var type = target.protocol.replace(':', '');
      var strip = filePair.strip;
      var upload = helper[type] || function(){};
      var callback = filePair.callback || function(){};

      if (typeof strip === 'string') {
        strip = new RegExp('^' + grunt.template.process(strip).replace(/[\-\[\]{}()*+?.,\\\^$|#\s]/g, '\\$&'));
      }

      var uploadStartTime = new Date();
      var files = filePair.src.filter(function(filePath) {return grunt.file.isFile(filePath);});
      upload(files, strip, target, function(successFiles, errorFiles) {
        var uploadTotalTime = new Date() - uploadStartTime;
        callback(successFiles, errorFiles);
        grunt.log.writeln();
        grunt.log.ok('Upload Completed, ' + successFiles.length.toString().green + ' success, ' + errorFiles.length.toString().red + ' error.');
        grunt.log.ok('Total time: ' + uploadTotalTime.toString().green + 'ms');

        if (--doneCount <= 0) {
          done();
        }
      });
    });
  });

  // 实现ftp上传接口
  helper.ftp = function(files, strip, target, callback) {
    var ftp = new FTPClient();
    var auth = target.auth;
    var user = null;
    var password = null;
    var successFiles = [];
    var errorFiles = [];

    if (auth) {
      auth = auth.split(':');
      if (auth.length === 2) {
        user = auth[0];
        password = auth[1];
      }
    }

    var ftpOpts = {
      host: target.hostname,
      port: target.port || 21,
      user: user,
      password: password
    };

    var mkdir = function (fullPath, cb) {
      var paths = fullPath.replace(/^\//, '').split('/');

      var makeNextDir = function () {
        var dir = paths.shift();

        if (dir !== undefined) {
          ftp.cwd(dir, function (err) {
            if (err) {// 目录不存在
              ftp.mkdir(dir, function (err) {
                if (err) {
                  grunt.log.error('[FTP]Create folder ' + dir.cyan + ' failed');
                } else {
                  grunt.log.writeln('[FTP]Create folder: ' + dir.cyan);
                }
                ftp.cwd(dir, makeNextDir);
              });
            } else {// 目录已存在
              makeNextDir();
            }
          });
        } else {
          if (typeof cb === 'function') {
            cb();
          }
        }
      };

      ftp.cwd(fullPath, function(err) {
        if (err) {
          // 进入根目录后开始递归创建目录
          ftp.cwd('/', makeNextDir);
        } else {
          cb();
        }
      });
    };

    var uploadNextFile = function () {
      var srcFile = files.shift();
      var _doUpload = function(err) {
        if (err) {
          errorFiles.push(toFile);
          grunt.log.error();

          uploadNextFile();
        } else {
          ftp.put(fs.createReadStream(srcFile), fileName, function(err) {
            if (err) {
              errorFiles.push(toFile);
              grunt.log.error();
            } else {
              successFiles.push(toFile);
              grunt.log.ok();
            }

            uploadNextFile();
          });
        }
      };

      if (srcFile) {
        var toFile = target.path.replace(/\{path\}/g, srcFile.replace(strip, ''));
        var toDir = path.dirname(toFile);
        var fileName = path.basename(toFile);

        mkdir(toDir, function() {
          grunt.log.write('[FTP]Upload ' + srcFile.cyan + ' to ' + toFile.cyan + '...');

          if (inSameDir()) {
            _doUpload(null);
          } else {
            ftp.cwd(toDir, function(err) {
              _doUpload(err);
            });
          }
        });
      } else {
        //ftp.end(); // Fixme
        callback(successFiles, errorFiles);
      }
    };

    ftp.on('ready', uploadNextFile);

    ftp.connect(ftpOpts);
  };

  function inSameDir(src, dest) {
    src = path.dirname(src);
    dest = path.dirname(dest);

    return path.resolve(src) === path.resolve(dest);
  }

  // 实现http put上传接口
  helper.http = function(files, strip, target, callback) {
    var successFiles = [];
    var errorFiles = [];
    var srcFileCount = files.length;
    var uploadedCount = 0;

    var putOpts = {
      host: target.hostname,
      port: target.port || 80,
      method: 'PUT'
    };

    var uploadCallback = function(res) {
        uploadedCount++;
        
        grunt.log.write('[PUT]Upload ' + res.src.cyan + ' to ' + res.file.cyan + '...');
        if (res.success) {
          successFiles.push(res.file);
          grunt.log.ok();
        } else {
          errorFiles.push(res.file);
          grunt.log.writeln(res.errmsg.red);
        }

        if (uploadedCount >= srcFileCount) {
          callback(successFiles, errorFiles);
        }
    };

    files.forEach(function(srcFile) {
        var srcFileStream = fs.createReadStream(srcFile);
        putOpts.path = target.path.replace(/\{path\}/g, srcFile.replace(strip, ''));

        var request = http.request(putOpts, function(response) {
            response.setEncoding('utf8');

            var data = '';

            response.on('data', function(chunk) {
              data += chunk;
            });

            response.on('end', function() {
              var res = JSON.parse(data);
              res.type = 'put';
              res.src = srcFile;
              uploadCallback(res);
            });
        });

        request.on('error', function(e) {
          uploadCallback({type: 'put', success: false, src: srcFile, file: url.parse(this.path, true).query.file, errmsg: e.message});
        });

        srcFileStream.pipe(request);
    });
  };
};
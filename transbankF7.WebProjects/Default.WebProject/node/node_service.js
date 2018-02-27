if (require.main === module) {
    //------------------------------------------------------------------- 
    // Fix #176 for GUI applications on Windows - copied from edge.js
    try {
        var stdout = process.stdout;
    } catch (e) {
        // This is a Windows GUI application without stdout and stderr defined.
        // Define process.stdout and process.stderr so that all output is discarded. 
        (function() {
            var stream = require('stream');
            var NullStream = function(o) {
                stream.Writable.call(this);
                this._write = function(c, e, cb) { cb && cb(); };
            }
            require('util').inherits(NullStream, stream.Writable);
            var nullStream = new NullStream();
            process.__defineGetter__('stdout', function() { return nullStream; });
            process.__defineGetter__('stderr', function() { return nullStream; });
        })();
    }
};

var messageHandler = function(settings) {
    var net = require('net');
    var a5id = settings.a5id;
    var outputFolder = settings.outputFolder;
    var exeFolder = settings.exeFolder;
    var serviceLocation = settings.serviceLocation;
    var cmdPipeName = '\\\\.\\pipe\\a5_node_command_' + a5id;
    var resultPipeName = '\\\\.\\pipe\\a5_node_request_' + a5id;
    var outstream = null;
    var pendingEvents = {};
    var nodeSettings = {};
    var fs = require("fs");
    var redisSend = null;
    var createUUID = null;
    var runStartupScripts = null;
    var lateInstallSource = null;
    var lateInstallDest = null;
    var lateInstallManifest = null;
    var jitModuleInstaller = {};
    var incompleteApiCalls = {};

    //------------------------------------- API call object 
    // For services that implement API pattern
    var callObjectConstructor = function() {
        function callObject(packet, response, sendResponse, returnMapping) {
            this.__state = { cancelled: false, complete: false, response: response, eventHandler: sendResponse };
            this.arguments = packet.arguments || {};
            this.properties = packet.properties || {};
            this._id = packet._id;
            this.returnMapping = returnMapping;
            incompleteApiCalls[this._id] = this;
        };
        var packBinarys = function(mapping, vars, name) {
            var binaries = null;
            if (typeof mapping === "string") {
                var levelName = null;
                var childNames = null;
                var offset = mapping.indexOf(".");
                if (offset > 0) {
                    levelName = mapping.substr(0, offset);
                    childNames = mapping.substr(offset + 1);
                } else {
                    levelName = mapping;
                }
                if (levelName.indexOf("[]") > 0) {
                    // Lets loop throught the 'array(s)'
                    levelName = levelName.split("[]");
                    var dimensions = levelName.length - 1;
                    levelName = levelName[0];
                    var walkArray = function(arr, arrName, nchild) {
                        var childBinaries = null,
                            childBinary = null;
                        if (arr) {
                            var i;
                            for (i = 0; i < arr.length; ++i) {
                                if (nchild > 0) {
                                    childBinary = walkArray(arr[i], arrName + "[" + i + "]", nchild - 1);
                                    if (childBinary) {
                                        if (childBinaries) {
                                            childBinaries = childBinaries.concat(childBinary);
                                        } else {
                                            childBinaries = childBinary;
                                        }
                                    }
                                } else {
                                    if (childNames) {
                                        childBinary = packBinarys(childNames, arr[i], arrName + "[" + i + "].");
                                        if (childBinary) {
                                            if (childBinaries) {
                                                childBinaries = childBinaries.concat(childBinary);
                                            } else {
                                                childBinaries = childBinary;
                                            }
                                        }
                                    } else {
                                        // Array of binaries...
                                        if (arr[i]) {
                                            if (!childBinaries) {
                                                childBinaries = [];
                                            }
                                            childBinaries.push({ name: (arrName + "[" + i + "]"), data: arr[i] });
                                            arr[i] = "@" + arrName + "[" + i + "]";
                                        }
                                    }
                                }
                            }
                        }
                        return childBinaries;
                    };
                    binaries = walkArray(vars[levelName], name + levelName, dimensions - 1);
                } else {
                    var elem = vars[levelName];
                    if (elem) {
                        if (childNames) {
                            binaries = packBinarys(childNames, elem, name + levelName + ".");
                        } else {
                            vars[levelName] = "@" + name + levelName;
                            binaries = [{ name: (name + levelName), data: elem }];
                        }
                    }
                }
            } else {
                var childBinaries = null;
                var i;
                for (i = 0; i < mapping.length; ++i) {
                    childBinaries = packBinarys(mapping[i], vars, name);
                    if (childBinaries) {
                        if (binaries) {
                            binaries = binaries.concat(childBinaries);
                        } else {
                            binaries = childBinaries;
                        }
                    }
                }
            }
            return binaries;
        };

        callObject.prototype.return = function(result) {
            if (!this.__state.complete) {
                var attachments = null;
                incompleteApiCalls[this._id] = null;
                this.__state.complete = true;
                this.__state.response.result = result;
                if (this.returnMapping) {
                    // Populate the result...
                    attachments = packBinarys(this.returnMapping, this.__state.response, "");
                }
                this.__state.eventHandler(this.__state.response, attachments);
            }
        };
        callObject.prototype.error = function(error) {
            if (!this.__state.complete) {
                incompleteApiCalls[this._id] = null;
                this.__state.complete = true;
                this.__state.response.error = error;
                this.__state.eventHandler(this.__state.response, null);
            }
        };
        callObject.prototype.cancelled = function() {
            if (this.__state.cancelled) {
                if (!this.__state.complete) {
                    this.error("Cancelled");
                }
            }
            return this.__state.cancelled;
        };
        callObject.prototype.returned = function() {
            if (this.__state.cancelled) {
                if (!this.__state.complete) {
                    this.error("Cancelled");
                }
            }
            return this.__state.complete;
        };
        callObject.prototype.GetSettingsFolder = function() {
            return outputFolder;
        };
        callObject.prototype.GetExeFolder = function() {
            return exeFolder;
        };
        callObject.prototype.GetSettings = function() {
            return nodeSettings;
        };
        return callObject;
    };

    var CallObject = callObjectConstructor();

    //---------------------------------------------------------------------------
    // Generic Api Wrapper (requires api be defined)
    var genericApi = function(packet, response, sendResponse) {
        if (packet.method) {
            var method = this.api[packet.method];
            if (method) {
                var returnMapping = null;
                if (this.api["$mapping"]) {
                    // Instructions for mapping results
                    returnMapping = this.api["$mapping"][packet.method];
                }
                method(new CallObject(packet, response, sendResponse, returnMapping));
            } else {
                response.error = "Method " + packet.method + " not found";
                sendResponse(response, null);
            }
        } else {
            response.error = "No method specified";
            sendResponse(response, null);
        }
    };



    // If service location is under /programdata/alpha software/ - assume we are using the late installer
    if (serviceLocation.toLowerCase().split("\\").join("/").indexOf("/programdata/alpha software/") >= 0) {
        lateInstallSource = process.execPath.split("\\");
        lateInstallSource[lateInstallSource.length - 1] = "node_install/";
        lateInstallSource = lateInstallSource.join("/");
        // Where to late install modules....
        lateInstallDest = serviceLocation.split("\\").join("/").split("/");
        if (lateInstallDest[lateInstallDest.length - 1] === "") {
            lateInstallDest.splice(lateInstallDest.length - 1, 1);
        }
        lateInstallManifest = lateInstallDest.join("/");
        lateInstallDest[lateInstallDest.length - 1] = "node_modules";
        lateInstallDest = lateInstallDest.join("/");
        // Manifest to track timestamps from source files.
        lateInstallManifest = serviceLocation.split("/");
        lateInstallManifest[lateInstallManifest.length - 1] = "installed.json";
        lateInstallManifest = lateInstallManifest.join("/");
        console.log("Late Install from " + lateInstallSource);
        console.log("Late Install to " + lateInstallDest);
        fs.readFile(lateInstallManifest, "utf8", function(err, mdata) {
            var mfest;
            if (!err) {
                try {
                    mfest = JSON.parse(mdata);
                } catch (e) {}
            }
            if (mfest && mfest.installed) {
                // Need to check if any installs are out of date
                fs.readdir(lateInstallSource.substring(0, lateInstallSource.length - 1), function(err, lateModules) {
                    if (!err) {
                        var i;
                        var pendingInstallCleanup = 0;
                        var rmFolders = [];
                        var onInstallCleanupComplete = function() {
                            --pendingInstallCleanup;
                            if (pendingInstallCleanup <= 0) {
                                if (rmFolders.length > 0) {
                                    // More work
                                    var i = -1;
                                    var folders = rmFolders;
                                    rmFolders = [];
                                    ++pendingInstallCleanup;
                                    //---- TBD cleaup logic
                                    var cleanupNextFolder = function() {
                                        ++i;
                                        if (i < folders.length) {
                                            fs.rmdir(folders[i], function() {
                                                cleanupNextFolder();
                                            })
                                        }
                                    };
                                    cleanupNextFolder();
                                }
                            }
                        };
                        var cleanupPathRecurse = function(topPath, contentsDone) {
                            ++pendingInstallCleanup;
                            fs.readdir(topPath, function(err, ddata) {
                                if (!err) {
                                    var i;
                                    var countDown = ddata.length;
                                    for (i = 0; i < ddata.length; ++i) {
                                        if (ddata[i] !== "." && ddata[i] !== "..") {
                                            (function() {
                                                var fname = ddata[i];
                                                ++pendingInstallCleanup;
                                                fs.stat(topPath + "/" + fname, function(serr, sinfo) {
                                                    if (sinfo.isDirectory()) {
                                                        cleanupPathRecurse(topPath + "/" + fname, function(foldername) {
                                                            rmFolders.push(foldername);
                                                            --countDown;
                                                            if (countDown <= 0) {
                                                                contentsDone(topPath);
                                                            }
                                                        });
                                                        onInstallCleanupComplete();
                                                    } else {
                                                        fs.unlink(topPath + "/" + fname, function() {
                                                            onInstallCleanupComplete();
                                                            --countDown;
                                                            if (countDown <= 0) {
                                                                contentsDone(topPath);
                                                            }
                                                        });
                                                    }
                                                });
                                            }());
                                        } else {
                                            --countDown;
                                            if (countDown <= 0) {
                                                contentsDone(topPath);
                                            }
                                        }
                                    }
                                }
                                onInstallCleanupComplete();
                            });
                        };
                        for (i = 0; i < lateModules.length; ++i) {
                            var modName = lateModules[i].toLowerCase()
                            if (modName.indexOf(".zip") > 0) {
                                modName = modName.replace(".zip", "");
                                if (mfest.installed[modName]) {
                                    (function() {
                                        var fname = lateModules[i];
                                        var testmtime = mfest.installed[modName];
                                        ++pendingInstallCleanup;
                                        fs.stat(lateInstallSource + fname, function(err, fdata) {
                                            if (!err) {
                                                if (JSON.parse(JSON.stringify({ mtime: fdata.mtime })).mtime !== testmtime) {
                                                    cleanupPathRecurse(lateInstallDest + "/" + fname.replace(".zip", ""), function(foldername) {
                                                        rmFolders.push(foldername);
                                                        onInstallCleanupComplete();
                                                    });
                                                } else {
                                                    onInstallCleanupComplete();
                                                }
                                            } else {
                                                onInstallCleanupComplete();
                                            }
                                        });
                                    }());
                                }
                            }
                        }
                    } else {
                        console.log("Cannot find install files " + err);
                    }
                });
            }
        });
    }

    (function(_window) {
        'use strict';

        // Unique ID creation requires a high quality random # generator.  We feature
        // detect to determine the best RNG source, normalizing to a function that
        // returns 128-bits of randomness, since that's what's usually required
        var _rng, _mathRNG, _nodeRNG, _whatwgRNG, _previousRoot;

        function setupNode() {
            // Node.js crypto-based RNG - http://nodejs.org/docs/v0.6.2/api/crypto.html
            //
            // Moderately fast, high quality
            if ('function' === typeof require) {
                try {
                    var _rb = require('crypto').randomBytes;
                    _nodeRNG = _rng = _rb && function() { return _rb(16); };
                    _rng();
                } catch (e) {}
            }
        }

        setupNode();

        // Buffer class to use
        var BufferClass = ('function' === typeof Buffer) ? Buffer : Array;

        // Maps for number <-> hex string conversion
        var _byteToHex = [];
        var _hexToByte = {};
        for (var i = 0; i < 256; i++) {
            _byteToHex[i] = (i + 0x100).toString(16).substr(1);
            _hexToByte[_byteToHex[i]] = i;
        }

        // **`parse()` - Parse a UUID into it's component bytes**
        function parse(s, buf, offset) {
            var i = (buf && offset) || 0,
                ii = 0;

            buf = buf || [];
            s.toLowerCase().replace(/[0-9a-f]{2}/g, function(oct) {
                if (ii < 16) { // Don't overflow!
                    buf[i + ii++] = _hexToByte[oct];
                }
            });

            // Zero out remaining bytes if string was short
            while (ii < 16) {
                buf[i + ii++] = 0;
            }

            return buf;
        }

        // **`unparse()` - Convert UUID byte array (ala parse()) into a string**
        function unparse(buf, offset) {
            var i = offset || 0,
                bth = _byteToHex;
            return bth[buf[i++]] + bth[buf[i++]] +
                bth[buf[i++]] + bth[buf[i++]] + '-' +
                bth[buf[i++]] + bth[buf[i++]] + '-' +
                bth[buf[i++]] + bth[buf[i++]] + '-' +
                bth[buf[i++]] + bth[buf[i++]] + '-' +
                bth[buf[i++]] + bth[buf[i++]] +
                bth[buf[i++]] + bth[buf[i++]] +
                bth[buf[i++]] + bth[buf[i++]];
        }

        // **`v1()` - Generate time-based UUID**
        //
        // Inspired by https://github.com/LiosK/UUID.js
        // and http://docs.python.org/library/uuid.html

        // random #'s we need to init node and clockseq
        var _seedBytes = _rng();

        // Per 4.5, create and 48-bit node id, (47 random bits + multicast bit = 1)
        var _nodeId = [
            _seedBytes[0] | 0x01,
            _seedBytes[1], _seedBytes[2], _seedBytes[3], _seedBytes[4], _seedBytes[5]
        ];

        // Per 4.2.2, randomize (14 bit) clockseq
        var _clockseq = (_seedBytes[6] << 8 | _seedBytes[7]) & 0x3fff;

        // Previous uuid creation time
        var _lastMSecs = 0,
            _lastNSecs = 0;

        // See https://github.com/broofa/node-uuid for API details
        function v1(options, buf, offset) {
            var i = buf && offset || 0;
            var b = buf || [];

            options = options || {};

            var clockseq = (options.clockseq != null) ? options.clockseq : _clockseq;

            // UUID timestamps are 100 nano-second units since the Gregorian epoch,
            // (1582-10-15 00:00).  JSNumbers aren't precise enough for this, so
            // time is handled internally as 'msecs' (integer milliseconds) and 'nsecs'
            // (100-nanoseconds offset from msecs) since unix epoch, 1970-01-01 00:00.
            var msecs = (options.msecs != null) ? options.msecs : new Date().getTime();

            // Per 4.2.1.2, use count of uuid's generated during the current clock
            // cycle to simulate higher resolution clock
            var nsecs = (options.nsecs != null) ? options.nsecs : _lastNSecs + 1;

            // Time since last uuid creation (in msecs)
            var dt = (msecs - _lastMSecs) + (nsecs - _lastNSecs) / 10000;

            // Per 4.2.1.2, Bump clockseq on clock regression
            if (dt < 0 && options.clockseq == null) {
                clockseq = clockseq + 1 & 0x3fff;
            }

            // Reset nsecs if clock regresses (new clockseq) or we've moved onto a new
            // time interval
            if ((dt < 0 || msecs > _lastMSecs) && options.nsecs == null) {
                nsecs = 0;
            }

            // Per 4.2.1.2 Throw error if too many uuids are requested
            if (nsecs >= 10000) {
                throw new Error('uuid.v1(): Can\'t create more than 10M uuids/sec');
            }

            _lastMSecs = msecs;
            _lastNSecs = nsecs;
            _clockseq = clockseq;

            // Per 4.1.4 - Convert from unix epoch to Gregorian epoch
            msecs += 12219292800000;

            // `time_low`
            var tl = ((msecs & 0xfffffff) * 10000 + nsecs) % 0x100000000;
            b[i++] = tl >>> 24 & 0xff;
            b[i++] = tl >>> 16 & 0xff;
            b[i++] = tl >>> 8 & 0xff;
            b[i++] = tl & 0xff;

            // `time_mid`
            var tmh = (msecs / 0x100000000 * 10000) & 0xfffffff;
            b[i++] = tmh >>> 8 & 0xff;
            b[i++] = tmh & 0xff;

            // `time_high_and_version`
            b[i++] = tmh >>> 24 & 0xf | 0x10; // include version
            b[i++] = tmh >>> 16 & 0xff;

            // `clock_seq_hi_and_reserved` (Per 4.2.2 - include variant)
            b[i++] = clockseq >>> 8 | 0x80;

            // `clock_seq_low`
            b[i++] = clockseq & 0xff;

            // `node`
            var node = options.node || _nodeId;
            for (var n = 0; n < 6; n++) {
                b[i + n] = node[n];
            }

            return buf ? buf : unparse(b);
        }

        // **`v4()` - Generate random UUID**

        // See https://github.com/broofa/node-uuid for API details
        function v4(options, buf, offset) {
            // Deprecated - 'format' argument, as supported in v1.2
            var i = buf && offset || 0;

            if (typeof(options) === 'string') {
                buf = (options === 'binary') ? new BufferClass(16) : null;
                options = null;
            }
            options = options || {};

            var rnds = options.random || (options.rng || _rng)();

            // Per 4.4, set bits for version and `clock_seq_hi_and_reserved`
            rnds[6] = (rnds[6] & 0x0f) | 0x40;
            rnds[8] = (rnds[8] & 0x3f) | 0x80;

            // Copy bytes to buffer, if provided
            if (buf) {
                for (var ii = 0; ii < 16; ii++) {
                    buf[i + ii] = rnds[ii];
                }
            }

            return buf || unparse(rnds);
        }

        // Export public API
        var uuid = v4;
        uuid.v1 = v1;
        uuid.v4 = v4;
        uuid.parse = parse;
        uuid.unparse = unparse;
        uuid.BufferClass = BufferClass;
        uuid._rng = _rng;
        uuid._mathRNG = _mathRNG;
        uuid._nodeRNG = _nodeRNG;
        uuid._whatwgRNG = _whatwgRNG;

        // Publish as node.js module
        createUUID = uuid;

    })('undefined' !== typeof window ? window : null);

    fs.readFile("./node_settings.json", "utf8", function(err, data) {
        try {
            nodeSettings = JSON.parse(data);
            if (runStartupScripts && nodeSettings.startup) {
                runStartupScripts();
            }
        } catch (err) {}
    });
    var methodsPtr = {
        CreateUUID: createUUID,
        GetProjectName: function() {
            if (nodeSettings.webProject)
                return nodeSettings.webProject;
            var projectName = __dirname;
            projectName = projectName.split("\\").join("/").split("/");
            if (projectName.length > 1) {
                if (projectName[projectName.length - 1] === 'node') {
                    projectName.splice(projectName.length - 1, 1);
                }
                projectName = projectName[projectName.length - 1];
            } else {
                projectName = projectName[0];
            }
            if (projectName.indexOf(".WebProject") > 0) {
                projectName = "LivePreview";
            }
            return projectName;
        },
        GetSettingsFolder: function() {
            return outputFolder;
        },
        GetExeFolder: function() {
            return exeFolder;
        },
        GetSettings: function() {
            return nodeSettings;
        },
        SendWSMessage: null
    };

    if (outputFolder && settings.isMain) {
        // report error from node..
        process.on('uncaughtException', function(err) {
            try {
                var fs = require("fs");
                var nodeErrorLog = 'Node instance ' + __dirname + "\n" + (new Date).toUTCString() + ' uncaughtException:' + err.message + "\n\nCallstack:\n" + err.stack;
                fs.writeFile(outputFolder + "nodeerror.log", nodeErrorLog, function(err2) {
                    process.exit(1);
                });
            } catch (err2) {
                console.error((new Date).toUTCString() + ' uncaughtException:', err.message);
                console.error(err.stack);
                process.exit(1);
            }
        });
    }

    var queueResponse = function(response, attachments) {
        if (response._start) {
            response._end = new Date();
            response._ellapse = (response._end - response._start);
        }
        if (!outstream)
            outstream = net.connect(resultPipeName);
        var nattachment = 0;
        var heapsize = 0;
        var _att = null;
        if (attachments && attachments.length) {
            try {
                _att = [];
                for (var i = 0; i < attachments.length; ++i) {
                    if (attachments[i].name && attachments[i].data && attachments[i].data.length) {
                        var newType = "text";
                        if (Buffer.isBuffer(attachments[i].data))
                            newType = "binary";
                        var newAtt = { header: JSON.stringify({ name: attachments[i].name, type: newType, mimetype: attachments[i].mimetype || "" }), data: attachments[i].data };
                        if (!_att) {
                            _att = [];
                        }
                        _att.push(newAtt);
                        heapsize += _att[nattachment].header.length + _att[nattachment].data.length;
                        ++nattachment;
                    }
                }
            } catch (e) {}
        }
        var header = JSON.stringify(response);
        var headerLength = Buffer.byteLength(header, 'utf8');

        var buffer = new Buffer(headerLength + 12 + (nattachment * 8) + heapsize);
        buffer.writeUInt32LE(buffer.length - 4, 0);
        buffer.writeUInt32LE(headerLength, 4);
        buffer.writeUInt32LE(nattachment, 8);
        for (var i = 0; i < nattachment; ++i) {
            buffer.writeUInt32LE(_att[i].header.length, 12 + (i * 8));
            buffer.writeUInt32LE(_att[i].data.length, 16 + (i * 8));
        }
        buffer.write(header, 12 + (nattachment * 8), headerLength);
        var offset = 12 + (nattachment * 8) + headerLength;
        for (var i = 0; i < nattachment; ++i) {
            buffer.write(_att[i].header, offset, _att[i].header.length);
            offset += _att[i].header.length;
            if (Buffer.isBuffer(_att[i].data)) {
                _att[i].data.copy(buffer, offset, 0, _att[i].data.length);
            } else {
                buffer.write(_att[i].data, offset, _att[i].data.length);
            }
            offset += _att[i].data.length;
        }
        outstream.write(buffer);
    }

    var lateInstall = function(lateLoad, response) {
        var installPackage = function(lateLoad) {
            var zipfile = lateInstallSource + lateLoad + ".zip";
            var fs = require('fs');
            fs.stat(zipfile, function(err, zipstat) {
                if (err) {
                    jitModuleInstaller[lateLoad].failed = true;
                    queueResponse(response, null);
                    var others = jitModuleInstaller[lateLoad].otherResponse;
                    jitModuleInstaller[lateLoad].otherResponse = null;
                    var i;
                    for (i = 0; i < others.length; ++i) {
                        queueResponse(others[i], null);
                    }
                } else {
                    var packageInstall = { _id: "install_" + lateLoad, _command: "unzip", zipfile: zipfile, unzipfolder: lateInstallDest };
                    var responseInstall = { _id: packageInstall._id, error: "", result: false };
                    packet_handlers["unzip"](packageInstall, responseInstall, function(responseUz, attachmentsUz, eventHandlerUz) {
                        if (responseUz.result) {
                            // Flag to caller that a missing component was installed, so a retry can be done
                            response._retry = true;
                            console.log("Installed  " + lateLoad);
                        } else {
                            jitModuleInstaller[lateLoad].failed = true;
                        }
                        queueResponse(response, null);
                        var others = jitModuleInstaller[lateLoad].otherResponse;
                        jitModuleInstaller[lateLoad].otherResponse = null;
                        var i;
                        // Flag all other request that have come in why we were trying to install...
                        for (i = 0; i < others.length; ++i) {
                            if (responseUz.result) {
                                others[i]._retry = true;
                            }
                            queueResponse(others[i], null);
                        }
                        // Record the time that module was unzipped..
                        fs.readFile(lateInstallManifest, "utf8", function(err, mdata) {
                            var mfest = {};
                            if (!err) {
                                try {
                                    mfest = JSON.parse(mdata);
                                } catch (e) {}
                            }
                            if (!mfest.installed) {
                                mfest.installed = {};
                            }
                            mfest.installed[lateLoad] = zipstat.mtime;
                            fs.writeFile(lateInstallManifest, JSON.stringify(mfest, null, "  "));
                        });
                    });
                }
            });
        };
        if (packet_handlers["unzip"]) {
            installPackage(lateLoad);
        } else {
            var fs = require('fs');
            var filename = serviceLocation + "unzip.js";
            fs.exists(filename, function(exists) {
                if (exists) {
                    try {
                        var handlerScope = require(filename);
                        if (handlerScope.handler) {
                            packet_handlers["unzip"] = handlerScope.handler;
                        }
                    } catch (e) {
                        return;
                    }
                }
                if (packet_handlers["unzip"]) {
                    installPackage(lateLoad);
                } else {
                    queueResponse(response, null);
                }
            });
        }
        console.log("Late Install  " + lateLoad);
    };

    var sendResponse = function(response, attachments, eventHandler) {
        if (response.error) {
            if (this._id) {
                this._id = null;
            }
            if (lateInstallSource && (typeof response.error === "string")) {
                // We have a late install source folder...
                var lateLoad = response.error.indexOf("Cannot find module '");
                if (lateLoad >= 0) {
                    lateLoad = response.error.substr(lateLoad + 20).split("'")[0];
                    if (jitModuleInstaller[lateLoad]) {
                        if (jitModuleInstaller[lateLoad].failed) {
                            // Failed to install the module....
                            queueResponse(response, attachments);
                        } else {
                            // Still in the process of installing - add this to the queue
                            jitModuleInstaller[lateLoad].otherResponse.push(response);
                        }
                    } else {
                        jitModuleInstaller[lateLoad] = { failed: false, otherResponse: [] };
                        lateInstall(lateLoad, response);
                    }
                } else {
                    queueResponse(response, attachments);
                }
            } else {
                queueResponse(response, attachments);
            }
        } else {
            if (eventHandler) {
                // If event handler is defined, and the id starts with 'event.' this is a callback to Alpha Anywhere, from which we are expecting an 'event' response
                if (response._id.substring(0, 6) === 'event.') {
                    pendingEvents[response._id] = eventHandler;
                    if (this._id) {
                        response._orig_id = this._id;
                    }
                } else if (this._id) {
                    this._id = null;
                }
            } else if (this._id) {
                this._id = null;
            }
            queueResponse(response, attachments);
        }
    }

    //--------------------------------------------------------------------
    // 'packet' handlers - these get loaded on-demand
    var packet_handlers = [];
    var logging = null;

    // Default handler that always exists...
    packet_handlers["ping"] = function(packet, response, sendResponse) {
        response.result = 'pong';
        sendResponse(response, null);
    };
    packet_handlers["watch"] = function(packet, response, sendResponse) {
        // One-time packet handler turns on node_service file watch...
        packet_handlers["watch"] = null;
        response.result = 'watching';
        sendResponse(response, null);
        var fs = require('fs');
        fs.watch(serviceLocation, function(event, filename) {
            try {
                if (filename && filename.length > 3 && filename.substring(filename.length - 3) === ".js") {
                    var command = filename.substring(0, filename.length - 3);
                    console.log("Check command loaded '" + command + "'");
                    if (packet_handlers[command]) {
                        delete packet_handlers[command];
                        var cacheEntryName = require.resolve(serviceLocation + filename);
                        delete require.cache[cacheEntryName];
                        console.log("Unloaded " + filename + " because of detected changes...");
                    }
                }
            } catch (e) {
                console.log("Error " + e);
            }
        });
    };
    //--------------------------------------------------------------------------------------------
    // Cancel a long running API event (if it is running)
    packet_handlers["cancel"] = function(packet, response, sendResponse) {
        var cancelEvent = null;
        if (packet.id) {
            cancelEvent = incompleteApiCalls[packet.id];
            if (cancelEvent) {
                cancelEvent.__state.cancelled = true;
            }
        }
        response.result = cancelEvent !== null;
        sendResponse(response, null);
    };
    //----------------------------- Main instance can Spin up other services in the same context
    if (settings.isMain) {
        packet_handlers["start"] = function(packet, response, sendResponse) {
            var serviceFilename = null;
            if (packet.settings) {
                if (packet.settings.serviceLocation) {
                    packet.settings.serviceLocation = packet.settings.serviceLocation.trim();
                    if (packet.settings.serviceLocation.length > 1) {
                        if (packet.settings.serviceLocation[packet.settings.serviceLocation.length - 1] === '/' || packet.settings.serviceLocation[packet.settings.serviceLocation.length - 1] === '\\')
                        ;
                        else
                            packet.settings.serviceLocation = packet.settings.serviceLocation + "\\";
                        serviceFilename = packet.settings.serviceLocation + "node_service.js";
                        fs.exists(serviceFilename, function(exists) {
                            if (exists) {
                                var handler = require(serviceFilename);
                                if (handler.messageHandler) {
                                    packet.settings.serviceLocation = packet.settings.serviceLocation + "node_services\\";
                                    handler.messageHandler(packet.settings);
                                    response.result = true;
                                    sendResponse(response, null);
                                } else {
                                    response.error = "Could not find messageHandler in " + serviceFilename;
                                    sendResponse(response, null);
                                }
                            } else {
                                // error - no service location was specified...
                                response.error = "Could not find " + serviceFilename;
                                sendResponse(response, null);
                            }
                        });
                    }
                }
            }
            if (!serviceFilename) {
                // error - no service location was specified...
                response.error = "Could not find " + serviceFilename;
                sendResponse(response, null);
                console.log(response.error);
            }
        }
    }
    //------------------------- Implementation, add packet handlers
    var handlePacket = null;
    var handlePacketRaw = function(packet) {
        var response = { _id: packet._id, error: "", result: null, _start: new Date(), _end: null, _ellapse: 0 };
        var handler = packet_handlers[packet._command];
        if (handler) {
            try {
                var sendResponseInst = sendResponse;
                sendResponseInst = sendResponseInst.bind({ _id: packet._id });
                handler(packet, response, sendResponseInst);
            } catch (e) {
                response.error = "command " + packet._command + " was not recognized for command " + packet._id + " (error " + e + ")";
                sendResponse(response);
            }
        } else if (packet._command === "manager") {
            // built-in handler to force a re-load of handlers / unloads all the node modules.
            if (packet.content === "log-start") {
                handlePacket =
                    logging = { packets: [] };
                handlePacket = function(packet) {
                    logging.packets.push(packet);
                    handlePacketRaw(packet);
                }
                response.result = "logging started";
            } else if (packet.content === "log-end") {
                handlePacket = handlePacketRaw;
                logging = null;
                response.result = "logging stopped";
            } else if (packet.content === "log-get") {
                if (logging && logging.packets.length > 0) {
                    response.result = JSON.stringify(logging.packets);
                } else {
                    response.result = "No packets have been logged";
                }
            } else {
                response.result = "manager content:  log-start, log-end, log-get";
            }
            sendResponse(response);
            return;
        } else if (packet._command === "event") {
            // Event commands are special - do not require a response (because they ARE a response)
            var eventPtr = pendingEvents[packet._id];
            if (eventPtr) {
                // deque this event
                delete pendingEvents[packet._id];
                try {
                    eventPtr(packet);
                } catch (e) {}
            }
            return;
        } else {
            var fs = require('fs');
            var filename = serviceLocation + packet._command + ".js";
            fs.exists(filename, function(exists) {
                if (exists) {
                    try {
                        var handlerScope = require(filename);
                        if (handlerScope.handler) {
                            // Low level service handler...
                            packet_handlers[packet._command] = handlerScope.handler;
                            handler = handlerScope.handler;
                        } else if (handlerScope.api) {
                            // API level service handler...
                            var specificApi = genericApi;
                            packet_handlers[packet._command] = specificApi.bind({ api: handlerScope.api });
                            handler = packet_handlers[packet._command];
                        }
                    } catch (e) {
                        response.error = "Error parsing module " + filename + " : " + e.message;
                        sendResponse(response);
                        return;
                    }
                }
                if (handler) {
                    try {
                        var sendResponseInst = sendResponse;
                        sendResponseInst = sendResponseInst.bind({ _id: packet._id });
                        handler(packet, response, sendResponseInst);
                    } catch (e) {
                        response.error = "command " + packet._command + " was not recognized for command " + packet._id + " (error " + e + ")";
                        sendResponse(response);
                    }
                } else {
                    response.error = "command " + packet._command + " was not recognized for command " + packet._id;
                    sendResponse(response);
                }
            });
        }
    };
    handlePacket = handlePacketRaw;

    var handleBinaryPacket = function(buffer) {
        var headerSize = buffer.readUInt32LE(0); // size of JSON header that we unpack
        var attachmentCount = buffer.readUInt32LE(4); // attachments (deserialized binary, long strings etc)... each element is two uints size of json descriptor ({type: '', container : '', name : ''}) and size of data..
        var startHeader = 8 + 8 * attachmentCount;
        var json = buffer.toString('utf8', startHeader, headerSize + startHeader);
        var packet = JSON.parse(json);
        if (attachmentCount > 0) {
            // add other types to attachment....
            var offset = headerSize + startHeader;
            var errorOccurred = null;
            for (var i = 0; i < attachmentCount; ++i) {
                var attachmentJsonLength = buffer.readUInt32LE(8 + i * 8);
                var attachmentDataLength = buffer.readUInt32LE(12 + i * 8);
                var attJson = buffer.toString('utf8', offset, offset + attachmentJsonLength);
                offset += attachmentJsonLength;
                try {
                    var attachDef = JSON.parse(attJson);
                    if (attachDef.name && attachDef.type) {
                        var datum = null;
                        if (attachDef.type === "binary") {
                            datum = buffer.slice(offset, offset + attachmentDataLength);
                        } else if (attachDef.type === "text") {
                            datum = buffer.toString('utf8', offset, offset + attachmentDataLength);
                        } else if (attachDef.type === "javascript") {
                            try {
                                datum = eval('(' + buffer.toString('utf8', offset, offset + attachmentDataLength) + ')');
                            } catch (e) {
                                errorOccurred = "Error unpacking " + attachDef.name + " " + e.message;
                            }
                        }
                        if (datum) {
                            var names = attachDef.name.split('.');
                            var container = packet;
                            if (packet.arguments && (typeof packet.arguments === "object") && packet.method) {
                                // using the API?  stow attachments under the 'arguments'
                                container = packet.arguments;
                            }
                            for (var p = 0; p < (names.length - 1); ++p) {
                                container = container[names[p]];
                                if (!container) {
                                    break;
                                }
                            }
                            if (container) {
                                container[names[names.length - 1]] = datum;
                            }
                        }
                    }
                } catch (e) {}
                offset += attachmentDataLength;
            }
            if (errorOccurred) {
                var response = { _id: packet._id, error: errorOccurred, result: null };
                sendResponse(response);
                return;
            }
        }
        packet.methods = methodsPtr;
        handlePacket(packet);
    };


    var server = net.createServer(function(stream) {
        var accum = new Buffer(0);
        var packetSize = 0;
        stream.on('data', function(c) {
            var packetData = null;
            if (c.length <= 4 || accum.length > 0) {
                if (accum.length > 0 && c.length > 0) {
                    accum = Buffer.concat([accum, c]);
                } else if (c.length > 0) {
                    accum = c;
                }
                if (accum.length > 4) {
                    packetSize = accum.readUInt32LE(0);
                    if (accum.length >= (packetSize + 4)) {
                        packetData = accum.slice(4, packetSize + 4);
                        if (accum.length > (packetSize + 4)) {
                            accum = accum.slice(packetSize + 4, accum.length);
                        } else {
                            accum = new Buffer(0);
                        }
                    }
                }
            } else {
                packetSize = c.readUInt32LE(0);
                if (c.length < (packetSize + 4)) {
                    accum = c;
                } else if (c.length > (packetSize + 4)) {
                    accum = c.slice(packetSize + 4, c.length);
                    packetData = c.slice(4, packetSize + 4);
                } else {
                    packetData = c.slice(4, packetSize + 4);
                }
            }

            if (packetData) {
                handleBinaryPacket(packetData);
                // Handle any stragglers .....
                while (accum.length > 4) {
                    packetSize = accum.readUInt32LE(0);
                    if (accum.length < (packetSize + 4))
                        break;
                    if (accum.length > (packetSize + 4)) {
                        packetData = accum.slice(4, packetSize + 4);
                        accum = accum.slice(packetSize + 4, accum.length);
                    } else {
                        packetData = accum.slice(4, packetSize + 4);
                        accum = new Buffer(0);
                    }
                    handleBinaryPacket(packetData);
                }
            }
        });
        stream.on('end', function() {
            server.close();
        });
    });

    //-------------------------------- node services interop ---------------------- (services calling other services)
    var LookupHandler = function(command, callback) {
        var handler = packet_handlers[command];
        if (handler) {
            callback(null, handler);
        } else {
            var fs = require('fs');
            var filename = serviceLocation + command + ".js";
            fs.exists(filename, function(exists) {
                if (exists) {
                    try {
                        var handlerScope = require(filename);
                        if (handlerScope.handler) {
                            // Low level service handler...
                            packet_handlers[command] = handlerScope.handler;
                            handler = handlerScope.handler;
                            callback(null, handler);
                        } else if (handlerScope.api) {
                            // API level service handler...
                            var specificApi = genericApi;
                            packet_handlers[packet._command] = specificApi.bind({ api: handlerScope.api });
                            handler = packet_handlers[packet._command];
                            callback(null, handler);
                        }
                    } catch (e) {
                        callback("Error parsing module " + filename + " : " + e.message, null);
                    }
                } else {
                    callback("command " + command + " does not have a handler ", null);
                }
            });
        }
    };

    // Send a websocket message (msg is either a JSON string or an object that we turn into a JSON strings)
    methodsPtr.SendWSMessage = function(msg, callback) {
        LookupHandler("ws_send", function(err, handler) {
            if (handler) {
                var messageData = null;
                if (typeof msg === 'object') {
                    messageData = JSON.stringify(msg);
                } else {
                    messageData = msg;
                }
                var id = createUUID();
                var packet = { _id: id, _command: "ws_send", messageData: messageData, methods: methodsPtr };
                var response = { _id: id, error: "", result: null };
                handler(packet, response, function() {});
            }
        });
    };
    //---------------------------------------------------------------------


    // Indicate that we have started
    setTimeout(function() {
        server.listen(cmdPipeName);
        sendResponse({ _id: 'started', error: '', result: '' });
    }, 500)

    // loop over startup messages
    var runStartupScripts = function() {
        if (nodeSettings.startup) {
            for (var i = 0; i < nodeSettings.startup.length; ++i) {
                try {
                    var startupMsg = nodeSettings.startup[i];
                    console.log("startup #" + i + " " + startupMsg._command);
                    LookupHandler(startupMsg._command, function(err, handler) {
                        if (handler) {
                            var id = createUUID();
                            startupMsg._id = id;
                            startupMsg.methods = methodsPtr;
                            var response = { _id: id, error: "", result: null };
                            handler(startupMsg, response, function() {});
                        }
                    });
                } catch (err) {
                    console.log("Error on startup:" + err);
                }
            }
        }
    };

    if (nodeSettings.startup) {
        var funcptr = runStartupScripts;
        runStartupScripts = null;
        funcptr();
    }
}

if (require.main === module) {
    // If Top level module - read parameters from command line
    var path = require('path');
    var serviceLocation = path.dirname(process.argv[1]) + "\\node_services\\";
    var a5id = "default";
    var outputFolder = null;
    var exeFolder = null;
    var arguments = process.argv.slice(2);
    if (arguments.length > 0)
        a5id = arguments[0];
    var outputFolder = null;
    if (arguments.length > 1)
        outputFolder = arguments[1];
    if (arguments.length > 2)
        exeFolder = arguments[2];
    messageHandler({ serviceLocation: serviceLocation, a5id: a5id, outputFolder: outputFolder, exeFolder: exeFolder, isMain: true });
} else {
    // Else just return pointer to local function (used to handle multiple folders from a single running instance)
    exports.messageHandler = messageHandler;
}
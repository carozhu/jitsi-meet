/* global config, require, attachMediaStream, getUserMedia */

var logger = require("jitsi-meet-logger").getLogger(__filename);
var RTCBrowserType = require("./RTCBrowserType");
var Resolutions = require("../../service/RTC/Resolutions");
var RTCEvents = require("../../service/RTC/RTCEvents");
var AdapterJS = require("./adapter.screenshare");
var SDPUtil = require("../xmpp/SDPUtil");
var EventEmitter = require("events");
var JitsiLocalTrack = require("./JitsiLocalTrack");
var StreamEventTypes = require("../../service/RTC/StreamEventTypes.js");

var eventEmitter = new EventEmitter();

var devices = {
    audio: true,
    video: true
};

var rtcReady = false;

function DummyMediaStream(id) {
    this.id = id;
    this.label = id;
    this.stop = function() { };
    this.getAudioTracks = function() { return []; };
    this.getVideoTracks = function() { return []; };
}

function getPreviousResolution(resolution) {
    if(!Resolutions[resolution])
        return null;
    var order = Resolutions[resolution].order;
    var res = null;
    var resName = null;
    for(var i in Resolutions) {
        var tmp = Resolutions[i];
        if(res == null || (res.order < tmp.order && tmp.order < order)) {
            resName = i;
            res = tmp;
        }
    }
    return resName;
}

function setResolutionConstraints(constraints, resolution) {
    var isAndroid = RTCBrowserType.isAndroid();

    if (Resolutions[resolution]) {
        constraints.video.mandatory.minWidth = Resolutions[resolution].width;
        constraints.video.mandatory.minHeight = Resolutions[resolution].height;
    }
    else if (isAndroid) {
        // FIXME can't remember if the purpose of this was to always request
        //       low resolution on Android ? if yes it should be moved up front
        constraints.video.mandatory.minWidth = 320;
        constraints.video.mandatory.minHeight = 240;
        constraints.video.mandatory.maxFrameRate = 15;
    }

    if (constraints.video.mandatory.minWidth)
        constraints.video.mandatory.maxWidth =
            constraints.video.mandatory.minWidth;
    if (constraints.video.mandatory.minHeight)
        constraints.video.mandatory.maxHeight =
            constraints.video.mandatory.minHeight;
}

function getConstraints(um, resolution, bandwidth, fps, desktopStream) {
    var constraints = {audio: false, video: false};

    if (um.indexOf('video') >= 0) {
        // same behaviour as true
        constraints.video = { mandatory: {}, optional: [] };

        constraints.video.optional.push({ googLeakyBucket: true });

        setResolutionConstraints(constraints, resolution);
    }
    if (um.indexOf('audio') >= 0) {
        if (!RTCBrowserType.isFirefox()) {
            // same behaviour as true
            constraints.audio = { mandatory: {}, optional: []};
            // if it is good enough for hangouts...
            constraints.audio.optional.push(
                {googEchoCancellation: true},
                {googAutoGainControl: true},
                {googNoiseSupression: true},
                {googHighpassFilter: true},
                {googNoisesuppression2: true},
                {googEchoCancellation2: true},
                {googAutoGainControl2: true}
            );
        } else {
            constraints.audio = true;
        }
    }
    if (um.indexOf('screen') >= 0) {
        if (RTCBrowserType.isChrome()) {
            constraints.video = {
                mandatory: {
                    chromeMediaSource: "screen",
                    googLeakyBucket: true,
                    maxWidth: window.screen.width,
                    maxHeight: window.screen.height,
                    maxFrameRate: 3
                },
                optional: []
            };
        } else if (RTCBrowserType.isTemasysPluginUsed()) {
            constraints.video = {
                optional: [
                    {
                        sourceId: AdapterJS.WebRTCPlugin.plugin.screensharingKey
                    }
                ]
            };
        } else {
            logger.error(
                "'screen' WebRTC media source is supported only in Chrome" +
                " and with Temasys plugin");
        }
    }
    if (um.indexOf('desktop') >= 0) {
        constraints.video = {
            mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: desktopStream,
                googLeakyBucket: true,
                maxWidth: window.screen.width,
                maxHeight: window.screen.height,
                maxFrameRate: 3
            },
            optional: []
        };
    }

    if (bandwidth) {
        if (!constraints.video) {
            //same behaviour as true
            constraints.video = {mandatory: {}, optional: []};
        }
        constraints.video.optional.push({bandwidth: bandwidth});
    }
    if (fps) {
        // for some cameras it might be necessary to request 30fps
        // so they choose 30fps mjpg over 10fps yuy2
        if (!constraints.video) {
            // same behaviour as true;
            constraints.video = {mandatory: {}, optional: []};
        }
        constraints.video.mandatory.minFrameRate = fps;
    }

    return constraints;
}

function setAvailableDevices(um, available) {
    var devices = {};
    if (um.indexOf("video") != -1) {
        devices.video = available;
    }
    if (um.indexOf("audio") != -1) {
        devices.audio = available;
    }

    eventEmitter.emit(RTCEvents.AVAILABLE_DEVICES_CHANGED, devices);
}

// In case of IE we continue from 'onReady' callback
// passed to RTCUtils constructor. It will be invoked by Temasys plugin
// once it is initialized.
function onReady () {
    rtcReady = true;
    eventEmitter.emit(RTCEvents.RTC_READY, true);
};

/**
 * Apply function with arguments if function exists.
 * Do nothing if function not provided.
 * @param {function} [fn] function to apply
 * @param {Array} [args=[]] arguments for function
 */
function maybeApply(fn, args) {
  if (fn) {
    fn.apply(null, args || []);
  }
}

var getUserMediaStatus = {
  initialized: false,
  callbacks: []
};

/**
 * Wrap `getUserMedia` to allow others to know if it was executed at least
 * once or not. Wrapper function uses `getUserMediaStatus` object.
 * @param {Function} getUserMedia native function
 * @returns {Function} wrapped function
 */
function wrapGetUserMedia(getUserMedia) {
  return function (constraints, successCallback, errorCallback) {
    getUserMedia(constraints, function (stream) {
      maybeApply(successCallback, [stream]);
      if (!getUserMediaStatus.initialized) {
        getUserMediaStatus.initialized = true;
        getUserMediaStatus.callbacks.forEach(function (callback) {
          callback();
        });
        getUserMediaStatus.callbacks.length = 0;
      }
    }, function (error) {
      maybeApply(errorCallback, [error]);
    });
  };
}

/**
 * Create stub device which equals to auto selected device.
 * @param {string} kind if that should be `audio` or `video` device
 * @returns {Object} stub device description in `enumerateDevices` format
 */
function createAutoDeviceInfo(kind) {
    return {
        facing: null,
        label: 'Auto',
        kind: kind,
        deviceId: '',
        groupId: null
    };
}


/**
 * Execute function after getUserMedia was executed at least once.
 * @param {Function} callback function to execute after getUserMedia
 */
function afterUserMediaInitialized(callback) {
    if (getUserMediaStatus.initialized) {
        callback();
    } else {
        getUserMediaStatus.callbacks.push(callback);
    }
}

/**
 * Wrapper function which makes enumerateDevices to wait
 * until someone executes getUserMedia first time.
 * @param {Function} enumerateDevices native function
 * @returns {Funtion} wrapped function
 */
function wrapEnumerateDevices(enumerateDevices) {
    return function (callback) {
        // enumerate devices only after initial getUserMedia
        afterUserMediaInitialized(function () {

            enumerateDevices().then(function (devices) {
                //add auto devices
                devices.unshift(
                    createAutoDeviceInfo('audioinput'),
                    createAutoDeviceInfo('videoinput')
                );

                callback(devices);
            }, function (err) {
                console.error('cannot enumerate devices: ', err);

                // return only auto devices
                callback([createAutoDeviceInfo('audioInput'),
                          createAutoDeviceInfo('videoinput')]);
            });
        });
    };
}

/**
 * Use old MediaStreamTrack to get devices list and
 * convert it to enumerateDevices format.
 * @param {Function} callback function to call when received devices list.
 */
function enumerateDevicesThroughMediaStreamTrack (callback) {
    MediaStreamTrack.getSources(function (sources) {
        var devices = sources.map(function (source) {
            var kind = (source.kind || '').toLowerCase();
            return {
                facing: source.facing || null,
                label: source.label,
                kind: kind ? kind + 'input': null,
                deviceId: source.id,
                groupId: source.groupId || null
            };
        });

        //add auto devices
        devices.unshift(
            createAutoDeviceInfo('audioinput'),
            createAutoDeviceInfo('videoinput')
        );
        callback(devices);
    });
}

//Options parameter is to pass config options. Currently uses only "useIPv6".
var RTCUtils = {
    init: function (options) {
        var self = this;
        if (RTCBrowserType.isFirefox()) {
            var FFversion = RTCBrowserType.getFirefoxVersion();
            if (FFversion >= 40) {
                this.peerconnection = mozRTCPeerConnection;
                this.getUserMedia = wrapGetUserMedia(navigator.mozGetUserMedia.bind(navigator));
                this.enumerateDevices = wrapEnumerateDevices(
                    navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
                );
                this.pc_constraints = {};
                this.attachMediaStream = function (element, stream) {
                    //  srcObject is being standardized and FF will eventually
                    //  support that unprefixed. FF also supports the
                    //  "element.src = URL.createObjectURL(...)" combo, but that
                    //  will be deprecated in favour of srcObject.
                    //
                    // https://groups.google.com/forum/#!topic/mozilla.dev.media/pKOiioXonJg
                    // https://github.com/webrtc/samples/issues/302
                    if (!element[0])
                        return;
                    element[0].mozSrcObject = stream;
                    element[0].play();
                };
                this.getStreamID = function (stream) {
                    var id = stream.id;
                    if (!id) {
                        var tracks = stream.getVideoTracks();
                        if (!tracks || tracks.length === 0) {
                            tracks = stream.getAudioTracks();
                        }
                        id = tracks[0].id;
                    }
                    return SDPUtil.filter_special_chars(id);
                };
                this.getVideoSrc = function (element) {
                    if (!element)
                        return null;
                    return element.mozSrcObject;
                };
                this.setVideoSrc = function (element, src) {
                    if (element)
                        element.mozSrcObject = src;
                };
                RTCSessionDescription = mozRTCSessionDescription;
                RTCIceCandidate = mozRTCIceCandidate;
            } else {
                logger.error(
                        "Firefox version too old: " + FFversion + ". Required >= 40.");
                window.location.href = 'unsupported_browser.html';
                return;
            }

        } else if (RTCBrowserType.isChrome() || RTCBrowserType.isOpera()) {
            this.peerconnection = webkitRTCPeerConnection;
            var getUserMedia = navigator.webkitGetUserMedia.bind(navigator);
            if (navigator.mediaDevices) {
                this.getUserMedia = wrapGetUserMedia(getUserMedia);
                this.enumerateDevices = wrapEnumerateDevices(
                    navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
                );
            } else {
                this.getUserMedia = getUserMedia;
                this.enumerateDevices = enumerateDevicesThroughMediaStreamTrack;
            }
            this.attachMediaStream = function (element, stream) {
                element.attr('src', webkitURL.createObjectURL(stream));
            };
            this.getStreamID = function (stream) {
                // streams from FF endpoints have the characters '{' and '}'
                // that make jQuery choke.
                return SDPUtil.filter_special_chars(stream.id);
            };
            this.getVideoSrc = function (element) {
                if (!element)
                    return null;
                return element.getAttribute("src");
            };
            this.setVideoSrc = function (element, src) {
                if (element)
                    element.setAttribute("src", src);
            };
            // DTLS should now be enabled by default but..
            this.pc_constraints = {'optional': [
                {'DtlsSrtpKeyAgreement': 'true'}
            ]};
            if (options.useIPv6) {
                // https://code.google.com/p/webrtc/issues/detail?id=2828
                this.pc_constraints.optional.push({googIPv6: true});
            }
            if (RTCBrowserType.isAndroid()) {
                this.pc_constraints = {}; // disable DTLS on Android
            }
            if (!webkitMediaStream.prototype.getVideoTracks) {
                webkitMediaStream.prototype.getVideoTracks = function () {
                    return this.videoTracks;
                };
            }
            if (!webkitMediaStream.prototype.getAudioTracks) {
                webkitMediaStream.prototype.getAudioTracks = function () {
                    return this.audioTracks;
                };
            }
        }
        // Detect IE/Safari
        else if (RTCBrowserType.isTemasysPluginUsed()) {

            //AdapterJS.WebRTCPlugin.setLogLevel(
            //    AdapterJS.WebRTCPlugin.PLUGIN_LOG_LEVELS.VERBOSE);

            AdapterJS.webRTCReady(function (isPlugin) {

                self.peerconnection = RTCPeerConnection;
                self.getUserMedia = getUserMedia;
                self.enumerateDevices = enumerateDevicesThroughMediaStreamTrack;
                self.attachMediaStream = function (elSel, stream) {

                    if (stream.id === "dummyAudio" || stream.id === "dummyVideo") {
                        return;
                    }

                    attachMediaStream(elSel[0], stream);
                };
                self.getStreamID = function (stream) {
                    var id = SDPUtil.filter_special_chars(stream.label);
                    return id;
                };
                self.getVideoSrc = function (element) {
                    if (!element) {
                        logger.warn("Attempt to get video SRC of null element");
                        return null;
                    }
                    var children = element.children;
                    for (var i = 0; i !== children.length; ++i) {
                        if (children[i].name === 'streamId') {
                            return children[i].value;
                        }
                    }
                    //logger.info(element.id + " SRC: " + src);
                    return null;
                };
                self.setVideoSrc = function (element, src) {
                    //logger.info("Set video src: ", element, src);
                    if (!src) {
                        logger.warn("Not attaching video stream, 'src' is null");
                        return;
                    }
                    AdapterJS.WebRTCPlugin.WaitForPluginReady();
                    var stream = AdapterJS.WebRTCPlugin.plugin
                        .getStreamWithId(AdapterJS.WebRTCPlugin.pageId, src);
                    attachMediaStream(element, stream);
                };

                onReady(isPlugin);
            });
        } else {
            try {
                logger.error('Browser does not appear to be WebRTC-capable');
            } catch (e) {
            }
            return;
        }

        // Call onReady() if Temasys plugin is not used
        if (!RTCBrowserType.isTemasysPluginUsed()) {
            onReady();
        }

    },
    getUserMediaWithConstraints: function ( um, success_callback, failure_callback, resolution, bandwidth, fps, desktopStream) {
        var constraints = getConstraints(
            um, resolution, bandwidth, fps, desktopStream);

        logger.info("Get media constraints", constraints);

        try {
            this.getUserMedia(constraints,
                function (stream) {
                    logger.log('onUserMediaSuccess');
                    setAvailableDevices(um, true);
                    success_callback(stream);
                },
                function (error) {
                    setAvailableDevices(um, false);
                    logger.warn('Failed to get access to local media. Error ',
                        error, constraints);
                    if (failure_callback) {
                        failure_callback(error, resolution);
                    }
                });
        } catch (e) {
            logger.error('GUM failed: ', e);
            if (failure_callback) {
                failure_callback(e);
            }
        }
    },

    /**
     * Creates the local MediaStreams.
     * @param devices the devices that will be requested
     * @param resolution resolution constraints
     * @param dontCreateJitsiTrack if <tt>true</tt> objects with the following structure {stream: the Media Stream,
     * type: "audio" or "video", videoType: "camera" or "desktop"}
     * will be returned trough the Promise, otherwise JitsiTrack objects will be returned.
     * @returns {*} Promise object that will receive the new JitsiTracks
     */
    obtainAudioAndVideoPermissions: function (devices, resolution, dontCreateJitsiTracks) {
        var self = this;
        // Get AV

        return new Promise(function (resolve, reject) {
            var successCallback = function (stream) {
                var streams = self.successCallback(stream, resolution);
                resolve(dontCreateJitsiTracks? streams: self.createLocalTracks(streams));
            };

            if (!devices)
                devices = ['audio', 'video'];

            if (devices.length === 0) {
                successCallback();
                return;
            }

            if (RTCBrowserType.isFirefox() || RTCBrowserType.isTemasysPluginUsed()) {

                // With FF/IE we can't split the stream into audio and video because FF
                // doesn't support media stream constructors. So, we need to get the
                // audio stream separately from the video stream using two distinct GUM
                // calls. Not very user friendly :-( but we don't have many other
                // options neither.
                //
                // Note that we pack those 2 streams in a single object and pass it to
                // the successCallback method.
                var obtainVideo = function (audioStream) {
                    self.getUserMediaWithConstraints(
                        ['video'],
                        function (videoStream) {
                            return successCallback({
                                audioStream: audioStream,
                                videoStream: videoStream
                            });
                        },
                        function (error, resolution) {
                            logger.error(
                                'failed to obtain video stream - stop', error);
                            self.errorCallback(error, resolve, resolution, dontCreateJitsiTracks);
                        },
                            resolution || '360');
                };
                var obtainAudio = function () {
                    self.getUserMediaWithConstraints(
                        ['audio'],
                        function (audioStream) {
                            if (devices.indexOf('video') !== -1)
                                obtainVideo(audioStream);
                        },
                        function (error) {
                            logger.error(
                                'failed to obtain audio stream - stop', error);
                            self.errorCallback(error, resolve, null, dontCreateJitsiTracks);
                        }
                    );
                };
                if (devices.indexOf('audio') !== -1) {
                    obtainAudio();
                } else {
                    obtainVideo(null);
                }
            } else {
                this.getUserMediaWithConstraints(
                    devices,
                    function (stream) {
                        successCallback(stream);
                    },
                    function (error, resolution) {
                        self.errorCallback(error, resolve, resolution, dontCreateJitsiTracks);
                    },
                    resolution || '360');
            }
        }.bind(this));
    },

    /**
     * Successful callback called from GUM.
     * @param stream the new MediaStream
     * @param resolution the resolution of the video stream.
     * @returns {*}
     */
    successCallback: function (stream, resolution) {
        // If this is FF or IE, the stream parameter is *not* a MediaStream object,
        // it's an object with two properties: audioStream, videoStream.
        if (stream && stream.getAudioTracks && stream.getVideoTracks)
            logger.log('got', stream, stream.getAudioTracks().length,
                stream.getVideoTracks().length);
        return this.handleLocalStream(stream, resolution);
    },

    /**
     * Error callback called from GUM. Retries the GUM call with different resolutions.
     * @param error the error
     * @param resolve the resolve funtion that will be called on success.
     * @param currentResolution the last resolution used for GUM.
     * @param dontCreateJitsiTracks if <tt>true</tt> objects with the following structure {stream: the Media Stream,
     * type: "audio" or "video", videoType: "camera" or "desktop"}
     * will be returned trough the Promise, otherwise JitsiTrack objects will be returned.
     */
    errorCallback: function (error, resolve, currentResolution, dontCreateJitsiTracks) {
        var self = this;
        logger.error('failed to obtain audio/video stream - trying audio only', error);
        var resolution = getPreviousResolution(currentResolution);
        if (typeof error == "object" && error.constraintName && error.name
            && (error.name == "ConstraintNotSatisfiedError" ||
                error.name == "OverconstrainedError") &&
            (error.constraintName == "minWidth" || error.constraintName == "maxWidth" ||
                error.constraintName == "minHeight" || error.constraintName == "maxHeight")
            && resolution != null) {
            self.getUserMediaWithConstraints(['audio', 'video'],
                function (stream) {
                    var streams = self.successCallback(stream, resolution);
                    resolve(dontCreateJitsiTracks? streams: self.createLocalTracks(streams));
                }, function (error, resolution) {
                    return self.errorCallback(error, resolve, resolution, dontCreateJitsiTracks);
                }, resolution);
        }
        else {
            self.getUserMediaWithConstraints(
                ['audio'],
                function (stream) {
                    var streams = self.successCallback(stream, resolution);
                    resolve(dontCreateJitsiTracks? streams: self.createLocalTracks(streams));
                },
                function (error) {
                    logger.error('failed to obtain audio/video stream - stop',
                        error);
                    var streams = self.successCallback(null);
                    resolve(dontCreateJitsiTracks? streams: self.createLocalTracks(streams));
                }
            );
        }
    },

    /**
     * Handles the newly created Media Streams.
     * @param stream the new Media Streams
     * @param resolution the resolution of the video stream.
     * @returns {*[]} Promise object with the new Media Streams.
     */
    handleLocalStream: function (stream, resolution) {
        var audioStream, videoStream;
        // If this is FF, the stream parameter is *not* a MediaStream object, it's
        // an object with two properties: audioStream, videoStream.
        if (window.webkitMediaStream) {
            audioStream = new webkitMediaStream();
            videoStream = new webkitMediaStream();
            if (stream) {
                var audioTracks = stream.getAudioTracks();

                for (var i = 0; i < audioTracks.length; i++) {
                    audioStream.addTrack(audioTracks[i]);
                }

                var videoTracks = stream.getVideoTracks();

                for (i = 0; i < videoTracks.length; i++) {
                    videoStream.addTrack(videoTracks[i]);
                }
            }

        }
        else if (RTCBrowserType.isFirefox() || RTCBrowserType.isTemasysPluginUsed()) {   // Firefox and Temasys plugin
            if (stream && stream.audioStream)
                audioStream = stream.audioStream;
            else
                audioStream = new DummyMediaStream("dummyAudio");

            if (stream && stream.videoStream)
                videoStream = stream.videoStream;
            else
                videoStream = new DummyMediaStream("dummyVideo");
        }

        return [
                {stream: audioStream, type: "audio", videoType: null},
                {stream: videoStream, type: "video", videoType: "camera",
                  resolution: resolution}
            ];
    },

    createStream: function (stream, isVideo) {
        var newStream = null;
        if (window.webkitMediaStream) {
            newStream = new webkitMediaStream();
            if (newStream) {
                var tracks = (isVideo ? stream.getVideoTracks() : stream.getAudioTracks());

                for (var i = 0; i < tracks.length; i++) {
                    newStream.addTrack(tracks[i]);
                }
            }

        } else {
            // FIXME: this is duplicated with 'handleLocalStream' !!!
            if (stream) {
                newStream = stream;
            } else {
                newStream =
                    new DummyMediaStream(isVideo ? "dummyVideo" : "dummyAudio");
            }
        }

        return newStream;
    },
    addListener: function (eventType, listener) {
        eventEmitter.on(eventType, listener);
    },
    removeListener: function (eventType, listener) {
        eventEmitter.removeListener(eventType, listener);
    },
    getDeviceAvailability: function () {
        return devices;
    },
    isRTCReady: function () {
        return rtcReady;
    },
    createLocalTracks: function (streams) {
        var newStreams = []
        for (var i = 0; i < streams.length; i++) {
            var localStream = new JitsiLocalTrack(null, streams[i].stream,
                eventEmitter, streams[i].videoType, streams[i].resolution);
            newStreams.push(localStream);
            if (streams[i].isMuted === true)
                localStream.setMute(true);

            var eventType = StreamEventTypes.EVENT_TYPE_LOCAL_CREATED;

            eventEmitter.emit(eventType, localStream);
        }
        return newStreams;
    },

    /**
     * Checks if its possible to enumerate available cameras/micropones.
     * @returns {boolean} true if available, false otherwise.
     */
    isDeviceListAvailable: function () {
        var isEnumerateDevicesAvailable = navigator.mediaDevices && navigator.mediaDevices.enumerateDevices;
        if (isEnumerateDevicesAvailable) {
            return true;
        }
        return (MediaStreamTrack && MediaStreamTrack.getSources)? true : false;
    }
};

module.exports = RTCUtils;

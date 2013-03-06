(function(){
  "use strict";

  // Compatibilty
  var RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
  var MediaSource = window.MediaSource || window.WebKitMediaSource;

  // Web RTC config
  // Holds the STUN server to use for PeerConnections.
  var SERVER = "stun:stun.l.google.com:19302";

  // Leechers that wants a specific track from you.
  // Map of [peerId,trackWanted] -> peerConnection
  var leechers = {};
  var MAX_LEECHERS_PER_SEEDER = 2;

  // Seeder and wanted track information (the client is designed for only one track for now)
  var seederConn = null; // peer connection
  var seedChan = null; // data channel
  var trackName = $("#trackName").text();
  var totalNChunk = parseInt($("#totalNbChunk").text(),10); // total number of chunks of the track
  var track = []; // array of chunks (in-memory cache)

  // Audio
  var audio = null; // html audio tag
  var mediaSource = null;
  var sourceBuffer = null;

  // streaming from server
  var CHUNK_WINDOW = 1400; // number of chunks we ask to server each time we need to
  var chunkNInsideWindow = -1; // higher chunk number received inside the current chunk window streamed from server

  // internal state
  var emergencyMode = false; // true if we need to stream from server right now (buffer is too low)
  var peerRequested = false;
  var nbCurrentLeechers = 0; // leechers which we are seeding to right now
  var seederIsSuspected = false; // suspected == maybeDead

  // info for UI
  var chunkFromServer = 0;
  var chunkFromPeers = 0;


  // create the control websocket

  var ctrlSocket = new WebSocket(wsUrl("control"));
  ctrlSocket.onopen = function() {
    ctrlSocket.send(mess("connect",{}));
    setInterval(function() {
      ctrlSocket.send(mess("heartbeat",{}));
    }, 9000);
  };
  ctrlSocket.onmessage = function(evt) {
    var parsedWsEvt = JSON.parse(evt.data);
    var event = parsedWsEvt.event;
    var data = parsedWsEvt.data;
    //trace("Rcv: "+evt.data);

    if (event === "reqPeer") {
      var trackWanted = data.trackName;
      // testing if we have the track and if we dont stream to too many peers yet
      if (trackWanted === trackName && track.length === totalNChunk && nbCurrentLeechers < MAX_LEECHERS_PER_SEEDER) {
        // ok
        ctrlSocket.send(mess("respReqPeer",
          {"trackName":trackWanted,"seekId":data.seekId,"seekerId":data.seekerId}));
      }
    }

    else if (event === "peerNotFound") {
      peerRequested = false;
    }

    else if (event === "info") {
      $("#totalNumberPeers").text(data.peers);
    }

    // WebRTC caller side (leecher)
    else if (event === "peerFound" && seederConn === null) {
      // seeder found
      peerRequested = false;
      var seederId = data.seederId;

      seederConn = new RTCPeerConnection({"iceServers": [{"url": SERVER}]},{ optional:[ { RtpDataChannels: true }]});
      trace("establishing P2P connection caller side (leecher)");

      seederConn.onicecandidate = function (iceEvt) {
          if (iceEvt.candidate) {
            ctrlSocket.send(fwdMess(seederId,"callerIceCandidate",
              {"trackName":trackName,"candidate": iceEvt.candidate }));
          }
      };
      seederConn.onnegotiationneeded = function() {
        seederConn.createOffer(function(desc){
            seederConn.setLocalDescription(desc, function() {
              ctrlSocket.send(fwdMess(seederId,"rtcOffer",
                {"trackName":trackName,"sdp": desc }));
            });
        });
      };

      seedChan = seederConn.createDataChannel(trackName,{ reliable : false });
      seedChan.binaryType = "arraybuffer";

      $("#connectedToSeeder").text(true);
      trace("Going to open DataChannel");

      seedChan.onopen = function() {
        trace("DataChannel opened");
        if (!emergencyMode) {
          trace("Sending P2P stream request");
          seedChan.send(JSON.stringify({"from":track.length}));
        }
      };
      seedChan.onmessage = function(evt) {
        seederIsSuspected = false;
        if (!emergencyMode) {
          var binaryData = base64.decode(evt.data);
          var chunkNum = new Uint32Array(binaryData.slice(0,4))[0];
          trace("P2P: rcv: chunk "+chunkNum);
          if (chunkNum === track.length) {
            var chunk = binaryData.slice(4);
            track.push(chunk);
            chunkFromPeers +=1;
            $("#chunkN").text(track.length);
            $("#percentagePeers").text(Math.ceil((chunkFromPeers+1)*100/totalNChunk));
            appendToPlayback(chunk);

            if (streamEnded()){
              ctrlSocket.send(mess("streamEnded",{"trackName":trackName}));
              mediaSource.endOfStream();
              $("#totalTime").text(formatTime(audio.duration)); // hack, should not be needed
            }
          } else {
            trace("rcv chunk from P2P but wrong number");
          }
        } else {
          trace("rcv chunk from P2P but emergency mode");
          // ignoring chunk (it arrived too late!)
          // TODO: implement "stop" message ?
        }
      };
      seedChan.onclose = function() {
        // Peer have closed the connection before the seeker have downloaded the full track
        if (seederConn !== null) { // == if we have not suspected the seeder before (onclose can be much delayed)
          trace("data channel closed");
          seedChan = null;
          try {
            seederConn.close();
          } catch(err) {}
          seederConn = null;
          seederIsSuspected = false;
          $("#connectedToSeeder").text(false);
        }
      }

    }

    // WebRTC callee side (seeder)
    else if (event === "rtcOffer" || event === "callerIceCandidate") {
      var leecherId = parsedWsEvt.from;
      var trackWanted = data.trackName;

      if (!leechers.hasOwnProperty([leecherId,data.trackName])){
        //creation of new P2P connection
        var leecherConn = new RTCPeerConnection({"iceServers": [{"url": SERVER}]},
          { optional:[ { RtpDataChannels: true } ]});

        leecherConn.onicecandidate = function (iceEvt) {
          if (iceEvt.candidate) {
            ctrlSocket.send(fwdMess(leecherId,"calleeIceCandidate",
              {"trackName":trackName,"candidate": iceEvt.candidate }));
          } else {
            trace("No more Ice candidate");
          }
        };

        leecherConn.ondatachannel = function (evt) {
          trace("DataChannel opened");
          var chan = evt.channel;
          chan.binaryType = "arraybuffer";
          var cancellable = null;
          chan.onmessage = function (evt) {
            trace("Rcving P2P stream request");
            var req = JSON.parse(evt.data);
            if (cancellable !== null) {
              // cancelling previous sending
              clearInterval(cancellable);
            } else {
              nbCurrentLeechers += 1;
            }
            var chunkI = req.from;
            $("#nbLeechers").text(nbCurrentLeechers);

            function sendProgressively() {
              for(var i = 0; (chunkI < track.length && i < 9); i++) {
                var chunkNum = new Uint32Array(1);
                chunkNum[0] = chunkI;
                var chunk = UInt32concat(chunkNum, new Uint32Array(track[chunkI])).buffer;
                var b64encoded = base64.encode(chunk);
                chan.send(b64encoded);
                chunkI++;
                trace("P2P: send chunk "+chunkI);
              }
              if (chunkI >= track.length) {
                clearInterval(cancellable);
                cancellable = null;
                nbCurrentLeechers -= 1;
                $("#nbLeechers").text(nbCurrentLeechers);
              }
            }
            //sendProgressively();
            cancellable = setInterval(sendProgressively, 300);

          };
          chan.onclose = function () {
            trace("datachannel closed");
            nbCurrentLeechers -= 1;
            delete leechers[[leecherId,trackWanted]];
            $("#nbLeechers").text(nbCurrentLeechers);
          };
        };

        leechers[[leecherId,trackWanted]] = leecherConn;
      }

      var leecherConn = leechers[[leecherId,data.trackName]];
      if (event === "rtcOffer") {
        leecherConn.setRemoteDescription(new RTCSessionDescription(data.sdp), function() {
          trace("rtc offer set"); 
          leecherConn.createAnswer(function(desc){
            leecherConn.setLocalDescription(desc, function() {
              ctrlSocket.send(fwdMess(leecherId,"rtcAnswer",
                {"trackName":trackName,"sdp": desc }));
            });
          });
        });
      }
      else if (event === "callerIceCandidate") {
        leecherConn.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    }

    // WebRTC caller side (leecher)
    else if (event === "rtcAnswer" && seederConn !== null) {
      seederConn.setRemoteDescription(new RTCSessionDescription(data.sdp));
    }

    // WebRTC caller side (leecher)
    else if (event === "calleeIceCandidate" && seederConn !== null) {
      seederConn.addIceCandidate(new RTCIceCandidate(data.candidate));
    }

  };


  // create streaming binary socket

  var socket = new WebSocket(wsUrl("stream"));
  socket.binaryType = 'arraybuffer';
  socket.onmessage = function (event) {
    var chunk = event.data;
    track.push(chunk);
    appendToPlayback(chunk);
    chunkNInsideWindow += 1;
    chunkFromServer += 1;

    $("#chunkN").text(track.length);
    $("#percentageServer").text(Math.floor((chunkFromServer+1)*100/totalNChunk));

    if (streamEnded()){
      chunkNInsideWindow = -1;
      ctrlSocket.send(mess("streamEnded",{"trackName":trackName}));
      emergencyMode = false;
      mediaSource.endOfStream();
      $("#totalTime").text(formatTime(audio.duration)); // hack, should not be needed
    } else if (chunkNInsideWindow >= CHUNK_WINDOW) {
      // end of the stream response of CHUNK_WINDOW chunks
      chunkNInsideWindow = -1;
      emergencyMode = false;
      // recontact seeder to ask for chunks
      if (seedChan !== null && seedChan.readyState === "open") {
        if (seederIsSuspected) {
          trace("seeder is inactive");
          seedChan.close();
          seederConn.close();
          seedChan = null;
          seederConn = null;
          seederIsSuspected = false;
          $("#connectedToSeeder").text(false);
          seekPeer();
        } else {
          trace("Sending P2P stream request from "+track.length);
          seedChan.send(JSON.stringify({"from":track.length}));
          seederIsSuspected = true;
        }
      } else {
        seekPeer();
      }
    }
  }


  // User events

  $("#connect").click(function(){
    if (audio === null || audio.currentTime === 0 || audio.ended) {
      // new playback of the track
      $("#track").remove();
      $("#player").prepend('<video id="track"></video>'); // use of video tag as an audio tag
      $("#track").hide();

      audio = $('#track').get(0);
      mediaSource = new MediaSource();
      audio.src = window.URL.createObjectURL(mediaSource);

      audio.addEventListener("canplay", function() {
        $("#totalTime").text(formatTime(audio.duration));
      },false);

      audio.addEventListener("timeupdate", function() {
        // setting emergency streaming from server if there is less
        // than 3 seconds until the end of the buffer
        if (needToFetch()) {
          streamFromServer(track.length,track.length+CHUNK_WINDOW);
        }
        $("#currentTime").text(formatTime(audio.currentTime));
      },false);

      audio.addEventListener("ended", function(){
        $("#connect").attr("src","assets/images/play.png");
        if (!($("#fromCache").length)) {
          $("#connect").after('<span id="fromCache">from cache</span>');
        }
      },false);

      mediaSource.addEventListener('webkitsourceopen', function(e) {
        sourceBuffer = mediaSource.addSourceBuffer('audio/webm; codecs="vorbis"');
        if (track.length > 0) {
          // play from cache
          for (var i = 0; i < track.length; i++) {
            appendToPlayback(track[i]);
          }
          if (streamEnded()) {
            mediaSource.endOfStream();
          }
        }
        else {
          streamFromServer(0,CHUNK_WINDOW);
        }
        
        if (track.length < totalNChunk) {
          seekPeer();
        }
      },false);

      audio.play();
      $("#connect").attr("src","assets/images/pause.png");

    } else {
      // play/pause
      if (audio.paused){
        //$("#connect").text("Pause");
        $("#connect").attr("src","assets/images/pause.png");
        audio.play();
      } else {
        //$("#connect").text("Play");
        $("#connect").attr("src","assets/images/play.png");
        audio.pause();
      }
    }
    return false;
  });


  // Helper functions for playback and streaming

  function appendToPlayback(chunk) {
    sourceBuffer.append(new Uint8Array(chunk));
  }

  function streamFromServer(fromChunkN,toChunkN) {
      // enter server streaming mode
      if (chunkNInsideWindow === -1) { // no other concurrent requests
        chunkNInsideWindow = 0;
        emergencyMode = true;
        var req = {"trackName":trackName,"from":fromChunkN,"to":toChunkN};
        trace(JSON.stringify(req));
        socket.send(str2ab(JSON.stringify(req)));
      }
  }

  function seekPeer() {
    if (!peerRequested){
      ctrlSocket.send(mess("seekPeer",{"trackName":trackName}));
      trace("SEEK NEW PEER");
      peerRequested = true;
    }
  }

  function streamEnded() {
    return (track.length >= totalNChunk);
  }

  function needToFetch() {
    var lastBuffered = audio.buffered.end(audio.buffered.length-1);
    return (!streamEnded() && (audio.currentTime > lastBuffered -3));
  }


  // UI 

  $("#maxLeecherN").text(MAX_LEECHERS_PER_SEEDER);

  function formatTime(time) {
    var m = ""+Math.floor(time / 60);
    var s = ""+Math.floor(time % 60);
    if (m.length === 1)
      m = "0"+m;
    if (s.length === 1)
      s = "0"+s;
    return m+":"+s;
  }

  // preload images
  function preload(arrayOfImages) {
    $(arrayOfImages).each(function(){
      $('<img/>')[0].src = this;
    });
  }
  preload(["assets/images/pause.png"]);


  // UTILS

  function trace(text) {
    performance.now = performance.now || performance.webkitNow;
    var log = (performance.now() / 1000).toFixed(1) + ": " + text;
    console.log(log);
    $("#log>textarea").text((log+"\n"+$("#log>textarea").text()).substring(0,20000));
  }

  function wsUrl(path) {
    var loc = window.location;
    var new_uri = (loc.protocol === "https:") ? "wss:" : "ws:";
    new_uri += "//" + loc.host +"/" + path;
    return new_uri;
  }

  function mess(event,data) {
    trace("Send: "+JSON.stringify({"event:":event,"data":data}));
    return JSON.stringify({"event":event,"data":data});
  }

  function fwdMess(to,event,data) {
    //trace("Send to peer"+to+": "+JSON.stringify({"event:":event,"data":data}));
    return JSON.stringify({"event":"forward","to":to,"data":{"event":event,"data":data}});
  }

  function str2ab(str) {
    var buf = new ArrayBuffer(str.length*2); // 2 bytes for each char
    var bufView = new Uint16Array(buf);
    for (var i=0, strLen=str.length; i<strLen; i++) {
      bufView[i] = str.charCodeAt(i);
    }
    return buf;
  }

  function ab2str(ab) {
    return String.fromCharCode.apply(null, new Uint16Array(ab));
  }

  function UInt32concat(first, second) {
      var firstLength = first.length;
      var result = new Uint32Array(firstLength + second.length);
      result.set(first);
      result.set(second, firstLength);
      return result;
  }

})();

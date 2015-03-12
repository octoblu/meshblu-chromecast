'use strict';
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var debug = require('debug')('chromecast')
var Client = require('castv2').Client;
var mdns = require('mdns');
var io = require('socket.io-client')
var getYouTubeId = require('get-youtube-id');
var chromecastFound;
var GlobalIP;


var MESSAGE_SCHEMA = {
    type: 'object',
    properties: {
        AutoDiscovery: {
            type: 'boolean',
            required: true
        },
        ChromecastName: {
            type: 'string',
            required: true
        },
        CastingApplication: {
            type: 'string',
            "enum" : ['youtube', 'DisplayText', 'Url' , 'Media', 'CustomApp' ] ,
            required: true
        },
        youtubeUrl: {
            type: 'string',
            required: true
        },
        Message: {
            type: 'string',
            required: true
        },
        Url: {
            type: 'string',
            required: true
        },
        MediaURL: {
            type: 'string',
            required: true
        },
        AppID: {
            type: 'string',
            required: true
        },
        urn: {
            type: 'string',
            required: true
        },
        payload: {
            type: 'string',
            required: true
        }
    } 
};

var OPTIONS_SCHEMA = {
    type: 'object',
    properties: {
        AutoDiscovery: {
            type: 'boolean',
            required: true
        },
        ChromecastName: {
            type: 'string',
            required: true
        }
    }
};




function Plugin(){
  this.options = {};
  this.messageSchema = MESSAGE_SCHEMA;
  this.optionsSchema = OPTIONS_SCHEMA;
  return this;
}
util.inherits(Plugin, EventEmitter);

Plugin.prototype.onMessage = function (message) {
    
    var self = this;
    var _message = null;

    if (message.hasOwnProperty("params"))
        _message = message.params;
    else if (message.hasOwnProperty("payload"))
        _message = message.payload;

   // if (this.chromecastFound == false)
        this.DetectChromecast(_message);
   // else
   //     this.ondeviceup(GlobalIP, message);
  
};


							  
Plugin.prototype.onConfig = function(device){
  this.setOptions(device.options||{});
};

Plugin.prototype.setOptions = function (options){
    this.options = options || {};
    //this.DetectChromecast(options);
};

Plugin.prototype.DetectChromecast = function (message) {
      
    this.chromecastFound = false;
    var _self = this;
    var HostIP;
    var _msg = message;
    
    
    /**
     * Google Chromecast uses mdns Service named googlecast as advertisement.
     * 
     **/
    var browser = mdns.createBrowser(mdns.tcp('googlecast')).on('serviceUp', function (service) {
        
        console.log(service);

        if (message) {

            if ((message.AutoDiscovery == false) && (message.ChromecastName)) {
                if (message.ChromecastName.toLowerCase() == service.name.toLowerCase()) {
                    HostIP = service.addresses[0];
                    GlobalIP = service.addresses[0];
                    _self.chromecastFound = true;
                    _self.emit('message', { devices: ['*'], topic: 'echo', payload: service });
                    _self.ondeviceup(HostIP, _msg);
                }
            }
            else if ((message.AutoDiscovery == true) && (_self.chromecastFound == false)) {
                if (service.hasOwnProperty("name")) {
                    HostIP = service.addresses[0];
                    GlobalIP = service.addresses[0];
                    _self.chromecastFound = true;
                    _self.emit('message', { devices: ['*'], topic: 'echo', payload: service });
                    _self.ondeviceup(HostIP, _msg);
                }
            }
        }
    });

    browser.start();
};



Plugin.prototype.ondeviceup = function (host, message) {
    
    var APPID = this.GetChromecastApplicationID(message);
    var client = new Client();
    var _self = this;
    

    client.connect(host, function () {
        // Google Chromecast various namespace handlers for initializing connection.
        var connection = client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.tp.connection', 'JSON');
        var heartbeat = client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.tp.heartbeat', 'JSON');
        var receiver = client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.receiver', 'JSON');
        
        
        var requestId = 1443;
        var _transportId;
        var launchRequestId;
        
        
        // establish virtual connection to the receiver
        connection.send({ type: 'CONNECT' });
        
        
        // Check first if the app is avaliable.
        receiver.send({ type: 'GET_APP_AVAILABILITY', appId: [APPID], requestId: requestId });
        
        
        // start heartbeating
        setInterval(function () {
            heartbeat.send({ type: 'PING' });
        }, 5000);
        
        
        receiver.on('message', function (data, broadcast) {
            
            if (data.type = 'RECEIVER_STATUS') {
                if (data.requestId == requestId) {
                    if ('APP_AVAILABLE' === data.availability[APPID]) {
                        console.log(data);
                        launchRequestId = requestId;
                        receiver.send({ type: 'LAUNCH', appId: APPID, requestId: requestId++ });
                    }
                }
                else if (data.requestId == launchRequestId) {
                    {
                        console.log('Handling LAUNCH response...');
                        data.status.applications.forEach(function (app) {
                            if (APPID === app.appId) {
                                console.log(app);
                                _transportId = app.transportId;
                                console.log('Discovered transportId: ' + _transportId);
                                var mySenderConnection = client.createChannel('client-13243', app.transportId, 'urn:x-cast:com.google.cast.tp.connection', 'JSON');
                                mySenderConnection.send({ type: 'CONNECT' });
                                _self.ShootChromecastAppSpecficMessage(message, app, client);
                            }
                        });
                    }
                    console.log(data.status);
                }
            }
        });
    });

}

Plugin.prototype.GetChromecastApplicationID = function (message) {
    console.log(message);
    if (message.hasOwnProperty('CastingApplication')) {
        switch (message.CastingApplication) {
            case 'youtube':
                return '233637DE';
            case 'DisplayText':
                return '794B7BBF';
            case 'Url':
                return '7897BA3B';
            case 'Media':
                return 'CC1AD845';
            case 'CustomApp':
                return message.AppID;
        }
    }
 
}

Plugin.prototype.GetChromecastAppNamespace = function (message) {
    if (message.hasOwnProperty('CastingApplication')) {
        switch (message.CastingApplication) {
            case 'youtube':
                return 'urn:x-cast:com.google.youtube.mdx';
            case 'DisplayText':
                return 'urn:x-cast:com.google.cast.sample.helloworld';
            case 'Url':
                return 'urn:x-cast:uk.co.splintered.urlcaster';
            case 'Media':
                return 'urn:x-cast:com.google.cast.media';
            case 'CustomApp':
                return message.urn;
        }
    }
 
}

Plugin.prototype.ShootChromecastAppSpecficMessage = function (message, app, client) {
    
    var namespace = this.GetChromecastAppNamespace(message);
    
    if (message.hasOwnProperty('CastingApplication')) {
        switch (message.CastingApplication) {
            case 'youtube':
                if (message.hasOwnProperty('youtubeUrl')) {
                    // var link = 'https://www.youtube.com/watch?v=0vxOhd4qlnA';
                    var youtubeId = getYouTubeId(message.youtubeUrl);
                    var url = client.createChannel('client-13243', app.transportId, namespace, 'JSON');
                    url.send({
                        type: 'flingVideo',
                        data: {
                            currentTime: 0,
                            videoId: youtubeId
                        }
                    });
                }
                break;

            case 'DisplayText':
                if (message.hasOwnProperty('Message')) {
                    var url = client.createChannel('client-13243', app.transportId, namespace);
                    url.send(message.Message);
                }
                break;

            case 'Url':
                if (message.hasOwnProperty('MeetingID')) {
                    var url = client.createChannel('client-13243', app.transportId, namespace);
                    url.send(message.Url);
                }
                break;

            case 'Media':
                if (message.hasOwnProperty('MediaURL')) {
                    var url = client.createChannel('client-13243', app.transportId, namespace, 'JSON');
                    url.send({
                        type: 'LOAD', 
                        requestId: 77063063, 
                        sessionId: app.sessionId, 
                        media: {
                            contentId: message.MediaURL, 
                            streamType: 'LIVE', 
                            contentType: 'video/mp4'
                        }, 
                        autoplay: true, 
                        currentTime: 0, 
                        customData: {
                            payload: {
                                title: 'Triggred from Octoblu'
                            }
                        }
                    });
                }
                break;
            case 'CustomApp':
            //FIXME
        }
    }
 
}


module.exports = {
  messageSchema: MESSAGE_SCHEMA,
  optionsSchema: OPTIONS_SCHEMA,
  Plugin: Plugin
};
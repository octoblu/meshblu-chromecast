'use strict';
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var debug = require('debug')('meshblu-chromecast')
var Client = require('castv2').Client;
var mdns = require('mdns');
var io = require('socket.io-client')
var getYouTubeId = require('get-youtube-id');
var chromecastFound;
var _ = require('lodash');

var MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
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

var doesMatchPluginSerivce = function(pluginName, serviceName){
  if(!pluginName || !serviceName) return;
  return pluginName.toLowerCase() === serviceName.toLowerCase();
};

function Plugin(){
  var self = this;
  self.options = {};
  self.messageSchema = MESSAGE_SCHEMA;
  self.optionsSchema = OPTIONS_SCHEMA;
  self.requestId = 1443;
  return self;
}

util.inherits(Plugin, EventEmitter);

Plugin.prototype.onMessage = function (message) {
  debug('onMessage', message);

  if (!message.payload) return;

  this.detectChromecast(message.payload);
};

Plugin.prototype.onConfig = function(device){
  debug('onConfig');

  this.setOptions(device.options || {});
  this.setupChromecast();
};

Plugin.prototype.setOptions = function (options){
  this.options = options || {};
};

Plugin.prototype.setupChromecast = function() {
  debug('Setting up chromecast....');
};

Plugin.prototype.detectChromecastImmediately = function (message) {
  var self = this,
    pluginName = self.options.ChromecastName,
    autodiscovery = self.options.AutoDiscovery;

  if(!autodiscovery && !pluginName) return;

  var browser = mdns.createBrowser(mdns.tcp('googlecast')).on('serviceUp', function (chromecast) {
    self.chromecast = chromecast;
    if (autodiscovery || doesMatchPluginSerivce(pluginName, self.chromecast.name)) {
      return self.sendMessageToDevice(message, self.chromecast);
    }
  });

  browser.start();
};

Plugin.prototype.detectChromecast = _.debounce(Plugin.prototype.detectChromecastImmediately, 1000);

Plugin.prototype.sendMessageToDevice = function (message, service) {
  debug('sendMessageToDevice', 'Casting...');

  var hostIP = service.addresses[0];

  // this.emit('message', { devices: ['*'], topic: 'echo', payload: service });
  this.onDeviceUp(hostIP, message);
}

Plugin.prototype.onDeviceUp = function (host, message) {
  debug('onDeviceUp', message);
  var self = this;
  self.client = new Client();

  self.client.connect(host, function () {
    self.sendMessageToClient(message);
  });
}

Plugin.prototype.sendMessageToClient = function(message){
  var self = this;
  var APPID = this.getChromecastApplicationID(message);
  // Google Chromecast various namespace handlers for initializing connection.
  var connection = self.client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.tp.connection', 'JSON');
  var heartbeat = self.client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.tp.heartbeat', 'JSON');
  var receiver = self.client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.receiver', 'JSON');

  var launchRequestId;

  // establish virtual connection to the receiver
  connection.send({ type: 'CONNECT' });

  // Check first if the app is avaliable.
  receiver.send({ type: 'GET_APP_AVAILABILITY', appId: [APPID], requestId: self.requestId });

  // start heartbeating
  setInterval(function () {
    heartbeat.send({ type: 'PING' });
  }, 5000);

  receiver.on('message', function (data, broadcast) {
    debug('chromecast ReceiverMessage', JSON.stringify(data));
    if (data.requestId === self.requestId) {
      debug('data requestId');
      debug('self requestId');
      if ('APP_AVAILABLE' === data.availability[APPID]) {
        debug('app is available', data.availability[APPID]);
        launchRequestId = self.requestId;
        debug('request id', self.requestId);
        receiver.send({ type: 'LAUNCH', appId: APPID, requestId: self.requestId++ });
      }
    }else if (data.requestId == launchRequestId) {
      // data requestId and self requestId are diff
      debug('handling launch response...');
      debug('launchRequestId', launchRequestId);
      var app = _.find(data.status.applications, {appId: APPID})
      if(_.isEmpty(app)) return;
      var mySenderConnection = self.client.createChannel('client-13243', app.transportId, 'urn:x-cast:com.google.cast.tp.connection', 'JSON');
      mySenderConnection.send({ type: 'CONNECT' });
      self.sendChromecastAppSpecficMessage(message, app, self.client);
    }
  });
};

Plugin.prototype.getChromecastApplicationID = function (message) {
  debug('getChromecastApplicationID');

  if (_.has(message, 'CastingApplication')) {
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

Plugin.prototype.getChromecastAppNamespace = function (message) {
  if (_.has(message, 'CastingApplication')) {
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

Plugin.prototype.sendChromecastAppSpecficMessage = function (message, app, client) {
  debug('sending chromecast a specific message');
  var self = this;
  var namespace = self.getChromecastAppNamespace(message);

  if (!_.has(message, 'CastingApplication')) {
    return;
  }
  switch (message.CastingApplication) {
    case 'youtube':
      if(!_.has(message, 'youtubeUrl')){ return; }
      // var link = 'https://www.youtube.com/watch?v=0vxOhd4qlnA';
      var youtubeId = getYouTubeId(message.youtubeUrl);
      debug('Sending Youtube', message.youtubeUrl, youtubeId);
      var url = client.createChannel('client-13243', app.transportId, namespace, 'JSON');
      url.send({
        type: 'flingVideo',
        data: {
          currentTime: 0,
          videoId: youtubeId
        }
      });
      break;
    case 'DisplayText':
      if(!_.has(message, 'Message')){ return; }
      var url = client.createChannel('client-13243', app.transportId, namespace);
      url.send(message.Message);
      break;
    case 'Url':
      if(!_.has(message, 'MeetingID')){ return; }
      var url = client.createChannel('client-13243', app.transportId, namespace);
      url.send(message.Url);
      break;
    case 'Media':
      if(!_.has(message, 'MediaURL')){ return; }
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
            title: 'Triggered from Octoblu'
          }
        }
      });
      break;
  }
}
module.exports = {
  messageSchema: MESSAGE_SCHEMA,
  optionsSchema: OPTIONS_SCHEMA,
  Plugin: Plugin
};

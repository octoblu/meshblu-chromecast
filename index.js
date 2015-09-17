'use strict';
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var debug = require('debug')('meshblu-chromecast')
var Client = require('castv2').Client;
var mdns = require('mdns-js');
var getYouTubeId = require('get-youtube-id');
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

var CLIENT_ID = 'client-13243';

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
  function exitHandler(){
    console.error('Shutting down chromecast');
    self.chromecast = null;
    if(self.client){
      self.client.close();
    }
    process.exit(1);
  }
  process.on('SIGINT', exitHandler);
  return self;
}

util.inherits(Plugin, EventEmitter);

Plugin.prototype.onMessage = function (message) {
  debug('onMessage', message);

  if (!message.payload) return debug('no payload in message');

  this.detectChromecast(message.payload);
};

Plugin.prototype.onConfig = function(device){
  debug('onConfig', device.options);

  this.setOptions(device.options || {});
};

Plugin.prototype.setOptions = function (options){
  this.options = options || {};
};

Plugin.prototype.saneifyData = function(data){
  var device = {};
  device.address = _.first(data.addresses);
  device.addresses = data.addresses;
  device.name = (data.host ? data.host.replace('.local', '') : undefined);
  device.port = data.port;
  var txtRecord = {};
  _.each(data.txt, function(item){
    if (!item) return;
    var items = item.split('=');
    txtRecord[items[0]] = items[1];
  });
  device.txtRecord = txtRecord;
  device.types = _.pluck(data.type, 'name');
  return device;
};

Plugin.prototype.getChromecast = function(data, options){
  var self = this;
  var pluginName = options.ChromecastName;
  var autodiscovery = options.AutoDiscovery;
  var chromecast = self.saneifyData(data);
  if(_.indexOf(chromecast.types, 'googlecast') < 0){
    debug('not a chromecast');
    return;
  }
  if(!chromecast.name){
    debug('not a valid chromecast name');
    return;
  }
  if(self.chromecast && self.chromecast.name == chromecast.name){
    debug('chromecast is the same');
    return;
  }
  debug('chromecast service up', chromecast.name);
  if (autodiscovery){
    debug('autodiscovery');
    return chromecast;
  } else if (doesMatchPluginSerivce(pluginName, chromecast.name)){
    debug('found chromecast by name', pluginName);
    return chromecast;
  }
  return;
}

Plugin.prototype.detectChromecastImmediately = function (message) {
  debug('detecting chromecast');
  var self = this;
  debug('connecting to browser');

  var browser = mdns.createBrowser(mdns.tcp('googlecast'));

  browser.on('update', function (data) {
    debug('mdns found chromecast');
    var chromecast = self.getChromecast(data, self.options);
    if(!chromecast){
      return;
    }
    self.chromecast = chromecast;
    self.sendMessageToDevice(message);
    browser.stop();
  });

  browser.on('ready', function(){
    debug('ready');
    browser.discover();
  });
};

Plugin.prototype.detectChromecast = _.debounce(Plugin.prototype.detectChromecastImmediately, 1000);

Plugin.prototype.sendMessageToDevice = function (message) {
  var self = this;
  debug('sendMessageToDevice', 'Casting...');
  self.onDeviceUp(self.chromecast.address, message);
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
  var APPID = self.getChromecastApplicationID(message);
  // Google Chromecast various namespace handlers for initializing connection.

  var connection = self.client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.tp.connection', 'JSON');
  var heartbeat = self.client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.tp.heartbeat', 'JSON');
  var receiver = self.client.createChannel('sender-0', 'receiver-0', 'urn:x-cast:com.google.cast.receiver', 'JSON');

  var launchRequestId;

  if(!connection){
    debug('no connection');
    return;
  }
  // establish virtual connection to the receiver
  connection.send({ type: 'CONNECT' });

  // Check first if the app is avaliable.
  receiver.send({ type: 'GET_APP_AVAILABILITY', appId: [APPID], requestId: self.requestId });

  // start heartbeating
  setInterval(function () {
    heartbeat.send({ type: 'PING' });
  }, 5000);

  receiver.on('message', function (data, broadcast) {
    debug('chromecast received message', JSON.stringify(data));
    if(data.reason === 'CANCELLED'){
      debug('Request cancelled');
      return;
    }
    if (data.requestId === self.requestId) {
      if ('APP_AVAILABLE' === data.availability[APPID]) {
        debug('app is available', data.availability[APPID]);
        launchRequestId = self.requestId;
        receiver.send({ type: 'LAUNCH', appId: APPID, requestId: self.requestId++ });
      }
    }else if (data.requestId == launchRequestId) {
      // data requestId and self requestId are diff
      debug('handling launch response...');
      debug('launchRequestId', launchRequestId);
      var app = _.find(data.status.applications, {appId: APPID})
      if(_.isEmpty(app)) return;
      var mySenderConnection = self.client.createChannel(CLIENT_ID, app.transportId, 'urn:x-cast:com.google.cast.tp.connection', 'JSON');
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
      var url = client.createChannel(CLIENT_ID, app.transportId, namespace, 'JSON');
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
      var url = client.createChannel(CLIENT_ID, app.transportId, namespace);
      url.send(message.Message);
      break;
    case 'Url':
      if(!_.has(message, 'Url') && !_.has(message, 'MeetingID')){ return; }
      var url = client.createChannel(CLIENT_ID, app.transportId, namespace);
      url.send(message.Url);
      break;
    case 'Media':
      if(!_.has(message, 'MediaURL')){ return; }
      var url = client.createChannel(CLIENT_ID, app.transportId, namespace, 'JSON');
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

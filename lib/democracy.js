/**
 * democracy.js
 * Copyright (c) 2016, GoldFire Studios, Inc.
 * http://goldfirestudios.com
 */

'use strict';

var dgram = require('dgram');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var StringDecoder = require('string_decoder').StringDecoder;
var decoder = new StringDecoder('utf8');
var uuid = require('node-uuid');
var AWS = require('aws-sdk');
var Q = require("q");
var instance = require("ec2-instance-data");

/**
 * Setup the base Democracy class so that we can add onto the prototype.
 * @param {Object} options User-defined options.
 */
var Democracy = function(options) {
  EventEmitter.call(this);
  this.init(options);
};

util.inherits(Democracy, EventEmitter);

/**
 * Initialize a new democracy with the given options.
 * @param  {Object} options User-defined options.
 */
Democracy.prototype.init = function(options) {
  var self = this;

  self._nodes = {};

  // Merge the passed options with the defaults.
  options = options || {};
  self.options = {
    interval: options.interval || 1000,
    timeout: options.timeout || 3000,
    source: options.source || '0.0.0.0:12345',
    peers: options.peers || [],
    weight: options.weight || Math.random() * Date.now(),
    awsRegion: options.region || "eu-west-1",
    awsDiscover: options.awsDiscover || false,
    awsDiscoverTagName: options.awsDiscoverTagName || "democracy",
    port: options.port || 12345
  };

  // Check discover
  self.discover().then(function(){
    // Remove the source from the peers.
    var sourceIndex = self.options.peers.indexOf(self.options.source);
    if (sourceIndex >= 0) {
      self.options.peers.splice(sourceIndex, 1);
    }

    // Better format the source and peers for speed.
    self.options.source = self.options.source.split(':');
    for (var i=0; i<self.options.peers.length; i++) {
      self.options.peers[i] = self.options.peers[i].split(':');
    }

    // Generate the details about this node to be sent between nodes.
    self._id = uuid.v4();
    self._weight = self.options.weight;
    self._state = 'follower';

    // Setup the UDP socket to listen on.
    self.socket = dgram.createSocket({type: 'udp4', reuseAddr: true});

    self.start();
  }, function(err){
    console.log(err)
    throw err;
  })
};

/**
 * Start the democratic process by binding to the UDP port and holding the first election.
 * @return {Democracy}
 */
Democracy.prototype.start = function() {
  var self = this;

  // Bind to the UDP port and begin listeneing for hello, etc messages.
  self.socket.bind(self.options.source[1], self.options.source[0], function() {
    // Listen for messages on this port.
    self.socket.on('message', function(msg) {
      self.processEvent(msg);
    });

    // Start sending 'hello' messages to the other nodes.
    self.hello();
  });

  // Run an election after two intervals if we still don't have a leader.
  setTimeout(function() {
    // Check if we have a leader.
    var haveLeader = false;
    for (var id in self._nodes) {
      if (self._nodes[id].state === 'leader') {
        haveLeader = true;
        break;
      }
    }

    if (!haveLeader && self._state !== 'leader') {
      self.holdElections();
    }
  }, self.options.interval * 2);

  return self;
};

/**
 * Run the `hello` interval to send out the heartbeats.
 * @return {Democracy}
 */
Democracy.prototype.hello = function() {
  var self = this;

  setInterval(function() {
    self.send('hello');
    self.check();
  }, self.options.interval);

  return self;
};

/**
 * Send a message to the other peers.
 * @param  {String} event 'hello', 'vote', etc
 * @param  {Object} extra Other data to send.
 * @return {Democracy}
 */
Democracy.prototype.send = function(event, extra) {
  var self = this;
  var data = {event: event, id: self._id};

  if (event === 'vote') {
    data.candidate = extra.candidate;
  } else {
    data.weight = self._weight;
    data.state = self._state;

    // Handle custom messaging between nodes.
    if (extra) {
      data.extra = extra;
    }
  }
  
  data.source = self.options.source[0] + ':' + self.options.source[1];

  // Data must be sent as a Buffer over the UDP socket.
  var msg = new Buffer(JSON.stringify(data));

  // Loop through each connect node and send the packet over.
  for (var i=0; i<self.options.peers.length; i++) {
    self.socket.send(msg, 0, msg.length, self.options.peers[i][1], self.options.peers[i][0]);
  }

  return self;
};

/**
 * After sending a `hello`, check if any of the other nodes are down.
 * @return {Democracy}
 */
Democracy.prototype.check = function() {
  var self = this;

  for (var id in self._nodes) {
    if (self._nodes[id] && self._nodes[id].last + self.options.timeout < Date.now()) {
      // Increment the vote count.
      if (self._nodes[id].voters.indexOf(self._id) < 0) {
        self._nodes[id].voters.push(self._id);

        // Send the vote to the other peers that this one is down.
        self.send('vote', {candidate: id});
        self.checkBallots(id);
      }
    }
  }

  return self;
};

/**
 * Process events that are received over the network.
 * @param  {Object} msg Data received.
 * @return {Democracy}
 */
Democracy.prototype.processEvent = function(msg) {
  var self = this;
  var data = self.decodeMsg(msg);

  if (!data || data.id === self._id) {
    return;
  }

  // Process the different available events.
  if (data.event === 'hello') {
    // Create a new node if we don't already know about this one.
    if (!self._nodes[data.id]) {
      self._nodes[data.id] = {
        id: data.id,
        weight: data.weight,
        state: data.state,
        last: Date.now(),
        voters: []
      };

      self.emit('added', self._nodes[data.id]);
    } else {
      self._nodes[data.id].last = Date.now();
      self._nodes[data.id].state = data.state;
      self._nodes[data.id].weight = data.weight;
    }

    // Reset the voters since we've now seen this node again.
    self._nodes[data.id].voters = [];

    // If we are both leaders, hold a runoff to determine the winner...hanging chads and all.
    if (self._state === 'leader' && data.state === 'leader') {
      self.holdElections();
    }

    // If we now have no leader, hold a new election.
    if (self._hadElection && !self.leader()) {
      self.holdElections();
    }

    // We have had an election somewhere if we have a leader.
    if (self.leader()) {
      self._hadElection = true;
    }
  } else if (data.event === 'vote') {
    if (self._nodes[data.candidate] && self._nodes[data.candidate].voters.indexOf(data.id) < 0) {
      // Tally this vote.
      self._nodes[data.candidate].voters.push(data.id);

      // Process the ballots to see if this node should be removed and a new leader selected.
      self.checkBallots(data.candidate);
    }
  } else if (data.event === 'leader') {
    if (!self._nodes[data.id]) {
      self._nodes[data.id] = {
        id: data.id,
        weight: data.weight,
        state: data.state,
        last: Date.now(),
        voters: []
      };

      self.emit('added', self._nodes[data.id]);
    } else {
      self._nodes[data.id].state = 'leader';
    }

    self.emit('leader', self._nodes[data.id]);
  } else {
    // Handle custom messaging between nodes.
    self.emit(data.event, data);
  }

  return self;
};

/**
 * Check if a unanimous decision has been reached by the active nodes.
 * @param  {String} candidate ID of the candidate to be removed.
 * @return {Democracy}
 */
Democracy.prototype.checkBallots = function(candidate) {
  var self = this;
  var node = self._nodes[candidate];
  var state = node.state;
  var numVoters = 0;

  // Count the number of voters that haven't been marked for election.
  for (var i=0; i<self._nodes.length; i++) {
    if (self._nodes[i] && !self._nodes[i].voters.length) {
      numVoters++;
    }
  }

  // If we have concensus, remove this node from the list.
  if (node.voters.length >= numVoters) {
    self.emit('removed', self._nodes[candidate]);
    self._nodes[candidate] = null;
  }

  if (state === 'leader') {
    self.holdElections();
  }

  return self;
};

/**
 * Hold an election for a new leader.
 * @return {Democracy}
 */
Democracy.prototype.holdElections = function() {
  var self = this;
  var highestWeight = 0;
  var nodes = self.nodes();
  var newLeader;

  // Elect a new leader based on highest weight.
  // Each server should always elect the same leader.
  for (var id in nodes) {
    if (nodes[id] && nodes[id].weight > highestWeight) {
      highestWeight = nodes[id].weight;
      newLeader = id;
    }
  }

  // If we are currently the leader, but not the "new leader", we lose the runoff and resign.
  if (self._state === 'leader' && newLeader && newLeader !== self._id) {
    self.resign();
  }

  // Elect our new benevolent dictator for life...of process.
  if (newLeader === self._id || !newLeader) {
    self._state = 'leader';
    nodes[newLeader].state = 'leader';
    self.emit('elected', nodes[newLeader]);
    self.send('leader');
  } else {
    self._nodes[newLeader].state = 'leader';
  }

  self._hadElection = true;

  return self;
};

/**
 * Resign as leader and fly into the sunset disgraced.
 * Calling this directly on the current leader will prompt a new election,
 * which could result in this same node becoming leader again (as is the way of the world).
 * @return {Democracy}
 */
Democracy.prototype.resign = function(noElection) {
  var self = this;
  var nodes = self.nodes();

  if (self._state === 'leader') {
    self._state = 'follower';
    self.emit('resigned', nodes[self._id]);
    self.send('hello');
  }

  return self;
},

/**
 * Get the list of current nodes, including this one.
 * @return {Object} All nodes.
 */
Democracy.prototype.nodes = function() {
  var self = this;

  // Add this server into the nodes list.
  var nodes = JSON.parse(JSON.stringify(self._nodes));
  nodes[self._id] = {
    id: self._id,
    weight: self._weight,
    state: self._state
  };

  return nodes;
};

/**
 * Find our current fearless leader.
 * @return {Object} Current leader.
 */
Democracy.prototype.leader = function() {
  var self = this;
  var nodes = self.nodes();
  var leader = null;

  for (var id in nodes) {
    if (nodes[id] && nodes[id].state === 'leader') {
      leader = nodes[id];
      break;
    }
  }

  return leader;
},

/**
 * Safely decode a Buffer message received over UDP.
 * @param  {Buffer} msg Received data.
 * @return {Object}     Parsed data.
 */
Democracy.prototype.decodeMsg = function(msg) {
  try {
    msg = JSON.parse(decoder.write(msg));
  } catch (e) {
    msg = null;
  }

  return msg;
};

/**
 * AWS Discover init.
 * @return {Object}     Parsed data.
 */
Democracy.prototype.discover = function() {
  var deferred = Q.defer();
  var self = this;

  if(self.options.awsDiscover)
  {
    AWS.config.region = self.options.awsRegion;

    self.describeLocalIp().then(function(){
      self.describeEC2Instances().then(function(){
        deferred.resolve(self);
      }, function(err){
        deferred.reject(err);
      })
    }, function(err){
      deferred.reject(err);
    });
  }
  else
  {
    deferred.resolve(self);
  }
  return deferred.promise;
}

/**
 * Get a aws instance private ip.
 * @return {Object}     Parsed data.
 */
Democracy.prototype.describeLocalIp = function() {
  var deferred = Q.defer();
  var self = this;

  instance.init(function (err) {
    if (err) {
      deferred.reject(err);
    }else{
      if(instance.latest && instance.latest["meta-data"]["local-ipv4"] !== undefined){
        self.options.source = instance.latest["meta-data"]["local-ipv4"] + ":" + self.options.port
      }else{
        deferred.reject({error: "couldn't get local ip from aws metadata"});
      }
      deferred.resolve(self);
    }
  });

  return deferred.promise;
}

/**
 * Get a aws instances by tag.
 * @return {Object}     Parsed data.
 */
Democracy.prototype.describeEC2Instances = function() {
  var deferred = Q.defer();
  var self = this;

  var ec2 = new AWS.EC2();

  ec2.describeInstances({
    Filters: [
      {
        Name: 'tag:' + self.options.awsDiscoverTagName,
        Values: [
          'yes'
        ]
      }
    ]
  }, function (err, data) {
    if (err) {
      deferred.reject(err);
    }else{
      for (var reservation in data.Reservations) {
        for (var instance in data.Reservations[reservation].Instances) {
          if (data.Reservations[reservation].Instances[instance].PrivateIpAddress !== undefined) {
            self.options.peers.push(data.Reservations[reservation].Instances[instance].PrivateIpAddress + ":" + self.options.port)
          }
        }
      }
      deferred.resolve(self);
    }
  });

  return deferred.promise;

}

module.exports = Democracy;

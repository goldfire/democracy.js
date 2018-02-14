/**
 * democracy.js
 * Copyright (c) 2016 - 2018, GoldFire Studios, Inc.
 * http://goldfirestudios.com
 */

const uuid = require('uuid');
const dgram = require('dgram');
const {EventEmitter} = require('events');
const {StringDecoder} = require('string_decoder');

// Create the string decoder.
const decoder = new StringDecoder('utf8');

/**
 * Setup the base Democracy class that handles all of the methods.
 */
class Democracy extends EventEmitter {
  /**
   * Initialize a new democracy with the given options.
   * @param  {Object} options User-defined options.
   */
  constructor(options = {}) {
    super();

    this._nodes = {};

    // Merge the passed options with the defaults.
    this.options = {
      interval: options.interval || 1000,
      timeout: options.timeout || 3000,
      source: options.source || '0.0.0.0:12345',
      peers: options.peers || [],
      weight: options.weight || Math.random() * Date.now(),
      id: options.id || uuid.v4(),
      channels: options.channels || [],
    };

    // Remove the source from the peers.
    const sourceIndex = this.options.peers.indexOf(this.options.source);
    if (sourceIndex >= 0) {
      this.options.peers.splice(sourceIndex, 1);
    }

    // Better format the source and peers for speed.
    this.options.source = this.options.source.split(':');
    for (let i = 0; i < this.options.peers.length; i += 1) {
      this.options.peers[i] = this.options.peers[i].split(':');
    }

    // Generate the details about this node to be sent between nodes.
    this._id = this.options.id;
    this._weight = this.options.weight;
    this._state = 'citizen';

    // Setup the UDP socket to listen on.
    this.socket = dgram.createSocket({type: 'udp4', reuseAddr: true});

    this.start();
  }

  /**
   * Start the democratic process by binding to the UDP port and holding the first election.
   * @return {Democracy}
   */
  start() {
    // Bind to the UDP port and begin listeneing for hello, etc messages.
    this.socket.bind(this.options.source[1], this.options.source[0], () => {
      // Listen for messages on this port.
      this.socket.on('message', (msg) => {
        this.processEvent(msg);
      });

      // Start sending 'hello' messages to the other nodes.
      this.hello();
    });

    // Run an election after two intervals if we still don't have a leader.
    setTimeout(() => {
      // Check if we have a leader.
      let haveLeader = false;
      Object.keys(this._nodes).forEach((id) => {
        if (this._nodes[id].state === 'leader') {
          haveLeader = true;
        }
      });

      if (!haveLeader && this._state !== 'leader') {
        this.holdElections();
      }
    }, this.options.interval * 2);

    return this;
  }

  /**
   * Run the `hello` interval to send out the heartbeats.
   * @return {Democracy}
   */
  hello() {
    // Send a hello message and then check the other nodes.
    const sendHello = () => {
      this.send('hello');
      this.check();
    };

    // Schedule hello messages on the specified interval.
    setInterval(sendHello, this.options.interval);

    // Immediately send the first hello message.
    sendHello();

    return this;
  }

  /**
   * Send a message to the other peers.
   * @param  {String} event 'hello', 'vote', etc.
   * @param  {Object} extra Other data to send.
   * @return {Democracy}
   */
  send(event, extra, id) {
    const data = {event, id: this._id};

    if (event === 'vote') {
      data.candidate = extra.candidate;
    } else {
      data.weight = this._weight;
      data.state = this._state;
      data.channels = this.options.channels;

      // Handle custom messaging between nodes.
      if (extra) {
        data.extra = extra;
      }
    }

    data.source = `${this.options.source[0]}:${this.options.source[1]}`;

    // Data must be sent as a Buffer over the UDP socket.
    const msg = Buffer.from(JSON.stringify(data));

    // Loop through each connect node and send the packet over.
    for (let i = 0; i < this.options.peers.length; i += 1) {
      if (!id || this._nodes[id].source === `${this.options.peers[i][0]}:${this.options.peers[i][1]}`) {
        this.socket.send(msg, 0, msg.length, this.options.peers[i][1], this.options.peers[i][0]);
      }
    }

    return this;
  }

  /**
   * After sending a `hello`, check if any of the other nodes are down.
   * @return {Democracy}
   */
  check() {
    Object.keys(this._nodes).forEach((id) => {
      if (this._nodes[id] && this._nodes[id].last + this.options.timeout < Date.now()) {
        // Increment the vote count.
        if (this._nodes[id].voters.indexOf(this._id) < 0) {
          this._nodes[id].voters.push(this._id);

          // Send the vote to the other peers that this one is down.
          this.send('vote', {candidate: id});
          this.checkBallots(id);
        }
      }
    });

    return this;
  }

  /**
   * Subscribe to a channel to listen for events from other nodes.
   * @param  {String} channel Channel name (can't be 'hello', 'vote', 'leader', or 'subscribe').
   * @return {Democracy}
   */
  subscribe(channel) {
    // Add the channel to this node.
    this.options.channels.push(channel);

    // Broadcast to the other nodes that this one has subscribed.
    this.send('subscribe', {channel});

    return this;
  }

  /**
   * Publish a message to any nodes that are subscribed to the passed channel.
   * @param  {String} channel Channel to publish to.
   * @param  {Mixed} msg     Data to send.
   * @return {Democracy}
   */
  publish(channel, msg) {
    // Loop through all nodes and send the message to ones that are subscribed.
    Object.keys(this._nodes).forEach((id) => {
      if (this._nodes[id] && this._nodes[id].channels.includes(channel)) {
        this.send(channel, msg, id);
      }
    });

    return this;
  }

  /**
   * Add a new node's data to the list (internal method).
   * @param {data} data Node data to setup.
   * @return {Democracy}
   */
  addNodeToList(data) {
    // Add the node to the list.
    this._nodes[data.id] = {
      id: data.id,
      source: data.source,
      weight: data.weight,
      state: data.state,
      last: Date.now(),
      voters: [],
      channels: data.channels || [],
    };

    // Emit that this node has been added.
    this.emit('added', this._nodes[data.id]);

    return this;
  }

  /**
   * Process events that are received over the network.
   * @param  {Object} msg Data received.
   * @return {Democracy}
   */
  processEvent(msg) {
    const data = this.decodeMsg(msg);

    if (!data || data.id === this._id) {
      return this;
    }

    // Process the different available events.
    if (data.event === 'hello') {
      // Create a new node if we don't already know about this one.
      if (!this._nodes[data.id]) {
        this.addNodeToList(data);
      } else {
        this._nodes[data.id].last = Date.now();
        this._nodes[data.id].state = data.state;
        this._nodes[data.id].weight = data.weight;
      }

      // Reset the voters since we've now seen this node again.
      this._nodes[data.id].voters = [];

      // If we are both leaders, hold a runoff to determine the winner...hanging chads and all.
      if (this._state === 'leader' && data.state === 'leader') {
        this.holdElections();
      }

      // If we now have no leader, hold a new election.
      if (this._hadElection && !this.leader()) {
        this.holdElections();
      }

      // We have had an election somewhere if we have a leader.
      if (this.leader()) {
        this._hadElection = true;
      }
    } else if (data.event === 'vote') {
      if (this._nodes[data.candidate] && this._nodes[data.candidate].voters.indexOf(data.id) < 0) {
        // Tally this vote.
        this._nodes[data.candidate].voters.push(data.id);

        // Process the ballots to see if this node should be removed and a new leader selected.
        this.checkBallots(data.candidate);
      }
    } else if (data.event === 'leader') {
      if (!this._nodes[data.id]) {
        this.addNodeToList(data);
      } else {
        this._nodes[data.id].state = 'leader';
      }

      this.emit('leader', this._nodes[data.id]);
    } else if (data.event === 'subscribe') {
      if (!this._nodes[data.id]) {
        this.addNodeToList(data);
      } else {
        this._nodes[data.id].channels.push(data.channel);
      }
    } else {
      // Handle custom messaging between nodes.
      this.emit(data.event, data.extra);
    }

    return this;
  }

  /**
   * Check if a unanimous decision has been reached by the active nodes.
   * @param  {String} candidate ID of the candidate to be removed.
   * @return {Democracy}
   */
  checkBallots(candidate) {
    const node = this._nodes[candidate];
    const {state} = node;
    let numVoters = 0;

    // Count the number of voters that haven't been marked for election.
    for (let i = 0; i < this._nodes.length; i += 1) {
      if (this._nodes[i] && !this._nodes[i].voters.length) {
        numVoters += 1;
      }
    }

    // If we have concensus, remove this node from the list.
    if (node.voters.length >= numVoters) {
      this.emit('removed', this._nodes[candidate]);
      this._nodes[candidate] = null;
    }

    if (state === 'leader') {
      this.holdElections();
    }

    return this;
  }

  /**
   * Hold an election for a new leader.
   * @return {Democracy}
   */
  holdElections() {
    const nodes = this.nodes();
    let highestWeight = 0;
    let newLeader;

    // Elect a new leader based on highest weight.
    // Each server should always elect the same leader.
    Object.keys(nodes).forEach((id) => {
      if (nodes[id] && nodes[id].weight > highestWeight) {
        highestWeight = nodes[id].weight;
        newLeader = id;
      }
    });

    // If we are currently the leader, but not the "new leader", we lose the runoff and resign.
    if (this._state === 'leader' && newLeader && newLeader !== this._id) {
      this.resign();
    }

    // Elect our new benevolent dictator for life...of process.
    if (newLeader === this._id || !newLeader) {
      this._state = 'leader';
      nodes[newLeader].state = 'leader';
      this.emit('elected', nodes[newLeader]);
      this.send('leader');
    } else {
      this._nodes[newLeader].state = 'leader';
    }

    this._hadElection = true;

    return this;
  }

  /**
   * Resign as leader and fly into the sunset disgraced.
   * Calling this directly on the current leader will prompt a new election,
   * which could result in this same node becoming leader again (as is the way of the world).
   * @return {Democracy}
   */
  resign() {
    const nodes = this.nodes();

    if (this._state === 'leader') {
      this._state = 'citizen';
      this.emit('resigned', nodes[this._id]);
      this.send('hello');
    }

    return this;
  }

  /**
   * Get the list of current nodes, including this one.
   * @return {Object} All nodes.
   */
  nodes() {
    // Add this server into the nodes list.
    const nodes = JSON.parse(JSON.stringify(this._nodes));
    nodes[this._id] = {
      id: this._id,
      weight: this._weight,
      state: this._state,
      channels: this.options.channels,
    };

    return nodes;
  }

  /**
   * Find our current fearless leader.
   * @return {Object} Current leader.
   */
  leader() {
    const nodes = this.nodes();
    let leader = null;

    Object.keys(nodes).forEach((id) => {
      if (nodes[id] && nodes[id].state === 'leader') {
        leader = nodes[id];
      }
    });

    return leader;
  }

  /**
   * Check if the current server is the leader or not.
   * @return {Boolean} True if this is the leader.
   */
  isLeader() {
    const leader = this.leader();

    return leader ? this._id === leader.id : false;
  }

  /**
   * Safely decode a Buffer message received over UDP.
   * @param  {Buffer} msg Received data.
   * @return {Object}     Parsed data.
   */
  decodeMsg(msg) {
    try {
      return JSON.parse(decoder.write(msg));
    } catch (e) {
      return null;
    }
  }
}

module.exports = Democracy;

/**
 * democracy.js
 * Copyright (c) 2016 - 2021, GoldFire Studios, Inc.
 * http://goldfirestudios.com
 */

import {Socket, createSocket} from 'dgram';

import {customAlphabet} from 'nanoid';
import {EventEmitter} from 'events';
import {StringDecoder} from 'string_decoder';
import {
  NodeAddress,
  NodeId,
  NodeState,
  NodeInfo,
  NodeInfoMap,
  NodeAddressTuple,
  DemocracyOptions,
  DemocracyDefaultedOptions,
  SendExtra,
  MsgData,
  NodeInfoMsg,
  HelloMsg,
  VoteMsg,
  LeaderMsg,
  SubscribeMsg,
  CustomMsg,
  ChunkMsg,
} from './types';

// Create the string decoder.
const decoder = new StringDecoder('utf8');

const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyz', 10);

/**
 * Setup the base Democracy class that handles all of the methods.
 */
class Democracy extends EventEmitter {
  private _democracy_node_state: 'stopped' | 'starting' | 'started' | 'stopping';

  private _nodes: NodeInfoMap;

  private _helloTimer: ReturnType<typeof setInterval> | null;

  private _id: NodeId;

  private _weight: number;

  private _state: NodeState;

  private _chunks: { [msg_id: string]: Array<any> };

  private _hadElection: boolean;

  options: DemocracyDefaultedOptions;

  socket: Socket | null;

  /**
   * Initialize a new democracy with the given options.
   * @param  {DemocracyOptions} options User-defined options.
   */
  constructor(options: DemocracyOptions = {}) {
    super();

    this._nodes = {};
    this._chunks = {};
    this._hadElection = false;
    // Set by this.hello() so that the setInterval can be cancelled by this.stop()
    this._helloTimer = null;

    // Remove the source from the peers.
    const sourceIndex = options.peers.indexOf(options.source);
    if (sourceIndex >= 0) {
      options.peers.splice(sourceIndex, 1);
    }

    // Merge the passed options with the defaults.
    this.options = {
      interval: options.interval ?? 1000,
      timeout: options.timeout ?? 3000,
      maxPacketSize: options.maxPacketSize ?? 508,
      source: this._parseAddress(options.source ?? '0.0.0.0:12345'),
      peers: (options.peers ?? []).map((a) => this._parseAddress(a)),
      weight: options.weight ?? Math.random() * Date.now(),
      id: options.id ?? nanoid(),
      channels: options.channels ?? [],
      enableStrictWeightMode: options.enableStrictWeightMode ?? false,
      autoStart: options.autoStart ?? true,
    };

    // Generate the details about this node to be sent between nodes.
    this._id = this.options.id;
    this._weight = this.options.weight;
    this._state = 'citizen';
    this._democracy_node_state = 'stopped';

    if (this.options.autoStart) {
      this.start();
    }
  }

  // Format addresses in a way that's more convenient later
  private _parseAddress(address: NodeAddress): NodeAddressTuple {
    const parts: Array<string> = address.split(':');
    return [parts[0], Number(parts[1])];
  }

  /**
   * Start the democratic process by binding to the UDP port and holding the first election.
   * @return {Democracy}
   */
  start(): this {
    const setup = () => {
      // Setup the UDP socket to listen on.
      this.socket = createSocket({type: 'udp4', reuseAddr: true});

      // Handle for DNS resolution failures.
      this.socket.on('error', (err) => {
        if ('code' in err && err.code === 'ENOTFOUND') {
          // Intentionally swallow DNS resolution failures. This is a common requirement in
          // K8s environments where headless services are used and DNS resolution is not available
          // for pods until after said pods are running and healthy.
        } else {
          throw err;
        }
      });

      // Bind to the UDP port and begin listeneing for hello, etc messages.
      this.socket.bind(this.options.source[1], this.options.source[0], () => {
      // Listen for messages on this port.
        this.socket.on('message', (msg) => {
          this._processEvent(msg);
        });

        // Start sending 'hello' messages to the other nodes.
        this._hello();
      });

      // Run an election after two intervals if we still don't have a leader.
      setTimeout(() => {
        // Check if we have a leader.
        const leader = this.leader();

        // If autoStart is off, the node may not be started when this handler runs.
        // In this scenario, holding an election will result in the node believing it is the leader.
        // This is undesirable because it isn't considered part of the cluster yet.
        if (this._democracy_node_state === 'started'
            && (!leader || (this.options.enableStrictWeightMode && leader.weight < this._weight))
        ) {
          this._holdElections();
        }
      }, this.options.interval * 2);

      this._democracy_node_state = 'started';
      this.emit('started');
    };

    if (this._democracy_node_state === 'stopping') {
      this._democracy_node_state = 'starting';
      // If the node is still shutting down, we wait for it to complete to avoid race conditions
      this.once('stopped', setup);
    } else if (this._democracy_node_state === 'stopped') {
      this._democracy_node_state = 'starting';
      setup();
    }

    return this;
  }

  /**
   * Start the democratic process by binding to the UDP port and holding the first election.
   * @return {Democracy}
   */
  stop(): this {
    const teardown = () => {
      // We don't want to keep attempting to send heartbeats if the socket is closed.
      clearInterval(this._helloTimer);
      this._helloTimer = null;

      this.socket.close(() => {
        this.socket = null;

        // Reset relevant states back to initial values
        this._nodes = {};
        this._hadElection = false;
        this._state = 'citizen';
        this._chunks = {};

        this._democracy_node_state = 'stopped';
        this.emit('stopped');
      });
    };

    if (this._democracy_node_state === 'starting') {
      this._democracy_node_state = 'stopping';
      // If the node is still starting up, we wait for it to complete to avoid race conditions
      this.once('started', teardown);
    } else if (this._democracy_node_state === 'started') {
      this._democracy_node_state = 'stopping';
      teardown();
    }

    return this;
  }

  /**
   * Run the `hello` interval to send out the heartbeats.
   * @return {Democracy}
   */
  private _hello(): this {
    // Send a hello message and then check the other nodes.
    const sendHello = () => {
      this.send('hello');
      this._check();
    };

    // Schedule hello messages on the specified interval.
    this._helloTimer = setInterval(sendHello, this.options.interval);

    // Immediately send the first hello message.
    sendHello();

    return this;
  }

  /**
   * Send a message to the other peers.
   * @param  {String} event 'hello', 'vote', etc.
   * @param  {Object} extra Other data to send.
   * @param  {NodeId} Optionally specify a specific recipient by node id
   * @return {Democracy}
   */
  send(event: string, extra?: SendExtra, id?: NodeId): this {
    type Payload = {
      event: string,
      id: NodeId,
      source: NodeAddress
      candidate?: string,
      weight?: number,
      state?: NodeState,
      channels?: Array<string>,
      extra?: SendExtra
    };
    const data: Payload = {
      event,
      id: this._id,
      source: `${this.options.source[0]}:${this.options.source[1]}`,
    };

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

    // Adjust the max size by the max size of the chunk wrapper data.
    const maxSize = this.options.maxPacketSize;
    const chunkSize = maxSize - 52;

    // Check if the packet needs to be chunked.
    const str = JSON.stringify(data);
    let chunks = [];
    if (str.length > maxSize) {
      const count = Math.ceil(str.length / chunkSize);
      const packetId = nanoid();

      for (let i = 0; i < count; i += 1) {
        chunks.push(JSON.stringify({
          chunk: str.substr(i * chunkSize, chunkSize),
          id: packetId,
          c: count,
          i,
        }));
      }
    } else {
      chunks.push(str);
    }

    // Data must be sent as a Buffer over the UDP socket.
    chunks = chunks.map((chunk) => Buffer.from(chunk));

    // Loop through each connect node and send the packet over.
    for (let x = 0; x < chunks.length; x += 1) {
      for (let i = 0; i < this.options.peers.length; i += 1) {
        if (!id || this._nodes[id].source === `${this.options.peers[i][0]}:${this.options.peers[i][1]}`) {
          this.socket?.send(chunks[x], 0, chunks[x].length, this.options.peers[i][1], this.options.peers[i][0]);
        }
      }
    }

    return this;
  }

  /**
   * After sending a `hello`, check if any of the other nodes are down.
   * @return {Democracy}
   */
  private _check(): this {
    Object.keys(this._nodes).forEach((id) => {
      if (this._nodes[id] && this._nodes[id].last + this.options.timeout < Date.now()) {
        // Increment the vote count.
        if (this._nodes[id].voters.indexOf(this._id) < 0) {
          this._nodes[id].voters.push(this._id);

          // Send the vote to the other peers that this one is down.
          this.send('vote', {candidate: id});
          this._checkBallots(id);
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
  subscribe(channel: string): this {
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
  publish(channel: string, msg: any): this {
    // Loop through all nodes and send the message to ones that are subscribed.
    const ids = Object.keys(this._nodes);
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      if (this._nodes[id] && this._nodes[id].channels.includes(channel)) {
        this.send(channel, msg, id);
      }
    }

    return this;
  }

  /**
   * Add a new node's data to the internal node list
   * @param {data} data Node data to setup.
   * @return {Democracy}
   */
  private _addNodeToList(data: NodeInfoMsg): this {
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

    // Add this to the peers list.
    const source = this._parseAddress(data.source);
    const index = this.options.peers.findIndex((p) => p[0] === source[0] && p[1] === source[1]);
    if (index < 0) {
      this.options.peers.push(source);
    }

    // Emit that this node has been added.
    this.emit('added', this._nodes[data.id]);

    return this;
  }

  /**
   * Process events that are received over the network.
   * @param  {Object} msg Data received.
   * @return {Democracy}
   */
  private _processEvent(msg: Buffer): this {
    const parsedMsg: MsgData = this.decodeMsg(msg);

    // Noop if empty payload, invalid msg, or this node sent it
    if (!parsedMsg || parsedMsg.id === this._id || !('event' in parsedMsg || 'chunk' in parsedMsg)) {
      return this;
    }

    const msgType = (function getMsgType() {
      if ('chunk' in parsedMsg) return 'chunk';
      if (['vote', 'hello', 'leader', 'subscribe'].includes(parsedMsg.event)) return parsedMsg.event;
      return 'custom';
    }());

    // If this msg is part of a chunk, we'll store it. Once we have all the chunks we piece them together and recurse
    if (msgType === 'chunk') {
      const data = parsedMsg as ChunkMsg;
      // Add the chunk to the buffer.
      this._chunks[data.id] = this._chunks[data.id] || [];
      this._chunks[data.id].push(data);

      // If the buffer is full, combine and process.
      if (this._chunks[data.id].length === data.c) {
        // Sort the chunks by index.
        this._chunks[data.id].sort((a, b) => {
          if (a.i < b.i) {
            return -1;
          }
          if (a.i > b.i) {
            return 1;
          }

          return 0;
        });

        // Merge the data into a single string.
        const newData = this._chunks[data.id].reduce((acc, val) => acc + val.chunk, '');
        delete this._chunks[data.id];

        // Process the data as a buffer.
        this._processEvent(Buffer.from(newData));
      }

      return this;
    }

    // No longer mark this node as removed.
    if (this._nodes[parsedMsg.id] && this._nodes[parsedMsg.id].disconnected) {
      clearTimeout(this._nodes[parsedMsg.id].disconnected);
      delete this._nodes[parsedMsg.id].disconnected;
    }

    // Process the different available events.
    if (msgType === 'hello') {
      const data = parsedMsg as HelloMsg;
      // Create a new node if we don't already know about this one.
      if (!this._nodes[data.id]) {
        this._addNodeToList(data);
      } else {
        const revived = this._nodes[data.id].state === 'removed' && data.state !== 'removed';
        this._nodes[data.id].last = Date.now();
        this._nodes[data.id].state = data.state;
        this._nodes[data.id].weight = data.weight;

        if (revived) {
          this.emit('added', this._nodes[data.id]);
        }
      }

      // Reset the voters since we've now seen this node again.
      this._nodes[data.id].voters = [];

      // If we are both leaders, hold a runoff to determine the winner...hanging chads and all.
      if (this.isLeader() && data.state === 'leader') {
        this._holdElections();
      }

      // If we now have no leader, hold a new election.
      if (this._hadElection && !this.leader()) {
        this._holdElections();
      }

      // We have had an election somewhere if we have a leader.
      if (this.leader()) {
        this._hadElection = true;
      }
    } else if (msgType === 'vote') {
      const data = parsedMsg as VoteMsg;
      if (this._nodes[data.candidate] && this._nodes[data.candidate].voters.indexOf(data.id) < 0) {
        // Tally this vote.
        this._nodes[data.candidate].voters.push(data.id);

        // Process the ballots to see if this node should be removed and a new leader selected.
        this._checkBallots(data.candidate);
      }
    } else if (msgType === 'leader') {
      const data = parsedMsg as LeaderMsg;
      if (!this._nodes[data.id]) {
        this._addNodeToList(data);
      } else {
        this._nodes[data.id].state = 'leader';

        // If notified of election results while thinking we're the leader,
        // resolve it immediately instead of waiting for the next hello msg from the other leader
        if (this.isLeader() || (this.options.enableStrictWeightMode && this._weight > this._nodes[data.id].weight)) {
          this._holdElections();
        }
      }

      this.emit('leader', this._nodes[data.id]);
    } else if (msgType === 'subscribe') {
      const data = parsedMsg as SubscribeMsg;
      if (!this._nodes[data.id]) {
        this._addNodeToList(data);
      } else {
        this._nodes[data.id].channels.push(data.extra.channel);
      }
    } else if (msgType === 'custom') {
      // Handle custom messaging between nodes.
      const data = parsedMsg as CustomMsg;
      this.emit(data.event, data.extra);
    }

    return this;
  }

  /**
   * Check if the decision to remove a node has been made unanimously by the active, healthy nodes.
   * @param  {String} candidate ID of the candidate to be removed.
   * @return {Democracy}
   */
  private _checkBallots(candidate): this {
    const node = this._nodes[candidate];
    const {state} = node;
    let numVoters = 0; // This is the number of votes we need to achieve consensus

    // Count how many nodes are healthy
    for (let i = 0; i < Object.keys(this._nodes).length; i += 1) {
      if (this._nodes[i] && !this._nodes[i].voters.length) {
        numVoters += 1;
      }
    }

    // If we have concensus, remove this node from the list.
    if (node.voters.length >= numVoters) {
      this.emit('removed', node);

      // Make sure we don't setup multiple timeouts.
      if (this._nodes[candidate].disconnected) {
        clearTimeout(this._nodes[candidate].disconnected);
      }

      // Mark the node as removed (to be removed later).
      this._nodes[candidate].state = 'removed';
      this._nodes[candidate].disconnected = setTimeout(() => {
        if (this._nodes[candidate].state !== 'removed') {
          return;
        }

        // Remove from the nodes/peers.
        const source = this._parseAddress(node.source);
        const index = this.options.peers.findIndex((p) => p[0] === source[0] && p[1] === source[1]);
        if (index >= 0) {
          this.options.peers.splice(index, 1);
        }
        this._nodes[candidate] = null;
      }, 3600000);
    }

    if (state === 'leader') {
      this._holdElections();
    }

    return this;
  }

  /**
   * Hold an election for a new leader.
   * @return {Democracy}
   */
  private _holdElections(): this {
    const nodes = this.nodes();
    let highestWeight = 0;
    let newLeader;

    // Elect a new leader based on highest weight.
    // Each server should always elect the same leader (assuming no network partitions)
    Object.keys(nodes).forEach((id) => {
      if (nodes[id] && nodes[id].weight > highestWeight && nodes[id].state !== 'removed') {
        highestWeight = nodes[id].weight;
        newLeader = id;

        // We could set all the node states to 'citizen' here, but this would cause the _nodes registry to diverge from the server's reported values.
        // The state values will update with the next hello message received from other servers.
      }
    });

    // If we are currently the leader, but not the "new leader", we lose the runoff and resign.
    if (this.isLeader() && newLeader && newLeader !== this._id) {
      this.resign();
    }

    // Elect our new benevolent dictator for life...of process
    // (unless enableStrictWeightMode=true and a new node with higher weight joins)
    if (newLeader === this._id) {
      if (this._state !== 'leader') {
        this._state = 'leader';
        nodes[newLeader].state = 'leader';
        this.emit('elected', nodes[newLeader]);
      }
      this.send('leader');
    } else if (newLeader) {
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
  resign(): this {
    const nodes = this.nodes();

    if (this.isLeader()) {
      this._state = 'citizen';
      this.emit('resigned', nodes[this._id]);
      this.send('hello');
    }

    return this;
  }

  /**
   * Get the list of current nodes, including this one.
   * @return {NodeInfoMap} All nodes.
   */
  nodes(): NodeInfoMap {
    const nodes = {};

    // Copy the nodes data to return.
    Object.keys(this._nodes).forEach((id) => {
      const node = this._nodes[id];

      if (node) {
        nodes[node.id] = {
          id: node.id,
          weight: node.weight,
          state: node.state,
          last: node.last,
          voters: node.voters,
          channels: node.channels,
        };
      }
    });

    // Add this server into the nodes list.
    nodes[this._id] = {
      id: this._id,
      weight: this._weight,
      state: this._state,
      channels: this.options.channels,
      voters: [],
      source: this.options.source,
    };

    return nodes;
  }

  /**
   * Find our current fearless leader.
   * @return {NodeInfo} Current leader.
   */
  leader(): NodeInfo {
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
  isLeader(): boolean {
    return this._state === 'leader';
  }

  /**
   * Safely decode a Buffer message received over UDP.
   * @param  {Buffer} msg Received data.
   * @return {any}     Parsed data.
   */
  decodeMsg(msg: Buffer): any {
    try {
      return JSON.parse(decoder.write(msg));
    } catch (e) {
      return null;
    }
  }
}

export default Democracy;

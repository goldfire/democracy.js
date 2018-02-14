## Description
In-process monitoring of distributed Node.js instances over UDP unicast. Simply require democracy in each instance and provide the IP/port for other peers and the rest is taken care of automatically. democracy.js will get the configuration from the other nodes, elect a leader and keep them all in sync. If the active leader becomes unresponsive, the other instances will elect a new leader.

## Installation
```
npm install democracy
```

## Examples
The below example is easy to run on your local machine (also found in the examples directory). The IP's can just as easily be swapped out for IP's of other servers/instances.

```javascript
var Democracy = require('democracy');

// Basic usage of democracy to manager leader and citizen nodes.
var dem = new Democracy({
  source: '0.0.0.0:12345',
  peers: ['0.0.0.0:12345', '0.0.0.0:12346', '0.0.0.0:12347'],
});

dem.on('added', (data) => {
  console.log('Added: ', data);
});

dem.on('removed', (data) => {
  console.log('Removed: ', data);
});

dem.on('elected', (data) => {
  console.log('You have been elected leader!');
});

// Support for custom events.
dem.on('ciao', (data) => {
  console.log(data.hello); // Logs 'world'
});

dem.send('ciao', {hello: 'world'});

// Support for basic pub/sub.
dem.on('my-channel', (data) => {
  console.log(data.hello); // Logs 'world'
});

dem.subscribe('my-channel');
dem.publish('my-channel', {hello: 'world'});

```

## API
### Constructor
```javascript
new Democracy({
  interval: 1000, // The interval (ms) at which `hello` heartbeats are sent to the other peers.
  timeout: 3000, // How long a peer must go without sending a `hello` to be considered down.
  source: '0.0.0.0:12345', // The IP and port to listen to (usually the local IP).
  peers: [], // The other servers/ports you want to communicate with (can be on the same or different server).
  weight: Math.random() * Date.now(), // The highest weight is used to determine the new leader. Must be unique for each node.
  id: 'uuid', // (optional) This is generated automatically with uuid, but can optionally be set. Must be unique for each node.
  channels: [], // (optional) Array of channels for this node to listen to (for pub/sub).
});
```

### Methods
#### nodes()
Returns the object containing all active nodes and their properties (including the one the method is called from).
#### leader()
Returns the current leader node from the cluster.
#### isLeader()
Returns whether or not the current server is the leader.
#### resign()
If called on the current leader node, will force it to resign as the leader. A new election will be held, which means the same node could be re-elected.
#### send(customEvent, data)
Sends a custom event to all other nodes.
#### subscribe(channel)
Subscribe to a channel for use with pub/sub.
#### publish(channel, data)
Publish to a channel and send specific data with pub/sub.

### Events
All events return the data/configuration of the affected node as their first parameter.

#### added
Fired when a new peer has been found.
#### removed
Fired when a peer has gone down and subsequently been removed from the list.
#### leader
Fired when a new leader is selected.
#### elected
Fired on the server that has become the new leader.
#### resigned
Fired on the server that has resigned as the leader.
#### custom/all other events
Fired on all the server except the one that "sent" the event.

## License
Copyright (c) 2016 - 2018 James Simpson and GoldFire Studios, Inc.

Released under the MIT License.

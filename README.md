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

var dem = new Democracy({
  source: '0.0.0.0:12345',
  peers: ['0.0.0.0:12345', '0.0.0.0:12346', '0.0.0.0:12347']
});

dem.on('added', function(data) {
  console.log('Added: ', data);
});

dem.on('removed', function(data) {
  console.log('Removed: ', data);
});

dem.on('elected', function(data) {
  console.log('You have been elected leader!');
});

dem.on('ciao', function(data) {
    console.log("ciao from %s", data.id, data.extra)
});

dem.send("ciao", { hello: "world"});

```

## API
### Constructor
```javascript
new Democracy({
  interval: 1000, // The interval (ms) at which `hello` heartbeats are sent to the other peers.
  timeout: 3000, // How long a peer must go without sending a `hello` to be considered down.
  source: '0.0.0.0:12345', // The IP and port to listen to (usually the local IP).
  peers: [], // The other servers/ports you want to communicate with (can be on the same or different server).
  weight: Math.random() * Date.now() // The highest weight is used to determine the new leader. Must be unique for each node.
});
```

### Methods
#### nodes()
Returns the object containing all active nodes and their properties (including the one the method is called from).
#### leader()
Returns the current leader node from the cluster.
#### resign()
If called on the current leader node, will force it to resign as the leader. A new election will be held, which means the same node could be re-elected.

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
Copyright (c) 2016 James Simpson and GoldFire Studios, Inc.

Released under the MIT License.

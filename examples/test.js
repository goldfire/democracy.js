/**
 * Basic example usage of democracy.js
 *
 * Test on your local machine by running three instances of this test script,
 * with the parameter being the port. You can then test it by killing the leader
 * process to see the re-election happen between the remaining two.
 *
 * node test.js 12345
 * node test.js 12346
 * node test.js 12347
 *
 * Alternatively, you may use the "npm run dev" script to run 3 nodes concurrently
 */

var { default: Democracy } = require('../')

var dem = new Democracy({
  source: '0.0.0.0:' + process.argv[2],
  peers: ['0.0.0.0:12345', '0.0.0.0:12346', '0.0.0.0:12347', 'unable-to-resolve.example.com:12348'],
  weight: Number(process.argv[2]),
  id: process.argv[2],
  enableStrictWeightMode: true,
  autoStart: false,
});

dem.on('added', function(data) {
  console.log('Added: ', data.id);
});

dem.on('removed', function(data) {
  console.log('Removed: ', { id: data.id, voters: data.voters });
});

dem.on('elected', function(data) {
  console.log('You are elected leader!');
});

dem.on('leader', function(data) {
  console.log('New Leader: ', data.id);
});

dem.on('started', function() {
  console.log('Started!');
  setTimeout(() => dem.stop(), Math.random() * 90 * 1000)
});

dem.on('stopped', function() {
  console.log('Stopped!!');
  setTimeout(() => dem.start(), Math.random() * 30 * 1000)
});

// (Duplicate calls and rapid toggling do not cause issues)
dem.start();
dem.stop();
dem.stop();
dem.start();
dem.start();

setInterval(() => {
  console.log({
    leader: dem.leader() && dem.leader().id,
    nodes: Object.values(dem.nodes()).map(a => a.id),
  });
}, 5000);

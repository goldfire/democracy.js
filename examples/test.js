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
 */

var Democracy = require('democracy');

var dem = new Democracy({
  source: '0.0.0.0:' + process.argv[2],
  peers: ['0.0.0.0:12345', '0.0.0.0:12346', '0.0.0.0:12347']
});

dem.on('added', function(data) {
  console.log('Added: ', data);
});

dem.on('removed', function(data) {
  console.log('Removed: ', data);
});

dem.on('elected', function(data) {
  console.log('You are elected leader!');
});

dem.on('leader', function(data) {
  console.log('New Leader: ', data);
});

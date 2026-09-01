const net = require('node:net');

const serverPrototype = net.Server.prototype;
const originalListen = serverPrototype.listen;

serverPrototype.listen = function listenWithLocalHost(...args) {
  if (typeof args[0] === 'number') {
    if (args.length === 1 || args[1] === undefined || args[1] === null) args[1] = '127.0.0.1';
  } else if (args[0] && typeof args[0] === 'object' && !('host' in args[0])) {
    args[0] = { ...args[0], host: '127.0.0.1' };
  }
  return originalListen.apply(this, args);
};

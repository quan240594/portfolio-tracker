import { createNodeStack } from './node-stack.js';
import { defineLogoSuite } from './logos-suite.js';
import { defineAppSuite } from './suite.js';
import { defineEarningsSuite } from './earnings-suite.js';

const start = (options?: Parameters<typeof createNodeStack>[0]) => createNodeStack({ limits: options?.limits, prices: options?.prices, logos: options?.logos, noVapid: options?.noVapid, earnings: options?.earnings });

defineAppSuite('Node (real Worker and Hub, SQLite in WebAssembly)', start);
defineLogoSuite('Node (real Worker and Hub, SQLite in WebAssembly)', start);
defineEarningsSuite('Node (real Worker and Hub, SQLite in WebAssembly)', start);

import { createNodeStack } from './node-stack.js';
import { defineLogoSuite } from './logos-suite.js';
import { defineAppSuite } from './suite.js';

const start = (options?: Parameters<typeof createNodeStack>[0]) => createNodeStack({ limits: options?.limits, prices: options?.prices, logos: options?.logos });

defineAppSuite('Node (real Worker and Hub, SQLite in WebAssembly)', start);
defineLogoSuite('Node (real Worker and Hub, SQLite in WebAssembly)', start);

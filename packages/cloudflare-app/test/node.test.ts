import { createNodeStack } from './node-stack.js';
import { defineAppSuite } from './suite.js';

defineAppSuite('Node (real Worker and Hub, SQLite in WebAssembly)', (options) => createNodeStack({ limits: options?.limits }));

// The tests never reach a real network: outbound calls go through the fakes (an injected fetch in Node, Miniflare's
// `outboundService` in workerd). Anything that falls through to the global fetch is a bug in a test, not a request to make.
globalThis.fetch = () => Promise.reject(new Error('Tests must not use the real network'));

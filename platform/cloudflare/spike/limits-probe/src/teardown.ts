// Replacement Worker used only by `wrangler deploy -c wrangler.teardown.toml`: it ships no Durable Object class, so the
// `deleted_classes` migration can remove the Probe namespace and its data. It is deleted right afterwards.
export default {
  fetch(): Response {
    return new Response('probe torn down', { status: 410 });
  },
};

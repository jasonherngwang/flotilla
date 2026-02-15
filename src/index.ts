export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const stub = env.CLUSTER_MANAGER.getByName('singleton');
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export { RaftNode } from './raft/node';
export { ClusterManager } from './cluster/manager';

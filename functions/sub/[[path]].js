import { handle } from '../../lib/server.js';

export function onRequest(context) {
  return handle(context, context.env.LIVE_KV);
}

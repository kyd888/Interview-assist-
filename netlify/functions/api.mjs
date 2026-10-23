import { createHostedAPI } from '../../lib/hosted-api.mjs';

export default request => createHostedAPI({ env: process.env })(request);

export const config = {
  path: ['/api/config', '/api/suggest'],
  rateLimit: { action: 'rate_limit', aggregateBy: 'ip', windowSize: 60, windowLimit: 30 }
};

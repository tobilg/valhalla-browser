import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { staticHost, listen, closeHost } from './package-support.js';

test('clearing a CDN outage releases a download already delayed by that outage', async () => {
  const host = staticHost();
  const origin = await listen(host);
  try {
    host.setFault({ match: '/', delayMs: 60000 });
    const received = once(host.server, 'request');
    const response = fetch(origin, { signal: AbortSignal.timeout(5000) });
    await received;
    assert.equal(host.records.length, 1);
    assert.equal(host.records[0].status, 0, 'The original request is still delayed');
    host.setFault(null);
    const result = await response;
    assert.equal(result.status, 200);
    assert.match(await result.text(), /Package consumer/);
    assert.equal(host.records.length, 1, 'Recovery must release the original download');
  } finally { await closeHost(host); }
});

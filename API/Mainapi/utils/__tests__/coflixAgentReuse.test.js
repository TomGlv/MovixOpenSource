'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const { createProxyAgentPool } = require('../proxyAgentPool');
const { createCoflixProxyPolicy } = require('../coflixProxyPolicy');

function fixture(transport, policyOptions) {
  const filename = path.resolve(__dirname, '../proxyManager.js');
  const code = fs.readFileSync(filename, 'utf8');
  const start = code.indexOf('async function makeCoflixRequest(');
  const end = code.indexOf('// Fonction pour faire une requete LecteurVideo', start);
  assert.ok(start > 0 && end > start);
  const agents = [];
  const pool = createProxyAgentPool({ createAgent(key) {
    const agent = { key, destroyed: false, destroy() { this.destroyed = true; } };
    agents.push(agent);
    return agent;
  } });
  const proxies = [{ host: 'proxy.test', port: 8080 }, { host: 'backup.test', port: 8080 }];
  const context = vm.createContext({ coflixHttpAgentPool: pool,
    coflixProxyPolicy: createCoflixProxyPolicy(policyOptions),
    pickProxyscrapeCandidates: (available = () => true) => ({ proxies: proxies.filter(proxy => available(proxy, false)), useSocks: false, totalAvailable: proxies.length }),
    axios: transport,
  });
  vm.runInContext(code.slice(start, end) + '\nglobalThis.request = makeCoflixRequest;', context, { filename });
  return { request: context.request, agents, pool };
}

test('le vrai helper Coflix réutilise son agent sur vingt réponses HTML', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { data: '<html>test</html>' }; });
  for (let i = 0; i < 20; i++) await f.request('https://coflix.example/');
  assert.equal(calls, 20);
  assert.equal(f.agents.length, 1);
  f.pool.clear();
  assert.equal(f.agents[0].destroyed, true);
});

test('la rotation sur HTTP 429 reste active', async () => {
  const used = [];
  const f = fixture(async config => {
    used.push(config.httpsAgent.key);
    if (used.length === 1) throw Object.assign(new Error('limited'), { response: { status: 429 } });
    return { data: 'OK' };
  });
  assert.equal((await f.request('https://coflix.example/')).data, 'OK');
  assert.deepEqual(used, ['http://proxy.test:8080', 'http://backup.test:8080']);
});

test('le bail d’une réponse stream persiste jusqu’à sa fermeture', async () => {
  const stream = new PassThrough();
  const f = fixture(async () => ({ data: stream }));
  await f.request('https://coflix.example/', { responseType: 'stream' });
  f.pool.clear();
  assert.equal(f.agents[0].destroyed, false);
  stream.destroy();
  await new Promise(resolve => stream.once('close', resolve));
  assert.equal(f.agents[0].destroyed, true);
  assert.equal(stream.listenerCount('end'), 0);
});

test('un flux d’erreur HTTP renvoyé à l’appelant conserve aussi son bail', async () => {
  const stream = new PassThrough();
  const error = Object.assign(new Error('missing'), { response: { status: 404, data: stream } });
  const f = fixture(async () => { throw error; });
  await assert.rejects(f.request('https://coflix.example/', { responseType: 'stream' }), value => value === error);
  f.pool.clear();
  assert.equal(f.agents[0].destroyed, false);
  stream.destroy();
  await new Promise(resolve => stream.once('close', resolve));
  assert.equal(f.agents[0].destroyed, true);
});

test('un flux d’erreur abandonné pour réessayer est fermé avant la rotation', async () => {
  const stream = new PassThrough();
  let calls = 0;
  const f = fixture(async () => {
    if (++calls === 1) throw Object.assign(new Error('limited'), { response: { status: 429, data: stream } });
    assert.equal(stream.destroyed, true);
    return { data: 'OK' };
  });
  assert.equal((await f.request('https://coflix.example/')).data, 'OK');
  await new Promise(resolve => setImmediate(resolve));
  f.pool.clear();
  assert.ok(f.agents.every(agent => agent.destroyed));
});

test('le dernier proxy transmet son flux d’erreur encore lisible à l’appelant', async () => {
  const streams = [new PassThrough(), new PassThrough()];
  let calls = 0;
  const f = fixture(async () => {
    throw Object.assign(new Error('blocked'), { response: { status: 403, data: streams[calls++] } });
  });
  await assert.rejects(f.request('https://coflix.example/', { responseType: 'stream' }), error => error.response.data === streams[1]);
  assert.equal(streams[0].destroyed, true);
  assert.equal(streams[1].destroyed, false);
  f.pool.clear();
  assert.equal(f.agents[1].destroyed, false);
  streams[1].destroy();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.agents.every(agent => agent.destroyed));
});

test('un proxy en panne est évité sur les requêtes suivantes puis redevient éligible', async () => {
  let now = 0;
  const used = [];
  const f = fixture(async config => {
    used.push(config.httpsAgent.key);
    if (used.length === 1) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    return { data: 'OK' };
  }, { now: () => now, cooldownMs: 30000 });
  await f.request('https://coflix.example/?s=serie');
  await f.request('https://coflix.example/?s=autre');
  now = 30001;
  await f.request('https://coflix.example/?s=encore');
  assert.deepEqual(used, ['http://proxy.test:8080', 'http://backup.test:8080',
    'http://backup.test:8080', 'http://proxy.test:8080']);
  f.pool.clear();
});

test('la quarantaine de tout le pool ne provoque aucun accès direct au site', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw Object.assign(new Error('blocked'), { response: { status: 403 } }); });
  await assert.rejects(f.request('https://coflix.example/'));
  await assert.rejects(f.request('https://coflix.example/'), { code: 'COFLIX_PROXIES_UNAVAILABLE' });
  assert.equal(calls, 2);
  f.pool.clear();
});

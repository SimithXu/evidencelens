import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const mod=await import('../dist/server/index.js');
if(typeof mod.default?.fetch!=='function')throw Error('Missing Worker fetch');
const origin='https://example.invalid';
const request=(path,headers={},body)=>new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
for(const headers of [{},{'X-EvidenceLens-Session':'invalid'},{'oai-authenticated-user-id':'artifact-smoke-user'}]){
 const response=await mod.default.fetch(request('/api/requests/private-request',headers));
 assert.equal(response.status,400,'Missing/invalid session or forged identity must not access cached results');
}
const alice={'X-EvidenceLens-Session':Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('hex')};
const bob={'X-EvidenceLens-Session':Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('hex')};
for(const headers of [{},alice]){
 const response=await mod.default.fetch(request('/api/status',headers));
 assert.equal(response.status,200);
 const status=await response.json();
 assert.equal(status.mode,'public_test');
 assert.equal(status.authentication.authenticated,false);
 assert.equal(status.authentication.visitor_required,false);
 assert.equal(status.request_cache.scope,headers===alice?'this_worker_isolate_and_browser_session_only':'none');
 assert.equal(status.request_cache.available,headers===alice);
 assert.equal(status.server_instance_id,undefined);
}
for(const path of ['/api/demo','/app.js']){
 const response=await mod.default.fetch(request(path));
 assert.equal(response.status,200,'Bundled route failed: '+path);
}
// Invalid ID fails locally before configuration/provider access, but yields a
// recoverable failure in this session only. This smoke test makes no live calls.
const failed=await mod.default.fetch(request('/api/paypal/read',alice,{dispute_id:'INVALID',request_id:'artifact-private-request'}));
assert.equal(failed.status,400);
assert.equal((await (await mod.default.fetch(request('/api/requests/artifact-private-request',alice))).json()).state,'failed');
assert.equal((await (await mod.default.fetch(request('/api/requests/artifact-private-request',bob))).json()).state,'unknown');
const source=await fs.readFile(new URL('../dist/server/index.js',import.meta.url),'utf8');
if(/^import\s/m.test(source))throw Error('Artifact must be self-contained');
console.log('Single-file Worker validates; public mode, capability rejection/isolation and bundled route smoke checks passed (no live calls).');

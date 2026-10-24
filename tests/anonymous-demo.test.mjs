import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from '../worker/server.js';
const env={AI_PROVIDER:'deepseek',DEEPSEEK_MODEL:'deepseek-flash',DEEPSEEK_API_KEY:'never-disclose',PAYPAL_CLIENT_ID:'never-disclose-id',PAYPAL_CLIENT_SECRET:'never-disclose-secret'};
const req=(path,body,headers={})=>new Request('https://site.example'+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://site.example','Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
const alice={'X-EvidenceLens-Session':'a'.repeat(64)},bob={'X-EvidenceLens-Session':'b'.repeat(64)};
test('public status advertises real integrations without leaking credentials or making calls',async()=>{
 let calls=0;const w=createWorker({fetch:()=>{calls++;throw Error('must never call');}});
 for(const path of ['/','/app.js','/styles.css','/api/demo'])assert.equal((await w.fetch(req(path),env)).status,200);
 const s=await (await w.fetch(req('/api/status'),env)).json();
 assert.equal(s.mode,'public_test');assert.equal(s.ai.configured,true);assert.equal(s.paypal.configured,true);
 assert.equal(s.ai.model,'deepseek-flash');assert.equal(s.request_cache.scope,'none');
 assert.equal(s.authentication.authenticated,false);assert.equal(s.authentication.visitor_required,false);
 assert.equal(s.server_instance_id,undefined);assert.ok(!JSON.stringify(s).includes('never-disclose'));assert.equal(calls,0);
});
test('external work and recovery need an isolation capability, never a forged platform identity',async()=>{
 let calls=0;const w=createWorker({fetch:()=>{calls++;throw Error('must never call');}});
 for(const path of ['/api/paypal/read','/api/ai-review','/api/extract-image','/api/import-image-evidence']){
  assert.equal((await w.fetch(req(path,{consent:true}, {'oai-authenticated-user-id':'alice'}),env)).status,400);
 }
 assert.equal((await w.fetch(req('/api/requests/private-request'),env)).status,400);
 assert.equal((await w.fetch(req('/api/status',undefined,{'X-EvidenceLens-Session':'shared'}),env)).status,400);
 assert.equal(calls,0);
});
test('anonymous deterministic roundtrip works while mutation guards remain',async()=>{const w=createWorker({fetch:()=>{throw Error('must never call');}}),d=await(await w.fetch(req('/api/demo'),env)).json();for(const path of ['/api/analyze','/api/export']){const r=await w.fetch(req(path,{case:d.case,sources:d.sources,claims:d.analysis.claims}),env);assert.equal(r.status,200);if(path==='/api/export')assert.equal((await r.json()).submission_permitted,false);}assert.equal((await w.fetch(req('/api/import-case',{content:'{"dispute_id":"demo"}',name:'demo.json'}),env)).status,200);assert.equal((await w.fetch(req('/api/analyze',{case:d.case,sources:d.sources},{Origin:'https://attacker.example'}),env)).status,403);assert.equal((await w.fetch(req('/api/analyze',{}, {'Content-Type':'text/plain'}),env)).status,415);});

test('anonymous Sandbox read succeeds; same request IDs and status observations stay isolated',async()=>{
 const calls=[];const w=createWorker({fetch:async(url,options)=>{
  calls.push([url,options.method]);
  if(url.endsWith('/v1/oauth2/token'))return Response.json({access_token:'mock-token'});
  assert.equal(url,'https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-TEST123');
  assert.equal(options.method,'GET');return Response.json({dispute_id:'PP-TEST123',reason:'ITEM_NOT_RECEIVED'});
 }});
 const body={dispute_id:'PP-TEST123',request_id:'same-request-id'};
 const a=await w.fetch(req('/api/paypal/read',body,alice),env);assert.equal(a.status,200,await a.clone().text());
 const result=await a.json();assert.equal(result.read_only,true);assert.equal(calls.length,2);
 assert.equal((await (await w.fetch(req('/api/requests/same-request-id',undefined,bob),env)).json()).state,'unknown');
 assert.equal((await (await w.fetch(req('/api/requests/same-request-id',undefined,alice),env)).json()).state,'succeeded');
 for(const h of [bob,{}, {'oai-authenticated-user-id':'alice'}]){
  const s=await (await w.fetch(req('/api/status',undefined,h),env)).json();assert.equal(s.paypal.connection_verified,false);assert.equal(s.paypal.latest_attempt.at,null);
 }
 const status=await (await w.fetch(req('/api/status',undefined,alice),env)).json();assert.equal(status.paypal.connection_verified,true);
 assert.equal((await (await w.fetch(req('/api/paypal/read',body,alice),env)).json()).replayed,true);assert.equal(calls.length,2);
 assert.equal((await w.fetch(req('/api/paypal/read',body,bob),env)).status,200);assert.equal(calls.length,4);
 assert.equal((await w.fetch(req('/api/paypal/read',body,{...alice,Origin:'https://evil.example'}),env)).status,403);assert.equal(calls.length,4);
});
test('public mode adds no payment/refund/submission routes or credential forwarding redirects',async()=>{
 const w=createWorker({fetch:()=>{throw Error('must never call');}});
 for(const path of ['/api/paypal/refund','/api/paypal/pay','/api/submit'])assert.equal((await w.fetch(req(path,{case:{},sources:[]},alice),env)).status,404);
});

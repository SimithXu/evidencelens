import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createAdapters,resolve_citations,request_json,validate_model_review,ai_configuration} from '../worker/adapters.js';
import {import_case,import_evidence} from '../worker/engine.js';
globalThis.crypto??=webcrypto;
const respond=o=>new Response(JSON.stringify(o),{headers:{'Content-Type':'application/json'}});
async function workspace(){const c=await import_case(await readFile(new URL('../fixtures/sandbox-dispute.json',import.meta.url),'utf8'),'sandbox-dispute.json');return [c,await import_evidence(await readFile(new URL('../fixtures/simulated-evidence.json',import.meta.url),'utf8'),'simulated-evidence.json',c)];}
test('codepoint overlapping occurrence and exact structure',()=>{
 assert.deepEqual(resolve_citations([{source_id:'s',quote:'😀a😀',occurrence:1}],new Map([['s',{text:'😀a😀a😀'}]])),[{source_id:'s',quote:'😀a😀',start:2,end:5}]);
 assert.throws(()=>resolve_citations([{source_id:'s',quote:'😀',occurrence:3}],{s:{text:'😀'}}));
 assert.throws(()=>resolve_citations([{source_id:'s',quote:'😀',occurrence:0,start:0}],{s:{text:'😀'}}));
});
test('configuration does not imply verified connection; independent observations',async()=>{
 const env={AI_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'mock-only',DEEPSEEK_MODEL:'explicit-model'};
 const a=createAdapters(env),b=createAdapters(env);assert.equal((await a.status()).ai.configured,true);assert.equal((await b.status()).ai.connection_verified,false);assert.equal(ai_configuration({...env,AI_PROVIDER:'elsewhere'}).provider_key,'unsupported');
 await assert.rejects(a.ai_review({},[],false),/Consent/);assert.equal((await a.status()).ai.latest_attempt.state,'failed');assert.equal((await b.status()).ai.latest_attempt.state,'not_checked');
});
test('remote redirect and oversized stream rejected; errors hide response content',async()=>{
 await assert.rejects(request_json('https://test.invalid',{},async()=>new Response('secret',{status:302,headers:{Location:'https://evil.invalid'}})),/redirect refused/);
 await assert.rejects(request_json('https://test.invalid',{},async()=>new Response('secret',{status:401})),e=>/HTTP 401/.test(e.message)&&!e.message.includes('secret'));
 await assert.rejects(request_json('https://test.invalid',{},async()=>new Response(new Uint8Array(2*1024*1024+1))),/size limit/);
 await assert.rejects(request_json('https://test.invalid',{},async()=>{throw new Error('SECRET');}),e=>!e.message.includes('SECRET')&&e.message.includes('Do not automatically retry'));
});
test('PayPal only sandbox token POST + dispute GET; no retry',async()=>{
 const calls=[];const env={PAYPAL_CLIENT_ID:'mock-client',PAYPAL_CLIENT_SECRET:'mock-secret'};
 const a=createAdapters(env,{fetch:async(url,options)=>{calls.push([url,options]);return calls.length===1?respond({access_token:'mock-token'}):respond({dispute_id:'PP-ABC'});}});
 const result=await a.paypal_dispute('PP-ABC');assert.equal(result.dispute_id,'PP-ABC');assert.equal(calls.length,2);assert.equal(calls[0][0],'https://api-m.sandbox.paypal.com/v1/oauth2/token');assert.equal(calls[0][1].method,'POST');assert.equal(calls[1][1].method,'GET');assert.equal(calls[1][1].redirect,'manual');assert.equal((await a.status()).paypal.connection_verified,true);
 await assert.rejects(a.paypal_dispute('PP-ABC?evil'),/valid PayPal/);assert.equal(calls.length,2);assert.equal((await a.status()).paypal.connection_verified,false);
});
test('AI opt-in sends fixed Responses endpoint, preserves all adverse full citations',async()=>{
 const [c,s]=await workspace();const model={claims:s.filter(x=>['buyer_nonreceipt','partial_delivery'].includes(x.assertion)).map(x=>({text:'The imported source states: “'+x.text+'”',citations:[{source_id:x.source_id,quote:x.text,occurrence:0}]})),contradictions:[],gaps:[],warnings:['Mock review only.']};
 const requests=[];const adapter=createAdapters({AI_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'mock',DEEPSEEK_MODEL:'explicit-model'},{fetch:async(url,options)=>{requests.push([url,options]);return respond({id:'mock-response',status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(model)}]}]});}});
 const result=await adapter.ai_review(c,s,true);assert.equal(requests.length,1);assert.equal(requests[0][0],'https://api.deepseek.com/responses');assert.equal(JSON.parse(requests[0][1].body).store,false);assert.equal(result.provider_key,'deepseek');assert.equal(result.claims.length,model.claims.length);assert.equal(result.claims[0].status,'needs_review');assert.equal((await adapter.status()).ai.connection_verified,true);
 await assert.rejects(validate_model_review({...model,claims:[]},c,s),/adverse/);
});
test('duplicate upstream keys and nonfinite JSON never silently accepted',async()=>{
 await assert.rejects(request_json('https://test.invalid',{},async()=>new Response('{"id":"first","id":"second"}')),/invalid JSON/);
 await assert.rejects(request_json('https://test.invalid',{},async()=>new Response('{"n":1e999}')),/invalid JSON/);
});
test('PayPal response mismatch is unverified and never retried',async()=>{
 let calls=0;const adapter=createAdapters({PAYPAL_CLIENT_ID:'mock',PAYPAL_CLIENT_SECRET:'mock'},{fetch:async()=>{calls++;return respond(calls===1?{access_token:'mock'}:{dispute_id:'PP-OTHER'});}});
 await assert.rejects(adapter.paypal_dispute('PP-ABC'),/different or missing/);assert.equal(calls,2);assert.equal((await adapter.status()).paypal.connection_verified,false);
});
test('model missing-evidence flag must actually be boolean',async()=>{
 const c=await import_case('{"dispute_id":"PP-ABC"}','dispute.json');
 await assert.rejects(validate_model_review({claims:[],contradictions:[],gaps:[{title:'Gap',detail:'Check evidence',citations:[{source_id:c.source.source_id,quote:'PP-ABC',occurrence:0}],missing_evidence:null}],warnings:[]},c,[]),/missing evidence/);
});

for(const provider of ['deepseek','openai'])test(`${provider} review preserves output headroom and disables reasoning only for DeepSeek`,async()=>{
 const c=await import_case('{"dispute_id":"PP-ABC"}','dispute.json');
 const env={AI_PROVIDER:provider,[provider==='deepseek'?'DEEPSEEK_API_KEY':'OPENAI_API_KEY']:'mock-only',[provider==='deepseek'?'DEEPSEEK_MODEL':'OPENAI_MODEL']:provider==='deepseek'?'deepseek-flash':'explicit-openai-model'};
 let calls=0;
 const adapter=createAdapters(env,{fetch:async(url,options)=>{
  calls++;const body=JSON.parse(options.body);
  assert.equal(url,provider==='deepseek'?'https://api.deepseek.com/responses':'https://api.openai.com/v1/responses');
  assert.equal(body.model,provider==='deepseek'?'deepseek-flash':'explicit-openai-model');
  assert.equal(body.store,false);assert.equal(body.max_output_tokens,8000);
  assert.equal(body.text.format.strict,true);
  if(provider==='deepseek')assert.deepEqual(body.reasoning,{effort:'none'});
  else assert.equal(Object.hasOwn(body,'reasoning'),false);
  return respond({id:'mock-response',status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify({claims:[],contradictions:[],gaps:[],warnings:[]})}]}]});
 }});
 await adapter.ai_review(c,[],true);assert.equal(calls,1);
});

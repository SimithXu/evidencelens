import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createWorker} from '../worker/server.js';
import {INSTRUCTIONS} from '../worker/adapter-schema.js';
import {import_case,import_evidence} from '../worker/engine.js';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const c=await import_case(read('fixtures/sandbox-dispute.json'),'sandbox-dispute.json');
const sources=await import_evidence(read('fixtures/simulated-evidence.json'),'simulated-evidence.json',c);
const sample=JSON.parse(read('tests/fixtures/attributed-model-review.json'));
const env={AI_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'secret-mock-only',DEEPSEEK_MODEL:'mock-only'};
const request=(body)=>new Request('https://site.example/api/ai-review',{method:'POST',headers:{'X-EvidenceLens-Session':'d'.repeat(64),Origin:'https://site.example','Content-Type':'application/json'},body:JSON.stringify(body)});
const variants=[
 ['fake quote','citation_match',r=>{r.claims[0].citations[0].quote='PRIVATE_FAKE_QUOTE_DO_NOT_ECHO';}],
 ['negative occurrence','citation_index',r=>{r.claims[0].citations[0].occurrence=-1;}],
 ['fractional occurrence','citation_index',r=>{r.claims[0].citations[0].occurrence=0.5;}],
 ['nonexistent occurrence','citation_match',r=>{r.claims[0].citations[0].occurrence=99999;}],
 ['unknown source','citation_source',r=>{r.claims[0].citations[0].source_id='PRIVATE_UNKNOWN_SOURCE';}],
 ['missing adverse','adverse_coverage',r=>{r.claims=[r.claims[0]];r.contradictions=[];r.gaps=[];}],
 ['partial adverse','adverse_coverage',r=>{for(const item of [...r.claims,...r.contradictions,...r.gaps])for(const ref of item.citations){const source=sources.find(s=>s.source_id===ref.source_id);if(['buyer_nonreceipt','partial_delivery'].includes(source?.assertion)){ref.quote=source.text.slice(0,1);ref.occurrence=0;}}}],
 ['missing collection','review_shape',r=>{delete r.gaps;}],
 ['single-source contradiction','contradiction_sources',r=>{r.contradictions[0].citations=[r.contradictions[0].citations[0]];}],
 ['uncited gap','gap_missing_flag',r=>{r.gaps=[{title:'Missing',detail:'Missing',citations:[],missing_evidence:false}];}],
];
for(const [label,code,mutate] of variants)test(`route rejects ${label} with safe diagnosis and no retry`,async()=>{
 const raw=structuredClone(sample);mutate(raw);let calls=0;
 const w=createWorker({fetch:async()=>{calls++;return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(raw)}]}]});}});
 const res=await w.fetch(request({case:c,sources,consent:true,request_id:'diagnostics-'+code}),env);
 assert.equal(res.status,502);const body=await res.text();
 assert.ok(body.includes('['+code+']'),body);assert.match(body,/existing draft was left unchanged/);
 assert.doesNotMatch(body,/PRIVATE_|secret-mock-only/);assert.equal(calls,1);
 for(const source of sources)assert.ok(!body.includes(source.text),'must not echo source text');
 const replay=await w.fetch(request({case:c,sources,consent:true,request_id:'diagnostics-'+code}),env);
 assert.equal(replay.status,502);const replayBody=await replay.json();assert.equal(replayBody.error,JSON.parse(body).error);assert.equal(replayBody.replayed,true);assert.equal(calls,1,'same request replays the failure without another paid call');
});
test('malformed review JSON is diagnosed without echoing provider text',async()=>{
 let calls=0;const w=createWorker({fetch:async()=>{calls++;return Response.json({status:'completed',output:[{content:[{type:'output_text',text:'PRIVATE_PROVIDER_TEXT not JSON'}]}]});}});
 const res=await w.fetch(request({case:c,sources,consent:true,request_id:'diag-bad-json'}),env);
 assert.equal(res.status,502);const body=await res.text();assert.match(body,/\[review_json\]/);assert.doesNotMatch(body,/PRIVATE_PROVIDER_TEXT/);assert.equal(calls,1);
});
test('source tampering still rejects before any provider request',async()=>{
 let calls=0;const w=createWorker({fetch:async()=>{calls++;throw Error('must not call');}});
 const altered=structuredClone(sources);altered[0].text+='tampered';
 const res=await w.fetch(request({case:c,sources:altered,consent:true,request_id:'diag-tamper'}),env);
 assert.notEqual(res.status,200);assert.equal(calls,0);
});
test('concise prompt retains full adverse coverage priority, exact quotations and fixed request budget',async()=>{
 assert.match(INSTRUCTIONS,/5 claims, 2 contradictions, and 3 gaps/);
 assert.match(INSTRUCTIONS,/full adverse-source coverage takes precedence/);
 assert.match(INSTRUCTIONS,/Payment or order status is not proof of delivery/);
 let calls=0;const w=createWorker({fetch:async(url,options)=>{
  calls++;assert.equal(url,'https://api.deepseek.com/responses');const body=JSON.parse(options.body);
  assert.equal(body.model,'mock-only');assert.equal(body.max_output_tokens,8000);assert.equal(body.store,false);
  assert.deepEqual(body.reasoning,{effort:'none'});assert.equal(body.instructions,INSTRUCTIONS);
  return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(sample)}]}]});
 }});
 const res=await w.fetch(request({case:c,sources,consent:true,request_id:'diag-valid'}),env);
 assert.equal(res.status,200);const review=await res.json();assert.equal(review.citation_integrity_verified,true);
 assert.equal(review.semantic_support_verified,false);assert.equal(review.human_review_required,true);assert.equal(calls,1);
});

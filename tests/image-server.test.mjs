import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorker} from '../worker/server.js';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const req=(path,body)=>new Request('https://site.example'+path,{method:body?'POST':'GET',headers:{'X-EvidenceLens-Session':'a'.repeat(64),Origin:'https://site.example','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
const env={AI_PROVIDER:'deepseek',DEEPSEEK_MODEL:'deepseek-flash',DEEPSEEK_API_KEY:'mock-only-key'};
test('image extraction staged; explicit edited admission retains original and export provenance',async()=>{
 let calls=0;const w=createWorker({fetch:async(url,options)=>{calls++;assert.equal(url,'https://api.deepseek.com/responses');const body=JSON.parse(options.body);assert.ok(body.input[0].content.some(c=>c.type==='input_image'&&c.image_url.startsWith('data:image/png;base64,')));return new Response(JSON.stringify({id:'image-response',status:'completed',model:'deepseek-flash',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({text:'Only four delivered'})}]}]}));}});
 const d=await (await w.fetch(req('/api/import-case',{content:'{"dispute_id":"D-image"}',name:'case.json'}),env)).json();const base={case:d.case,sources:[],name:'receipt.png',mime_type:'image/png',image_base64:png};
 assert.equal((await w.fetch(req('/api/extract-image',base),env)).status,400);assert.equal(calls,0);
 const r=await w.fetch(req('/api/extract-image',{...base,consent:true,request_id:'image-request-1'}),env);assert.equal(r.status,200,await r.clone().text());const extraction=await r.json();assert.equal(extraction.sources,undefined);assert.equal(calls,1);
 const unreviewed=await w.fetch(req('/api/import-image-evidence',{...base,extraction,text:'Only 4 delivered 😀',reviewed:false}),env);assert.equal(unreviewed.status,400);
 const admitted=await w.fetch(req('/api/import-image-evidence',{...base,extraction,text:'Only 4 delivered 😀',reviewed:true}),env);assert.equal(admitted.status,200,await admitted.clone().text());const result=await admitted.json();assert.equal(calls,1);assert.equal(result.sources[0].image_provenance.corrected,true);assert.equal(result.sources[0].image_provenance.authenticity_verified,false);
 const raw=JSON.parse(result.sources[0].original_text);assert.equal(raw.image_derivation.image.image_base64,png);assert.equal(raw.image_derivation.transcription.text,'Only four delivered');assert.equal(raw.image_derivation.review.text,'Only 4 delivered 😀');
 const exported=await w.fetch(req('/api/export',{case:d.case,sources:result.sources,claims:result.analysis.claims}),env);assert.equal(exported.status,200);const packet=await exported.json();assert.equal(packet.submission_permitted,false);assert.ok(packet.warnings.some(w=>w.includes('image pixels')));
});
test('image admission strictly preserves explicit synthetic boolean and export warning without provider calls',async()=>{
 let calls=0;const w=createWorker({fetch:async()=>{calls++;throw Error('Admission must remain local');}});
 const d=await (await w.fetch(req('/api/import-case',{content:'{"dispute_id":"D-label"}',name:'case.json'}))).json();
 const {validateImage}=await import('../worker/image-validation.js');
 const base={case:d.case,sources:[],name:'demo.png',mime_type:'image/png',image_base64:png};
 const image=await validateImage(base);
 const extraction={mode:'image_extraction',...image,provider:'DeepSeek Responses API',model:'deepseek-flash',text:'SIMULATED TEST EVIDENCE 4/10 missing 6',response_id:'mock-response',generated_at:'2026-10-24T00:00:00Z',request_id:'mock-request'};
 const payload={...base,extraction,text:extraction.text,reviewed:true};
 for(const value of [true,false,undefined]){
  const r=await w.fetch(req('/api/import-image-evidence',{...payload,...(value===undefined?{}:{synthetic:value})}),env);
  assert.equal(r.status,200,await r.clone().text());const result=await r.json(),s=result.sources[0];
  assert.equal(s.synthetic,value===true);assert.equal(s.provenance,value===true?'synthetic_demo':'user_import');
  const raw=JSON.parse(s.original_text);assert.equal(raw.evidence[0].synthetic,value===true);
  assert.equal(raw.image_derivation.image.image_base64,png);assert.equal(raw.image_derivation.image.image_sha256,image.image_sha256);
  assert.equal(raw.image_derivation.transcription.text,extraction.text);assert.equal(raw.image_derivation.review.text,extraction.text);
  const packet=await (await w.fetch(req('/api/export',{case:d.case,sources:result.sources,claims:result.analysis.claims}))).json();
  assert.equal(packet.contains_synthetic,value===true);assert.equal(packet.submission_permitted,false);
  assert.equal(packet.review_blockers.some(b=>b.code==='synthetic-warning'),value===true);
 }
 for(const synthetic of ['true','false',0,1,null,{},[]]){
  const r=await w.fetch(req('/api/import-image-evidence',{...payload,synthetic}),env);
  assert.equal(r.status,400);assert.match(await r.text(),/synthetic must be true or false/);
 }
 assert.equal(calls,0);
});

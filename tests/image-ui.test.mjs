import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').split("document.addEventListener('click'")[0];
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
function harness(){const nodes=new Map(),calls=[];const node=k=>{if(!nodes.has(k))nodes.set(k,{value:'',textContent:'',innerHTML:'',checked:false,hidden:false,disabled:false,open:true,classList:{toggle(){}},setAttribute(){},removeAttribute(){},showModal(){this.open=true},close(){this.open=false}});return nodes.get(k)};const status={ai:{configured:true,provider_key:'deepseek',provider:'DeepSeek Responses API',model:'deepseek-flash'},paypal:{configured:false}};const context=vm.createContext({document:{querySelector:node,querySelectorAll:()=>[]},structuredClone,Date,Map,AbortController,TextDecoder,TextEncoder,Uint8Array,btoa,setTimeout:()=>1,clearTimeout(){},confirm:()=>true,status});vm.runInContext(source,context);vm.runInContext("state.status=status;state.case={dispute_id:'D',order_id:'O'};state.analysis={claims:[],findings:[]};state.importMode='image';render=()=>{};renderAI=()=>{};renderSummary=()=>{};renderDrafts=()=>{};renderIntegrationStatus=()=>{};state.image={name:'shot.png',mime_type:'image/png',image_base64:'AA==',workspaceVersion:0,extraction:null};",context);let responder=()=>Promise.resolve(status);context.mockApi=(...args)=>{calls.push(args);return responder(...args)};vm.runInContext('api=(...args)=>mockApi(...args)',context);return {node,calls,context,run:s=>vm.runInContext(s,context),respond:fn=>responder=fn,status};}
const result=()=>({mode:'image_extraction',provider:'DeepSeek Responses API',model:'deepseek-flash',text:'Machine text',image_sha256:'abc',request_id:'request-123'});
test('screenshot selection and consent do not automatically transmit; explicit consent gate',async()=>{const h=harness();await h.run('extractImage()');assert.equal(h.calls.length,0);assert.equal(h.run('state.sources.length'),0);h.node('#image-consent').checked=true;h.respond(p=>Promise.resolve(p==='/api/extract-image'?result():h.status));await h.run('extractImage()');assert.equal(h.calls.filter(c=>c[0]==='/api/extract-image').length,1);assert.equal(h.run('state.sources.length'),0);assert.equal(h.node('#image-reviewed').checked,false);assert.equal(h.node('#image-transcript').value,'Machine text');});
test('wrong provider/model is never silently substituted',async()=>{const h=harness();h.node('#image-consent').checked=true;h.run("state.status.ai.model='other-model'");await h.run('extractImage()');assert.equal(h.calls.length,0);});
test('cancelled extraction and replacement workspace reject late result',async()=>{const h=harness(),d=deferred();h.node('#image-consent').checked=true;h.respond(p=>p==='/api/extract-image'?d.promise:Promise.resolve(h.status));const pending=h.run('extractImage()');h.run('cancelPending();state.workspaceVersion++;state.image=null');d.resolve(result());await pending;assert.equal(h.run('state.image'),null);assert.equal(h.node('#image-transcript').value,'');});
test('unknown recovery only GETs cache, never starts charged extraction',async()=>{const h=harness();h.run("state.imageRequest={id:'unknown-request',state:'uncertain',workspaceVersion:0}");h.respond(()=>Promise.resolve({state:'unknown'}));await h.run('recoverImage()');assert.equal(h.calls.length,1);assert.match(h.calls[0][0],/^\/api\/requests\//);assert.equal(h.run('state.image.extraction'),null);assert.match(h.node('#image-error').textContent,/no automatic retry/i);});
test('user review required and corrected text passed only on explicit admission',async()=>{const h=harness();h.context.extracted=result();h.run('state.image.extraction=extracted');h.node('#image-transcript').value='Corrected text';await h.run('admitImage()');assert.equal(h.calls.length,0);h.node('#image-reviewed').checked=true;h.respond(()=>Promise.resolve({sources:[{text:'Corrected text'}],analysis:{claims:[],findings:[]}}));await h.run('admitImage()');assert.equal(h.calls[0][0],'/api/import-image-evidence');assert.equal(h.calls[0][1].text,'Corrected text');assert.equal(h.calls[0][1].reviewed,true);assert.equal(h.run('state.sources[0].text'),'Corrected text');});
test('admission cannot overwrite newer transcript edit',async()=>{const h=harness(),d=deferred();h.context.extracted=result();h.run('state.image.extraction=extracted');h.node('#image-transcript').value='Reviewed text';h.node('#image-reviewed').checked=true;h.respond(()=>d.promise);const pending=h.run('admitImage()');h.node('#image-transcript').value='New unreviewed text';h.node('#image-reviewed').checked=false;d.resolve({sources:[{text:'Reviewed text'}],analysis:{claims:[],findings:[]}});await pending;assert.equal(h.run('state.sources.length'),0);});
test('huge, unsupported and corrupt image selection stays local and unadmitted',async()=>{for(const file of [{name:'big.png',type:'image/png',size:262145},{name:'pdf.pdf',type:'application/pdf',size:3},{name:'bad.png',type:'image/png',size:4,arrayBuffer:async()=>new Uint8Array([0,1,2,3]).buffer}]){const h=harness();h.context.file=file;await h.run('acceptImage(file)');assert.equal(h.calls.length,0);assert.equal(h.run('state.image'),null);assert.equal(h.node('#image-error').hidden,false);}});
test('source inspector and TXT export retain image derivation warning/hash',()=>{const h=harness();h.context.packet={case_id:'D',order_id:'O',sources:[{source_id:'s',label:'Screenshot',image_provenance:{image_sha256:'original-hash',mime_type:'image/png',filename:'shot.png',provider:'DeepSeek Responses API',model:'deepseek-flash',corrected:true,review_note:'User-reported review; not authentication.'}}],claims:[],warnings:[],contains_synthetic:false,review_complete:false};const text=h.run('exportText(packet)');assert.match(text,/original-hash/);assert.match(text,/NOT verified/);assert.match(text,/deepseek-flash/);assert.match(source,/if\(s.image_provenance\)/);});
test('editing transcript resets review checkbox and screenshot API is explicit',()=>{const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');assert.match(app,/image-transcript'\)\.oninput=\(\)=>\{\$\('#image-reviewed'\)\.checked=false/);const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');assert.match(html,/完整图片发送给 DeepSeek Responses API \/ deepseek-flash/);assert.doesNotMatch(html,/尚未通过真实 API 验证/);assert.match(html,/真实性|authenticity/);});
const pngBytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC','base64');
const jpegBytes=fs.readFileSync(new URL('../fixtures/test-screenshot.jpg',import.meta.url));
const imageFile=(bytes,type,name='image.png')=>({name,type,size:bytes.length,arrayBuffer:async()=>Uint8Array.from(bytes).buffer});
test('PNG/JPEG with empty or generic MIME use byte-derived canonical type and exact bytes without sending',async()=>{
 for(const [bytes,mime] of [[pngBytes,'image/png'],[jpegBytes,'image/jpeg']])for(const type of ['',undefined,'application/octet-stream',mime]){
  const h=harness();h.context.file=imageFile(bytes,type,'extension-is-not-proof.bin');await h.run('acceptImage(file)');
  assert.equal(h.run('state.image.mime_type'),mime);assert.equal(h.run('state.image.image_base64'),bytes.toString('base64'));
  assert.equal(h.node('#image-preview').src,`data:${mime};base64,${bytes.toString('base64')}`);assert.equal(h.calls.length,0);assert.equal(h.node('#image-consent').checked,false);
 }
});
test('conflicting MIME, disguised filenames, unsupported types and malformed signatures reject locally',async()=>{
 for(const file of [imageFile(pngBytes,'image/jpeg'),imageFile(jpegBytes,'image/png'),imageFile(pngBytes,'application/pdf'),imageFile(Buffer.from('not a PNG'),'','looks-valid.png'),imageFile(Buffer.from('not a JPEG'),'application/octet-stream','looks-valid.jpg'),imageFile(jpegBytes.subarray(0,-2),'','truncated.jpg')]){
  const h=harness();h.context.file=file;await h.run('acceptImage(file)');assert.equal(h.run('state.image'),null);assert.equal(h.calls.length,0);assert.equal(h.node('#image-error').hidden,false);
 }
});
test('size failures are specific and checked before reading; actual byte count must match metadata',async()=>{
 for(const [size,message] of [[0,/empty/],[262145,/exceeds 256 KiB/],[undefined,/determine.*size/]]){
  const h=harness();let reads=0;h.context.file={type:'application/pdf',size,arrayBuffer:async()=>{reads++;return pngBytes.buffer;}};
  await h.run('acceptImage(file)');assert.equal(reads,0);assert.match(h.node('#image-error').textContent,message);assert.equal(h.calls.length,0);
 }
 const h=harness();h.context.file={...imageFile(pngBytes,''),size:pngBytes.length-1};await h.run('acceptImage(file)');assert.equal(h.run('state.image'),null);assert.match(h.node('#image-error').textContent,/bytes read do not match/);
});
test('replacement selection and closed dialog cannot adopt late MIME-detected file',async()=>{
 for(const action of ["state.fileEpoch++", "$('#import-dialog').open=false", "state.workspaceVersion++"]){
  const h=harness(),d=deferred();h.context.file={...imageFile(pngBytes,''),arrayBuffer:()=>d.promise};const pending=h.run('acceptImage(file)');h.run(action);d.resolve(Uint8Array.from(pngBytes).buffer);await pending;assert.equal(h.run('state.image'),null);assert.equal(h.calls.length,0);
 }
});
test('generic MIME fallback cannot bypass server PNG CRC or JPEG structure validation before provider call',async()=>{
 const {extractImage}=await import('../worker/images.js');
 const corruptPng=Buffer.from(pngBytes);corruptPng[45]^=1;
 const corruptJpeg=Buffer.from(jpegBytes);corruptJpeg[4]=255;corruptJpeg[5]=255;
 let calls=0;
 for(const bytes of [corruptPng,corruptJpeg]){
  const h=harness();h.context.file=imageFile(bytes,'application/octet-stream');await h.run('acceptImage(file)');
  const selected=h.run('state.image');assert.ok(selected,'signature intake is not a full decoder');
  await assert.rejects(extractImage({...selected,consent:true},{AI_PROVIDER:'deepseek',DEEPSEEK_MODEL:'deepseek-flash',DEEPSEEK_API_KEY:'mock-only'},{fetch:async()=>{calls++;throw Error('Must not reach provider');}}));
 }
 assert.equal(calls,0);
});
test('simulated screenshot label is explicit, bilingual, default false and reset on new selection',async()=>{
 const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 assert.match(html,/<input id="image-synthetic" type="checkbox">/);
 assert.match(html,/data-en="This screenshot is simulated demo material" data-zh="这张截图是模拟演示材料"/);
 const h=harness();assert.equal(h.node('#image-synthetic').checked,false);
 h.node('#image-synthetic').checked=true;h.context.file=imageFile(pngBytes,'image/png');
 await h.run('acceptImage(file)');assert.equal(h.node('#image-synthetic').checked,false);assert.equal(h.calls.length,0);
});
test('admission carries only explicit screenshot label, never infers it from model text',async()=>{
 for(const synthetic of [false,true]){
  const h=harness();h.context.extracted={...result(),text:'SIMULATED TEST EVIDENCE',synthetic:!synthetic};
  h.run("state.imageRequest={};applyImageExtraction(extracted,state.image)");
  assert.equal(h.node('#image-synthetic').checked,false);
  h.node('#image-synthetic').checked=synthetic;h.node('#image-reviewed').checked=true;
  h.respond(()=>Promise.resolve({sources:[],analysis:{claims:[],findings:[]}}));await h.run('admitImage()');
  assert.equal(h.calls[0][1].synthetic,synthetic);
 }
});
test('admission rejects late result after screenshot label changes and disables label while busy',async()=>{
 const h=harness(),d=deferred();h.context.extracted=result();h.run('state.image.extraction=extracted');
 h.node('#image-transcript').value='Reviewed';h.node('#image-reviewed').checked=true;h.respond(()=>d.promise);
 const pending=h.run('admitImage()');h.run('updateImageControls()');assert.equal(h.node('#image-synthetic').disabled,true);
 h.node('#image-synthetic').checked=true;d.resolve({sources:[{text:'Reviewed'}],analysis:{claims:[],findings:[]}});
 await pending;assert.equal(h.run('state.sources.length'),0);assert.equal(h.node('#image-synthetic').disabled,false);
});

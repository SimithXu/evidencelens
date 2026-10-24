import * as engine from './engine.js';
import {createAdapters, AdapterError} from './adapters.js';
import {extractImage} from './images.js';
import {validateImage, ImageValidationError} from './image-validation.js';
import {ASSETS, FIXTURES} from './embedded.js';
const MAX_BODY=2097152, TTL=1800000, MAX_ENTRIES=64, MAX_BYTES=16777216;
const enc=new TextEncoder();
const size=v=>enc.encode(JSON.stringify(v)).length;
const clone=v=>structuredClone(v);
class RequestError extends Error {constructor(message,status=400){super(message);this.status=status;}}
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const rid=value=>{if(value==null)return crypto.randomUUID();if(typeof value!=='string'||!/^[-_a-zA-Z0-9]{8,128}$/.test(value))throw new RequestError('Request ID must contain 8–128 letters, digits, hyphens or underscores.');return value;};
const fail=err=>({error:err instanceof RequestError||err instanceof AdapterError||err instanceof ImageValidationError||err.name==='ValueError'?err.message.slice(0,300):'Invalid case or evidence schema.'});
const code=err=>err.status||(err.name==='ValueError'||err instanceof TypeError?400:500);
async function hash(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(engine._canonical(value))))].map(v=>v.toString(16).padStart(2,'0')).join('');}
// Global memory is bounded and every key is partitioned by an opaque browser-session capability, never a claimed identity.
// Nothing here is durable or shared between isolates. Unknown never starts work.
export class RequestCache {
 constructor(){this.entries=new Map();}
 key(user,id){return JSON.stringify([user,id]);}
 purge(){const now=Date.now();for(const [key,e] of this.entries)if(e.state!=='in_flight'&&now-e.updated>TTL)this.entries.delete(key);}
 trim(reserve=0){this.purge();while(this.entries.size+reserve>MAX_ENTRIES||[...this.entries.values()].reduce((n,e)=>n+(e.bytes||0),0)>MAX_BYTES){const first=[...this.entries].find(([,e])=>e.state!=='in_flight');if(!first)break;this.entries.delete(first[0]);}}
 async execute(user,id,operation,payload,action){const fingerprint=await hash({operation,payload});this.purge();const key=this.key(user,id),existing=this.entries.get(key);if(existing){if(existing.fingerprint!==fingerprint)throw new RequestError('This request ID was already used for different inputs. Start a new explicit action.',409);if(existing.state==='in_flight')return [{error:'This request is still running. Recover its result without resubmitting.',state:'in_flight'},409,false];return [clone(existing.result),existing.status,true];}
 this.trim(1);if(this.entries.size>=MAX_ENTRIES)throw new RequestError('Too many requests are in flight. Wait and recover an existing request.',503);
 for(const e of this.entries.values())if(e.user===user&&e.state==='in_flight'&&e.fingerprint===fingerprint)return [{error:'Identical work is already running. Recover the active request instead.',state:'in_flight',active_request_id:e.id},409,false];
 const entry={user,id,fingerprint,state:'in_flight',updated:Date.now(),bytes:0};this.entries.set(key,entry);let result,status=200;try{result=await action();}catch(err){result=fail(err);status=code(err);}Object.assign(entry,{state:status<400?'succeeded':'failed',result:clone(result),status,updated:Date.now(),bytes:size(result)});this.trim();return [result,status,false];}
 lookup(user,id){this.purge();const e=this.entries.get(this.key(user,id));if(!e)return {request_id:id,state:'unknown',note:'No result is available in this Worker isolate. Do not automatically resubmit; an earlier operation may have completed or charged.'};const result={request_id:id,state:e.state};if(e.state==='succeeded')Object.assign(result,{status:e.status,result:{...clone(e.result),request_id:id,replayed:true}});else if(e.state==='failed')Object.assign(result,{status:e.status,error:e.result.error});return result;}
 async matches(user,id,operation,payload,result){this.purge();const e=this.entries.get(this.key(user,id));return !!(e&&e.state==='succeeded'&&e.fingerprint===await hash({operation,payload})&&engine._canonical(e.result)===engine._canonical(result));}
}
function budget(case_,sources,analysis){const value={case:case_,sources,claims:analysis.claims,analysis}; // Match Python default JSON spacing conservatively.
 if(size(value)+JSON.stringify(value).replace(/"(?:\\.|[^"\\])*"/g,'').split(/[:,]/).length>1250000)throw new RequestError('This import expands beyond the safe workspace limit (1.25 MB normalized). Import smaller bundles or fewer records. Existing evidence and draft were not changed.',413);}
async function readBody(request){const declared=request.headers.get('Content-Length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BODY))throw new RequestError('Request body must be between 1 byte and 2 MB.',413);const reader=request.body?.getReader();if(!reader)throw new RequestError('Provide a JSON object.');let length=0;const parts=[];while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>MAX_BODY){await reader.cancel();throw new RequestError('Request body must be between 1 byte and 2 MB.',413);}parts.push(value);}if(!length)throw new RequestError('Provide a JSON object.');const bytes=new Uint8Array(length);let at=0;for(const part of parts){bytes.set(part,at);at+=part.byteLength;}let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new RequestError('Provide valid UTF-8 JSON.');}return engine._decode(text,MAX_BODY)[0];}
function content(body){if(typeof body.content!=='string'||typeof(body.name??'import.json')!=='string')throw new RequestError('Import requires text content and a filename.');return [body.content,body.name??'import.json'];}
function caseSources(body){if(!object(body.case)||!Array.isArray(body.sources??[]))throw new RequestError('A case object and sources array are required.');const sources=body.sources??[];if(sources.length>100)throw new RequestError('At most 100 supplemental sources are supported.');return [body.case,sources];}
export async function validateExportReview(review,case_,sources){
 if(!object(review)||size(review)>400000)throw new RequestError('AI review must be an object no larger than 400 KB.');
 for(const key of ['claims','contradictions','gaps','warnings'])if(!Array.isArray(review[key])||review[key].length>24)throw new RequestError('Invalid AI review collection.');
 // Original model suggestions are never human-reviewed claims. Recompute all
 // guard metadata rather than trusting client-provided risk/status fields.
 const checkedClaims=await engine.verify_export(case_,sources,review.claims);
 const result={claims:checkedClaims.claims.map(c=>({...c,status:'needs_review'}))},refs=[];
 for(const key of ['contradictions','gaps']){
  result[key]=[];
  for(const [index,item] of review[key].entries()){
   if(!object(item)||typeof item.title!=='string'||typeof item.detail!=='string'||Array.from(item.title).length>300||Array.from(item.detail).length>12000||!Array.isArray(item.citations))throw new RequestError('Invalid AI review finding length or citations.');
   if(key==='contradictions'&&new Set(item.citations.filter(object).map(c=>c.source_id)).size<2)throw new RequestError('AI contradictions must cite two distinct sources.');
   if(key==='gaps'&&(typeof item.missing_evidence!=='boolean'||(!item.citations.length&&!item.missing_evidence)))throw new RequestError('Uncited AI gaps must be explicitly marked missing evidence.');
   const id=`ai-${key}-${index+1}`;
   refs.push({id,text:item.title+': '+item.detail,citations:item.citations,status:item.citations.length?'needs_review':'unsupported'});
   result[key].push({id,title:item.title,detail:item.detail,citations:clone(item.citations),status:'needs_review',origin:'model',...(key==='gaps'?{missing_evidence:item.missing_evidence}:{})});
  }
 }
 const checked=await engine.verify_export(case_,sources,[...result.claims,...refs]);
 if(checked.adverse_coverage.some(e=>!e.coverage_complete))throw new RequestError('AI review omitted or only partially cited annotated adverse evidence.');
 for(const item of [...result.contradictions,...result.gaps]){
  const checkedItem=checked.claims.find(c=>c.id===item.id);
  if(checkedItem?.semantic_risk)item.semantic_risk=checkedItem.semantic_risk;
 }
 if(review.warnings.some(w=>typeof w!=='string'||Array.from(w).length>3000))throw new RequestError('Invalid AI review warnings.');
 result.warnings=clone(review.warnings);
 Object.assign(result,{semantic_risks:checked.semantic_risks,citation_integrity_verified:true,semantic_support_verified:false,human_review_required:true});
 for(const key of ['mode','provider','provider_key','model','response_id','generated_at','request_id']){
  const v=review[key]??null;if(v!==null&&(typeof v!=='string'||Array.from(v).length>300))throw new RequestError('Invalid AI review metadata.');result[key]=v;
 }
 return result;
}
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'"};
export function createWorker({fetch:fetchImpl=globalThis.fetch}={}){
 const cache=new RequestCache(),userObservations=new Map();
 // Bounded per-session observations store hashes/status only, never raw credentials.
 return {async fetch(request,env={},ctx={}){let requestID;const send=(value,status=200)=>new Response(JSON.stringify(requestID?{...value,request_id:requestID}:value),{status,headers:{...headers,'Content-Type':'application/json; charset=utf-8',...(requestID?{'X-EvidenceLens-Request-ID':requestID}:{})}});try{const url=new URL(request.url),path=url.pathname;
 const session=request.headers.get('X-EvidenceLens-Session');
 if(session!==null&&!/^[a-f0-9]{64}$/.test(session))throw new RequestError('Invalid browser session capability.');
 const user=session; // A bearer capability for ephemeral isolation, NOT authentication. Ignore platform user headers.
 // Public, immutable bundled assets contain no user state or runtime secrets.
 // A legitimate link from chat arrives as Sec-Fetch-Site: cross-site. Serve only
 // this exact static allowlist before API-origin guards; never generalize to GET APIs.
 const staticPath=path==='/'?'/index.html':path;
 if(['GET','HEAD'].includes(request.method)&&Object.hasOwn(ASSETS,staticPath)){
 const asset=ASSETS[staticPath];return new Response(request.method==='HEAD'?null:asset.text,{headers:{...headers,'Content-Type':asset.type}});
 }
 // Public deterministic routes need no session. Private observations/recovery and
 // external work require a browser-generated random capability, not a login.
 const needsSession=path.startsWith('/api/requests/')||path.startsWith('/api/paypal/')||['/api/ai-review','/api/extract-image','/api/import-image-evidence'].includes(path);
 const origin=request.headers.get('Origin');if(origin&&origin!==url.origin)throw new RequestError('Cross-origin requests are not permitted.',403);if(request.headers.get('Sec-Fetch-Site')==='cross-site')throw new RequestError('Cross-site requests are not permitted.',403);
 if(needsSession&&!user)throw new RequestError('A random browser session capability is required. Reload the app; no login is needed.',400);
 if(!['GET','POST'].includes(request.method))throw new RequestError('Cross-origin access is not enabled.',405);
 if(user&&!userObservations.has(user)){if(userObservations.size>=64)userObservations.delete(userObservations.keys().next().value);userObservations.set(user,new Map());}
 const adapters=createAdapters(env,{fetch:fetchImpl,observations:user?userObservations.get(user):new Map()});
 const workspace=async id=>{const raw=await adapters.paypal_dispute(id);const case_=await engine.import_case(JSON.stringify(raw),'paypal-sandbox-live-response.json'),analysis=await engine.analyze(case_,[]);budget(case_,[],analysis);return {case:case_,sources:[],analysis,read_only:true,fetched_from:'paypal_sandbox',receipt:{source_mode:'paypal_sandbox_read',fetched_at:new Date().toISOString(),environment:'sandbox',read_only:true}};};
 const external=async(operation,payload,action,body={})=>{const h=request.headers.get('X-EvidenceLens-Request-ID'),b=body.request_id;if(h&&b&&h!==b)throw new RequestError('Request ID header and body disagree.');requestID=rid(h||b);const [result,status,replayed]=await cache.execute(user,requestID,operation,payload,action);return send({...result,replayed},status);};
 if(request.method==='GET'){
 if(path==='/api/status'){const state=await adapters.status();return send({...state,mode:'public_test',request_cache:{scope:user?'this_worker_isolate_and_browser_session_only':'none',available:!!user,durable:false,ttl_seconds:TTL/1000,max_entries:MAX_ENTRIES},authentication:{authenticated:false,visitor_required:false,external_operations_allowed:true,isolation:'ephemeral_random_browser_capability_not_identity'},notice:'Public test mode: real AI calls may incur charges; PayPal Sandbox reads are public and read-only. No call-count or spending cap. Session results are temporary and unavailable after reload.'});}
 if(path==='/api/demo'){const case_=await engine.import_case(FIXTURES['sandbox-dispute.json'],'sandbox-dispute.json'),sources=await engine.import_evidence(FIXTURES['simulated-evidence.json'],'simulated-evidence.json',case_);return send({case:case_,sources,analysis:await engine.analyze(case_,sources)});}
 if(path.startsWith('/api/requests/'))return send({...cache.lookup(user,rid(decodeURIComponent(path.slice(14)))),recovery_scope:'this_worker_isolate_and_browser_session_only'});
 if(path.startsWith('/api/paypal/disputes/')){ // Legacy external operation still demands same-origin proof.
 if(origin!==url.origin)throw new RequestError('Same-origin Origin is required for external operations.',403);const dispute_id=decodeURIComponent(path.slice(21));return external('paypal_read',{dispute_id},()=>workspace(dispute_id));}
 if(path.startsWith('/api/'))throw new RequestError('Endpoint not found. This MVP has no submission, payment, or refund endpoints.',404);
 const asset=ASSETS[path==='/'?'/index.html':path];if(!asset)throw new RequestError('File not found.',404);return new Response(asset.text,{headers:{...headers,'Content-Type':asset.type}});
 }
 if(origin!==url.origin)throw new RequestError('Same-origin Origin is required for JSON mutations.',403);
 if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new RequestError('Use application/json for this endpoint.',415);
 const body=await readBody(request);
 if(path==='/api/paypal/read')return external('paypal_read',{dispute_id:body.dispute_id},()=>workspace(body.dispute_id),body);
 if(path==='/api/import-case'){const case_=await engine.import_case(...content(body)),analysis=await engine.analyze(case_,[]);budget(case_,[],analysis);return send({case:case_,sources:[],analysis});}
 const [case_,sources]=caseSources(body);
 if(path==='/api/import-evidence'){await engine.verify_export(case_,sources,[]);const imported=await engine.import_evidence(...content(body),case_),merged=[...new Map([...sources,...imported].map(s=>[s.source_id,s])).values()];if(merged.length>100)throw new RequestError('At most 100 supplemental sources are supported.');const analysis=await engine.analyze(case_,merged);budget(case_,merged,analysis);return send({sources:merged,analysis});}
 if(path==='/api/analyze')return send(await engine.analyze(case_,sources));
 if(path==='/api/extract-image'){
 await engine.verify_export(case_,sources,[]);
 const payload={case:case_,sources,name:body.name,mime_type:body.mime_type,image_base64:body.image_base64,consent:body.consent??false};
 return external('image_extraction',payload,()=>extractImage(body,env,{fetch:fetchImpl}),body);
 }
 if(path==='/api/import-image-evidence'){
 await engine.verify_export(case_,sources,[]);
 if(body.reviewed!==true)throw new RequestError('Review and correct the machine transcription before admitting it as evidence.');
 const synthetic=Object.hasOwn(body,'synthetic')?body.synthetic:false;
 if(typeof synthetic!=='boolean')throw new RequestError('synthetic must be true or false.');
 const image=await validateImage(body),extraction=body.extraction;
 if(!object(extraction)||extraction.mode!=='image_extraction'||extraction.image_sha256!==image.image_sha256||extraction.name!==image.name||extraction.mime_type!==image.mime_type||extraction.provider!=='DeepSeek Responses API'||extraction.model!=='deepseek-flash')throw new RequestError('Image extraction metadata does not match this original image.');
 const text=engine._string(body.text,'reviewed transcription',{required:true,limit:50000}),machine=engine._string(extraction.text,'machine transcription',{required:true,limit:50000});
 const transcription={text:machine,provider:extraction.provider,model:extraction.model};
 for(const key of ['response_id','generated_at','request_id'])transcription[key]=engine._string(extraction[key],key,{limit:300});
 const raw=JSON.stringify({case_id:case_.dispute_id,order_id:case_.order_id,image_derivation:{image:{name:image.name,mime_type:image.mime_type,image_base64:image.image_base64,image_sha256:image.image_sha256},transcription,review:{reviewed:true,corrected:text!==machine,text}},evidence:[{kind:'note',label:'Image transcription · '+Array.from(image.name).slice(0,220).join(''),text,synthetic}]});
 const imported=await engine.import_evidence(raw,'image-'+image.image_sha256.slice(0,16)+'.transcription.json',case_),merged=[...new Map([...sources,...imported].map(s=>[s.source_id,s])).values()];
 if(merged.length>100)throw new RequestError('At most 100 supplemental sources are supported.');
 const analysis=await engine.analyze(case_,merged);budget(case_,merged,analysis);
 return send({sources:merged,analysis,image_intake:{image_sha256:image.image_sha256,reviewed:true,corrected:text!==machine,authenticity_verified:false,note:'Original image bytes and machine/corrected text retained. Citations reference derived text, not image pixels or independently verified truth.'}});
 }
 if(path==='/api/ai-review')return external('ai_review',{case:case_,sources,consent:body.consent??false},()=>adapters.ai_review(case_,sources,body.consent??false),body);
 if(path==='/api/export'){if(!Array.isArray(body.claims))throw new RequestError('An editable claims array is required.');const exported=await engine.verify_export(case_,sources,body.claims);if(body.ai_review!=null){const review=body.ai_review,preserved=await validateExportReview(review,case_,sources),original=Object.fromEntries(Object.entries(review).filter(([k])=>!['request_id','replayed'].includes(k))),verified=!!user&&await cache.matches(user,review.request_id,'ai_review',{case:case_,sources,consent:true},original);preserved.provenance={verification_scope:'response_origin_only_not_semantic_support',semantic_support_verified:false,verified_in_current_process:verified,verified_in_current_isolate:verified,observation_scope:'this_worker_isolate_and_browser_session_only',kind:verified?'observed_model_response':'client_provided_model_review_unverified',note:verified?'Matched exact inputs and a successful adapter result in this browser session’s bounded Worker-isolate cache.':'Citations validated, but no matching actual call is available in this browser session’s current Worker-isolate cache. Metadata is not independently attested.'};exported.ai_review=preserved;}if(body.receipt!=null){if(!object(body.receipt)||size(body.receipt)>3000)throw new RequestError('Invalid Sandbox read receipt.');exported.workspace_receipt={...body.receipt,export_note:'Client-provided receipt metadata; original source integrity is checked separately.'};}return send(exported);}
 throw new RequestError('Endpoint not found. This MVP has no submission, payment, or refund endpoints.',404);
 }catch(err){return send(fail(err),code(err));}}};
}
export default createWorker();

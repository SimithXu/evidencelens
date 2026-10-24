/** Fixed-endpoint, opt-in runtime adapters. No retries or credential logging. */
import {import_case, verify_export, _decode} from './engine.js';
import {REVIEW_SCHEMA, INSTRUCTIONS} from './adapter-schema.js';
export const PAYPAL_BASE='https://api-m.sandbox.paypal.com';
export const AI_PROVIDERS={
 openai:{provider:'OpenAI Responses API',endpoint:'https://api.openai.com/v1/responses',credential_env:'OPENAI_API_KEY',model_env:'OPENAI_MODEL'},
 deepseek:{provider:'DeepSeek Responses API',endpoint:'https://api.deepseek.com/responses',credential_env:'DEEPSEEK_API_KEY',model_env:'DEEPSEEK_MODEL'}
};
const encoder=new TextEncoder();
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export const utc_now=()=>new Date().toISOString();
export class AdapterError extends Error {constructor(message,status=502){super(message);this.status=status;}}
export function ai_configuration(env={}){
 const key=String(env.AI_PROVIDER??'openai').toLowerCase().trim();
 if(!Object.hasOwn(AI_PROVIDERS,key))return {provider_key:'unsupported',provider:'Unsupported provider',credential_env:'',model_env:'',model:'',configuration_error:'AI_PROVIDER must be openai or deepseek.'};
 const config={...AI_PROVIDERS[key],provider_key:key};config.model=env[config.model_env]||'';return config;
}
const uncertain='Integration response could not be confirmed. The provider may have received the request. Do not automatically retry; recover this request before explicitly starting another.';
export async function request_json(url,options,fetchImpl=globalThis.fetch,timeout=25000){
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout);
 try{
  let response;
  try{response=await fetchImpl(url,{...options,redirect:'manual',signal:controller.signal});}catch{throw new AdapterError(uncertain);}
  if(response.status>=300&&response.status<400)throw new AdapterError('Integration redirect refused; no credentials were forwarded.');
  if(!response.ok)throw new AdapterError(`Integration request failed (HTTP ${response.status}). Check runtime configuration and account access.`);
  const limit=2*1024*1024;const size=response.headers.get('content-length');
  if(size&&/^\d+$/.test(size)&&Number(size)>limit){await response.body?.cancel();throw new AdapterError('Integration response exceeded the size limit.');}
  const reader=response.body?.getReader();let chunks=[],length=0;
  if(reader){try{while(true){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();throw new AdapterError('Integration response exceeded the size limit.');}chunks.push(value);}}catch(e){if(e instanceof AdapterError)throw e;throw new AdapterError(uncertain);}}
  const raw=new Uint8Array(length);let offset=0;for(const c of chunks){raw.set(c,offset);offset+=c.length;}
  let result;try{const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);result=_decode(text,limit)[0];}catch{throw new AdapterError('Integration returned an invalid JSON response.');}
  if(!object(result))throw new AdapterError('Integration returned an unexpected response shape.');return result;
 }finally{clearTimeout(timer);}
}
export function resolve_citations(citations,source_map){
 if(!Array.isArray(citations)||citations.length>100)throw new Error('Invalid citation list.');
 return citations.map(c=>{
  if(!object(c)||Object.keys(c).sort().join(',')!=='occurrence,quote,source_id')throw new Error('Quote citations require source_id, quote, and occurrence only.');
  const {source_id,quote,occurrence}=c;const source=source_map instanceof Map?source_map.get(source_id):Object.hasOwn(source_map,source_id)?source_map[source_id]:undefined;
  if(typeof source_id!=='string'||!source)throw new Error('Unknown citation source.');
  if(typeof quote!=='string'||!quote||!Number.isInteger(occurrence)||occurrence<0||occurrence>=100000)throw new Error('Invalid quote or occurrence.');
  const text=source.text;let index=-1;
  for(let n=0;n<=occurrence;n++){index=text.indexOf(quote,index+1);if(index<0)throw new Error('Quote occurrence does not exist.');}
  const start=Array.from(text.slice(0,index)).length;return {source_id,quote,start,end:start+Array.from(quote).length};
 });
}
function modelText(value,maximum=12000){if(typeof value!=='string'||!value.trim()||Array.from(value).length>maximum)throw new Error('Invalid model text.');return value;}
export async function validate_model_review(result,case_,sources){
 if(!object(result)||Object.keys(result).sort().join(',')!=='claims,contradictions,gaps,warnings')throw new Error('Incomplete model review.');
 for(const key of ['claims','contradictions','gaps','warnings'])if(!Array.isArray(result[key])||result[key].length>12)throw new Error('Invalid model review collection.');
 const warnings=result.warnings.map(w=>modelText(w,2000));const source_map=new Map([case_.source,...sources].map(s=>[s.source_id,s]));
 const claims=[],contradictions=[],gaps=[],verification=[];
 for(const [index,claim] of result.claims.entries()){
  if(!object(claim))throw new Error('Invalid model claim.');const citations=resolve_citations(claim.citations,source_map);if(!citations.length)throw new Error('Model claims must cite evidence.');
  claims.push({id:`ai-${index+1}`,text:modelText(claim.text),citations,status:'needs_review'});
 }
 for(const [kind,destination] of [['contradictions',contradictions],['gaps',gaps]])for(const [index,item] of result[kind].entries()){
  if(!object(item))throw new Error('Invalid model finding.');const citations=resolve_citations(item.citations,source_map),missing=Object.hasOwn(item,'missing_evidence')?item.missing_evidence:false;
  if(kind==='contradictions'&&new Set(citations.map(c=>c.source_id)).size<2)throw new Error('Contradictions require citations from two distinct sources.');
  if(kind==='gaps'&&(typeof missing!=='boolean'||(!citations.length&&!missing)))throw new Error('Uncited gap must explicitly identify missing evidence.');
  const finding={id:`ai-${kind}-${index+1}`,title:modelText(item.title,300),detail:modelText(item.detail),citations,status:'needs_review',origin:'model'};
  if(kind==='gaps')finding.missing_evidence=missing;destination.push(finding);verification.push({id:finding.id,text:finding.title+': '+finding.detail,citations,status:citations.length?'needs_review':'unsupported'});
 }
 const checked=await verify_export(case_,sources,[...claims,...verification]);
 if((checked.adverse_coverage||[]).some(e=>!e.coverage_complete))throw new Error('The model omitted or only partially cited annotated adverse evidence.');
 // Lexical risk is a review signal, not proof of an invalid interpretation.
 // Keep exact-citation/input-integrity and adverse-coverage failures fatal.
 for(const item of [...claims,...contradictions,...gaps]){
  const checkedItem=checked.claims.find(c=>c.id===item.id);
  if(checkedItem?.semantic_risk)item.semantic_risk=checkedItem.semantic_risk;
 }
 if(checked.semantic_risks.length)warnings.push('Conservative delivery-language guard flagged suggestions for human review. Attribution and negation may also trigger it; no semantic support is verified.');
 const used=new Set([...claims,...contradictions,...gaps].flatMap(i=>i.citations.map(c=>c.source_id)));
 if(sources.some(s=>['buyer_nonreceipt','partial_delivery'].includes(s.assertion)&&!used.has(s.source_id)))throw new Error('The model omitted annotated adverse evidence.');
 return {claims,contradictions,gaps,warnings,semantic_risks:checked.semantic_risks,citation_integrity_verified:true,semantic_support_verified:false,human_review_required:true};
}
// Only these fixed validator messages may influence public diagnostics. Never echo
// provider output, source text, identifiers, or arbitrary exception messages.
const REVIEW_REJECTIONS=new Map([
 ['Invalid citation list.', ['citation_shape','Citation list is invalid.']],
 ['Quote citations require source_id, quote, and occurrence only.', ['citation_shape','Citation fields are invalid.']],
 ['Unknown citation source.', ['citation_source','A citation references an unknown source.']],
 ['Invalid quote or occurrence.', ['citation_index','A quote or zero-based occurrence index is invalid.']],
 ['Quote occurrence does not exist.', ['citation_match','An exact quote or its occurrence was not found in its source.']],
 ['Invalid model text.', ['review_text','A review text field is empty, invalid, or too long.']],
 ['Incomplete model review.', ['review_shape','Required review collections are missing or unexpected.']],
 ['Invalid model review collection.', ['review_collection','A review collection is invalid or exceeds its limit.']],
 ['Invalid model claim.', ['claim_shape','A claim has an invalid shape.']],
 ['Model claims must cite evidence.', ['claim_uncited','A claim lacks a citation.']],
 ['Invalid model finding.', ['finding_shape','A finding has an invalid shape.']],
 ['Contradictions require citations from two distinct sources.', ['contradiction_sources','A contradiction does not cite two distinct sources.']],
 ['Uncited gap must explicitly identify missing evidence.', ['gap_missing_flag','An uncited gap is not marked as missing evidence.']],
 ['The model omitted or only partially cited annotated adverse evidence.', ['adverse_coverage','Annotated adverse evidence was omitted or not quoted in full.']],
 ['The model omitted annotated adverse evidence.', ['adverse_coverage','Annotated adverse evidence was omitted or not quoted in full.']],
]);
function rejectedReview(code,detail){return new AdapterError(`AI review rejected [${code}]: ${detail} Suggestions were rejected; existing draft was left unchanged.`);}
async function fingerprint(provider,env){
 const config=ai_configuration(env);const values=provider==='paypal'?[env.PAYPAL_CLIENT_ID,env.PAYPAL_CLIENT_SECRET]:[config.provider_key,env[config.credential_env],env[config.model_env]];
 if(!values.every(Boolean))return null;const hash=await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(values)));return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}
/** Observations MUST be user-scoped by the caller, never a global cross-user Map. */
export function createAdapters(env={}, {fetch:fetchImpl=globalThis.fetch,observations=new Map()}={}){
 async function observed(provider,fn){const fp=await fingerprint(provider,env),attempt_id=Symbol(),old=observations.get(provider)||{};observations.set(provider,{state:'in_flight',at:utc_now(),fingerprint:fp,attempt_id,last_success_at:old.last_success_at??null});
  try{const result=await fn();const latest=observations.get(provider);if(latest?.attempt_id===attempt_id){const now=utc_now();observations.set(provider,{...latest,state:'succeeded',at:now,last_success_at:now});}return result;}
  catch(error){const latest=observations.get(provider);if(latest?.attempt_id===attempt_id)observations.set(provider,{...latest,state:'failed',at:utc_now()});throw error;}
 }
 async function connectionStatus(provider){const fp=await fingerprint(provider,env),observation=observations.get(provider)||{},same=fp!==null&&fp===observation.fingerprint;const state=same?(observation.state||'not_checked'):(fp?'not_checked':'not_configured');return {configured:fp!==null,connection_verified:state==='succeeded',latest_attempt:{state,at:same?observation.at:null},last_success_at:same?(observation.last_success_at??null):null,observation_scope:'this_browser_session_worker_isolate_only'};}
 return {
  async status(){const {endpoint,...config}=ai_configuration(env);return {mode:'hosted',version:'0.2.0',paypal:{...await connectionStatus('paypal'),environment:'sandbox',read_only:true},ai:{...await connectionStatus('ai'),...config}};},
  async paypal_dispute(dispute_id){return observed('paypal',async()=>{
   if(typeof dispute_id!=='string'||!/^PP-[A-Z0-9-]{3,80}$/.test(dispute_id))throw new AdapterError('Enter a valid PayPal dispute ID (PP-…).',400);
   const client_id=env.PAYPAL_CLIENT_ID||'',secret=env.PAYPAL_CLIENT_SECRET||'';
   if(!client_id||!secret)throw new AdapterError('PayPal Sandbox is not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET on the server; do not paste secrets into the app.',503);
   const basic=btoa(Array.from(encoder.encode(`${client_id}:${secret}`),b=>String.fromCharCode(b)).join(''));
   const token=await request_json(PAYPAL_BASE+'/v1/oauth2/token',{method:'POST',body:'grant_type=client_credentials',headers:{Authorization:'Basic '+basic,'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'}},fetchImpl);
   if(typeof token.access_token!=='string'||!token.access_token)throw new AdapterError('PayPal did not return an access token.');
   const result=await request_json(PAYPAL_BASE+'/v1/customer/disputes/'+dispute_id,{method:'GET',headers:{Authorization:'Bearer '+token.access_token,Accept:'application/json'}},fetchImpl);
   if(result.dispute_id!==dispute_id)throw new AdapterError('PayPal returned a different or missing dispute identifier; response was rejected.');
   await import_case(JSON.stringify(result),'paypal-sandbox-live-response.json');return result;
  });},
  async ai_review(case_,sources,consent=false){return observed('ai',async()=>{
   const config=ai_configuration(env);
   if(consent!==true)throw new AdapterError('Consent is required before sending case and evidence text to the configured AI provider. The call may incur API charges.',400);
   if(config.provider_key==='unsupported')throw new AdapterError(config.configuration_error,503);
   const api_key=env[config.credential_env]||'',model=config.model;
   if(!api_key||!model)throw new AdapterError(`AI is not configured. Set ${config.credential_env} and ${config.model_env} on the server. Local rule-based analysis remains available.`,503);
   await verify_export(case_,sources,[]);const selected=[case_.source,...sources];
   if(selected.length>101)throw new AdapterError('AI review supports at most 100 supplemental sources.',400);
   const evidence=selected.map(source=>Object.fromEntries(['source_id','label','kind','occurred_at','synthetic','assertion','text'].map(key=>[key,source[key]??null])));
   const payload_text=JSON.stringify({case:Object.fromEntries(['dispute_id','order_id','reason','status'].map(k=>[k,case_[k]??null])),sources:evidence});
   if(encoder.encode(payload_text).length>160000)throw new AdapterError('Evidence is too large for this bounded AI review (160 KB text limit).',400);
   const response=await request_json(config.endpoint,{method:'POST',headers:{Authorization:'Bearer '+api_key,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({model,store:false,...(config.provider_key==='deepseek'?{reasoning:{effort:'none'}}:{}),instructions:INSTRUCTIONS,input:[{role:'user',content:[{type:'input_text',text:payload_text}]}],max_output_tokens:8000,text:{format:{type:'json_schema',name:'evidence_review_v2',strict:true,schema:REVIEW_SCHEMA}}})},fetchImpl,60000);
   if(response.status!=='completed')throw new AdapterError('AI review was not completed. Existing draft was left unchanged.');
   const texts=[],output=Object.hasOwn(response,'output')?response.output:[];if(!Array.isArray(output))throw new AdapterError('AI returned an unexpected response shape.');
   for(const item of output){if(!object(item)||!Array.isArray(Object.hasOwn(item,'content')?item.content:[]))throw new AdapterError('AI returned an unexpected response shape.');for(const content of (Object.hasOwn(item,'content')?item.content:[])){if(!object(content))throw new AdapterError('AI returned an unexpected response shape.');if(content.type==='refusal')throw new AdapterError('AI declined this review. Existing draft was left unchanged.');if(content.type==='output_text'&&typeof content.text==='string')texts.push(content.text);}}
   let decoded;try{decoded=_decode(texts.join(''));}catch{throw rejectedReview('review_json','The review was not valid strict JSON.');}
   let result;try{result=await validate_model_review(Array.isArray(decoded)?decoded[0]:decoded,case_,sources);}catch(error){
    const [code,detail]=REVIEW_REJECTIONS.get(error?.message)||['review_validation','The review failed source-integrity or validation checks.'];
    throw rejectedReview(code,detail);
   }
   return {...result,mode:'model',provider:config.provider,provider_key:config.provider_key,model,response_id:response.id??null,generated_at:utc_now(),warnings:[...result.warnings,'Actual model output; not human reviewed. Exact quote checks and full adverse-source coverage do not establish authenticity, completeness, or semantic support.']};
  });}
 };
}

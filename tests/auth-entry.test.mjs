// Offline public-test UI contracts; no live provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const html=read('public/index.html'),app=read('public/app.js');
test('public test has no login gate or fake authenticated identity',()=>{
 assert.doesNotMatch(html,/signin-with-chatgpt|integration-sign-in|external APIs disabled|not yet verified/);
 assert.doesNotMatch(app,/oai-authenticated-user-id|localStorage|sessionStorage|indexedDB/);
 assert.match(html,/Public test: no sign-in required/);
 assert.match(html,/AI calls require consent and may incur charges/);
 assert.match(html,/refresh clears edits and request recovery/);
});
test('page capabilities are random ephemeral isolation tokens, stable only in one page context',()=>{
 const source=app.slice(app.indexOf('let browserSession;'),app.indexOf('async function api('));
 const first=vm.createContext({crypto:webcrypto,Uint8Array}),second=vm.createContext({crypto:webcrypto,Uint8Array});
 vm.runInContext(source,first);vm.runInContext(source,second);
 const token=vm.runInContext('sessionCapability()',first);
 assert.match(token,/^[a-f0-9]{64}$/);
 assert.equal(vm.runInContext('sessionCapability()',first),token);
 assert.notEqual(vm.runInContext('sessionCapability()',second),token);
 assert.match(app,/headers:\{'Accept':'application\/json','X-EvidenceLens-Session':sessionCapability\(\)\}/);
});
test('public status renders integrations and only this page status without a login CTA',()=>{
 const nodes=new Map();const $=s=>{if(!nodes.has(s))nodes.set(s,{hidden:true,textContent:'',innerHTML:''});return nodes.get(s);};
 const state={status:{mode:'public_test',ai:{configured:true,provider:'DeepSeek',model:'deepseek-flash'},paypal:{configured:true}},offline:false};
 const source=app.slice(app.indexOf('function renderIntegrationStatus(){'),app.indexOf('\nfunction applyWorkspace'));
 const context=vm.createContext({$,state,language:'en',esc:s=>s,integrationText:()=> 'Not verified'});
 vm.runInContext(source,context);vm.runInContext('renderIntegrationStatus()',context);
 assert.equal($('#public-test-notice').hidden,false);assert.match($('#connection-status').textContent,/Public test/);assert.match($('#integration-details').innerHTML,/DeepSeek/);
});
test('boot starts no automatic paid or Sandbox read operation',()=>{
 assert.match(app,/beforeunload[^]*?if\(state\.dirty\)/);
 const boot=app.slice(app.lastIndexOf('(async()=>'));
 assert.match(boot,/Promise\.all\(\[api\('\/api\/status'\),api\('\/api\/demo'\)\]\)/);
 assert.match(boot,/applyWorkspace\(demo,'demo'\)/);
 assert.doesNotMatch(boot,/\/api\/(?:ai-review|paypal|extract-image)/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
// Simulate the hosted module-evaluation boundary: no randomness, timer or I/O.
// This is a focused restriction regression, not a substitute for workerd deployment.
test('bundled Worker evaluation makes no random, timer, clock, or network calls',async()=>{
 const source=await fs.readFile(new URL('../dist/server/index.js',import.meta.url),'utf8');
 const denied=()=>{throw Error('Operation forbidden outside request context');};
 const sandbox={TextEncoder,TextDecoder,Map,Set,Uint8Array,Uint32Array,Array,Object,JSON,Number,String,RegExp,Error,TypeError,structuredClone,fetch:denied,setTimeout:denied,setInterval:denied,crypto:{randomUUID:denied,getRandomValues:denied,subtle:new Proxy({},{get:()=>denied})},Date:class extends Date{constructor(){super();denied();}static now=denied;},Math:Object.assign(Object.create(Math),{random:denied})};
 vm.runInNewContext(source.replace('export default SERVER.DEFAULT;','globalThis.worker=SERVER.DEFAULT;'),sandbox,{timeout:1000});
 assert.equal(typeof sandbox.worker.fetch,'function');
});

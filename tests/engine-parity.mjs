import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import * as engine from '../worker/engine.js';
const root=path.resolve(import.meta.dirname,'..');
const oracle=path.resolve(root,'tests/oracle');
const cases=[];
const snapshot=fs.readFileSync(path.join(root,'fixtures/sandbox-dispute.json'),'utf8');
const bundle=fs.readFileSync(path.join(root,'fixtures/simulated-evidence.json'),'utf8');
cases.push({raw:snapshot,name:'sandbox-dispute.json',bundle,bname:'simulated-evidence.json'});
for(let i=0;i<12;i++){
 const raw=JSON.stringify({prefix:'😀重复值',dispute:{dispute_id:'D-'+i,reason:'😀重复值',status:'OPEN',create_time:'2024-02-29T03:04:05.123456789+02:00',disputed_transactions:[{seller_transaction_id:'CAP'},...(i%2?[{seller_transaction_id:'CAP2'}]:[])],messages:i%3?[]:[{text:'unreviewed'}],evidences:i%4?[]:{unrecognized:true}},order:{id:'O',create_time:'2024-01-01T00:00:00Z'}});
 const b=JSON.stringify({case_id:'D-'+i,order_id:'O',evidence:[{text:'中文😀 cafe\u0301\r\n4 of 10 received',assertion:'partial_delivery',occurred_at:'2024-03-01T00:00:00.000002Z'},{text:'All 10 files were delivered.',assertion:'seller_delivery_claim',occurred_at:'2024-03-01T00:00:00.000001Z'},{text:'buyer did not receive files',assertion:'buyer_nonreceipt',synthetic:!!(i%2)}]});cases.push({raw,name:'unicode😀.json',bundle:b,bname:'unicode-evidence.json'});
}
const program=`import sys,json\nsys.path.insert(0,sys.argv[1])\nimport engine\nresult=[]\nfor fixture in json.load(sys.stdin):\n c=engine.import_case(fixture['raw'].encode(),fixture['name'])\n s=engine.import_evidence(fixture['bundle'].encode(),fixture['bname'],c)\n a=engine.analyze(c,s)\n e=engine.verify_export(c,s,a['claims'])\n result.append({'case':c,'sources':s,'analysis':a,'export':e})\njson.dump(result,sys.stdout,ensure_ascii=False)`;
const py=spawnSync('python3',['-c',program,oracle],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:20_000_000});assert.equal(py.status,0,py.stderr);const expected=JSON.parse(py.stdout);
for(let [i,f] of cases.entries()){const c=await engine.import_case(f.raw,f.name),s=await engine.import_evidence(f.bundle,f.bname,c),a=await engine.analyze(c,s),e=await engine.verify_export(c,s,a.claims);assert.deepEqual(JSON.parse(JSON.stringify({case:c,sources:s,analysis:a,export:e})),expected[i],`fixture ${i}`)}
for(let raw of ['{"dispute_id":"A","dispute_id":"B"}','{"dispute_id":"A","x":{"a":1,"a":2}}','{"dispute_id":"\\ud800"}','{"dispute_id":"A","x":1e999}'])await assert.rejects(engine.import_case(raw));
const d=expected[0], changed=structuredClone(d.case);changed.status='RESOLVED';await assert.rejects(engine.analyze(changed,d.sources));await assert.rejects(engine.analyze(d.case,d.sources.slice(1)));const adverse=d.sources.find(s=>s.assertion==='partial_delivery');const exported=await engine.verify_export(d.case,d.sources,[{id:'bad',text:'All files were delivered.',status:'reviewed',citations:[engine._cite(adverse)]}]);assert.equal(exported.claims[0].status,'needs_review');assert.equal(exported.review_complete,false);assert.equal(exported.submission_permitted,false);
console.log('Engine parity: 13 complete Python/JS snapshots matched (case, sources, analysis, export); duplicate keys, surrogates, nonfinite, tampering, incomplete bundle and adverse guard passed.');

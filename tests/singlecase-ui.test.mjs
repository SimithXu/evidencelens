// Structural checks only. Root task owns real-browser responsive and visual QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const html=read('public/index.html'),app=read('public/app.js'),css=read('public/styles.css');
test('demo has one case-local navigation and no global-platform or account shell',()=>{
 const nav=html.match(/<nav\b[^]*?<\/nav>/g);assert.equal(nav.length,1);
 assert.match(nav[0],/aria-label="Sections in this case"/);
 assert.deepEqual([...nav[0].matchAll(/href="#([^"]+)"/g)].map(m=>m[1]),['overview','timeline','findings','draft']);
 assert.doesNotMatch(html,/class="(?:sidebar|workspace-label|sidebar-case|avatar)"|id="side-(?:id|mode)"|>Workspace<|>SESSION<|>Current case<|Evidence workspace/);
 assert.doesNotMatch(app,/#side-id|#side-mode/);
 assert.match(html,/data-en="Single-case demo" data-zh="单案件演示"/);
 assert.doesNotMatch(nav[0],/Settings|Accounts|All cases|Saved cases|New case/i);
});
test('memory-only scope and refresh loss are visible and bilingual without fake save controls',()=>{
 assert.match(html,/Page memory only\. Refresh clears changes — export before leaving\./);
 assert.match(html,/仅存于页面内存。刷新清除修改，离开前请导出。/);
 assert.doesNotMatch(html,/>Save case<|>Restore case<|>Create account<|>Sign in</);
 for(const id of ['case-summary-id','case-summary-reason','case-summary-status'])assert.equal([...html.matchAll(new RegExp('id="'+id+'"','g'))].length,1);
 assert.doesNotMatch(app,/localStorage|sessionStorage|indexedDB/);
});
test('decorative brand and file glyphs use inline SVG, with no external assets',()=>{
 assert.match(html,/<svg class="demo-mark" aria-hidden="true"/);
 assert.match(app,/<span class="file-icon" aria-hidden="true"><svg/);
 assert.doesNotMatch(html+app,/[◈◫◷▤ⓘ]/);
 assert.doesNotMatch(html,/<(?:img|script)[^>]+src="https?:/);
});
test('case tabs fit four equal mobile columns and preserve active and focus affordances',()=>{
 assert.match(css,/\.case-navigation nav\{[^}]*grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
 assert.match(css,/\.case-navigation \.nav-item\.active:after/);
 assert.match(css,/a:focus-visible/);
 assert.match(app,/setAttribute\('aria-current','page'\)/);
});

test('redundant visible case caption is absent while the four-section navigation stays labeled',()=>{assert.doesNotMatch(html,/class="case-nav-label"|>In this case<|>本案内容</);assert.doesNotMatch(css,/\.case-nav-label/);assert.match(html,/aria-label="Sections in this case" data-en-aria="Sections in this case" data-zh-aria="本案内容导航"/);const nav=html.match(/<nav\b[^]*?<\/nav>/)[0];assert.equal([...nav.matchAll(/class="nav-item/g)].length,4);});

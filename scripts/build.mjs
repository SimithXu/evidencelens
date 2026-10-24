import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname??path.dirname(new URL(import.meta.url).pathname),'..');
const assets={};for(const name of await fs.readdir(path.join(root,'public'))){const type={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8'}[path.extname(name)];if(type)assets['/'+name]={type,text:await fs.readFile(path.join(root,'public',name),'utf8')};}
const fixtures={};for(const name of ['sandbox-dispute.json','simulated-evidence.json'])fixtures[name]=await fs.readFile(path.join(root,'fixtures',name),'utf8');
const embedded=`export const ASSETS=${JSON.stringify(assets)};\nexport const FIXTURES=${JSON.stringify(fixtures)};\n`;
await fs.writeFile(path.join(root,'worker/embedded.js'),embedded);
let combined='// Generated from worker/{engine,adapters,server}.js and retained frontend assets.\n';
for(const [name,namespace] of [['image-validation','imagevalidation'],['engine','engine'],['adapter-schema','schema'],['adapters','adapters'],['images','images'],['embedded','embedded'],['server','server']]){
 let source=await fs.readFile(path.join(root,'worker',name+'.js'),'utf8');
 const names=[...source.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)/g)].map(m=>m[1]);
 source=source.replace(/^import \* as engine from ['"].*?['"];?\s*$/gm,'const engine=ENGINE;').replace(/^import\s*\{([^}]+)\}\s*from\s*['"]\.\/engine\.js['"];?\s*$/gm,'const {$1}=ENGINE;').replace(/^import\s*\{([^}]+)\}\s*from\s*['"]\.\/adapters\.js['"];?\s*$/gm,'const {$1}=ADAPTERS;').replace(/^import\s*\{([^}]+)\}\s*from\s*['"]\.\/embedded\.js['"];?\s*$/gm,'const {$1}=EMBEDDED;');
 source=source.replace(/^import\s*\{([^}]+)\}\s*from\s*['"]\.\/adapter-schema\.js['"];?\s*$/gm,'const {$1}=SCHEMA;');
 source=source.replace(/^import\s*\{([^}]+)\}\s*from\s*['"]\.\/image-validation\.js['"];?\s*$/gm,'const {$1}=IMAGEVALIDATION;').replace(/^import\s*\{([^}]+)\}\s*from\s*['"]\.\/images\.js['"];?\s*$/gm,'const {$1}=IMAGES;');
 source=source.replace(/export default createWorker\(\);/,'const DEFAULT=createWorker();').replace(/\bexport\s+(?=(?:async\s+)?(?:function|class|const|let)\b)/g,'');
 if(name==='server')names.push('DEFAULT');
 combined+=`const ${namespace.toUpperCase()}=(()=>{\n${source}\nreturn {${names.join(',')}};\n})();\n`;
}
combined+='export default SERVER.DEFAULT;\n';
await fs.writeFile(path.join(root,'worker/index.js'),combined);
await fs.mkdir(path.join(root,'dist/server'),{recursive:true});await fs.writeFile(path.join(root,'dist/server/index.js'),combined);
console.log('Built dependency-free single-file Worker.');

import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {readFile,writeFile,mkdir,readdir,copyFile,rm} from 'node:fs/promises';
const root=path.dirname(fileURLToPath(import.meta.url));
const out=path.join(root,'public/vendor');
await rm(out,{recursive:true,force:true});
const result=await build({absWorkingDir:root,entryPoints:['notes-entry.mjs'],outdir:out,entryNames:'notes',bundle:true,format:'esm',splitting:true,minify:true,target:'es2022',legalComments:'linked',metafile:true});
const packages=new Map();
for(const input of Object.keys(result.metafile.inputs)){
  const match=input.replaceAll('\\','/').match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//);if(!match)continue;
  const name=match[1];if(packages.has(name))continue;
  const dir=path.join(root,'node_modules',name),info=JSON.parse(await readFile(path.join(dir,'package.json'),'utf8'));
  const folder=path.join(out,'licenses',name.replaceAll('/','-'));await mkdir(folder,{recursive:true});
  const files=(await readdir(dir)).filter(f=>/^(licen[cs]e|copying|notice)(\.|$|-)/i.test(f));
  for(const file of files)await copyFile(path.join(dir,file),path.join(folder,file));
  packages.set(name,{name,version:info.version,license:info.license,files:files.map(f=>path.relative(out,path.join(folder,f)).replaceAll('\\','/'))});
}
await writeFile(path.join(out,'licenses.json'),JSON.stringify([...packages.values()],null,2));

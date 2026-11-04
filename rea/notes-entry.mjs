// Bundled locally; notes and diagrams never require a CDN.
import {marked} from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';
mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'dark',htmlLabels:false,flowchart:{htmlLabels:false},suppressErrorRendering:true});
let serial=0;
export async function preview(target,markdown){
  target.innerHTML=DOMPurify.sanitize(marked.parse(markdown),{FORBID_TAGS:['img','iframe','style','form','input'],FORBID_ATTR:['style']});
  for(const a of target.querySelectorAll('a')){a.rel='noopener noreferrer';a.target='_blank';}
  for(const block of target.querySelectorAll('pre > code.language-mermaid')){
    const code=block.textContent,container=document.createElement('div');container.className='diagram-preview';
    try{
      const {svg}=await mermaid.render('reaDiagram'+(++serial),code);
      container.innerHTML=DOMPurify.sanitize(svg,{USE_PROFILES:{svg:true,svgFilters:true},FORBID_TAGS:['foreignObject'],FORBID_ATTR:['onclick','onload']});
      block.parentElement.replaceWith(container);
    }catch(error){const warning=document.createElement('p');warning.textContent='Mermaid: '+error.message;block.parentElement.after(warning);}
  }
}

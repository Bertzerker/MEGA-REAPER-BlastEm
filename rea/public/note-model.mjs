// GPL-3.0-or-later. DOM-independent recoverable editor state for REA adapters.
const fields=note=>({title:note.title||'',markdown:note.markdown||'',classification:note.classification||'observed'});
export class NoteDraft {
  constructor(storage,workspace,writer){this.storage=storage;this.prefix=`rea:${workspace}:note:`;this.writer=writer;}
  key(id=this.base?.id){return this.prefix+id+':'+this.writer;}
  open(note,{recover=true}={}){
    this.base=note;this.fields=fields(note);this.revision=note.revision||0;this.latest=null;this.recovered=false;this.error='';
    if(recover){const saved=this.read(this.key());if(saved){this.fields=saved.fields;this.revision=saved.revision;this.recovered=true;if(this.revision!==(note.revision||0))this.latest=note;}}
    return this;
  }
  read(key){try{const value=JSON.parse(this.storage.getItem(key));return value&&typeof value.fields?.title==='string'&&typeof value.fields?.markdown==='string'&&Number.isInteger(value.revision)?value:null;}catch(e){this.error='Local draft recovery is unavailable: '+e.message;return null;}}
  get dirty(){return !!this.base&&(this.revision!==(this.base.revision||0)||Object.keys(this.fields).some(key=>this.fields[key]!==fields(this.base)[key]));}
  set(value){Object.assign(this.fields,value);this.persist();}
  persist(){
    try{if(this.dirty)this.storage.setItem(this.key(),JSON.stringify({id:this.base.id,fields:this.fields,revision:this.revision,updated:Date.now(),writer:this.writer}));else this.storage.removeItem(this.key());this.error='';}
    catch(e){this.error='Draft is not recoverable in this browser: '+e.message;}
  }
  foreign(){
    const prefix=this.prefix+this.base.id+':',result=[];
    try{for(let i=0;i<this.storage.length;i++){const key=this.storage.key(i);if(key?.startsWith(prefix)&&key!==this.key()){const draft=this.read(key);if(draft)result.push({key,...draft});}}}catch(e){this.error=e.message;}
    return result.sort((a,b)=>b.updated-a.updated);
  }
  restore(key){const saved=this.read(key);if(!saved)throw Error('Draft recovery is no longer available');this.fields=saved.fields;this.revision=saved.revision;this.recovered=true;if(this.revision!==(this.base.revision||0))this.latest=this.base;this.persist();}
  discard(){try{this.storage.removeItem(this.key());}catch{}this.fields=fields(this.base);this.revision=this.base.revision||0;this.latest=null;this.recovered=false;}
  rebase(){if(!this.latest)throw Error('Read the conflicting server version first');this.base=this.latest;this.revision=this.latest.revision||0;this.latest=null;this.persist();}
  async save(send){
    const submitted={...this.fields,revision:this.revision},id=this.base.id;
    try{
      const saved=await send(id,submitted);
      // Text typed while the request was pending remains a new local draft.
      const unchanged=Object.keys(this.fields).every(key=>this.fields[key]===submitted[key]);
      this.base=saved;this.revision=saved.revision||0;this.latest=null;this.recovered=false;
      if(unchanged)this.fields=fields(saved);this.persist();return saved;
    }catch(e){if(e.latest)this.latest=e.latest;this.persist();throw e;}
  }
}

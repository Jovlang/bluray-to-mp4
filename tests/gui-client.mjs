import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const html=fs.readFileSync(new URL('../gui.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const elements=new Map();
class Element {
  constructor(id=''){this.id=id;this.value='';this.listeners={};this.options=[];this.dataset={};this.hidden=false;this.disabled=false;this.textContent='';}
  addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
  dispatchEvent(event){for(const fn of this.listeners[event.type]||[])fn(event);}
  before(){} append(){} setAttribute(){}
  replaceChildren(...options){this.options=options;this.value=options[0]?.value||'';}
  add(option){this.options.push(option);}
}
for(const match of html.matchAll(/id="([^"]+)"/g))elements.set(match[1],new Element(match[1]));
elements.get('subtitleMode').value='none';
const pending=[];
const context=vm.createContext({
  document:{getElementById:id=>{assert(elements.has(id),id);return elements.get(id);},createElement:()=>new Element(),querySelector:()=>({textContent:'Path'}),querySelectorAll:()=>[]},
  Option:class {constructor(text,value){this.textContent=text;this.value=value;}},
  Event:class {constructor(type){this.type=type;}},
  fetch:()=>new Promise(()=>{}),
  setInterval:()=>{},clearTimeout:()=>{},setTimeout:fn=>{pending.push(fn);return pending.length;},console
});
vm.runInContext(script,context);
const evaluate=source=>vm.runInContext(source,context);
const plan={title:'Lohengrin',feature:{duration:12560,chapters:Array(45).fill(0)},warnings:[],video:{height:1080},interlace:{state:'interlaced'},retainedAudio:[{channels:5,tags:{language:'ger'}},{channels:2,tags:{language:'ger'}}],subtitleTracks:[{index:4,codec_name:'hdmv_pgs_subtitle',tags:{language:'eng'}}],subtitles:[],candidates:[]};
context.plan=plan;
plan.retainedAudio.forEach((t,index)=>{t.index=index;t.codec_name=index?'pcm_s16le':'dts';t.profile=index?'':'DTS-HD MA';});
plan.audioDecisions=plan.retainedAudio.map(track=>({track,retained:true}));plan.audio={index:0};plan.audioPreflight={status:'pending'};
evaluate("state={busy:false,phase:'ready',tools:{seconv:'tools/seconv',tesseractDir:'tools/tesseract'}}; $('output').value='movie.mp4'; showReport(plan); controls();");
assert.equal(elements.get('convert').disabled,false);
assert.match(elements.get('ready').textContent,/Ready to convert/);
assert.match(elements.get('summary').textContent,/Lohengrin · 3:29:20 · 1080i · German 5.0 \+ German stereo · English PGS · 45 chapters/);
assert.equal(elements.get('subtitleMode').value,'ocr');
evaluate("plan.warnings=['Interlace uncertain']; showReport(plan); controls();");
assert.equal(elements.get('convert').disabled,true);assert.equal(elements.get('interlaceChoice').hidden,false);
evaluate("plan.warnings=[]; plan.subtitleTracks.push({...plan.subtitleTracks[0],index:5}); showReport(null); showReport(plan); controls();");
assert.equal(elements.get('subtitleMode').value,'ocr');assert.equal(elements.get('convert').disabled,true);
evaluate("$('subtitleIndex').value='5'; controls();");assert.equal(elements.get('convert').disabled,false);
evaluate("audioInputs.forEach(i=>i.checked=false); audioDefaults();");assert.equal(elements.get('convert').disabled,true);
evaluate("audioInputs[1].checked=true; audioDefaults();");assert.equal(elements.get('convert').disabled,false);assert.equal(elements.get('defaultAudio').value,'1');
assert.equal(evaluate('values().selectedAudioIndices.join()'),'1');
evaluate("state.busy=true; controls();");assert.equal(elements.get('convert').disabled,true);
evaluate("state.busy=false; $('source').value='other source'; sourceChanged();");assert.equal(elements.get('convert').disabled,true);assert(pending.length);
assert(!html.includes('I reviewed the playlist'));
assert(html.includes('Output resolution'));evaluate("$('resolution').value='720p';");assert.equal(evaluate('values().resolution'),'720p');
console.log('PASS: compact summary, automatic source analysis, automatic OCR default, ambiguity prompts, warning/busy/source-change gates, and ready state without review checkbox.');

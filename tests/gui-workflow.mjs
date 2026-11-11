import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {GuiWorkflow,subtitleSelection,suggestedOutput} from '../gui-workflow.mjs';
import {inspectTracks,prepareAudio,expectedAudio} from '../apple-mp4.mjs';
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'gui-flow-'));
const temporary=[];
const srt='1\n00:00:01,000 --> 00:00:03,000\nCandidate text\n';
function sampleSup(){
  const segment=(type,time,payload=Buffer.alloc(0))=>{const b=Buffer.alloc(13+payload.length);b.write('PG');b.writeUInt32BE(time*90000,2);b[10]=type;b.writeUInt16BE(payload.length,11);payload.copy(b,13);return b;};
  const pcs=Buffer.alloc(19);pcs.writeUInt16BE(1920);pcs.writeUInt16BE(1080,2);pcs[10]=1;
  const clear=Buffer.from(pcs.subarray(0,11));clear[10]=0;
  const palette=Buffer.from([0,0,0,16,128,128,0,1,235,128,128,255]);
  const object=Buffer.from([0,0,0,0xc0,0,0,7,0,1,0,1,1,0,0]);
  return Buffer.concat([segment(22,1,pcs),segment(20,1,palette),segment(21,1,object),segment(128,1),segment(22,3,clear),segment(128,3)]);
}
try {
  const source=path.join(scratch,'Disc');fs.mkdirSync(path.join(source,'BDMV','PLAYLIST'),{recursive:true});
  const fixture={version:2,source,title:'Opera',warnings:[],subtitleTracks:[{index:4,id:'4608',codec_name:'hdmv_pgs_subtitle',tags:{language:'eng'}}],subtitles:[],feature:{playlist:'00001',duration:12560,chapters:[0]},candidates:[],retainedAudio:[],video:{height:1080},interlace:{state:'interlaced'}};
  fixture.sourceProbe={streams:[...[0,1].map(index=>({index,codec_type:'audio',codec_name:'dts',profile:'DTS-HD MA',channels:5,channel_layout:'5.0',tags:{language:'ger'}})),{index:2,codec_type:'audio',codec_name:'pcm_s16le',channels:2,tags:{language:'ger',title:'Commentary'}},...fixture.subtitleTracks.map(t=>({...t,codec_type:'subtitle'}))]};
  fixture.fingerprint='source';inspectTracks(fixture,fixture.sourceProbe);fixture.expected={audio:expectedAudio(fixture)};
  function controller({warnings=[],issues=[],failEncode=false,failPreflight=false,mediaWarnings=[]}={}) {
    const calls=[];
    const app=new GuiWorkflow(async(mode,args,append)=>{
      calls.push({mode,args});const opt=key=>args[args.indexOf('--'+key)+1];
      append('test progress\n');
      if(mode==='inspect')fs.writeFileSync(opt('plan'),JSON.stringify({...fixture,warnings,output:opt('output')}));
      if(mode==='prepare-media'){
        assert.equal(app.state.phase,'media-preflight');assert.match(app.state.status,/probing tracks and sampling video/);
        const p=JSON.parse(fs.readFileSync(opt('plan')));p.preflight={status:'complete'};p.warnings=mediaWarnings;
        fs.writeFileSync(opt('prepared-plan'),JSON.stringify(p));
      }
      if(mode==='prepare-audio'){
        assert.equal(app.state.phase,'audio-preflight');assert.match(app.state.status,/Preparing conversion.*exact duplicates/);
        if(failPreflight)throw Error('hash read failed');
        const p=JSON.parse(fs.readFileSync(opt('plan')));
        fs.writeFileSync(opt('prepared-plan'),JSON.stringify(prepareAudio(p,{checkSource:()=>p.fingerprint,hashTracks:(_p,tracks)=>new Map(tracks.map(t=>[t.index,'same-payload']))})));
      }
      if(mode==='encode'&&failEncode)throw Error('promotion failed');
      if(['encode','burn-pgs'].includes(mode)){assert.equal(app.state.report.audioPreflight.status,'complete');assert(app.state.audioUpdate);}
      if(mode==='ocr-subtitles'&&args.includes('--prepare-only')){fs.mkdirSync(opt('workdir'),{recursive:true});fs.writeFileSync(path.join(opt('workdir'),'review.json'),JSON.stringify({reviewNeeded:issues}));fs.writeFileSync(path.join(opt('workdir'),'candidate.srt'),srt);fs.writeFileSync(path.join(opt('workdir'),'timed.sup'),sampleSup());}
    });
    app.tools=()=>({seconv:'seconv',tesseractDir:'tesseract',ocrAvailable:true});
    return {app,calls};
  }
  async function inspect(app){await app.start('inspect',{source});temporary.push(app.directory);assert.equal(app.state.phase,'ready');assert(app.state.planPath);}
  {
    const {app,calls}=controller();await inspect(app);
    assert.equal(app.state.status,'Ready to convert ✓');
    await app.start('convert',{output:path.join(scratch,'ordinary.mp4'),subtitleMode:'none'});
    assert.equal(app.state.phase,'complete');assert.deepEqual(calls.map(c=>c.mode),['inspect','prepare-media','prepare-audio','encode']);
    assert.equal(app.state.report.retainedAudio.length,1);assert.match(app.state.audioUpdate,/1 exact duplicate/);
    assert.equal(JSON.parse(fs.readFileSync(app.state.planPath)).output,path.join(scratch,'ordinary.mp4'));
  }
  {
    const {app,calls}=controller();await inspect(app);
    await app.start('convert',{output:path.join(scratch,'selected.mp4'),subtitleMode:'none',selectedAudioIndices:[2],defaultAudio:'2'});
    assert.equal(app.state.phase,'complete');assert.deepEqual(app.state.report.retainedAudio.map(t=>t.index),[2]);assert.equal(app.state.report.audio.index,2);
    assert.equal(calls[2].mode,'prepare-audio');
  }
  {
    const {app,calls}=controller();await inspect(app);
    await app.start('convert',{output:path.join(scratch,'no-audio.mp4'),selectedAudioIndices:[]});
    assert.equal(app.state.phase,'error');assert.equal(calls.length,1);
  }
  {
    const {app,calls}=controller({failPreflight:true});await inspect(app);
    await app.start('convert',{output:path.join(scratch,'hash-failed.mp4'),subtitleMode:'burn'});
    assert.equal(app.state.phase,'error');assert.match(app.state.error,/hash read failed/);assert.deepEqual(calls.map(c=>c.mode),['inspect','prepare-media','prepare-audio']);
  }
  {
    const {app,calls}=controller({mediaWarnings:['Interlace uncertain']});await inspect(app);
    await app.start('convert',{output:path.join(scratch,'uncertain.mp4'),subtitleMode:'none'});
    assert.equal(app.state.phase,'ready');assert.match(app.state.status,/Preflight found/);assert.deepEqual(calls.map(c=>c.mode),['inspect','prepare-media']);assert.equal(app.state.report.warnings.length,1);
  }
  {
    const {app,calls}=controller();await inspect(app);
    await app.start('convert',{output:path.join(scratch,'burned.mp4'),subtitleMode:'burn'});
    assert.equal(app.state.phase,'complete');assert.deepEqual(calls.map(c=>c.mode),['inspect','prepare-media','prepare-audio','burn-pgs']);
    assert(calls[3].args.includes('--subtitle-index'));assert(!calls[3].args.includes('--base-mp4'));
  }
  {
    const {app,calls}=controller();await inspect(app);
    await app.start('convert',{output:path.join(scratch,'ocr.mp4'),subtitleMode:'ocr'});
    assert.equal(app.state.phase,'review');assert.deepEqual(calls.map(c=>c.mode),['inspect','prepare-media','prepare-audio','ocr-subtitles']);
    await app.start('resume',{reviewedSrt:app.state.review.candidate});assert.match(app.state.error,/separate reviewed/);assert.equal(calls.length,4);
    const reviewed=path.join(scratch,'clean-reviewed.srt');fs.writeFileSync(reviewed,srt.replace('Candidate text','Proofread text'));
    await app.start('resume',{reviewedSrt:reviewed});
    assert.equal(app.state.phase,'complete');assert.deepEqual(calls.map(c=>c.mode),['inspect','prepare-media','prepare-audio','ocr-subtitles','encode','ocr-subtitles']);
    assert(calls[3].args.includes('--prepare-only'));assert(calls[5].args.includes('--reviewed-srt'));
    const plan=JSON.parse(fs.readFileSync(app.state.planPath));assert.notEqual(plan.output,app.state.output);
  }
  {
    const {app,calls}=controller({issues:[{text:'suspicious'}]});await inspect(app);
    await app.start('convert',{output:path.join(scratch,'review.mp4'),subtitleMode:'ocr'});
    assert.equal(app.state.phase,'review');assert.equal(calls.length,4);assert(app.state.review.candidate);
    const reviewed=path.join(scratch,'reviewed.srt');fs.writeFileSync(reviewed,srt.replace('00:00:01,000','00:00:02,000'));
    await app.start('resume',{reviewedSrt:reviewed});assert.match(app.state.error,/timing/);assert.equal(calls.length,4);assert(app.state.review);
    fs.writeFileSync(reviewed,srt.replace('Candidate text','Corrected text'));
    await app.start('resume',{reviewedSrt:reviewed});
    assert.equal(app.state.phase,'complete');assert(calls.at(-1).args.includes('--reviewed-srt'));
  }
  {
    const {app,calls}=controller({warnings:['Interlace uncertain']});await inspect(app);
    await app.start('convert',{output:path.join(scratch,'blocked.mp4'),subtitleMode:'none'});
    assert.equal(app.state.phase,'error');assert.equal(calls.length,1);
  }
  {
    const {app,calls}=controller({failEncode:true});await inspect(app);
    await app.start('convert',{output:path.join(scratch,'recover.mp4'),subtitleMode:'none'});
    assert.equal(app.state.phase,'error');assert.equal(app.failedCommand.mode,'encode');
    await app.start('recover',{});assert.equal(app.state.phase,'complete');assert.equal(calls.at(-1).mode,'finalize');
  }
  {
    const {app,calls}=controller();await inspect(app);fs.appendFileSync(app.inspectionPath,' ');
    await app.start('convert',{output:path.join(scratch,'changed.mp4'),subtitleMode:'none'});
    assert.match(app.state.error,/plan changed/);assert.equal(calls.length,1);
  }
  {
    const {app}=controller();assert.throws(()=>app.start('convert',{}),/inspect/);
    const running=app.start('inspect',{source});assert.throws(()=>app.start('inspect',{source}),/already running/);await running;temporary.push(app.directory);
    const existing=path.join(scratch,'existing.mp4');fs.writeFileSync(existing,'keep');await app.start('convert',{output:existing});assert.match(app.state.error,/already exists/);assert.equal(fs.readFileSync(existing,'utf8'),'keep');
  }
  const duplicate={...fixture,subtitleTracks:[...fixture.subtitleTracks,{...fixture.subtitleTracks[0],index:5}]};
  assert.throws(()=>subtitleSelection(duplicate,'ocr','',{ocrAvailable:true}),/Choose which/);
  assert.equal(subtitleSelection(duplicate,'burn','5',{}).index,5);
  assert.throws(()=>subtitleSelection(fixture,'ocr','4',{ocrAvailable:false}),/SeConv/);
  assert.equal(suggestedOutput(source,'Opera: title'),path.join(scratch,'Opera  title.mp4'));
  console.log('PASS: automatic analysis, destination binding, no-review conversion, direct PGS burning, OCR pipeline/review pause, ambiguity and warning gates, immutable plans, no-overwrite, and single-job control.');
} finally {
  const targets=[scratch,...temporary];
  for(const target of targets){const resolved=path.resolve(target);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true});}
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fastScan} from '../fast-scan.mjs';
import {mpls,inspectTracks,expectedAudio,prepareMedia,encodeReviewed} from '../apple-mp4.mjs';
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'fast-scan-'));
function playlist(items){
  const mark=50+items.length*250,b=Buffer.alloc(mark+20);b.write('MPLS0200');b.writeUInt32BE(40,8);b.writeUInt32BE(mark,12);b.writeUInt16BE(items.length,46);
  items.forEach((item,i)=>{const at=50+i*250,body=at+2;b.writeUInt16BE(248,at);b.write(item.clip+'M2TS',body);b.writeUInt32BE(item.start*45000,body+12);b.writeUInt32BE(item.end*45000,body+16);const stn=body+32;b[stn+4]=1;b[stn+5]=2;b[stn+6]=1;let pos=stn+16;
    for(const [pid,attrs] of [[4113,[0x1b,0x43,0,0,0]],[4352,[0x86,0x61,100,101,117]],[4353,[0x80,0x31,100,101,117]],[4608,[0x90,101,110,103]]]){b[pos]=9;b[pos+1]=1;b.writeUInt16BE(pid,pos+2);pos+=10;b[pos]=attrs.length;Buffer.from(attrs).copy(b,pos+1);pos+=1+attrs.length;}
  });b.writeUInt16BE(1,mark+4);b[mark+7]=1;b.writeUInt32BE(45000,mark+10);return b;
}
try{
  const directory=path.join(scratch,'BDMV','PLAYLIST');fs.mkdirSync(directory,{recursive:true});
  const main=[{clip:'00001',start:0,end:120}];fs.writeFileSync(path.join(directory,'00001.mpls'),playlist(main));
  fs.writeFileSync(path.join(directory,'00002.mpls'),playlist([{clip:'00002',start:0,end:70},{clip:'00002',start:0,end:70}]));
  const p=fastScan({source:scratch,output:path.join(scratch,'movie.mp4'),mpls,inspectTracks,expectedAudio});
  assert.equal(p.feature.playlist,'00001');assert.equal(p.feature.duration,120);assert.deepEqual(p.feature.chapters,[0,1]);assert.equal(p.audioTracks.length,2);assert.equal(p.subtitleTracks.length,1);assert.equal(p.subtitleTracks[0].tags.language,'eng');assert.equal(p.audio.index,1);assert.equal(p.video.height,1080);assert.equal(p.preflight.status,'pending');assert.equal(p.interlace.state,'pending');assert.equal(p.timings.length,3);
  assert(!fs.existsSync(path.join(scratch,'BDMV','STREAM')));
  const plan=path.join(scratch,'scan.json');
  const cli=spawnSync(process.execPath,['apple-mp4.mjs','inspect','--source',scratch,'--plan',plan,'--ffprobe','DOES_NOT_EXIST','--ffmpeg','DOES_NOT_EXIST'],{encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert(!cli.stderr.includes('idet'));assert(JSON.parse(fs.readFileSync(plan)).timings.length);
  assert.throws(()=>encodeReviewed({p}),/metadata only/);
  const selected=structuredClone(p);selected.selectedAudioIndices=[1];selected.requestedDefaultAudio='1';
  const q={streams:p.sourceProbe.streams.map(t=>({...t,index:t.index+10,channels:t.codec_type==='audio'?t.index===1?5:2:undefined}))};
  let probed=0,sampled=0;
  const options={checkSource:()=> 'fingerprint',recoverLanguages:()=>{},probeSource:()=>{probed++;return q;},sampleVideo:()=>{sampled++;return {state:'progressive'};}};
  const ready=prepareMedia(selected,options);
  assert.equal(probed,1);assert.equal(sampled,1);assert.equal(ready.preflight.status,'complete');assert.equal(ready.audioPreflight.status,'pending');assert.deepEqual(ready.selectedAudioIndices,[11]);assert.equal(ready.audio.index,11);assert(ready.timings.some(t=>t.step==='ffprobe selected playlist'));assert.equal(p.preflight.status,'pending');
  const uncertain=prepareMedia(selected,{...options,sampleVideo:()=>({state:'uncertain'})});assert(uncertain.warnings.some(w=>/Interlace uncertain/.test(w)));
  assert.throws(()=>prepareMedia(selected,{...options,probeSource:()=>({streams:[]})}),/matched by PID/);
  let checks=0;assert.throws(()=>prepareMedia(selected,{...options,checkSource:()=>++checks===1?'old':'changed'}),/Source changed/);
  console.log('PASS: metadata-only fast scan with no media files or tools, playlist-loop handling, track/chapter metadata, per-step timings, provisional encoding gate, PID mapping, video preflight warnings and source-change checks.');
}finally{const target=path.resolve(scratch);assert(target.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(target,{recursive:true,force:true});}

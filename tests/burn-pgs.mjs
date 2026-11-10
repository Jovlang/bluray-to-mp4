import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {burnPgs} from '../pgs-ocr.mjs';
import crypto from 'node:crypto';
import {run,probe,encodeReviewed,buildEncodeCommand,fingerprint,chapterMetadata} from '../apple-mp4.mjs';

// Capture the renderer's normal progress so the test runner reports a compact
// result, while preserving complete diagnostics for a failed child test.
if(!process.argv.includes('--child')) {
  const r=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'--child'],{encoding:'utf8',maxBuffer:16*1024*1024});
  if(r.error)throw r.error;
  if(r.status!==0){process.stderr.write((r.stdout||'')+(r.stderr||''));process.exit(r.status||1);}
  console.log(r.stdout.split(/\r?\n/).filter(line=>line.startsWith('PASS:')).join('\n'));process.exit(0);
}
const original=process.cwd(),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'bluray-burn-test-'));
process.chdir(scratch);
try {
  const segment=(type,time,payload=Buffer.alloc(0))=>{
    const b=Buffer.alloc(13+payload.length);b.write('PG');b.writeUInt32BE(Math.round(time*90000),2);b[10]=type;b.writeUInt16BE(payload.length,11);payload.copy(b,13);return b;
  };
  const pcs=Buffer.alloc(19);pcs.writeUInt16BE(320);pcs.writeUInt16BE(180,2);pcs[4]=0x30;pcs[7]=0x80;pcs[10]=1;pcs.writeUInt16BE(50,15);pcs.writeUInt16BE(80,17);
  const window=Buffer.alloc(10);window[0]=1;window.writeUInt16BE(320,6);window.writeUInt16BE(180,8);
  const palette=Buffer.from([0,0,0,16,128,128,0,1,235,128,128,255]);
  const rle=Buffer.from(Array.from({length:20},()=>[0,0xc0,80,1,0,0]).flat());
  const object=Buffer.alloc(11+rle.length);object[3]=0xc0;object.writeUIntBE(4+rle.length,4,3);object.writeUInt16BE(80,7);object.writeUInt16BE(20,9);rle.copy(object,11);
  const clear=Buffer.from(pcs.subarray(0,11));clear[7]=0;clear[10]=0;
  fs.writeFileSync('captions.sup',Buffer.concat([segment(22,1,pcs),segment(23,1,window),segment(20,1,palette),segment(21,1,object),segment(128,1),segment(22,2,clear),segment(128,2)]));
  fs.writeFileSync('text.srt','1\n00:00:01,000 --> 00:00:02,000\nSource text\n');
  run('ffmpeg',['-v','error','-n','-f','lavfi','-i','color=blue:size=320x180:rate=50:duration=3','-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000:duration=3','-f','lavfi','-i','anullsrc=channel_layout=5.1:sample_rate=48000:duration=3','-i','text.srt','-map','0:v','-map','1:a','-map','2:a','-map','3:s','-vf','tinterlace=mode=interleave_top','-c:v','ffv1','-field_order','tt','-c:a','pcm_s16le','-c:s','srt','-metadata','title=Source title','-metadata:s:a:0','language=eng','-metadata:s:a:0','title=Stereo','-metadata:s:a:1','language=fra','-metadata:s:a:1','title=Surround','-disposition:a:0','0','-disposition:a:1','default','-metadata:s:s:0','language=eng','-metadata:s:s:0','title=Source English','-disposition:s:0','forced','-output_ts_offset','100','original.mkv']);
  const source=path.resolve('disc');fs.mkdirSync(source+'/BDMV/PLAYLIST',{recursive:true});fs.mkdirSync(source+'/BDMV/STREAM');fs.copyFileSync('original.mkv',source+'/BDMV/STREAM/00000.m2ts');
  const m=Buffer.alloc(300);m.write('MPLS0200');m.writeUInt32BE(40,8);m.writeUInt16BE(1,46);m.writeUInt16BE(248,50);m.write('00000M2TS',52);m.writeUInt32BE(270000,68);m[88]=1;m[89]=2;m[90]=1;
  let at=100;for(const [pid,codec,lang] of [[0x1011,0x1b,''],[0x1100,0x80,'eng'],[0x1101,0x80,'fra'],[0x1200,0x90,'eng']]){m[at]=9;m[at+1]=1;m.writeUInt16BE(pid,at+2);m[at+10]=5;m[at+11]=codec;if(lang)m.write(lang,at+(codec===0x90?12:13));at+=16;}
  fs.writeFileSync(source+'/BDMV/PLAYLIST/00000.mpls',m);
  const originalProbe=probe(['-i','original.mkv']);
  const p={version:2,source,output:path.resolve('never-encoded.mp4'),title:'Source title',warnings:[],feature:{playlist:'00000',duration:3,items:[{clip:'00000',start:0,end:3}],chapters:[0,1.5]},video:originalProbe.streams[0],retainedAudio:originalProbe.streams.filter(s=>s.codec_type==='audio'),subtitles:originalProbe.streams.filter(s=>s.codec_type==='subtitle'),subtitleTracks:[{index:4,id:'0x1200',codec_name:'hdmv_pgs_subtitle',tags:{language:'eng'}}],filters:['bwdif=mode=send_frame:parity=auto:deint=all','scale=320:180','format=yuv420p']};p.audio=p.retainedAudio[1];p.fingerprint=fingerprint(source,p.feature);
  const sha=b=>crypto.createHash('sha256').update(b).digest('hex');fs.writeFileSync('plan.json',JSON.stringify(p));
  fs.mkdirSync('pgs-work');fs.copyFileSync('captions.sup','pgs-work/clip-0-00000.sup');fs.writeFileSync('pgs-work/job.json',JSON.stringify({version:1,planHash:sha(fs.readFileSync('plan.json')),language:'eng',pid:0x1200,artifacts:{'clip-0-00000.sup':sha(fs.readFileSync('captions.sup'))}}));
  const values={plan:'plan.json',language:'eng',workdir:'pgs-work',output:'burned.mp4'};
  const sourceInput=['-i',source+'/BDMV/STREAM/00000.m2ts'];let rendered;
  const ctx={args:[],opt:(k,d)=>values[k]??d,hash:sha,fingerprint,probe,run,ff:'ffmpeg',encodeReviewed:options=>{rendered=options;encodeReviewed({...options,sourceInput});}};
  assert(!fs.existsSync(p.output));assert(!fs.existsSync(p.output+'.verified.json'));
  burnPgs(ctx);
  assert(rendered.burn);assert.equal(rendered.p.source,source);
  const command=buildEncodeCommand(p,{sourceInput,metadata:'chapters.ffmeta',output:'unused.mp4',burn:rendered.burn});
  assert(command.includes('0:1'));assert(command.includes('0:2'));assert(command.includes('0:3'));assert(!command.includes('-copyts'));assert(!command.includes(p.output));assert(command.includes('aac'));assert(command.includes('512k'));assert(command.includes('256k'));
  const ordinary=buildEncodeCommand(p,{sourceInput,metadata:'chapters.ffmeta',output:'ordinary.mp4'});
  const settings=a=>a.slice(a.indexOf('-map_metadata'));
  assert.deepEqual(settings(command).slice(0,-1),settings(ordinary).slice(0,-1),'burn must share all audio/text/metadata/output settings with normal encode');
  const q=probe(['-i','burned.mp4']);assert.equal(q.streams[0].codec_name,'h264');assert.equal(q.streams[0].avg_frame_rate,'25/1');assert.equal(q.streams[0].pix_fmt,'yuv420p');assert.equal(q.streams[0].field_order,'progressive');assert.equal(q.format.tags.title,'Source title');assert.equal(q.streams.filter(s=>s.codec_type==='subtitle').length,1);assert(q.streams.filter(s=>s.codec_type==='audio').every(s=>s.codec_name==='aac'&&s.profile==='LC'));assert.equal(q.chapters.length,2);
  const receipt=JSON.parse(fs.readFileSync('burned.mp4.verified.json'));assert.equal(receipt.operation,'pgs-burn');assert.equal(receipt.source,source);assert.equal(receipt.pgsHash,rendered.burn.hash);
  const before=sha(fs.readFileSync('burned.mp4'));assert.throws(()=>encodeReviewed({...rendered,sourceInput,burn:{...rendered.burn,hash:'different'}}),/matching render/);assert.equal(sha(fs.readFileSync('burned.mp4')),before);
  function pixel(time) {
    const r=spawnSync('ffmpeg',['-v','error','-ss',String(time),'-i','burned.mp4','-frames:v','1','-pix_fmt','gray','-f','rawvideo','-'],{encoding:null,maxBuffer:1024*1024});
    assert.equal(r.status,0);assert.equal(r.stdout.length,320*180);return r.stdout[90*320+90];
  }
  assert(pixel(.5)>10&&pixel(.5)<50,'wrong video source or caption appeared too soon');assert(pixel(1.5)>150,'PGS bitmap was not burned at its source time');assert(pixel(2.5)>10&&pixel(2.5)<50,'wrong video source or PGS bitmap did not clear');
  // Long chapters plus a microsecond subtitle timebase must not overflow the
  // automatically generated QuickTime chapter track's 32-bit sample durations.
  fs.writeFileSync('chapters.ffmeta',';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=4000000\ntitle=Long first\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=4000000\nEND=9000000\ntitle=Long second\n');
  fs.writeFileSync('text.srt','1\n00:00:01,000 --> 00:00:02,000\nTest\n');
  run('ffmpeg',['-v','error','-n','-i','burned.mp4','-f','ffmetadata','-i','chapters.ffmeta','-i','text.srt','-map','0:v','-map','0:a','-map','2:s','-map_chapters','1','-c','copy','-c:s','mov_text','-movie_timescale','1000','chapters.mp4']);
  const chapters=probe(['-i','chapters.mp4']).chapters;assert.equal(chapters.length,2);assert.equal(chapters[1].start_time,'4000.000000');assert.equal(chapters[1].end_time,'9000.000000');
  console.log('PASS: burn-pgs without any base MP4/receipt; original PCM -> AAC-LC tracks/defaults/text/chapters via shared renderer; source-video deinterlace/scale and timed PGS; render-identity no-overwrite checks; long chapters.');
}finally {
  process.chdir(original);const target=path.resolve(scratch);
  if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('bluray-burn-test-'))throw Error('Unsafe test cleanup');
  fs.rmSync(target,{recursive:true,force:true});
}

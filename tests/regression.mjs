import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {moveNoReplace,mpls,playlistLanguages,validate,audioScore,run,selectTracks,trackOptions,verifyTracks,probe,restoreSubtitleDefaults} from '../apple-mp4.mjs';
const originalCwd=process.cwd();
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'bluray-to-mp4-test-'));
process.chdir(scratch);fs.mkdirSync('work');
try {
{
// Two trimmed play items and two entry marks, including a mark in item two.
const b=Buffer.alloc(200);b.write('MPLS0200');b.writeUInt32BE(40,8);b.writeUInt32BE(110,12);b.writeUInt16BE(2,46);
for(const [at,clip,start,end] of [[50,'00001',10,12],[72,'00002',20,23]]){b.writeUInt16BE(20,at);b.write(clip+'M2TS',at+2);b.writeUInt32BE(start*45000,at+14);b.writeUInt32BE(end*45000,at+18);}
b.writeUInt16BE(2,114);for(const [at,ref,time] of [[116,0,10],[130,1,21]]){b[at+1]=1;b.writeUInt16BE(ref,at+2);b.writeUInt32BE(time*45000,at+4);}fs.writeFileSync('work/test.mpls',b);
const p=mpls('work/test.mpls');assert.equal(p.duration,5);assert.deepEqual(p.chapters,[0,3]);assert.deepEqual(p.items.map(i=>i.clip),['00001','00002']);assert(audioScore({channels:6,codec_name:'dts'})>audioScore({channels:2,codec_name:'ac3'}));assert(audioScore({channels:6,tags:{title:'Director commentary'}})<0);
run('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=25:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2','-vf',"scale=w='min(iw,1920)':h='min(ih,1080)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",'-c:v','libx264','-crf','20','-preset','medium','-fps_mode','passthrough','-c:a','aac','-profile:a','aac_low','-b:a','256k','-movflags','+faststart','work/test.mp4']);
validate('work/test.mp4',{feature:{duration:2},video:{avg_frame_rate:'25/1'}});
assert.throws(()=>validate('work/test.mp4',{feature:{duration:200},video:{avg_frame_rate:'25/1'}},false),/duration/);
run('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=50:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2','-vf','tinterlace=mode=interleave_top,bwdif=mode=send_frame:parity=auto:deint=all,format=yuv420p','-c:v','libx264','-crf','20','-preset','medium','-c:a','aac','-profile:a','aac_low','-b:a','256k','-movflags','+faststart','work/interlace.mp4']);
validate('work/interlace.mp4',{feature:{duration:2},video:{avg_frame_rate:'25/1'}});

}
{
fs.writeFileSync('work/en.srt','1\n00:00:00,100 --> 00:00:01,700\nEnglish test\n');
fs.writeFileSync('work/fr.srt','1\n00:00:00,200 --> 00:00:01,500\nFrench test\n');
run('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=25:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2','-f','lavfi','-i','anullsrc=channel_layout=7.1:sample_rate=48000:duration=2','-i','work/en.srt','-i','work/fr.srt','-map','0:v','-map','1:a','-map','2:a','-map','1:a','-map','1:a','-map','3:s','-map','4:s','-c:v','ffv1','-c:a','pcm_s16le','-ac:a:0','2','-ac:a:2','2','-ac:a:3','2','-c:s','srt','-metadata:s:a:0','language=eng','-metadata:s:a:0','title=Stereo','-metadata:s:a:1','language=fra','-metadata:s:a:1','title=Surround','-metadata:s:a:2','language=eng','-metadata:s:a:2','title=Stereo','-metadata:s:a:3','title=Commentary','-disposition:a:0','default','-disposition:a:1','original','-disposition:a:2','0','-metadata:s:s:0','language=eng','-metadata:s:s:0','title=English','-disposition:s:0','default','-metadata:s:s:1','language=fra','-metadata:s:s:1','title=French forced','-disposition:s:1','forced','work/multi.mkv']);
const q=probe(['-i','work/multi.mkv']),tracks=q.streams.filter(s=>s.codec_type==='audio');
const hashText=run('ffmpeg',['-v','error','-i','work/multi.mkv','-map','0:a','-c','copy','-f','streamhash','-hash','sha256','-']);
const hashes=new Map(hashText.trim().split(/\r?\n/).filter(line=>!line.startsWith('#')).map(line=>{const m=line.match(/^(\d+),a,SHA256=(\w+)$/) || line.match(/^(\d+),\s*\d+,\s*([a-f0-9]{64})$/i);assert(m);return [tracks[Number(m[1])].index,m[2]];}));

const p={version:2,feature:{duration:2},video:{avg_frame_rate:'25/1'}};
selectTracks(p,q,undefined,hashes);
assert.equal(p.retainedAudio.length,2);assert.equal(p.subtitles.length,2);assert.equal(p.audio.channels,8);assert(p.audioDecisions.some(d=>d.duplicateOf!==undefined));assert(p.audioDecisions.some(d=>d.reason.includes('description')));
const synthetic={streams:[...q.streams,{index:99,codec_type:'subtitle',codec_name:'hdmv_pgs_subtitle',tags:{language:'eng'}}]};
const p2={};selectTracks(p2,synthetic,undefined,hashes);assert.equal(p2.subtitleDecisions.at(-1).retained,false);
run('ffmpeg',['-v','error','-y','-i','work/multi.mkv','-map','0:v:0','-c:v','libx264','-crf','20','-preset','medium','-pix_fmt','yuv420p',...trackOptions(p),'-movflags','+faststart','work/multi.mp4']);
const out=validate('work/multi.mp4',p);assert.equal(out.streams.filter(s=>s.codec_type==='audio')[1].channels,6);
const missing=structuredClone(out);missing.streams=missing.streams.filter(s=>s.codec_type!=='subtitle');assert.throws(()=>verifyTracks(missing,p),/count/);
const bad=structuredClone(out);bad.streams.find(s=>s.codec_type==='audio').profile='HE-AAC';assert.throws(()=>verifyTracks(bad,p),/codec/);
const flags=structuredClone(out);flags.streams.find(s=>s.codec_type==='subtitle').disposition.forced=1;assert.throws(()=>verifyTracks(flags,p),/disposition/);
fs.writeFileSync('work/chapters.ffmeta',';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=One\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=Two\n');
const noDefaults=structuredClone(p);for(const t of noDefaults.subtitles)t.disposition.default=0;
run('ffmpeg',['-v','error','-y','-i','work/multi.mkv','-f','ffmetadata','-i','work/chapters.ffmeta','-map_chapters','1','-map','0:v:0','-c:v','libx264','-crf','20','-preset','medium','-pix_fmt','yuv420p',...trackOptions(noDefaults),'-movflags','+faststart','work/multi-no-default-sub.mp4']);
const before=fs.readFileSync('work/multi-no-default-sub.mp4');restoreSubtitleDefaults('work/multi-no-default-sub.mp4',noDefaults);const after=fs.readFileSync('work/multi-no-default-sub.mp4');assert.equal(before.length,after.length);assert.equal(before.reduce((n,b,i)=>n+(b!==after[i]),0),1);assert.equal(validate('work/multi-no-default-sub.mp4',noDefaults).chapters.length,2);

}

{
 const track={index:0,channels:6,channel_layout:'5.1(side)',tags:{language:'eng',title:'Side surround'}};
 const side={retainedAudio:[track],audio:track,subtitles:[]};
 run('ffmpeg',['-v','error','-y','-f','lavfi','-i','anullsrc=channel_layout=5.1(side):sample_rate=48000:duration=1',...trackOptions(side),'-movflags','+faststart','work/side.mp4']);
 const q=probe(['-i','work/side.mp4']);verifyTracks(q,side);assert.equal(q.streams[0].channel_layout,'5.1');
 const disc='work/disc';fs.mkdirSync(disc+'/BDMV/PLAYLIST',{recursive:true});
 const b=Buffer.alloc(140);b.writeUInt32BE(40,8);b[89]=1;b[100]=9;b[101]=1;b.writeUInt16BE(0x1100,102);b[110]=5;b[111]=0x80;b.write('eng',113);fs.writeFileSync(disc+'/BDMV/PLAYLIST/00000.mpls',b);
 const languageProbe={streams:[{id:'0x1100',codec_type:'audio'}]};playlistLanguages({source:disc,feature:{playlist:'00000'}},languageProbe);assert.equal(languageProbe.streams[0].tags.language,'eng');
}
{
 const from="work/source's & value.txt",good='work/good.txt',to='work/moved.txt';
 fs.writeFileSync(from,'new');fs.writeFileSync(good,'good');
 assert.throws(()=>moveNoReplace(from,good));assert.equal(fs.readFileSync(good,'utf8'),'good');assert.equal(fs.readFileSync(from,'utf8'),'new');
 moveNoReplace(from,to);assert.equal(fs.existsSync(from),false);assert.equal(fs.readFileSync(to,'utf8'),'new');
}
console.log('PASS: playlist trims/chapters; audio ranking/exclusion/deduplication; H.264/AAC encode and full decode; multiple audio and text subtitle tracks; language/title/default/forced metadata; 7.1 to 5.1; no default subtitle; chapter safety; codec/count/disposition/duration rejection.');
}finally{process.chdir(originalCwd);const target=path.resolve(scratch);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('bluray-to-mp4-test-'))throw Error('Unsafe cleanup path');fs.rmSync(target,{recursive:true,force:true});}

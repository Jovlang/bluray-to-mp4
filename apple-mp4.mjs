#!/usr/bin/env node
// Node.js 20+, ffmpeg/ffprobe with libbluray and libx264. No npm dependencies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {ocrSubtitles,burnPgs} from './pgs-ocr.mjs';
const args=process.argv.slice(2), mode=args.shift();
function opt(k,d){const i=args.indexOf('--'+k);return i<0?d:args[i+1];}
function run(bin,a,inherit=false){const r=spawnSync(bin,a,{encoding:'utf8',stdio:inherit?'inherit':'pipe',maxBuffer:64*1024*1024});if(r.error)throw r.error;if(r.status!==0)throw Error(`${bin} failed (${r.status}): ${r.stderr||''}`);return r.stdout;}
const ff=opt('ffmpeg','ffmpeg'), fp=opt('ffprobe','ffprobe');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function probe(input){return JSON.parse(run(fp,['-v','error',...input,'-show_streams','-show_format','-show_chapters','-of','json']));}
function moveNoReplace(source,destination){
 if(process.platform==='win32'){
  // File.Move's two-argument overload refuses existing destinations. Unlike
  // fs.rename it cannot replace a good output, and needs no hard-link privilege.
  const literal=s=>"'"+path.resolve(s).replaceAll("'","''")+"'";
  const command="$ErrorActionPreference='Stop';[System.IO.File]::Move("+literal(source)+","+literal(destination)+")";
  run('powershell.exe',['-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')]);
 }else{fs.linkSync(source,destination);fs.unlinkSync(source);}
}
function mpls(file){const b=fs.readFileSync(file);if(b.toString('ascii',0,4)!=='MPLS')throw Error('Invalid MPLS');const p=b.readUInt32BE(8),m=b.readUInt32BE(12),n=b.readUInt16BE(p+6);let at=p+10,items=[];for(let i=0;i<n;i++){const len=b.readUInt16BE(at),s=at+2;const clip=b.toString('ascii',s,s+5),start=b.readUInt32BE(s+12)/45000,end=b.readUInt32BE(s+16)/45000;items.push({clip,start,end});at=s+len;}let chapters=[],base=0;const bases=items.map(i=>{const v=base;base+=i.end-i.start;return v;});if(m && m+6<=b.length){const count=b.readUInt16BE(m+4);for(let i=0;i<count;i++){const s=m+6+i*14,ref=b.readUInt16BE(s+2);if(b[s+1]===1&&items[ref]){const t=bases[ref]+b.readUInt32BE(s+4)/45000-items[ref].start;if(t>=0&&t<base)chapters.push(t);}}}return {playlist:path.basename(file,'.mpls'),duration:base,items,chapters:[...new Set([0,...chapters])].sort((a,b)=>a-b),signature:JSON.stringify(items),hash:hash(b)};}
function fingerprint(root,pl){return hash(JSON.stringify({mpls:hash(fs.readFileSync(path.join(root,'BDMV','PLAYLIST',pl.playlist+'.mpls'))),clips:pl.items.map(i=>{const f=path.join(root,'BDMV','STREAM',i.clip+'.m2ts'),s=fs.statSync(f);return [f,s.size,s.mtimeMs];})}));}
function input(p){return ['-playlist',String(Number(p.feature.playlist)),'-i','bluray:'+p.source];}
function detect(p,v){const samples=[];for(const frac of [.12,.48,.82]){const r=spawnSync(ff,['-hide_banner','-ss',String(p.feature.duration*frac),...input(p),'-map',`0:${v.index}`,'-an','-sn','-vf','idet','-frames:v','300','-f','null','-'],{encoding:'utf8',maxBuffer:8*1024*1024});if(r.status!==0)throw Error(r.stderr);const all=[...r.stderr.matchAll(/Multi frame detection: TFF:\s*(\d+) BFF:\s*(\d+) Progressive:\s*(\d+) Undetermined:\s*(\d+)/g)];if(!all.length)throw Error('idet returned no result');const x=all.at(-1).slice(1).map(Number);samples.push({tff:x[0],bff:x[1],progressive:x[2],undetermined:x[3]});}const t=samples.reduce((a,s)=>a+s.tff+s.bff,0),g=samples.reduce((a,s)=>a+s.progressive,0),ratio=t/Math.max(1,t+g);return {samples,ratio,state:ratio>.8?'interlaced':ratio<.05&&g>300?'progressive':'uncertain',fieldOrder:v.field_order};}
function audioScore(s){const label=JSON.stringify(s.tags||{});if(/commentary|descriptive|description|visually impaired/i.test(label)||s.disposition?.comment||s.disposition?.visual_impaired)return -1e6;return Math.min(s.channels||0,6)*100+(/truehd|dts|pcm|flac/.test(s.codec_name)?40:0)+(s.disposition?.default?10:0);}

const textCodecs = new Set(['subrip','srt','ass','ssa','webvtt','mov_text','text','ttml','microdvd','mpl2','jacosub','sami','realtext','subviewer','subviewer1','vplayer','pjs','stl','eia_608']);
const titleOf = s => s.tags?.title || s.tags?.handler_name || '';
const languageOf = s => s.tags?.language || 'und';
function playlistLanguages(p,q) {
 const b=fs.readFileSync(path.join(p.source,'BDMV','PLAYLIST',p.feature.playlist+'.mpls'));
 const body=b.readUInt32BE(8)+12;
 // First play item, primary angle. STN follows its fixed 32-byte header.
 if(b.readUInt16BE(body+9)&0x10)return;
 const stn=body+32, counts=[b[stn+4],b[stn+5],b[stn+6]];
 let at=stn+16;
 for(let i=0;i<counts.reduce((a,b)=>a+b,0);i++){
  const n=b[at],entry=at+1,pid=b[entry]===1?b.readUInt16BE(entry+1):undefined;
  at=entry+n;const len=b[at],attr=at+1,codec=b[attr];
  const langAt=[0x80,0x81,0x82,0x83,0x84,0x85,0x86,0xa1,0xa2].includes(codec)?attr+2:[0x90,0x91].includes(codec)?attr+1:codec===0x92?attr+2:undefined;
  if(langAt!==undefined){const lang=b.toString('ascii',langAt,langAt+3);if(/^[a-z]{3}$/.test(lang)){const stream=q.streams.find(s=>Number(s.id)===pid);if(stream&&!stream.tags?.language)stream.tags={...stream.tags,language:lang};}}
  at=attr+len;
 }
}
const targetLayout=t=>t.channels>6?'5.1':({'5.1(side)':'5.1','5.0(side)':'5.0'}[t.channel_layout]||t.channel_layout);
function dispositions(s, isDefault) {
 const flags = Object.entries(s.disposition || {}).filter(([k,v]) => v && k !== 'default').map(([k]) => k);
 if (isDefault ?? !!s.disposition?.default) flags.unshift('default');
 return flags.join('+') || '0';
}
function audioHashes(p, tracks) {
 if (!tracks.length) return new Map();
 console.error('Checking retained audio payloads for exact duplicates (one full read; no encoding)...');
 const a=['-v','error',...input(p)];
 for (const t of tracks) a.push('-map', '0:'+t.index);
 a.push('-c','copy','-f','streamhash','-hash','sha256','-');
 const lines=run(ff,a).trim().split(/\r?\n/), result=new Map();
 for (const line of lines) {const m=line.match(/^(\d+),a,SHA256=([a-f0-9]+)$/i) || line.match(/^(\d+),\s*\d+,\s*([a-f0-9]{64})$/i);if(m && tracks[Number(m[1])])result.set(tracks[Number(m[1])].index,m[2]);}
 if (result.size !== tracks.length) throw Error('Could not fingerprint all audio payloads');
 return result;
}
function selectTracks(p,q,chosen,hashes) {
 p.audioTracks=q.streams.filter(s=>s.codec_type==='audio');
 const retained=[],seen=new Map();
 p.audioDecisions=p.audioTracks.map(track=>{
  if(audioScore(track)<0)return {track,retained:false,reason:'Commentary or audio description'};
  // Equal labels alone never prove equivalence. Only identical full payloads,
  // codec, channel layout and language are deduplicated. Keep the first copy.
  const digest=hashes.get(track.index);
  const key=digest && JSON.stringify([digest,track.codec_name,track.channels,track.channel_layout,track.sample_rate,track.start_time,track.duration,languageOf(track),titleOf(track),dispositions(track,false)]);
  if(key && seen.has(key))return {track,retained:false,reason:'Exact equivalent payload of stream '+seen.get(key),duplicateOf:seen.get(key)};
  if(key)seen.set(key,track.index);retained.push(track);return {track,retained:true,reason:'Useful audio'};
 });
 p.retainedAudio=retained;
 const requested=chosen===undefined?undefined:Number(chosen);
 const decision=p.audioDecisions.find(d=>d.track.index===requested);
 const index=decision?.duplicateOf ?? requested;
 p.audio=requested===undefined?[...retained].sort((a,b)=>audioScore(b)-audioScore(a))[0]:retained.find(t=>t.index===index);
 if(!p.audio)throw Error('No retained main audio; --audio must name a useful retained audio track');
 for(const d of p.audioDecisions)d.default=d.retained && d.track.index===p.audio.index;
 p.subtitleTracks=q.streams.filter(s=>s.codec_type==='subtitle');
 p.subtitleDecisions=p.subtitleTracks.map(track=>({track,retained:textCodecs.has(track.codec_name),reason:textCodecs.has(track.codec_name)?'Text subtitle -> mov_text':'Image/PGS or unsupported non-text subtitle; no OCR/burn-in'}));
 p.subtitles=p.subtitleDecisions.filter(d=>d.retained).map(d=>d.track);
}
function trackOptions(p) {
 const a=[];
 for(const t of p.retainedAudio)a.push('-map','0:'+t.index);
 for(const t of p.subtitles)a.push('-map','0:'+t.index);
 function metadata(t,type,i){
  const spec=type+':'+i;
  a.push('-map_metadata:s:'+spec,'0:s:'+t.index,'-metadata:s:'+spec,'language='+languageOf(t));
  if(titleOf(t))a.push('-metadata:s:'+spec,'title='+titleOf(t),'-metadata:s:'+spec,'handler_name='+titleOf(t));
  a.push('-disposition:'+spec,dispositions(t,type==='a'?t.index===p.audio.index:undefined));
 }
 p.retainedAudio.forEach((t,i)=>{
  metadata(t,'a',i);a.push('-c:a:'+i,'aac','-profile:a:'+i,'aac_low','-b:a:'+i,t.channels>2?'512k':'256k');
  if(t.channels>6)a.push('-ac:a:'+i,'6','-channel_layout:a:'+i,'5.1');
  else if(['5.1(side)','5.0(side)'].includes(t.channel_layout))a.push('-filter:a:'+i,'pan='+targetLayout(t)+'|FL=FL|FR=FR|FC=FC'+(t.channels===6?'|LFE=LFE':'')+'|BL=SL|BR=SR','-channel_layout:a:'+i,targetLayout(t));
  else if(t.channel_layout && t.channel_layout!=='unknown')a.push('-channel_layout:a:'+i,t.channel_layout);
 });
 p.subtitles.forEach((t,i)=>{metadata(t,'s',i);a.push('-c:s:'+i,'mov_text');});
 return a;
}
// MOV muxing enables a subtitle even when all input default flags are clear.
// Restore only tkhd's enabled bit in the generated partial, without resizing
// any atom or touching media offsets, chapter tracks, or source files.
function restoreSubtitleDefaults(file,p) {
 if(!p.subtitles.length)return;
 const streams=probe(['-i',file]).streams.filter(s=>s.codec_type==='subtitle');
 if(streams.length!==p.subtitles.length)throw Error('Subtitle count mismatch before flag restoration');
 const desired=new Map(streams.map((s,i)=>[Number(s.id),!!p.subtitles[i].disposition?.default]));
 const fd=fs.openSync(file,'r+');
 try {
  const total=fs.fstatSync(fd).size,header=Buffer.alloc(16);let moov,offset;
  for(let at=0;at<total;){
   if(fs.readSync(fd,header,0,16,at)<8)throw Error('Truncated MP4 atom');
   let size=header.readUInt32BE(0),head=8;
   if(size===1){size=Number(header.readBigUInt64BE(8));head=16;}else if(size===0)size=total-at;
   if(!Number.isSafeInteger(size)||size<head||at+size>total)throw Error('Invalid MP4 atom size');
   if(header.toString('ascii',4,8)==='moov'){
    if(size>256*1024*1024)throw Error('Unexpectedly large moov atom');
    moov=Buffer.alloc(size);if(fs.readSync(fd,moov,0,size,at)!==size)throw Error('Truncated moov');offset=at;break;
   }at+=size;
  }
  if(!moov)throw Error('No moov atom');
  const found=new Set();
  function walk(start,end){for(let at=start;at<end;){
   if(at+8>end)throw Error('Truncated child atom');
   let size=moov.readUInt32BE(at),head=8;const type=moov.toString('ascii',at+4,at+8);
   if(size===1){if(at+16>end)throw Error('Truncated extended atom');size=Number(moov.readBigUInt64BE(at+8));head=16;}
   if(size===0)size=end-at;
   if(size<head||at+size>end)throw Error('Invalid child atom');
   const body=at+head;
   if(type==='moov'||type==='trak')walk(body,at+size);
   if(type==='tkhd'){
    if(body+24>at+size)throw Error('Truncated track header');
    const version=moov[body];if(version!==0&&version!==1)throw Error('Unknown track header version');
    const id=moov.readUInt32BE(body+(version===1?20:12));
    if(desired.has(id)){
     const position=body+3,byte=Buffer.from([(moov[position]&0xfe)|(desired.get(id)?1:0)]);
     if(fs.writeSync(fd,byte,0,1,offset+position)!==1)throw Error('Track flag write failed');found.add(id);
    }
   }at+=size;
  }}
  walk(0,moov.length);if(found.size!==desired.size)throw Error('Subtitle track IDs not found');
  fs.fsyncSync(fd);
 }finally{fs.closeSync(fd);}
}
function verifyTracks(q,p) {
 const audio=q.streams.filter(s=>s.codec_type==='audio'),sub=q.streams.filter(s=>s.codec_type==='subtitle');
 if(audio.length!==p.retainedAudio.length || sub.length!==p.subtitles.length)throw Error('Retained track count mismatch');
 function metadata(t,out,isDefault){
  if(languageOf(t)!==languageOf(out))throw Error('Track language mismatch');
  if(titleOf(t) && titleOf(t)!==titleOf(out))throw Error('Track title mismatch');
  if(!!out.disposition?.default!==isDefault || !!out.disposition?.forced!==!!t.disposition?.forced)throw Error('Track default/forced disposition mismatch');
 }
 audio.forEach((out,i)=>{const t=p.retainedAudio[i];
  if(out.codec_name!=='aac'||out.profile!=='LC'||out.channels!==Math.min(t.channels,6))throw Error('Audio codec/channel mismatch');
  if(targetLayout(t) && targetLayout(t)!=='unknown' && out.channel_layout!==targetLayout(t))throw Error('Audio channel layout mismatch');
  metadata(t,out,t.index===p.audio.index);
 });
 sub.forEach((out,i)=>{if(out.codec_name!=='mov_text')throw Error('Invalid MP4 text subtitle codec');metadata(p.subtitles[i],out,!!p.subtitles[i].disposition?.default);});
}

function validate(file,p,decode=true){const q=probe(['-i',file]),v=q.streams.filter(s=>s.codec_type==='video'),a=q.streams.filter(s=>s.codec_type==='audio');if(v.length!==1||v[0].codec_name!=='h264'||v[0].pix_fmt!=='yuv420p'||v[0].height>1080||v[0].width>1920||!a.length||a.some(s=>s.codec_name!=='aac'||s.profile!=='LC'))throw Error('Output codec/layout validation failed');if(Math.abs(Number(q.format.duration)-p.feature.duration)>Math.max(3,p.feature.duration*.001))throw Error('Output duration mismatch');const rate=s=>{const [n,d]=s.split('/').map(Number);return n/d;};if(Math.abs(rate(v[0].avg_frame_rate)-rate(p.video.avg_frame_rate))>.02)throw Error('Frame rate mismatch');if(p.version===2)verifyTracks(q,p);if(decode && p.version===2 && p.subtitles.length)run(ff,['-v','error','-xerror','-i',file,'-map','0:s','-c:s','srt','-f','null','-'],true);if(decode)run(ff,['-v','error','-xerror','-i',file,'-map','0:v:0','-map','0:a','-fps_mode','passthrough','-enc_time_base:v','demux','-f','null','-'],true);return q;}
function chapterMetadata(p) {
 const escape=s=>s.replace(/[\\=;#\n]/g,c=>'\\'+c);
 let text=';FFMETADATA1\ntitle='+escape(p.title)+'\n';
 p.feature.chapters.forEach((t,i,arr)=>text+=`[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(t*1000)}\nEND=${Math.round((arr[i+1]??p.feature.duration)*1000)}\ntitle=Chapter ${i+1}\n`);
 return text;
}

// Both encode paths share input 0 (original Blu-ray), input 1 (chapters/title),
// video settings and the exact same source-audio/text-track mapping pipeline.
function buildEncodeCommand(p,{metadata,output,burn,sourceInput=input(p)}) {
 const a=['-hide_banner','-nostdin','-n',...sourceInput,'-f','ffmetadata','-i',metadata];
 if(burn) {
  if(!Number.isFinite(burn.start))throw Error('PGS timeline start is missing');
  a.push('-itsoffset',String(burn.start),'-canvas_size',p.video.width+'x'+p.video.height,'-i',burn.file,
   '-filter_complex',`[0:${p.video.index}]${p.filters.join(',')}[clean];[2:s:0][clean]scale2ref[caption][picture];[picture][caption]overlay=eof_action=pass:shortest=0,format=yuv420p[burned]`,
   '-map','[burned]');
 }else a.push('-map','0:'+p.video.index,'-vf',p.filters.join(','));
 a.push('-map_metadata','0','-map_metadata:g','1','-map_chapters','1','-metadata','title='+p.title,
  '-c:v','libx264','-crf','20','-preset','medium','-pix_fmt','yuv420p','-tag:v','avc1','-fps_mode','passthrough',
  ...trackOptions(p),'-movie_timescale','1000','-movflags','+faststart','-max_muxing_queue_size','4096',output);
 return a;
}

function encodeReviewed({p,planFile,output,burn,prepareOnly=false,finalize=false,sourceInput}) {
 if(p.version!==2)throw Error('This converter requires a new version-2 inspection plan');
 if(p.warnings.length)throw Error(p.warnings.join('\n'));
 if(fingerprint(p.source,p.feature)!==p.fingerprint)throw Error('Source changed; inspect again');
 output=path.resolve(output);
 const planHash=hash(fs.readFileSync(planFile));
 const operation=burn?'pgs-burn':'encode';
 const renderKey=hash(JSON.stringify({operation,pgsHash:burn?.hash,language:burn?.language}));
 const matches=r=>r.planHash===planHash && (r.renderKey===renderKey || (!burn&&!r.renderKey&&!r.operation));
 if(fs.existsSync(output)) {
  validate(output,p);
  const receipt=output+'.verified.json';
  if(!fs.existsSync(receipt)||!matches(JSON.parse(fs.readFileSync(receipt))))throw Error('Existing output has no matching render receipt; preserved. Choose another output path.');
  console.log('Verified matching existing output; skipping.');return;
 }
 const partial=output+'.partial.mp4',metadata=output+'.chapters.ffmeta';
 const command=buildEncodeCommand(p,{metadata,output:partial,burn,sourceInput});
 console.log(JSON.stringify({operation,playlist:p.feature.playlist,duration:p.feature.duration,language:burn?.language,pgsCaptions:burn?.cues,video:'Original Blu-ray -> planned video filters'+(burn?' + normalized PGS overlay':'')+' -> libx264 CRF 20 medium',audio:'All retained source audio -> AAC-LC via the shared track pipeline',command:[ff,...command]},null,2));
 if(prepareOnly)return;
 fs.mkdirSync(path.dirname(output),{recursive:true});
 const verifyAndPromote=()=>{
  restoreSubtitleDefaults(partial,p);
  const verified=validate(partial,p);
  const expectedChapters=p.feature.chapters.map((t,i,all)=>[Math.round(t*1000),Math.round((all[i+1]??p.feature.duration)*1000),'Chapter '+(i+1)]);
  const actualChapters=verified.chapters.map(c=>[Math.round(Number(c.start_time)*1000),Math.round(Number(c.end_time)*1000),c.tags?.title]);
  if(JSON.stringify(expectedChapters)!==JSON.stringify(actualChapters))throw Error('Output chapters differ from the reviewed plan');
  const receipt=partial+'.verified.json';
  if(fs.existsSync(receipt)) {
   if(!matches(JSON.parse(fs.readFileSync(receipt))))throw Error('Partial receipt belongs to another render; preserved');
  }else fs.writeFileSync(receipt,JSON.stringify({planHash,renderKey,operation,source:p.source,language:burn?.language,pgsHash:burn?.hash,sourceCueCount:burn?.cues,verifiedAt:new Date().toISOString(),probe:verified},null,2),{flag:'wx'});
  moveNoReplace(partial,output);moveNoReplace(receipt,output+'.verified.json');
  console.log('Completed and fully decoded: '+output);
 };
 if(finalize){if(!fs.existsSync(partial))throw Error('No partial MP4 to finalize');verifyAndPromote();return;}
 if(fs.existsSync(partial))throw Error('Partial output exists; preserve/rename it before retrying');
 fs.writeFileSync(metadata,chapterMetadata(p),{flag:'wx'});
 try{run(ff,command,true);verifyAndPromote();}finally{fs.unlinkSync(metadata);}
}

function main(){
 if(mode==='burn-pgs'){burnPgs({args,opt,run,probe,ff,fp,hash,moveNoReplace,mpls,input,fingerprint,validate,restoreSubtitleDefaults,encodeReviewed});return;}
 if(mode==='ocr-subtitles'){ocrSubtitles({args,opt,run,probe,ff,fp,hash,moveNoReplace,mpls,input,fingerprint,validate,restoreSubtitleDefaults});return;}

 if(mode==='inspect'){
  let source=path.resolve(opt('source',''));if(path.basename(source).toUpperCase()==='BDMV')source=path.dirname(source);
  if(!opt('source'))throw Error('--source is required');const dir=path.join(source,'BDMV','PLAYLIST');let candidates=fs.readdirSync(dir).filter(f=>/\.mpls$/i.test(f)).map(f=>mpls(path.join(dir,f))).filter(p=>p.duration>60).sort((a,b)=>b.duration-a.duration);const unique=[...new Map(candidates.map(p=>[p.signature,p])).values()].sort((a,b)=>b.duration-a.duration);if(!unique.length)throw Error('No feature playlists');const selected=opt('playlist');const feature=selected?candidates.find(p=>Number(p.playlist)===Number(selected)):unique[0];if(!feature)throw Error('Playlist not found');const p={version:2,source,title:opt('title',path.basename(source)),output:path.resolve(opt('output',path.join(source,path.basename(source)+'.mp4'))),feature,candidates:unique.map(({playlist,duration,items})=>({playlist,duration,clips:items.map(i=>i.clip)})),warnings:[]};p.fingerprint=fingerprint(source,feature);const q=probe(input(p));playlistLanguages(p,q);p.sourceProbe=q;p.video=q.streams.filter(s=>s.codec_type==='video'&&!s.disposition?.attached_pic).sort((a,b)=>b.width*b.height-a.width*a.height)[0];if(!p.video)throw Error('No video');const audioCandidates=q.streams.filter(t=>t.codec_type==='audio'&&audioScore(t)>=0);selectTracks(p,q,opt('audio'),audioHashes(p,audioCandidates));p.interlace=detect(p,p.video);const force=opt('interlace');if(force){if(!['progressive','interlaced'].includes(force))throw Error('Invalid --interlace');p.interlace.state=force;p.interlace.manual=true;}if(new Set(feature.items.map(i=>JSON.stringify(i))).size<feature.items.length)p.warnings.push('Selected playlist repeats clip ranges; review for loops/extras before encoding.');if(!selected&&unique[1]?.duration>feature.duration*.9)p.warnings.push('Competing feature playlists: inspect candidates and rerun with --playlist NUMBER.');if(p.interlace.state==='uncertain')p.warnings.push('Interlace uncertain: review samples/source and rerun with --interlace progressive|interlaced.');if(/smpte2084|arib-std-b67/.test(p.video.color_transfer||'')||p.video.color_space==='bt2020nc')p.warnings.push('HDR/wide gamut source requires a separately reviewed tone mapping workflow.');p.filters=[...(p.interlace.state==='interlaced'?['bwdif=mode=send_frame:parity=auto:deint=all']:[]),"scale=w='min(iw,1920)':h='min(ih,1080)':force_original_aspect_ratio=decrease:force_divisible_by=2",'format=yuv420p'];p.expected={video:'libx264 CRF 20 medium yuv420p; original frame rate; maximum 1920x1080',audio:p.retainedAudio.map(t=>({sourceIndex:t.index,language:languageOf(t),title:titleOf(t),codec:'AAC-LC',channels:Math.min(t.channels,6),bitrate:t.channels>2?'512k':'256k',default:t.index===p.audio.index})),subtitles:p.subtitles.map(s=>s.index),chapters:feature.chapters.length,filters:p.filters};const plan=path.resolve(opt('plan','apple-mp4-plan.json'));fs.writeFileSync(plan,JSON.stringify(p,null,2),{flag:'wx'});console.log(JSON.stringify({plan,title:p.title,feature:p.feature,candidates:p.candidates,video:p.video,audioTracks:p.audioDecisions,subtitleTracks:p.subtitleDecisions,selectedDefaultAudio:p.audio,interlace:p.interlace,expected:p.expected,warnings:p.warnings},null,2));return;
 }
 if(mode==='encode'||mode==='finalize'){
  const planFile=path.resolve(opt('plan','apple-mp4-plan.json'));
  const p=JSON.parse(fs.readFileSync(planFile));
  encodeReviewed({p,planFile,output:p.output,finalize:mode==='finalize'});return;
 }
 console.log('Inspect: node apple-mp4.mjs inspect --source "D:\\Opera" --output "D:\\Converted\\Opera.mp4" --plan "Opera.plan.json"\nEncode after review: node apple-mp4.mjs encode --plan "Opera.plan.json"\nRecover a completed partial (reverifies fully): node apple-mp4.mjs finalize --plan \"Opera.plan.json\"\nOpt-in PGS OCR/remux: node apple-mp4.mjs ocr-subtitles --plan Opera.plan.json --language eng --seconv PATH --tesseract-dir DIR --prepare-only\nAfter text review: repeat with --reviewed-srt reviewed.srt --output Opera-English.mp4\nHardcoded PGS option: node apple-mp4.mjs burn-pgs --plan Opera.plan.json --language eng --output Opera-burned.mp4 --prepare-only\nInspection options: --playlist NUMBER --audio STREAM_INDEX --interlace progressive|interlaced --title TITLE\nTool overrides: --ffmpeg PATH --ffprobe PATH');
}
export {encodeReviewed,buildEncodeCommand,chapterMetadata,fingerprint,moveNoReplace, mpls, playlistLanguages, audioScore, selectTracks, trackOptions, verifyTracks, validate, probe, run, restoreSubtitleDefaults};
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{main();}catch(e){console.error(e.message);process.exitCode=1;}
}

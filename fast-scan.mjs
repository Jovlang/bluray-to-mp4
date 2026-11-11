import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';

export function profiler() {
  const timings=[];
  return {timings,measure(label,fn){const start=performance.now();try{return fn();}finally{const ms=Number((performance.now()-start).toFixed(1));timings.push({step:label,ms});console.error(`[timing] ${label}: ${ms} ms`);}}};
}

// Primary video/audio/subtitle STN attributes only. No STREAM files or processes.
export function playlistMetadata(file) {
  const b=fs.readFileSync(file),list=b.readUInt32BE(8),body=list+12;
  const end=body+b.readUInt16BE(body-2);
  let stn=body+32;
  if(b.readUInt16BE(body+9)&0x10)stn+=2+10*(b[stn]-1);
  const requireBytes=(at,n)=>{if(at<0||at+n>Math.min(b.length,end))throw Error('Truncated MPLS stream table');};
  requireBytes(stn,16);
  const counts=[b[stn+4],b[stn+5],b[stn+6]],streams=[];
  let pos=stn+16;
  for(let i=0;i<counts.reduce((a,n)=>a+n,0);i++){
    requireBytes(pos,1);const entryLength=b[pos],entry=pos+1;requireBytes(entry,entryLength);
    const pid=entryLength>=3&&b[entry]===1?b.readUInt16BE(entry+1):undefined;
    pos=entry+entryLength;requireBytes(pos,1);const length=b[pos],attr=pos+1;requireBytes(attr,length);pos=attr+length;
    if(pid===undefined||!length)continue;
    const coding=b[attr],type=i<counts[0]?'video':i<counts[0]+counts[1]?'audio':'subtitle';
    const stream={index:streams.length,id:String(pid),codec_type:type,metadataOnly:true,tags:{}};
    if(type==='video'){
      stream.codec_name=({2:'mpeg2video',0x1b:'h264',0x24:'hevc',0xea:'vc1'})[coding]||'unknown';
      if(length>=2){const format=b[attr+1]>>4,rate=b[attr+1]&15;const size=({1:[720,480,'tt'],2:[720,576,'tt'],3:[720,480,'progressive'],4:[1920,1080,'tt'],5:[1280,720,'progressive'],6:[1920,1080,'progressive'],7:[720,576,'progressive'],8:[3840,2160,'progressive']})[format];if(size)[stream.width,stream.height,stream.field_order]=size;stream.avg_frame_rate=({1:'24000/1001',2:'24/1',3:'25/1',4:'30000/1001',6:'50/1',7:'60000/1001'})[rate]||'0/0';}
    }else if(type==='audio'){
      stream.codec_name=({0x80:'pcm_bluray',0x81:'ac3',0x82:'dts',0x83:'truehd',0x84:'eac3',0x85:'dts',0x86:'dts',0xa1:'eac3',0xa2:'dts'})[coding]||'unknown';
      if(coding===0x86)stream.profile='DTS-HD MA';if(coding===0x85)stream.profile='DTS-HD HRA';
      if(length>=2){const format=b[attr+1]>>4;stream.channels=({1:1,3:2})[format];stream.channelDescription=stream.channels?undefined:'multichannel (layout checked before encoding)';}
      if(length>=5)stream.tags.language=b.toString('ascii',attr+2,attr+5);
    }else{
      stream.codec_name=({0x90:'hdmv_pgs_subtitle',0x91:'hdmv_ig_subtitle',0x92:'text'})[coding]||'unknown';
      const offset=coding===0x92?2:1;if(length>=offset+3)stream.tags.language=b.toString('ascii',attr+offset,attr+offset+3);
    }
    if(!/^[a-z]{3}$/.test(stream.tags.language||''))delete stream.tags.language;
    streams.push(stream);
  }
  return {streams};
}

export function fastScan({source,output,title,playlist,audio,mpls,inspectTracks,expectedAudio}){
  const profile=profiler();
  const {feature,candidates,unique}=profile.measure('parse MPLS playlists',()=>{
    const candidates=fs.readdirSync(path.join(source,'BDMV','PLAYLIST')).filter(f=>/\.mpls$/i.test(f)).map(f=>mpls(path.join(source,'BDMV','PLAYLIST',f))).filter(p=>p.duration>60).sort((a,b)=>b.duration-a.duration);
    const unique=[...new Map(candidates.map(p=>[p.signature,p])).values()].sort((a,b)=>b.duration-a.duration);
    const eligible=unique.filter(p=>new Set(p.items.map(i=>JSON.stringify(i))).size===p.items.length);
    const feature=playlist!==undefined?candidates.find(p=>Number(p.playlist)===Number(playlist)):(eligible[0]||unique[0]);
    if(!feature)throw Error('No matching feature playlist');return {feature,candidates,unique};
  });
  const q=profile.measure('read playlist track metadata',()=>playlistMetadata(path.join(source,'BDMV','PLAYLIST',feature.playlist+'.mpls')));
  const video=q.streams.find(s=>s.codec_type==='video')||{codec_type:'video',metadataOnly:true};
  const p={version:2,source,title:title||path.basename(source),output,feature,candidates:unique.map(({playlist,duration,items})=>({playlist,duration,clips:items.map(i=>i.clip)})),sourceProbe:q,video,warnings:[],scanStage:'fast',preflight:{status:'pending'},interlace:{state:'pending',metadataHint:video.field_order==='progressive'?'progressive':video.field_order?'interlaced':'unknown'},scanNotes:['Playlist metadata only. Track indexes, exact channel layouts, labels, and picture properties are confirmed before encoding.']};
  profile.measure('provisional track decisions',()=>{
    if(q.streams.some(t=>t.codec_type==='audio'))inspectTracks(p,q,audio);
    else Object.assign(p,{audioTracks:[],audioDecisions:[],retainedAudio:[],subtitleTracks:q.streams.filter(t=>t.codec_type==='subtitle'),subtitleDecisions:[],subtitles:[],audioPreflight:{status:'pending'}});
  });
  if(!playlist&&unique.some(p=>p.playlist!==feature.playlist&&new Set(p.items.map(i=>JSON.stringify(i))).size===p.items.length&&p.duration>feature.duration*.9))p.warnings.push('Competing feature playlists: inspect candidates and rerun with --playlist NUMBER.');
  if(new Set(feature.items.map(i=>JSON.stringify(i))).size<feature.items.length)p.warnings.push('Selected playlist repeats clip ranges; review for loops/extras before encoding.');
  p.requestedPlaylist=playlist;p.requestedDefaultAudio=audio;p.expected={audio:p.audio?expectedAudio(p):[]};p.timings=profile.timings;return p;
}

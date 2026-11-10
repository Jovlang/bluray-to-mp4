import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const TICKS = 90000;
const WRAP = 2 ** 32;

export function supGroups(buffer) {
  const groups = [];
  const palettes = new Map(), objects = new Map();
  let group = [];
  for (let at = 0; at < buffer.length;) {
    if (at + 13 > buffer.length || buffer.toString('ascii', at, at + 2) !== 'PG') throw Error('Invalid SUP segment');
    const size = 13 + buffer.readUInt16BE(at + 11);
    if (at + size > buffer.length) throw Error('Truncated SUP segment');
    const segment = Buffer.from(buffer.subarray(at, at + size));
    if (segment[10] === 0x16 && group.length) throw Error('Unterminated SUP display set');
    group.push(segment);
    if (segment[10] === 0x80) {
      const pcs = group.find(s => s[10] === 0x16);
      if (!pcs || pcs.length < 24) throw Error('SUP display set has no composition');
      for(const s of group) {
        if(s[10]===0x14) {
          const palette=palettes.get(s[13])||new Map();
          for(let i=15;i+4<s.length;i+=5)palette.set(s[i],s[i+4]);
          palettes.set(s[13],palette);
        }
        if(s[10]===0x15) {
          const id=s.readUInt16BE(13),first=!!(s[16]&0x80);
          if(first)objects.set(id,Buffer.from(s.subarray(24)));
          else objects.set(id,Buffer.concat([objects.get(id)||Buffer.alloc(0),s.subarray(17)]));
        }
      }
      let visible=false,known=true;
      const palette=palettes.get(pcs[22]);
      let position=24;
      for(let i=0;i<pcs[23];i++) {
        if(position+8>pcs.length)throw Error('Truncated composition object');
        const data=objects.get(pcs.readUInt16BE(position));
        if(!data||!palette)known=false;
        else for(let k=0;k<data.length;) {
          let color=data[k++];
          if(color===0){if(k===data.length)throw Error('Truncated PGS RLE');const flags=data[k++];if(flags===0)continue;if(flags&0x40)k++;color=flags&0x80?data[k++]:0;}
          if(k>data.length)throw Error('Truncated PGS RLE run');
          if((palette.get(color)||0)>0){visible=true;break;}
        }
        position+=pcs[position+3]&0x80?16:8;
      }
      // Transparent display objects (often the final black slate) are not text.
      groups.push({segments: group, pts: pcs.readUInt32BE(2), objects: known&&!visible?0:pcs[23]});
      group = [];
    }
    at += size;
  }
  if (group.length) throw Error('Incomplete SUP display set');
  return groups;
}

function unwrap(ticks, near) {
  return ticks + Math.round((near - ticks) / WRAP) * WRAP;
}

export function normalizeSup(items, buffers) {
  const result = [];
  let base = 0;
  items.forEach((item, index) => {
    const start = Math.round(item.start * TICKS);
    const end = Math.round(item.end * TICKS);
    const groups = supGroups(buffers[index]);
    const timed = groups.map(g => ({...g, time: unwrap(g.pts, start)}));
    const inside = timed.filter(g => g.time >= start && g.time < end);
    const preroll = timed.filter(g => g.time < start).at(-1);
    if (preroll?.objects) inside.unshift({...preroll, time: start});
    let previous = -1;
    for (const group of inside) {
      if (group.time < previous) throw Error('Non-monotonic source PGS compositions');
      previous = group.time;
      for (const original of group.segments) {
        const segment = Buffer.from(original);
        const originalPts = unwrap(original.readUInt32BE(2), start);
        const pts = Math.max(base, base + originalPts - start);
        segment.writeUInt32BE(Math.round(pts) >>> 0, 2);
        const rawDts = original.readUInt32BE(6);
        segment.writeUInt32BE(rawDts ? Math.max(base, base + unwrap(rawDts, start) - start) >>> 0 : 0, 6);
        result.push(segment);
      }
    }
    // Trim a caption that remains displayed past this play item's OUT point.
    if (inside.at(-1)?.objects) {
      const old = inside.at(-1).segments.find(s => s[10] === 0x16);
      const clear = Buffer.alloc(24);
      old.copy(clear, 0, 0, 24);
      clear.writeUInt16BE(11, 11);
      clear.writeUInt32BE((base + end - start) >>> 0, 2);
      clear.writeUInt32BE(0, 6);
      clear[23] = 0;
      const finish = Buffer.alloc(13);
      finish.write('PG'); finish.writeUInt32BE((base + end - start) >>> 0, 2); finish[10] = 0x80;
      result.push(clear, finish);
    }
    base += end - start;
    if (base >= WRAP) throw Error('Feature exceeds SUP timestamp range');
  });
  return Buffer.concat(result);
}

export function supTimes(buffer) {
  const cues = [];
  let pending;
  for (const g of supGroups(buffer)) {
    if (pending) {
      if (g.pts / TICKS < pending.start) throw Error('Non-monotonic normalized PGS');
      if (g.pts > pending.start) cues.push({...pending, end: g.pts / TICKS});
      pending = undefined;
    }
    if (g.objects) pending = {start: g.pts / TICKS};
  }
  if (pending) throw Error('PGS caption has no end time');
  return cues;
}

export function parseSrt(text) {
  const time = t => {const [h,m,s,ms] = t.split(/[:,]/).map(Number); return h*3600+m*60+s+ms/1000;};
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r/g, '').trim().split(/\n\s*\n/);
  return blocks.map((block, i) => {
    const lines = block.split('\n');
    const timing = lines[1]?.match(/^(\d{2,}:\d{2}:\d{2},\d{3}) --> (\d{2,}:\d{2}:\d{2},\d{3})$/);
    if (!/^\d+$/.test(lines[0]) || !timing || !lines.slice(2).join('\n').trim()) throw Error('Invalid/empty SRT cue '+(i+1));
    return {start: time(timing[1]), end: time(timing[2]), text: lines.slice(2).join('\n')};
  });
}

export function writeSrt(cues) {
  const time = seconds => {
    const n = Math.round(seconds * 1000);
    return String(Math.floor(n/3600000)).padStart(2,'0')+':'+String(Math.floor(n/60000)%60).padStart(2,'0')+':'+String(Math.floor(n/1000)%60).padStart(2,'0')+','+String(n%1000).padStart(3,'0');
  };
  return cues.map((c,i) => `${i+1}\n${time(c.start)} --> ${time(c.end)}\n${c.text}\n`).join('\n');
}

export function checkTiming(cues, expected, duration) {
  if (cues.length !== expected.length) throw Error(`OCR cue count mismatch: ${cues.length} vs ${expected.length}`);
  cues.forEach((c,i) => {
    if (c.start < 0 || c.end <= c.start || c.end > duration+.003 || (i && c.start < cues[i-1].end-.003)) throw Error('Invalid/overlapping cue '+(i+1));
    if (Math.abs(c.start-expected[i].start) > .003 || Math.abs(c.end-expected[i].end) > .003) throw Error('OCR changed source timing at cue '+(i+1));
  });
}

export function reviewOcr(cues) {
  const fixes = [], issues = [];
  const cleaned = cues.map((c,i) => {
    const text = c.text.replace(/(?<!\w)\|(?=\s|['’]|$)/g, 'I');
    if (text !== c.text) fixes.push({cue:i+1,before:c.text,after:text,reason:'Standalone vertical bar misread as pronoun I'});
    const reasons = [];
    if (/[|�□]/.test(text)) reasons.push('Unrecognized glyph');
    if (/\b[A-Za-z]+\d+[A-Za-z]*\b|\b\d+[A-Za-z]+\b/.test(text)) reasons.push('Mixed letters/digits');
    if (/\b[a-z][A-Za-z]*[A-Z][A-Za-z]*\b/.test(text)) reasons.push('Unexpected internal capital');
    if (/\S\s+K(?:iss\w*|ill\w*|now\w*|neel\w*|eep\w*)\b/.test(text)) reasons.push('Possible lowercase k read as uppercase K');
    if (/\blago\b|\bHm\b|\byoul\b|(?:^|\s)\/(?=\s|[,.'’]|$)/.test(text)) reasons.push('Possible I/l or missing-letter OCR confusion; compare with image');
    if (reasons.length) issues.push({cue:i+1,text,reasons});
    return {...c,text};
  });
  return {cues:cleaned,fixes,issues};
}

// Read language/PID attributes for every play item, including changed PIDs.
export function playlistPgs(file) {
  const b = fs.readFileSync(file), list = b.readUInt32BE(8), count = b.readUInt16BE(list+6);
  const result = [];
  let at = list+10;
  for (let i=0;i<count;i++) {
    const len=b.readUInt16BE(at), body=at+2;
    let stn=body+32;
    if (b.readUInt16BE(body+9)&0x10) stn += 2 + 10*(b[stn]-1);
    const counts=[b[stn+4],b[stn+5],b[stn+6]], tracks=[];
    let pos=stn+16;
    for(let j=0;j<counts.reduce((a,b)=>a+b,0);j++) {
      const n=b[pos], entry=pos+1, pid=b[entry]===1?b.readUInt16BE(entry+1):undefined;
      pos=entry+n;const size=b[pos], attr=pos+1;
      if(j>=counts[0]+counts[1] && b[attr]===0x90 && pid!==undefined) tracks.push({pid,language:b.toString('ascii',attr+1,attr+4)});
      pos=attr+size;
    }
    result.push(tracks);at=body+len;
  }
  return result;
}

function mediaHashes(ctx, file, types=['v','a']) {
  const maps=types.flatMap(type=>['-map','0:'+type]);
  const lines=ctx.run(ctx.ff,['-v','error','-xerror','-i',file,...maps,'-c','copy','-f','streamhash','-hash','sha256','-']);
  const entries=lines.split(/\r?\n/).filter(l=>/^\d+,/.test(l)).map(l=>l.trim());
  if(!entries.length)throw Error('No video/audio stream hashes');
  return entries;
}

export function verifiedBase(ctx,p,identity) {
  const file=path.resolve(ctx.opt('base-mp4',p.output));
  const receiptFile=path.resolve(ctx.opt('base-receipt',file+'.verified.json'));
  if(!fs.existsSync(file)||!fs.existsSync(receiptFile))throw Error('Base MP4/receipt missing; use --base-mp4 and --base-receipt if relocated');
  const receipt=JSON.parse(fs.readFileSync(receiptFile)),plan=structuredClone(p);
  if(receipt.planHash!==identity.planHash) {
    if(receipt.parentPlanHash!==identity.planHash||!['pgs-ocr-streamcopy','pgs-burn'].includes(receipt.operation))throw Error('Base receipt belongs to a different plan');
    const retained=receipt.probe.streams.filter(s=>s.codec_type==='subtitle');
    if(retained.length<plan.subtitles.length)throw Error('Base receipt lost expected subtitles');
    plan.subtitles.push(...retained.slice(plan.subtitles.length));
  }
  if(String(fs.statSync(file).size)!==String(receipt.probe?.format?.size))throw Error('Base MP4 size differs from its verified receipt');
  const q=ctx.validate(file,plan,false);
  return {file,plan,probe:q};
}

function preparePgs(ctx) {
  const {opt,run,probe,ff,hash,moveNoReplace}=ctx;
  const planFile=path.resolve(opt('plan','apple-mp4-plan.json'));
  const p=JSON.parse(fs.readFileSync(planFile));
  if(p.version!==2 || p.warnings?.length)throw Error('Use a reviewed version-2 inspection plan');
  if(ctx.fingerprint(p.source,p.feature)!==p.fingerprint)throw Error('Source changed; inspect again');
  const language=opt('language','eng');if(!/^[a-z]{3}$/.test(language))throw Error('Use an ISO 639-2 language code such as eng');
  const tracks=p.subtitleTracks.filter(t=>t.codec_name==='hdmv_pgs_subtitle'&&t.tags?.language===language);
  const requested=opt('subtitle-index');
  const selected=requested===undefined?(tracks.length===1?tracks[0]:undefined):tracks.find(t=>t.index===Number(requested));
  if(!selected)throw Error('No unique PGS track for '+language+'; inspect tracks and use --subtitle-index when needed');
  const directory=path.resolve(opt('workdir',path.join(path.dirname(planFile),'ocr-'+language)));
  fs.mkdirSync(directory,{recursive:true});
  const manifestFile=path.join(directory,'job.json');
  const identity={version:1,planHash:hash(fs.readFileSync(planFile)),language,pid:Number(selected.id)};
  let manifest={...identity,artifacts:{}};
  if(fs.existsSync(manifestFile)) {
    manifest=JSON.parse(fs.readFileSync(manifestFile));
    for(const key of Object.keys(identity))if(manifest[key]!==identity[key])throw Error('OCR work directory belongs to a different job');
  }else fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2),{flag:'wx'});
  const save=()=>fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2));
  function cached(name,produce) {
    const file=path.join(directory,name);
    if(fs.existsSync(file)) {
      if(manifest.artifacts[name]!==digest(fs.readFileSync(file)))throw Error('Unverified/changed OCR cache: '+file);
      return file;
    }
    produce(file);
    manifest.artifacts[name]=digest(fs.readFileSync(file));save();return file;
  }
  const itemTracks=playlistPgs(path.join(p.source,'BDMV','PLAYLIST',p.feature.playlist+'.mpls'));
  const raw=p.feature.items.map((item,i)=>{
    const candidates=itemTracks[i].filter(t=>t.language===language);
    const track=candidates.find(t=>t.pid===identity.pid)||(candidates.length===1?candidates[0]:undefined);
    if(!track)throw Error('Missing/ambiguous '+language+' PGS in play item '+i);
    return cached(`clip-${i}-${item.clip}.sup`,file=>{
      console.error('Extracting '+language+' PGS: '+item.clip);
      run(ff,['-v','error','-nostdin','-n','-copyts','-i',path.join(p.source,'BDMV','STREAM',item.clip+'.m2ts'),'-map','0:i:'+track.pid,'-c:s','copy','-f','sup',file]);
    });
  });
  const normalized=cached('timed.sup',file=>fs.writeFileSync(file,normalizeSup(p.feature.items,raw.map(f=>fs.readFileSync(f))),{flag:'wx'}));
  const expected=supTimes(fs.readFileSync(normalized));
  if(!expected.length)throw Error('Selected PGS has no visible captions');
  return {p,planFile,language,directory,identity,cached,normalized,expected};
}

export function ocrSubtitles(ctx) {
  const {opt,run,probe,ff,hash,moveNoReplace}=ctx;
  const {p,planFile,language,directory,identity,cached,normalized,expected}=preparePgs(ctx);
  const rawSrt=cached('raw.srt',file=>{
    const seconv=opt('seconv');if(!seconv)throw Error('--seconv PATH is required for local OCR');
    const env={...process.env},tess=opt('tesseract-dir');
    if(tess){env.PATH=path.resolve(tess)+path.delimiter+env.PATH;env.TESSDATA_PREFIX=path.join(path.resolve(tess),'tessdata');}
    const result=spawnSync(path.resolve(seconv),[normalized,'subrip','--ocr-engine:tesseract','--ocr-language:'+language,'--output-folder:'+directory,'--output-filename:raw.srt','--json'],{env,encoding:'utf8',maxBuffer:16*1024*1024});
    fs.writeFileSync(path.join(directory,'ocr-engine.log'),(result.stdout||'')+(result.stderr||''));
    if(result.error)throw result.error;if(result.status!==0)throw Error('Local OCR failed; see ocr-engine.log');
    const status=JSON.parse(result.stdout);if(!status.success||!fs.existsSync(file))throw Error('OCR produced no SRT');
  });
  const rawCues=parseSrt(fs.readFileSync(rawSrt,'utf8'));
  checkTiming(rawCues,expected,p.feature.duration);
  const review=reviewOcr(rawCues);
  const candidate=cached('candidate.srt',file=>fs.writeFileSync(file,writeSrt(review.cues),{flag:'wx'}));
  const report={language,cueCount:expected.length,automaticFixes:review.fixes,reviewNeeded:review.issues,timing:'Every cue checked against trimmed, unwrapped source PGS timestamps',note:'Heuristics flag likely errors; they do not prove that all OCR text is correct.'};
  fs.writeFileSync(path.join(directory,'review.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({candidate,report:path.join(directory,'review.json'),cues:expected.length,automaticFixes:review.fixes.length,reviewNeeded:review.issues.length},null,2));
  if(ctx.args.includes('--prepare-only'))return;
  const reviewed=opt('reviewed-srt');
  if(!reviewed && review.issues.length)throw Error('Review flagged text, save a separate reviewed SRT, then rerun with --reviewed-srt PATH');
  const srt=path.resolve(reviewed||candidate), cues=parseSrt(fs.readFileSync(srt,'utf8'));
  checkTiming(cues,expected,p.feature.duration);
  const {file:baseFile,plan:basePlan,probe:baseProbe}=verifiedBase(ctx,p,identity);
  if(basePlan.subtitles.some(t=>t.tags?.language===language))throw Error('Base MP4 already has text subtitles in '+language+'; preserved instead of duplicating them');
  const output=path.resolve(opt('output',baseFile.replace(/\.mp4$/i,'')+' - '+language+' subtitles.mp4'));
  if(output===path.resolve(baseFile))throw Error('Choose a new output path; the existing good MP4 is preserved');
  if(fs.existsSync(output))throw Error('Output exists; preserved: '+output);
  const outPlan=structuredClone(basePlan), subtitle={codec_type:'subtitle',codec_name:'subrip',tags:{language,title:language==='eng'?'English':language},disposition:{default:0,forced:0}};
  outPlan.subtitles.push(subtitle);
  const partial=output+'.partial.mp4';if(fs.existsSync(partial))throw Error('Partial remux exists; preserved for inspection');
  const baseHashes=mediaHashes(ctx,baseFile);
  fs.mkdirSync(path.dirname(output),{recursive:true});
  const command=['-v','warning','-nostdin','-n','-i',baseFile,'-i',srt,'-map','0:v','-map','0:a','-map','0:s?','-map','1:s:0','-map_metadata','0','-map_chapters','0','-c','copy','-c:s:'+basePlan.subtitles.length,'mov_text','-metadata:s:s:'+basePlan.subtitles.length,'language='+language,'-metadata:s:s:'+basePlan.subtitles.length,'title='+subtitle.tags.title,'-metadata:s:s:'+basePlan.subtitles.length,'handler_name='+subtitle.tags.title,'-disposition:s:'+basePlan.subtitles.length,'0','-movie_timescale','1000','-movflags','+faststart',partial];
  run(ff,command,true);
  ctx.restoreSubtitleDefaults(partial,outPlan);
  const copiedHashes=mediaHashes(ctx,partial);
  if(JSON.stringify(baseHashes)!==JSON.stringify(copiedHashes))throw Error('Video/audio payloads changed; partial preserved');
  const verified=ctx.validate(partial,outPlan);
  const chapterView=q=>q.chapters.map(c=>[c.start_time,c.end_time,c.tags?.title]);
  if(JSON.stringify(chapterView(baseProbe))!==JSON.stringify(chapterView(verified)))throw Error('Chapter metadata changed');
  const srtTemp=path.join(directory,'remux-roundtrip.srt');
  if(fs.existsSync(srtTemp))throw Error('Subtitle round-trip file already exists; inspect the previous attempt');
  run(ff,['-v','error','-n','-i',partial,'-map','0:s:'+basePlan.subtitles.length,'-c:s','srt',srtTemp]);
  const roundtrip=parseSrt(fs.readFileSync(srtTemp,'utf8'));checkTiming(roundtrip,expected,p.feature.duration);
  if(roundtrip.some((c,i)=>c.text!==cues[i].text))throw Error('Muxed text differs from reviewed SRT');
  const receipt=partial+'.verified.json';
  fs.writeFileSync(receipt,JSON.stringify({version:1,operation:'pgs-ocr-streamcopy',parentPlanHash:identity.planHash,sourceMp4:baseFile,language,srtHash:digest(fs.readFileSync(srt)),sourceCueCount:expected.length,mediaPayloadHashes:copiedHashes,verifiedAt:new Date().toISOString(),probe:verified},null,2),{flag:'wx'});
  moveNoReplace(partial,output);moveNoReplace(receipt,output+'.verified.json');
  const sidecar=output.replace(/\.mp4$/i,'.'+language+'.srt');
  fs.writeFileSync(sidecar,fs.readFileSync(srt),{flag:'wx'});
  console.log('Completed OCR subtitles; video/audio payloads unchanged: '+output);
}

export function burnCommand({sourceInput,videoIndex,input,pgs,pgsStart,output,width,height,filters}) {
  if(!sourceInput?.length || !filters?.length || !Number.isFinite(pgsStart))throw Error('Burn requires original-source input, its video filters, and the PGS timeline start');
  // Input 0: original Blu-ray video, with FFmpeg's normal timestamp correction.
  // Input 1: verified MP4, used ONLY for copied audio/text/metadata/chapters.
  // Input 2: playlist-normalized PGS. Restore its absolute feature-time offset
  // after demuxer start-time normalization; do not use global -copyts, because
  // that disables the Blu-ray video's act-boundary discontinuity correction.
  return ['-v','warning','-nostdin','-n',...sourceInput,'-i',input,
    '-itsoffset',String(pgsStart),'-canvas_size',width+'x'+height,'-i',pgs,
    '-filter_complex',`[0:${videoIndex}]${filters.join(',')}[clean];[2:s:0]scale=${width}:${height}[captions];[clean][captions]overlay=eof_action=pass:shortest=0,format=yuv420p[burned]`,
    '-map','[burned]','-map','1:a','-map','1:s?',
    '-map_metadata','1','-map_metadata:s:v:0','1:s:v:0','-map_chapters','1',
    '-c:v','libx264','-crf','20','-preset','medium','-pix_fmt','yuv420p','-tag:v','avc1','-fps_mode','passthrough',
    '-c:a','copy','-c:s','copy','-movie_timescale','1000','-movflags','+faststart',output];
}

export function burnPgs(ctx) {
  const {opt,run,probe,ff,moveNoReplace}=ctx;
  const {p,language,identity,normalized,expected}=preparePgs(ctx);
  const {file:baseFile,plan:basePlan,probe:base}=verifiedBase(ctx,p,identity);
  const output=path.resolve(opt('output',baseFile.replace(/\.mp4$/i,'')+' - '+language+' burned.mp4'));
  if(output===path.resolve(baseFile)||fs.existsSync(output))throw Error('Choose a new burn output path; existing MP4s are preserved');
  const video=base.streams.find(s=>s.codec_type==='video');
  const partial=output+'.partial.mp4';if(fs.existsSync(partial))throw Error('Partial burned output exists; preserved');
  const pgsStart=Number(probe(['-i',normalized]).format.start_time);
  const command=burnCommand({sourceInput:ctx.input(p),videoIndex:p.video.index,input:baseFile,pgs:normalized,pgsStart,output:partial,width:video.width,height:video.height,filters:p.filters});
  console.log(JSON.stringify({mode:'hardcoded PGS',language,captions:expected.length,video:'Original Blu-ray -> planned deinterlace/scale + PGS overlay -> one libx264 CRF 20 medium encode',audio:'stream copy from verified MP4; payload hashes checked',switchable:false,command:[ff,...command]},null,2));
  if(ctx.args.includes('--prepare-only'))return;
  const audioHashes=mediaHashes(ctx,baseFile,['a']);
  fs.mkdirSync(path.dirname(output),{recursive:true});
  run(ff,command,true);
  ctx.restoreSubtitleDefaults(partial,basePlan);
  if(JSON.stringify(audioHashes)!==JSON.stringify(mediaHashes(ctx,partial,['a'])))throw Error('Burn changed audio payloads; partial preserved');
  const verified=ctx.validate(partial,basePlan);
  const chapterView=q=>q.chapters.map(c=>[c.start_time,c.end_time,c.tags?.title]);
  if(JSON.stringify(chapterView(base))!==JSON.stringify(chapterView(verified)))throw Error('Burn changed chapters');
  const receipt=partial+'.verified.json';
  fs.writeFileSync(receipt,JSON.stringify({version:1,operation:'pgs-burn',parentPlanHash:identity.planHash,sourceMp4:baseFile,language,sourceCueCount:expected.length,pgsHash:digest(fs.readFileSync(normalized)),audioPayloadHashes:audioHashes,verifiedAt:new Date().toISOString(),probe:verified},null,2),{flag:'wx'});
  moveNoReplace(partial,output);moveNoReplace(receipt,output+'.verified.json');
  console.log('Completed hardcoded PGS; audio payloads unchanged: '+output);
}

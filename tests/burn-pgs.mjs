import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {burnCommand} from '../pgs-ocr.mjs';
import {run,probe} from '../apple-mp4.mjs';

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
  // Deliberately different pictures: original is blue and interlaced, with a
  // nonzero timestamp origin; the previously encoded MP4 picture is red.
  // Re-encoding the MP4 video therefore fails the pixel assertions below.
  run('ffmpeg',['-v','error','-n','-f','lavfi','-i','color=blue:size=320x180:rate=50:duration=3','-vf','tinterlace=mode=interleave_top','-c:v','ffv1','-field_order','tt','-output_ts_offset','100','original.mkv']);
  run('ffmpeg',['-v','error','-n','-f','lavfi','-i','color=red:size=320x180:rate=25:duration=3','-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000:duration=3','-c:v','libx264','-crf','20','-preset','medium','-c:a','aac','-profile:a','aac_low','-b:a','256k','-metadata','title=Verified title','base.mp4']);
  const command=burnCommand({sourceInput:['-i','original.mkv'],videoIndex:0,input:'base.mp4',pgs:'captions.sup',pgsStart:1,output:'burned.mp4',width:320,height:180,filters:['bwdif=mode=send_frame:parity=auto:deint=all','scale=320:180','format=yuv420p']});
  assert(command.includes('1:a'));assert(!command.includes('0:a'));assert(!command.includes('-copyts'));
  run('ffmpeg',command);
  const q=probe(['-i','burned.mp4']);assert.equal(q.streams[0].codec_name,'h264');assert.equal(q.streams[0].avg_frame_rate,'25/1');assert.equal(q.streams[0].pix_fmt,'yuv420p');assert.equal(q.streams[0].field_order,'progressive');assert.equal(q.format.tags.title,'Verified title');assert.equal(q.streams.filter(s=>s.codec_type==='subtitle').length,0);
  function pixel(time) {
    const r=spawnSync('ffmpeg',['-v','error','-ss',String(time),'-i','burned.mp4','-frames:v','1','-pix_fmt','gray','-f','rawvideo','-'],{encoding:null,maxBuffer:1024*1024});
    assert.equal(r.status,0);assert.equal(r.stdout.length,320*180);return r.stdout[90*320+90];
  }
  assert(pixel(.5)>10&&pixel(.5)<50,'wrong video source or caption appeared too soon');assert(pixel(1.5)>150,'PGS bitmap was not burned at its source time');assert(pixel(2.5)>10&&pixel(2.5)<50,'wrong video source or PGS bitmap did not clear');
  const audioHash=file=>run('ffmpeg',['-v','error','-i',file,'-map','0:a','-c','copy','-f','streamhash','-hash','sha256','-']).split(/\r?\n/).filter(l=>/^\d+,/.test(l));
  assert.deepEqual(audioHash('burned.mp4'),audioHash('base.mp4'));
  // Long chapters plus a microsecond subtitle timebase must not overflow the
  // automatically generated QuickTime chapter track's 32-bit sample durations.
  fs.writeFileSync('chapters.ffmeta',';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=4000000\ntitle=Long first\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=4000000\nEND=9000000\ntitle=Long second\n');
  fs.writeFileSync('text.srt','1\n00:00:01,000 --> 00:00:02,000\nTest\n');
  run('ffmpeg',['-v','error','-n','-i','base.mp4','-f','ffmetadata','-i','chapters.ffmeta','-i','text.srt','-map','0:v','-map','0:a','-map','2:s','-map_chapters','1','-c','copy','-c:s','mov_text','-movie_timescale','1000','chapters.mp4']);
  const chapters=probe(['-i','chapters.mp4']).chapters;assert.equal(chapters.length,2);assert.equal(chapters[1].start_time,'4000.000000');assert.equal(chapters[1].end_time,'9000.000000');
  console.log('PASS: original interlaced video used instead of MP4 video; source timestamp normalization; planned deinterlace/scale; exact PGS display interval; H.264 frame rate; verified MP4 metadata/audio payload identity; long chapters with text subtitles.');
}finally {
  process.chdir(original);const target=path.resolve(scratch);
  if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('bluray-burn-test-'))throw Error('Unsafe test cleanup');
  fs.rmSync(target,{recursive:true,force:true});
}

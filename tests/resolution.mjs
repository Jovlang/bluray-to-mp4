import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {applyVideoSettings} from '../video-settings.mjs';
import {run,validate,buildEncodeCommand} from '../apple-mp4.mjs';
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'resolution-test-'));
try{
  for(const [source,target,expected] of [['3840x2160','1080p',[1920,1080]],['3840x2160','720p',[1280,720]],['640x360','1080p',[640,360]],['1440x1080','480p',[640,480]]]){
    const p=applyVideoSettings({video:{index:0,avg_frame_rate:'1/1'},feature:{duration:1},interlace:{state:'progressive'}},target);
    const file=path.join(scratch,source+'-'+target+'.mp4');
    run('ffmpeg',['-v','error','-f','lavfi','-i','color=size='+source+':rate=1:duration=1','-f','lavfi','-i','anullsrc=channel_layout=stereo:sample_rate=48000:duration=1','-vf',p.filters.join(','),'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-profile:a','aac_low',file]);
    const q=validate(file,p);const video=q.streams.find(s=>s.codec_type==='video');assert.deepEqual([video.width,video.height],expected);
    if(target==='1080p'&&source==='3840x2160')assert.throws(()=>validate(file,{...p,targetResolution:'720p'},false),/codec\/layout/);
  }
  assert.throws(()=>applyVideoSettings({},'garbage'),/resolution/);
  const p=applyVideoSettings({video:{index:0},interlace:{state:'interlaced'},retainedAudio:[],subtitles:[],title:'Test'},'720p');
  assert(p.filters[0].startsWith('bwdif='));
  const command=buildEncodeCommand(p,{metadata:'chapters',output:'out.mp4',burn:{file:'captions.sup',start:0},sourceInput:['-i','source']});
  assert(command[command.indexOf('-filter_complex')+1].includes("min(iw,1280)"));
  console.log('PASS: real UHD to 1080p/720p encoding and full decode, no upscaling, aspect ratio, target-size validation, invalid presets, and shared subtitle-burn scaling.');
}finally{const target=path.resolve(scratch);assert(target.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(target,{recursive:true,force:true});}

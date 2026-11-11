import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {findDiscSources} from './gui-source.mjs';
import {validateReviewedSrt,supTimes} from './pgs-ocr.mjs';
import {selectTracks,expectedAudio} from './apple-mp4.mjs';
import {applyVideoSettings} from './video-settings.mjs';
const text=v=>typeof v==='string'?v.trim():'';
export function suggestedOutput(source,title) {
  const name=(title||path.basename(source)).replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').replace(/[. ]+$/,'').trim()||'Movie';
  return path.join(path.dirname(source),name+'.mp4');
}
export function findTools() {
  const dirs=(process.env.PATH||'').split(path.delimiter),pf=process.env.ProgramFiles||'C:\\Program Files';
  const find=(names,extra=[])=>[...dirs,...extra].flatMap(dir=>names.map(name=>path.join(dir,name))).find(file=>fs.existsSync(file)&&fs.statSync(file).isFile())||'';
  const seconv=find(['seconv.exe','SeConv.exe','seconv'],[path.join(pf,'Subtitle Edit'),path.join(process.cwd(),'tools','SeConv')]);
  const tess=find(['tesseract.exe','tesseract'],[path.join(pf,'Tesseract-OCR'),path.join(process.cwd(),'tools','Tesseract')]);
  return {seconv,tesseractDir:tess?path.dirname(tess):'',ocrAvailable:!!(seconv&&tess)};
}
export function subtitleSelection(plan,mode,index,tools) {
  if(!['none','burn','ocr'].includes(mode))throw Error('Choose a subtitle method');
  if(mode==='none')return null;
  const tracks=plan.subtitleTracks.filter(t=>t.codec_name==='hdmv_pgs_subtitle'&&/^[a-z]{3}$/.test(t.tags?.language||''));
  const english=tracks.filter(t=>t.tags.language==='eng');
  const selected=text(index)?tracks.find(t=>String(t.index)===text(index)):english.length===1?english[0]:tracks.length===1?tracks[0]:null;
  if(!selected)throw Error('Choose which PGS subtitle track to use');
  if(mode==='ocr'&&!tools.ocrAvailable)throw Error('Selectable PGS text needs SeConv and Tesseract. Set their paths in Advanced / Troubleshooting.');
  if(mode==='ocr'&&plan.subtitles.some(t=>t.tags?.language===selected.tags.language))throw Error('This language already has selectable text. Choose None to keep the existing text tracks.');
  return selected;
}
export class GuiWorkflow {
  constructor(run) {
    this.run=run;
    this.state={busy:false,phase:'idle',status:'Choose a Blu-ray folder to begin.',log:'',report:null,tools:findTools(),sources:[],review:null,output:'',planPath:'',workdir:'',error:'',audioUpdate:''};
  }
  tools(data) {
    const detected=findTools(),seconv=text(data.seconv)||detected.seconv,tesseractDir=text(data.tesseractDir)||detected.tesseractDir;
    return {seconv,tesseractDir,ocrAvailable:!!(seconv&&tesseractDir&&fs.existsSync(seconv)&&fs.existsSync(path.join(tesseractDir,'tessdata')))};
  }
  toolArgs(data){return ['ffmpeg','ffprobe'].flatMap(key=>text(data[key])?['--'+key,text(data[key])]:[]);}
  append(chunk){this.state.log=(this.state.log+chunk).slice(-200000);}
  async step(mode,args,status){this.state.status=status;this.failedCommand={mode,args,status};await this.run(mode,args,chunk=>this.append(chunk));this.failedCommand=null;}
  start(action,data) {
    if(this.state.busy)throw Error('A job is already running');
    if(!['inspect','convert','resume','recover'].includes(action))throw Error('Unknown action');
    if(action==='inspect'&&!text(data.source))throw Error('Choose a Blu-ray folder');
    if(action!=='inspect'&&!this.state.report)throw Error('Choose and inspect a Blu-ray folder first');
    if(action==='resume'&&!this.pending)throw Error('No subtitle review is pending');
    if(action==='recover'&&!this.failedCommand)throw Error('No failed conversion to recover');
    this.state.busy=true;this.state.error='';
    if(!['resume','recover'].includes(action))this.state.log='';
    return this.execute(action,data).catch(error=>{this.state.phase='error';this.state.status='Needs attention';this.state.error=error.message;this.append('\n'+error.message+'\n');}).finally(()=>{this.state.busy=false;});
  }
  async execute(action,data) {
    if(action==='inspect') {
      this.state.phase='inspecting';this.state.report=null;this.state.review=null;this.pending=null;this.task=null;this.failedCommand=null;this.state.audioUpdate='';
      const sources=findDiscSources(data.source);this.state.sources=sources;
      if(sources.length>1){this.state.phase='choose-disc';this.state.status='Choose a disc';return;}
      const source=sources[0];this.directory=fs.mkdtempSync(path.join(os.tmpdir(),'bluray-gui-'));
      const planPath=text(data.plan)||path.join(this.directory,'inspection.plan.json'),output=text(data.output)||suggestedOutput(source);
      this.state.tools=this.tools(data);
      const args=['--source',source,'--output',output,'--plan',planPath,...this.toolArgs(data)];
      for(const key of ['title','playlist','audio','interlace'])if(text(data[key]))args.push('--'+key,text(data[key]));
      await this.step('inspect',args,'Analyzing playlists, tracks, and picture…');
      this.contents=fs.readFileSync(planPath,'utf8');this.inspectionPath=planPath;
      const report=JSON.parse(this.contents);this.state.report=report;
      this.state.output=text(data.output)||suggestedOutput(source,report.title);this.state.planPath=planPath;this.state.workdir=this.directory;
      this.state.phase='ready';this.state.status=report.warnings.length?'A source choice needs your attention':'Ready to convert ✓';return;
    }
    if(action==='resume') {
      if(!text(data.reviewedSrt))throw Error('Choose the proofread SRT to continue');
      const candidate=path.join(this.task.workdir,'candidate.srt'),reviewed=path.resolve(text(data.reviewedSrt));
      if(fs.realpathSync(candidate)===fs.realpathSync(reviewed))throw Error('Choose a separate reviewed SRT; preserve candidate.srt');
      const plan=JSON.parse(fs.readFileSync(this.task.planPath,'utf8'));
      validateReviewedSrt(fs.readFileSync(candidate,'utf8'),fs.readFileSync(reviewed,'utf8'),supTimes(fs.readFileSync(path.join(this.task.workdir,'timed.sup'))),plan.feature.duration);
      this.task.reviewedSrt=reviewed;return this.finishTask();
    }
    if(action==='recover') {
      const command=this.failedCommand;
      if(!['encode','burn-pgs'].includes(command.mode))throw Error('This step cannot be finalized. Resolve the reported problem and retry conversion.');
      try { await this.step(command.mode==='encode'?'finalize':command.mode,[...command.args,...(command.mode==='burn-pgs'?['--finalize']:[])],'Verifying completed partial…'); }
      catch(error){this.failedCommand=command;throw error;}
      if(this.task.mode==='ocr')return this.finishTask();
      this.complete();return;
    }
    if(fs.readFileSync(this.inspectionPath,'utf8')!==this.contents)throw Error('Inspection plan changed. Analyze the source again.');
    const plan=JSON.parse(this.contents);
    if(plan.warnings.length)throw Error(plan.warnings.join('\n'));
    applyVideoSettings(plan,text(data.resolution)||'1080p');
    if(data.selectedAudioIndices!==undefined){
      if(!Array.isArray(data.selectedAudioIndices))throw Error('Select at least one valid audio track');
      plan.selectedAudioIndices=data.selectedAudioIndices;
      const chosen=text(data.defaultAudio);
      const preferred=chosen?Number(chosen):plan.audio?.index;
      if(chosen&&!plan.selectedAudioIndices.includes(preferred))throw Error('The default audio track must be selected');
      plan.requestedDefaultAudio=plan.selectedAudioIndices.includes(preferred)?preferred:undefined;
      selectTracks(plan,plan.sourceProbe,plan.requestedDefaultAudio,new Map());
      plan.expected.audio=expectedAudio(plan);
    }
    const output=path.resolve(text(data.output)||this.state.output);
    if(!/\.mp4$/i.test(output))throw Error('Save as must end in .mp4');
    if(fs.existsSync(output))throw Error('Output already exists; choose a new Save as path.');
    const mode=text(data.subtitleMode)||'none',tools=this.tools(data),track=subtitleSelection(plan,mode,data.subtitleIndex,tools);
    const executionDirectory=path.join(path.dirname(output),'.'+path.basename(output,'.mp4')+'-conversion-'+randomUUID());
    fs.mkdirSync(executionDirectory,{recursive:true});
    let planPath=path.join(executionDirectory,'conversion-provisional.plan.json');
    plan.output=mode==='ocr'?path.join(executionDirectory,'base.mp4'):output;
    fs.writeFileSync(planPath,JSON.stringify(plan,null,2),{flag:'wx'});
    this.state.phase='audio-preflight';
    const mediaPath=path.join(executionDirectory,'media-preflight.plan.json');
    this.state.phase='media-preflight';
    await this.step('prepare-media',['--plan',planPath,'--prepared-plan',mediaPath,...this.toolArgs(data)],'Preparing conversion — probing tracks and sampling video');
    const media=JSON.parse(fs.readFileSync(mediaPath,'utf8'));
    this.state.report=media;this.state.planPath=mediaPath;
    if(media.preflight?.status!=='complete')throw Error('Media preflight did not complete; encoding is blocked');
    if(media.warnings.length){this.state.phase='ready';this.state.status='Preflight found a source question — review the choices above';return;}
    // Match the selected metadata subtitle by PID, never by provisional stream index.
    let finalTrack=track;
    if(track){const matches=media.subtitleTracks.filter(t=>Number(t.id)===Number(track.id));if(matches.length!==1)throw Error('Selected subtitle could not be matched by PID');finalTrack=matches[0];}
    const preparedPath=path.join(executionDirectory,'conversion.plan.json');
    this.state.phase='audio-preflight';
    await this.step('prepare-audio',['--plan',mediaPath,'--prepared-plan',preparedPath,...this.toolArgs(data)],'Preparing conversion — checking audio tracks for exact duplicates');
    const prepared=JSON.parse(fs.readFileSync(preparedPath,'utf8'));
    if(prepared.audioPreflight?.status!=='complete')throw Error('Audio duplicate detection did not complete; encoding is blocked');
    this.state.report=prepared;
    const removed=plan.retainedAudio.length-prepared.retainedAudio.length;
    this.state.audioUpdate=removed>0?'Audio finalized: '+removed+' exact duplicate track(s) removed.':'Audio finalized: no exact duplicate tracks removed.';
    planPath=preparedPath;
    const workdir=text(data.subtitleWorkdir)||path.join(executionDirectory,'subtitles-'+(track?.index??'none'));
    this.state.planPath=planPath;this.state.workdir=workdir;this.state.output=output;this.state.tools=tools;
    this.task={mode,output,planPath,workdir,tools,track:finalTrack,toolArgs:this.toolArgs(data)};this.state.phase='converting';
    if(mode==='ocr') {
      await this.step('ocr-subtitles',[...this.subtitleOptions(),...this.ocrOptions(),'--prepare-only'],'Reading subtitle images and recognizing text…');
      const review=JSON.parse(fs.readFileSync(path.join(workdir,'review.json'),'utf8'));
      this.pending=true;this.state.phase='review';this.state.status='SRT ready for external review';this.state.review={...review,candidate:path.join(workdir,'candidate.srt'),report:path.join(workdir,'review.json')};return;
    }
    await this.finishTask();
  }
  subtitleOptions(){const t=this.task;return ['--plan',t.planPath,'--language',t.track.tags.language,'--subtitle-index',String(t.track.index),'--workdir',t.workdir,...t.toolArgs];}
  ocrOptions(){const t=this.task;return ['--seconv',t.tools.seconv,'--tesseract-dir',t.tools.tesseractDir];}
  async finishTask(){
    const t=this.task;this.state.phase='converting';
    if(t.mode==='ocr'&&!t.reviewedSrt)throw Error('Supply a separate externally reviewed SRT before conversion');
    if(t.mode==='burn')await this.step('burn-pgs',[...this.subtitleOptions(),'--output',t.output],'Encoding with burned subtitles, then verifying…');
    else {
      await this.step('encode',['--plan',t.planPath,...t.toolArgs],'Encoding video and audio, then verifying…');
      if(t.mode==='ocr')await this.step('ocr-subtitles',[...this.subtitleOptions(),...this.ocrOptions(),'--output',t.output,...(t.reviewedSrt?['--reviewed-srt',t.reviewedSrt]:[])],'Adding selectable text and verifying the final MP4…');
    }
    this.complete();
  }
  complete(){this.state.phase='complete';this.state.status='Completed and verified ✓';this.state.review=null;this.pending=null;}
}

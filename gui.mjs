import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {GuiWorkflow} from './gui-workflow.mjs';
import {pickPath} from './gui-picker.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const token=randomBytes(24).toString('hex');
let picking=false;
const workflow=new GuiWorkflow((mode,args,append)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(root,'apple-mp4.mjs'),mode,...args],{cwd:root,windowsHide:true});
  let tail='';
  const log=chunk=>{const value=chunk.toString();append(value);tail=(tail+value).slice(-3000);};
  child.stdout.on('data',log);child.stderr.on('data',log);
  child.once('error',reject);
  child.once('close',code=>code===0?resolve():reject(Error(tail.trim().split(/\r?\n/).filter(Boolean).at(-1)||'Conversion failed')));
}));
const reply=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const server=http.createServer(async(req,res)=>{
  if(req.method==='GET'&&req.url==='/'){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});
    res.end(fs.readFileSync(path.join(root,'gui.html'),'utf8').replace('__TOKEN__',token));return;
  }
  if(req.headers['x-gui-token']!==token)return reply(res,403,{error:'Access denied'});
  if(req.method==='GET'&&req.url==='/status')return reply(res,200,{...workflow.state,recoverable:!!workflow.failedCommand&&['encode','burn-pgs'].includes(workflow.failedCommand.mode)});
  if(req.method!=='POST'||!['/run','/pick','/open-candidate'].includes(req.url))return reply(res,404,{error:'Not found'});
  try{
    let body='';for await(const chunk of req){body+=chunk;if(body.length>2*1024*1024)throw Error('Request too large');}
    const data=JSON.parse(body);
    if(workflow.state.busy)throw Error('A job is already running');
    if(picking)throw Error('Close the current file picker first');
    if(req.url==='/open-candidate'){
      const candidate=workflow.state.review?.candidate;
      if(!candidate||!fs.existsSync(candidate))throw Error('Create a candidate SRT first');
      const command=process.platform==='win32'?'notepad.exe':process.platform==='darwin'?'open':'xdg-open';
      await new Promise((resolve,reject)=>{const child=spawn(command,[candidate],{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
      return reply(res,200,{ok:true});
    }
    if(req.url==='/pick'){
      picking=true;try{return reply(res,200,{path:await pickPath(data.field,data.current||'')});}finally{picking=false;}
    }
    workflow.start(data.action,data);
    reply(res,200,{ok:true});
  }catch(error){reply(res,400,{error:error.message});}
});
server.listen(0,'127.0.0.1',()=>{
  const url='http://127.0.0.1:'+server.address().port;
  console.log('Blu-ray to MP4 GUI: '+url+'\nKeep this terminal open. Press Ctrl+C to stop.');
  if(!process.argv.includes('--no-open')){
    const command=process.platform==='win32'?['rundll32',['url.dll,FileProtocolHandler',url]]:process.platform==='darwin'?['open',[url]]:['xdg-open',[url]];
    const opener=spawn(command[0],command[1],{windowsHide:true,stdio:'ignore'});opener.on('error',()=>console.log('Open the URL above in your browser.'));
  }
});

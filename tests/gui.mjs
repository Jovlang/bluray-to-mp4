import {spawn,spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {findDiscSources} from '../gui-source.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pickerFields,pickerScript} from '../gui-picker.mjs';

assert.throws(()=>pickerScript('unknown'),/Unknown file picker/);
assert.throws(()=>pickerScript('source',{}),/Invalid picker path/);
for(const field of Object.keys(pickerFields)) {
  const unusual="E:\\Opera\\Nürnberg's $(unexpected) `folder";
  const script=pickerScript(field,unusual);
  assert(!script.includes(unusual));
  const encoded=script.match(/FromBase64String\('([^']+)'\)/)[1];
  assert.equal(JSON.parse(Buffer.from(encoded,'base64').toString('utf8')).current,unusual);
  if(process.platform==='win32') {
    const parse=`$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(script).toString('base64')}')),[ref]$tokens,[ref]$errors);if($errors.Count){$errors | Out-String | Write-Error;exit 1}`;
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(parse,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
  }
}

const sourceTest=fs.mkdtempSync(path.join(os.tmpdir(),'gui-source-'));
try {
  assert.throws(()=>findDiscSources(sourceTest),/No Blu-ray disc/);
  assert.throws(()=>findDiscSources(path.join(sourceTest,'missing')),/does not exist/);
  const first=path.join(sourceTest,'Disc 1'), second=path.join(sourceTest,'Disc 2');
  fs.mkdirSync(path.join(first,'BDMV','PLAYLIST'),{recursive:true});
  assert.deepEqual(findDiscSources(sourceTest),[first]);
  assert.deepEqual(findDiscSources(path.join(first,'BDMV')),[first]);
  fs.mkdirSync(path.join(second,'BDMV','PLAYLIST'),{recursive:true});
  assert.deepEqual(findDiscSources(sourceTest),[first,second]);
} finally { fs.rmSync(sourceTest,{recursive:true,force:true}); }

const child=spawn(process.execPath,['gui.mjs','--no-open'],{stdio:['ignore','pipe','inherit']});
try {
  const url=await new Promise((resolve,reject)=>{
    child.stdout.once('data',data=>resolve(data.toString().match(/http:\/\/127\.0\.0\.1:\d+/)[0]));
    child.once('error',reject);
  });
  const page=await (await fetch(url)).text();
  assert(page.includes('Ready to convert ✓'));
  assert(!page.includes('I reviewed the playlist'));
  assert(page.includes('Advanced / Troubleshooting'));
  assert(page.includes("browse.textContent='Browse…'"));
  for(const label of ['Subtitles','Selectable text','Burned into video','Save as','Details']) assert(page.includes(label));
  new Function(page.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const token=page.match(/const token='([^']+)'/)[1];
  assert.equal((await fetch(url+'/status')).status,403);
  const headers={'x-gui-token':token,'Content-Type':'application/json'};
  const status=await (await fetch(url+'/status',{headers})).json();
  assert.equal(status.busy,false);
  const invalidPicker=await fetch(url+'/pick',{method:'POST',headers,body:JSON.stringify({field:'unknown'})});
  assert.equal(invalidPicker.status,400);
  assert.equal((await fetch(url+'/open-candidate',{method:'POST',headers,body:'{}'})).status,400);
  for(const body of [{action:'encode',confirmed:true},{action:'invalid'},{action:'inspect'},...['burn-prepare','burn-encode','burn-finalize','ocr-prepare','ocr-mux'].map(action=>({action,confirmed:true}))]) {
    assert.equal((await fetch(url+'/run',{method:'POST',headers,body:JSON.stringify(body)})).status,400);
  }
  console.log('PASS: GUI page, client syntax, authentication, status, review gates, PGS selection, burn/preview/recovery and OCR prepare/mux argument mapping.');
} finally {
  child.kill();
}

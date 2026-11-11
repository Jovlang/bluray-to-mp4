import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {normalizeSup,supTimes,parseSrt,writeSrt,checkTiming,reviewOcr,supGroups,verifiedBase,validateReviewedSrt} from '../pgs-ocr.mjs';

function segment(type,time,payload=Buffer.alloc(0)) {
  const b=Buffer.alloc(13+payload.length);b.write('PG');b.writeUInt32BE(Math.round(time*90000)>>>0,2);b[10]=type;b.writeUInt16BE(payload.length,11);payload.copy(b,13);return b;
}
function display(time,{clear=false,transparent=false}={}) {
  const pcs=Buffer.alloc(clear?11:19);pcs.writeUInt16BE(1920);pcs.writeUInt16BE(1080,2);pcs[10]=clear?0:1;
  if(clear)return Buffer.concat([segment(22,time,pcs),segment(128,time)]);
  const palette=Buffer.from([0,0,0,16,128,128,0,1,235,128,128,255]);
  const rle=transparent?[0,1,0,0]:[1,0,0];
  const object=Buffer.from([0,0,0,0xc0,0,0,4+rle.length,0,1,0,1,...rle]);
  return Buffer.concat([segment(22,time,pcs),segment(20,time,palette),segment(21,time,object),segment(128,time)]);
}
const track=(start,end,transparent=false)=>Buffer.concat([display(start,{transparent}),display(end,{clear:true})]);
const item={start:50,end:55};
assert.deepEqual(supTimes(normalizeSup([item],[track(51,53)])),[{start:1,end:3}]);
assert.deepEqual(supTimes(normalizeSup([item],[track(51,56)])),[{start:1,end:5}]);
assert.deepEqual(supTimes(normalizeSup([item],[track(49,51)])),[{start:0,end:1}]);
assert.deepEqual(supTimes(normalizeSup([item],[track(51,53,true)])),[]);
const wrap={start:47720,end:47725};
assert.deepEqual(supTimes(normalizeSup([item,wrap],[track(51,53),track(47722,47723)])),[{start:1,end:3},{start:7,end:8}]);
assert.deepEqual(supTimes(normalizeSup([item,item],[track(51,53),track(51,53)])),[{start:1,end:3},{start:6,end:8}]);
assert.throws(()=>supGroups(Buffer.from('PG')),/Invalid/);
assert.throws(()=>supGroups(display(1).subarray(0,-1)),/Truncated|Invalid/);
const cues=[{start:1,end:3,text:'| see her.\nA Kiss for lago.'}];
const reviewed=reviewOcr(cues);assert.equal(reviewed.cues[0].text,'I see her.\nA Kiss for lago.');assert.equal(reviewed.fixes.length,1);assert(reviewed.issues.length);
assert.deepEqual(parseSrt(writeSrt(reviewed.cues)),reviewed.cues);
checkTiming(reviewed.cues,[{start:1,end:3}],5);
assert.throws(()=>checkTiming([{start:1.1,end:3,text:'wrong timing'}],[{start:1,end:3}],5),/changed source timing/);
assert.throws(()=>checkTiming([], [{start:1,end:3}],5),/count/);
assert.throws(()=>parseSrt('1\n00:00:01,000 --> 00:00:02,000\n'),/empty/);
const original=[{start:1,end:3,text:'First'},{start:3,end:5,text:'Second'}],candidate=writeSrt(original);
assert.equal(validateReviewedSrt(candidate,candidate.replace('First','Corrected first'),original,6)[0].text,'Corrected first');
for(const altered of [writeSrt(original.slice(0,1)),writeSrt([...original].reverse()),candidate.replace('\n2\n','\n3\n'),candidate.replace('Second',''),candidate.replace('00:00:01,000','00:00:01,004'),candidate.replace('00:00:03,000 -->','00:00:02,999 -->'),candidate.replace('00:00:01,000','00:60:01,000'),candidate.replace(' --> ',' -> ')]) {
  assert.throws(()=>validateReviewedSrt(candidate,altered,original,6));
}
validateReviewedSrt(candidate,candidate.replace('00:00:01,000','00:00:01,002'),original,6);
validateReviewedSrt(candidate,candidate.replace('00:00:01,000','00:00:01,003'),original,6);
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'bluray-receipt-test-'));
try {
  const file=path.join(scratch,'relocated.mp4'),receiptFile=path.join(scratch,'receipt.json');fs.writeFileSync(file,'test');
  const receipt={operation:'pgs-ocr-streamcopy',parentPlanHash:'plan',probe:{format:{size:'4'},streams:[{codec_type:'subtitle',codec_name:'mov_text',tags:{language:'eng'}}]}};
  fs.writeFileSync(receiptFile,JSON.stringify(receipt));
  const options={'base-mp4':file,'base-receipt':receiptFile};let checked=0;
  const ctx={opt:(k,d)=>options[k]??d,validate:(f,p,decode)=>{checked++;assert.equal(f,file);assert.equal(p.subtitles.length,1);assert.equal(decode,false);return receipt.probe;}};
  assert.equal(verifiedBase(ctx,{output:'old-location.mp4',subtitles:[]},{planHash:'plan'}).plan.subtitles[0].tags.language,'eng');assert.equal(checked,1);
  assert.throws(()=>verifiedBase(ctx,{subtitles:[]},{planHash:'wrong-plan'}),/different plan/);assert.equal(checked,1);
  fs.appendFileSync(file,'changed');assert.throws(()=>verifiedBase(ctx,{subtitles:[]},{planHash:'plan'}),/size differs/);
}finally {
  const target=path.resolve(scratch);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('bluray-receipt-test-'))throw Error('Unsafe cleanup');fs.rmSync(target,{recursive:true,force:true});
}
console.log('PASS: PGS IN/OUT trimming, preroll, timestamp wrap, repeated clips, transparent objects, malformed inputs, SRT timing/count checks, OCR corrections and review flags.');

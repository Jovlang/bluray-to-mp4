export const resolutions={
  '1080p':{width:1920,height:1080},
  '720p':{width:1280,height:720},
  '480p':{width:854,height:480}
};
export function videoBounds(plan){
  const bounds=resolutions[plan.targetResolution||'1080p'];
  if(!bounds)throw Error('Choose an output resolution: 1080p, 720p, or 480p');
  return bounds;
}
export function applyVideoSettings(plan,resolution=plan.targetResolution||'1080p'){
  plan.targetResolution=resolution;
  const {width,height}=videoBounds(plan);
  plan.filters=[...(plan.interlace?.state==='interlaced'?['bwdif=mode=send_frame:parity=auto:deint=all']:[]),`scale=w='min(iw,${width})':h='min(ih,${height})':force_original_aspect_ratio=decrease:force_divisible_by=2`,'format=yuv420p'];
  plan.expected={...plan.expected,video:`libx264 CRF 20 medium yuv420p; original frame rate; maximum ${width}x${height}`,resolution:{...videoBounds(plan),upscale:false},filters:plan.filters};
  return plan;
}

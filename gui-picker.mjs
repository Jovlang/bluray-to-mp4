import {spawn} from 'node:child_process';

export const pickerFields = {
  source:{kind:'folder',title:'Choose Blu-ray folder'},
  output:{kind:'save',title:'Save converted MP4',filter:'MP4 video (*.mp4)|*.mp4',extension:'mp4'},
  plan:{kind:'save',title:'Save new inspection plan',filter:'JSON plan (*.json)|*.json',extension:'json'},
  ffmpeg:{kind:'open',title:'Choose FFmpeg',filter:'Executable (*.exe)|*.exe|All files (*.*)|*.*'},
  ffprobe:{kind:'open',title:'Choose FFprobe',filter:'Executable (*.exe)|*.exe|All files (*.*)|*.*'},
  subtitleWorkdir:{kind:'folder',title:'Choose subtitle work folder'},
  subtitleOutput:{kind:'save',title:'Save new subtitled MP4',filter:'MP4 video (*.mp4)|*.mp4',extension:'mp4'},
  seconv:{kind:'open',title:'Choose Subtitle Edit SeConv',filter:'Executable (*.exe)|*.exe|All files (*.*)|*.*'},
  tesseractDir:{kind:'folder',title:'Choose Tesseract folder'},
  baseMp4:{kind:'open',title:'Choose verified base MP4',filter:'MP4 video (*.mp4)|*.mp4'},
  baseReceipt:{kind:'open',title:'Choose matching verification receipt',filter:'JSON receipt (*.json)|*.json'},
  reviewedSrt:{kind:'open',title:'Choose proofread subtitles',filter:'SubRip subtitles (*.srt)|*.srt'}
};

export function pickerScript(field,current='') {
  if (!Object.hasOwn(pickerFields,field)) throw Error('Unknown file picker');
  if (typeof current !== 'string' || current.length>4096) throw Error('Invalid picker path');
  const config=Buffer.from(JSON.stringify({...pickerFields[field],current}),'utf8').toString('base64');
  return `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
$config=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}')) | ConvertFrom-Json
$owner=New-Object System.Windows.Forms.Form
$owner.TopMost=$true
$owner.ShowInTaskbar=$false
$owner.Opacity=0
$owner.Show()
try {
  if($config.kind -eq 'folder') {
    $dialog=New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description=$config.title
    $dialog.ShowNewFolderButton=$true
    if([IO.Directory]::Exists($config.current)) { $dialog.SelectedPath=$config.current }
  } else {
    if($config.kind -eq 'save') {
      $dialog=New-Object System.Windows.Forms.SaveFileDialog
      $dialog.OverwritePrompt=$true
      $dialog.DefaultExt=$config.extension
      $dialog.AddExtension=$true
    } else { $dialog=New-Object System.Windows.Forms.OpenFileDialog; $dialog.CheckFileExists=$true }
    $dialog.Title=$config.title
    $dialog.Filter=$config.filter
    if($config.current) {
      $directory=[IO.Path]::GetDirectoryName($config.current)
      if([IO.Directory]::Exists($directory)) { $dialog.InitialDirectory=$directory }
      $dialog.FileName=[IO.Path]::GetFileName($config.current)
    }
  }
  try {
    $selected=''
    if($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
      if($config.kind -eq 'folder') { $selected=$dialog.SelectedPath } else { $selected=$dialog.FileName }
    }
    [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
    [Console]::Write(($selected | ConvertTo-Json -Compress))
  } finally { $dialog.Dispose() }
} finally { $owner.Dispose() }
`;
}

export async function pickPath(field,current) {
  const script=pickerScript(field,current);
  if(process.platform!=='win32') throw Error('Native Browse dialogs currently require Windows. You can enter paths manually.');
  return new Promise((resolve,reject)=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',errors='';
    child.stdout.on('data',chunk=>output+=chunk.toString('utf8'));
    child.stderr.on('data',chunk=>errors+=chunk.toString());
    child.on('error',reject);
    child.on('close',code=>{
      if(code!==0) return reject(Error('Could not open file picker: '+errors));
      try { resolve(JSON.parse(output)); } catch { reject(Error('Could not read file picker selection')); }
    });
  });
}

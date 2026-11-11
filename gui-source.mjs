import fs from 'node:fs';
import path from 'node:path';

export function findDiscSources(value) {
  let source = path.resolve(value.trim());
  if (path.basename(source).toUpperCase() === 'BDMV') source = path.dirname(source);
  const isDisc = directory => fs.existsSync(path.join(directory,'BDMV','PLAYLIST'));
  if (isDisc(source)) return [source];
  let entries;
  try { entries = fs.readdirSync(source,{withFileTypes:true}); }
  catch (error) {
    if (error.code === 'ENOENT') throw Error('Source folder does not exist: '+source);
    throw error;
  }
  const discs = entries.filter(entry=>entry.isDirectory()).map(entry=>path.join(source,entry.name)).filter(isDisc).sort();
  if (!discs.length) throw Error('No Blu-ray disc found. Choose a folder containing BDMV/PLAYLIST, its BDMV folder, or the parent of disc folders.');
  return discs;
}

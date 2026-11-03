'use strict';

// Codex sends new file contents for additions and unified hunks for updates.
function changeStats(change) {
 const diff=change?.diff,kind=change?.kind?.type;
 if(typeof diff!=='string')return null;
 if(kind==='add'&&!/^@@\s/.test(diff)){
  const lines=diff===''?0:diff.split(/\r?\n/).length-(diff.endsWith('\n')?1:0);
  return {added:lines,removed:0};
 }
 if(!/^@@\s/m.test(diff))return null;
 let added=0,removed=0,inHunk=false;
 for(const line of diff.split(/\r?\n/)){
  if(line.startsWith('@@ ')){inHunk=true;continue;}
  if(!inHunk)continue;
  if(line.startsWith('+'))added++;
  else if(line.startsWith('-'))removed++;
 }
 return {added,removed};
}
module.exports={changeStats};

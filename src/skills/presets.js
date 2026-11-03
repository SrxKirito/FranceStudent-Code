'use strict';
// Catégories indicatives : un skill peut appartenir à plusieurs groupes.
const GROUPS={
 code:/\b(code|coding|program|programmation|develop|developer|javascript|typescript|python|rust|logiciel|software|api|debug|git|react|web|site|frontend|backend)\w*/,
 design:/\b(design|ui|ux|interface|visuel|visual|graph|graphique|image|illustration|figma|typograph|couleur|couleurs|maquette|style|blender|3d|roblox|animation)\w*/,
 finance:/\b(finance|financial|financials|comptabil|invest|budget|revenu|bourse|econom|economic|tax|fiscal|trading|banque|banking|spreadsheet|tableur|excel)\w*/,
 documents:/\b(document|pdf|word|docx|presentation|slides|powerpoint|pptx|redaction|ecriture|rapport|report)\w*/,
 recherche:/\b(recherche|research|search|sources|veille|analyse|analysis|browse|navigat)\w*/
};
const normalize=value=>String(value||'').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
function groups(value){const text=normalize(value);return Object.entries(GROUPS).filter(([,pattern])=>pattern.test(text)).map(([name])=>name);}
function select(skills,task){
 const requested=groups(task),query=normalize(task);
 if(!requested.length)return skills;
 return skills.filter(skill=>{
  const name=normalize(skill.name||skill.id);
  if(name.length>2&&query.includes(name))return true;
  const categories=groups([name,skill.description,skill.category].filter(Boolean).join(' '));
  return !categories.length||categories.some(category=>requested.includes(category));
 });
}
module.exports={groups,select};

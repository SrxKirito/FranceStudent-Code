/* Destination et budget réel du prochain envoi, indépendants des messages de statut. */
const composerStatus=document.createElement('div');composerStatus.className='composer-status-line';
const composerScope=centerNode('span','composer-scope');composerScope.id='composer-scope';
const composerQuota=centerNode('button','composer-quota');composerQuota.type='button';composerQuota.id='composer-quota';
composerQuota.innerHTML='<span class="composer-quota-label"></span><span class="composer-quota-track" role="progressbar" aria-label="Quota restant" aria-valuemin="0" aria-valuemax="100"><span></span></span>';
composerQuota.onclick=()=>{browserHomeClosePage();setAgentTab('usage');};
composerStatus.append(composerScope,composerQuota);$('composer-feedback').before(composerStatus);
function renderComposerQuota(){
 const button=$('composer-quota');if(!button)return;
 const used=ui.quota?.percent==null?null:Number(ui.quota.percent),known=used!==null&&Number.isFinite(used),remaining=known?Math.max(0,Math.min(100,100-used)):null;
 const bar=button.querySelector('[role="progressbar"]');
 button.dataset.tone=!known?'unknown':used>=90?'red':used>=75?'orange':used>=50?'yellow':'green';
 button.querySelector('.composer-quota-label').textContent=known?`Quota restant : ${ui.quota.uncertain?'≈ ':''}${Math.round(remaining*10)/10} %`:ui.quotaLoading?'Quota : actualisation…':'Quota indisponible';
 bar.style.setProperty('--remaining',`${remaining??0}%`);
 if(known){bar.setAttribute('aria-valuenow',String(remaining));bar.removeAttribute('aria-valuetext');}else{bar.removeAttribute('aria-valuenow');bar.setAttribute('aria-valuetext','Indisponible');}
 button.title=ui.quotaError||`Quota du compte FranceStudent${ui.quotaUpdatedAt?' · actualisé à '+new Date(ui.quotaUpdatedAt).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}):''} · Voir les détails`;
}
function renderComposerScope(){
 if(!$('composer-scope'))return;
 if(isMotionOpen())composerScope.textContent='Motion · Projet EffectCraft';
 else if(ui.status.mode==='chat'){const selected=franceStudentProjects.find(project=>String(project.id)===$('agent-fr-project').value);composerScope.textContent=selected?`Chat · ${selected.name}`:'Chat · Historique général';}
 else composerScope.textContent=ui.workspace?`Code · ${ui.workspace.replace(/[\\/]+$/,'').split(/[\\/]/).pop()}`:'Code · Choisis un projet';
 composerScope.title=ui.status.mode==='chat'?composerScope.textContent:ui.workspace||composerScope.textContent;
 const button=$('codex-rail-new');if(button)button.title='Nouvelle discussion · '+composerScope.textContent;
}
$('agent-fr-project').addEventListener('change',renderComposerScope);
api.onEvent(channel=>{if(channel==='status'||channel==='signedOut'){renderComposerScope();renderComposerQuota();}});
new MutationObserver(renderComposerScope).observe($('app'),{attributes:true,attributeFilter:['class']});
renderComposerScope();renderComposerQuota();

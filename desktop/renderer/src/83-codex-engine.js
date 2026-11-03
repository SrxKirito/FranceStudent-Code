/* Indicateur de la copie expérimentale ; les contrôles habituels restent disponibles. */
const codexEngineBadge=document.createElement("span");
codexEngineBadge.id="codex-engine-status";
codexEngineBadge.setAttribute("role","status");
codexEngineBadge.textContent="Codex · expérimental";
codexEngineBadge.title="Moteur Codex avec les modèles du compte FranceStudent";
codexEngineBadge.style.cssText="font-size:12px;color:var(--fg-dim);margin-left:8px";
document.title="FranceStudent IDE — Codex (copie expérimentale)";
(document.querySelector("#agent .agent-tabs")||document.querySelector(".workspace-titlebar-brand"))?.append(codexEngineBadge);
api.onEvent((channel,data)=>{
    if(channel!=="status")return;
    codexEngineBadge.textContent=ui.motionDesign?"Motion":data.mode==="chat"?"Chat FranceStudent":data.agentEngine==="codex"?"Codex · expérimental":"Agent historique";
});

/* Bibliothèque du compte, classement facultatif par IA. */
const accountSkillsPanel = document.querySelector('[data-center-panel="installed"]');
const accountSkillsHeader = accountSkillsPanel.querySelector(".ext-section-head");
const accountSkillsToolbar = centerNode("div", "account-skills-toolbar");
const accountSkillsSearch = $("skills-search"); accountSkillsSearch.placeholder = "Rechercher un skill";
const accountSkillsSort = document.createElement("select"); accountSkillsSort.className = "account-skills-sort"; accountSkillsSort.setAttribute("aria-label", "Filtrer par domaine");
const accountSkillsAll = centerNode("option", "", "Tous les domaines"); accountSkillsAll.value = ""; accountSkillsSort.append(accountSkillsAll);
accountSkillsSort.onchange = () => { skillGroupFilter = accountSkillsSort.value; installedVisibleCount = 60; renderInstalledSkills(); };
const accountSkillsSuggest = centerButton("Classer avec l’IA", async () => {
    if (!accountSkills.length) { $("center-message").textContent = "Ajoute un skill avant de lancer le classement."; return; }
    $("center-message").textContent = "Classement des noms et descriptions par l’IA…";
    const result = await api.extensionAction("account-groups"); skillGroupSuggestions = new Map(result.map(item => [item.id,item.group]));
    const groups = [...new Set(result.map(item => item.group))].sort((a,b) => a.localeCompare(b,"fr"));
    accountSkillsSort.replaceChildren(accountSkillsAll); for (const group of groups) { const option = centerNode("option", "", group); option.value = group; accountSkillsSort.append(option); }
    skillGroupFilter = ""; accountSkillsSort.value = ""; syncSettingsModelMenu(accountSkillsSort); renderInstalledSkills();
    $("center-message").textContent = "Classement proposé par l’IA pour cette session. Les activations restent inchangées.";
});
const add = document.createElement("details"); add.className = "account-skills-add";
const summary = document.createElement("summary"); summary.textContent = "+ Ajouter"; add.append(summary);
const addMenu = centerNode("div", "account-skills-add-menu");
for (const id of ["btn-skill-import-file", "btn-skill-import-directory", "btn-skill-new"]) { const button = $(id); if (button) { button.addEventListener("click", () => { add.open = false; }); addMenu.append(button); } }
add.append(addMenu);
accountSkillsToolbar.append(accountSkillsSearch, accountSkillsSort, accountSkillsSuggest, $("btn-skill-dir"), add);
accountSkillsHeader.replaceChildren(); accountSkillsHeader.append(accountSkillsToolbar);
createSettingsModelMenu(accountSkillsSort, "Filtrer par domaine", false, true);
accountSkillsSort.nextElementSibling.classList.add("account-skills-filter-menu");
accountSkillsPanel.querySelector(".center-skill-section-label")?.remove();
accountSkillsPanel.querySelector(".center-filters").hidden = true;
accountSkillsPanel.querySelector(".center-filters").style.display = "none";
const help = accountSkillsPanel.querySelector(":scope > .settings-help"); if (help) help.hidden = true;
const label = centerNode("div", "account-skills-label", "Bibliothèque "); const count = centerNode("span", "account-skill-count", "0"); count.id = "account-skill-count"; label.append(count); $("skills-list").before(label);

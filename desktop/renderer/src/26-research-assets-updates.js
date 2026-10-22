// 26-research-assets-updates.js — recherche Internet en arrière-plan dans le cockpit du projet.
// Portage adapté de extraopaa/francestudents-ide. API : api.webResearch (list, start, cancel).
// Les mises à jour sont déjà gérées par la section « Import et mises à jour » des paramètres
// (12-sidebar.js, api.checkUpdates) : pas de carte en double. L'aperçu des fichiers binaires,
// la capture de page et la mise à jour automatique ne sont pas portés (API absentes en local).

const researchState = { jobs: [], timer: null };

(() => {
    const tabs = document.querySelector("#project-studio .studio-tabs");
    const body = document.querySelector("#project-studio .studio-body");
    if (!tabs || !body) return;
    const tab = centerNode("button", "", "Internet");
    tab.type = "button";
    tab.dataset.studioTab = "research";
    tabs.append(tab);
    pstudioBindTab(tab);
    body.insertAdjacentHTML("beforeend", `<div class="studio-tab-page hidden" data-studio-page="research"><section class="studio-card"><h3>Recherche Internet</h3><form id="studio-research-form" class="center-filters"><input id="studio-research-query" maxlength="1000" placeholder="Que cherchez-vous ?" aria-label="Recherche" spellcheck="false"><button type="submit" class="primary">Rechercher</button></form><p class="studio-muted">Les recherches tournent en arrière-plan (DuckDuckGo) : vous pouvez continuer à travailler.</p></section><div id="studio-research-jobs"></div></div>`);
    tab.addEventListener("click", () => researchRefresh());
})();

function researchStatus(status) {
    return { running: "En cours", done: "Terminée", failed: "Échec", stopped: "Arrêtée" }[status] || status;
}

function researchRender() {
    const box = $("studio-research-jobs");
    if (!box) return;
    box.replaceChildren();
    if (!researchState.jobs.length) {
        box.append(centerNode("p", "studio-muted", "Aucune recherche pour l'instant."));
        return;
    }
    for (const job of researchState.jobs.slice().reverse()) {
        const card = centerNode("article", "studio-card studio-research-job");
        card.dataset.status = job.status;
        const head = centerNode("div", "studio-card-head");
        head.append(centerNode("strong", "", job.query), centerNode("span", job.status === "failed" ? "studio-pill error" : "studio-pill", researchStatus(job.status)));
        if (job.status === "running") head.append(centerButton("Arrêter", () => researchCancel(job.id)));
        card.append(head);
        if (job.error) card.append(centerNode("p", "studio-muted", job.error));
        const result = job.result || {};
        if (result.message) card.append(centerNode("p", "studio-muted", result.message));
        for (const item of result.results || []) {
            const row = centerNode("div", "studio-research-result");
            const link = centerNode("a", "", item.title || item.url);
            link.href = item.url;
            link.title = item.url;
            link.onclick = (event) => {
                event.preventDefault();
                api.openExternal(item.url).catch((error) => pstudioError(error));
            };
            row.append(link, centerNode("span", "studio-muted", item.url));
            if (item.snippet) row.append(centerNode("p", "", item.snippet));
            card.append(row);
        }
        box.append(card);
    }
}

async function researchRefresh() {
    try {
        researchState.jobs = await api.webResearch("list");
        researchRender();
    } catch (error) {
        pstudioError(error);
    }
}

async function researchCancel(id) {
    try {
        researchState.jobs = await api.webResearch("cancel", { id });
        researchRender();
    } catch (error) {
        pstudioError(error);
    }
}

if ($("studio-research-form")) {
    $("studio-research-form").onsubmit = async (event) => {
        event.preventDefault();
        const query = $("studio-research-query").value.trim();
        if (!query) return;
        try {
            await api.webResearch("start", { query });
            $("studio-research-query").value = "";
            pstudioMessage(`Recherche lancée : ${query}`);
            await researchRefresh();
        } catch (error) {
            pstudioError(error);
        }
    };
}

if (api && typeof api.onEvent === "function") {
    api.onEvent((channel) => {
        if (channel !== "webResearch") return;
        clearTimeout(researchState.timer);
        researchState.timer = setTimeout(researchRefresh, 200);
    });
}

/* ---------- File de prompts visible (au-dessus de la saisie) ---------- */
/* Portage simplifié du module 14-task-queue du dépôt extraopaa : uniquement côté renderer,
   sur la file locale ui.promptQueue (09-composer.js), sans IPC taskQueue. */

(() => {
    const anchor = $("attachments");
    if (!anchor || $("pending-prompts")) return;
    const host = document.createElement("div");
    host.id = "pending-prompts";
    host.className = "pending-prompts hidden";
    host.setAttribute("aria-label", "Prompts en attente");
    anchor.parentNode.insertBefore(host, anchor);
})();

function pendingAttachmentName(a) {
    if (!a) return "";
    if (typeof a === "string") return a.split(/[\\/]/).pop();
    return a.name || (a.path ? String(a.path).split(/[\\/]/).pop() : "") || "fichier";
}

function pendingPromptAction(label, title, run) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pending-btn";
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.onclick = (ev) => {
        ev.preventDefault();
        run();
    };
    return btn;
}

function movePendingPrompt(index, delta) {
    const queue = ui.promptQueue || [];
    const target = index + delta;
    if (target < 0 || target >= queue.length) return;
    [queue[index], queue[target]] = [queue[target], queue[index]];
    updatePromptQueueBadge();
}

function removePendingPrompt(index) {
    const queue = ui.promptQueue || [];
    if (index < 0 || index >= queue.length) return;
    queue.splice(index, 1);
    updatePromptQueueBadge();
}

function editPendingPrompt(index) {
    const queue = ui.promptQueue || [];
    const item = queue[index];
    if (!item) return;
    if (input.value.trim() && !confirm("Remplacer le texte en cours de saisie par ce prompt en attente ?")) return;
    queue.splice(index, 1);
    input.value = item.value || "";
    if (Array.isArray(item.attachments) && item.attachments.length) {
        pendingAttachments = [...pendingAttachments, ...item.attachments];
        renderAttachments();
    }
    updatePromptQueueBadge();
    if (typeof autosizeInput === "function") autosizeInput();
    input.focus();
}

function renderPendingPrompts() {
    const host = $("pending-prompts");
    if (!host) return;
    const queue = ui.promptQueue || [];
    host.replaceChildren();
    host.classList.toggle("hidden", !queue.length);
    if (!queue.length) return;
    const head = document.createElement("div");
    head.className = "pending-head";
    const title = document.createElement("span");
    title.textContent = `${queue.length} demande(s) en attente · envoi automatique à la fin de la tâche en cours`;
    head.append(title, pendingPromptAction("Tout effacer", "Vider la file d'attente", () => {
        if (confirm(`Supprimer les ${queue.length} demande(s) en attente ?`)) clearPromptQueue();
    }));
    host.appendChild(head);
    queue.forEach((item, i) => {
        const row = document.createElement("div");
        row.className = "pending-prompt";
        const icon = document.createElement("span");
        icon.className = "pending-icon";
        icon.textContent = "↳";
        const text = document.createElement("span");
        text.className = "pending-text";
        text.textContent = item.value || "(sans texte)";
        text.title = item.value || "";
        if (Array.isArray(item.attachments) && item.attachments.length) {
            const files = document.createElement("small");
            files.className = "pending-attachments";
            files.textContent = "📎 " + item.attachments.map(pendingAttachmentName).join(", ");
            files.title = files.textContent;
            text.appendChild(files);
        }
        const up = pendingPromptAction("↑", "Monter", () => movePendingPrompt(i, -1));
        up.disabled = i === 0;
        const down = pendingPromptAction("↓", "Descendre", () => movePendingPrompt(i, 1));
        down.disabled = i === queue.length - 1;
        row.append(
            icon,
            text,
            pendingPromptAction("Modifier", "Remettre ce prompt dans la saisie pour le modifier", () => editPendingPrompt(i)),
            up,
            down,
            pendingPromptAction("✕", "Supprimer ce prompt en attente", () => removePendingPrompt(i))
        );
        host.appendChild(row);
    });
}

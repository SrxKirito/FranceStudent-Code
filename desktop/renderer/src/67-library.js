/* Bibliothèque des discussions du compte, même si elles ont commencé sur mobile. */
browserHomeViewTitles.library = "Bibliothèque";
let rememberedLibraryPage = null, rememberedLibraryCleanup = null, resumeLibraryLoading = null;
api.onEvent(channel => {
    if (channel !== "signedOut") return;
    rememberedLibraryCleanup?.();
    rememberedLibraryPage = rememberedLibraryCleanup = resumeLibraryLoading = null;
});
browserHomeViews.library = () => {
    if (rememberedLibraryPage) {
        browserHomeViewBody.append(rememberedLibraryPage);
        resumeLibraryLoading();
        return;
    }
    const page = centerNode("div", "library-page");
    rememberedLibraryPage=page;
    page.append(centerNode("h1", "", "Bibliothèque"), centerNode("p", "settings-help", "Fichiers et images trouvés dans les discussions synchronisées sur ton compte. Les originaux enregistrés uniquement sur un autre appareil ne sont pas accessibles ici."));
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "Rechercher dans les éléments chargés"; search.setAttribute("aria-label", "Rechercher dans la bibliothèque");
    const status = centerNode("p", "settings-help", "Chargement…"); status.setAttribute("role", "status");
    const grid = centerNode("div", "library-grid-desktop");
    const storedColumns = Number(localStorage.getItem("fs.library.columns"));
    grid.style.setProperty("--library-columns", storedColumns >= 1 && storedColumns <= 4 ? storedColumns : 3);
    const more = centerButton("Réessayer", () => load(retryRefresh)); more.hidden = true;
    const refresh = centerButton("Actualiser la bibliothèque", () => load(true));
    page.append(search, refresh, status, grid, more); browserHomeViewBody.append(page);
    const items = [], activePreviews = new Map(), loadedCursors = new Set();
    let cursor = "", hasMore = true, loading = false, failed = 0, limited = 0;
    let nextPageTimer, loadError = "", retryRefresh = false;
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) {
            observer.unobserve(entry.target);
            const item = entry.target.libraryItem;
            if (!item?.messageId || item.data || item.loading) continue;
            item.loading = true;
            api.accountLibraryImage(item.conversationId, item.messageId, item.imageId).then(data => {
                item.data = data; item.loading = false;
                const target = activePreviews.get(item); if (target?.isConnected) showImage(target, item);
            }).catch(error => { item.loading = false; const target = activePreviews.get(item); if (target?.isConnected) target.textContent = `Image indisponible : ${error.message}`; });
        }
    }, { root: browserHomeViewBody, rootMargin: "160px" });
    rememberedLibraryCleanup = () => {
        clearTimeout(nextPageTimer);
        observer.disconnect();
        items.length = 0;
        activePreviews.clear();
        page.replaceChildren();
    };
    function showImage(container, item) {
        const image = document.createElement("img"); image.src = item.data; image.alt = "Image générée"; image.loading = "lazy"; container.replaceChildren(image);
        const link = container.parentNode.querySelector("[data-image-download]");
        if (link) { link.href = item.data; link.download = "image-generee" + (item.data.startsWith("data:image/jpeg") ? ".jpg" : item.data.startsWith("data:image/webp") ? ".webp" : item.data.startsWith("data:image/gif") ? ".gif" : ".png"); link.hidden = false; }
    }
    function updateStatus() {
        const count = grid.childElementCount;
        status.textContent = `${count} élément(s) ${search.value ? "trouvé(s)" : "chargé(s)"}`
            + (failed ? ` · ${failed} discussion(s) indisponible(s)` : "")
            + (limited ? ` · ${limited} discussion(s) partiellement indexée(s), à ouvrir pour tout voir` : "")
            + (loadError ? ` · Chargement interrompu : ${loadError}` : hasMore ? " · Analyse des discussions en cours…" : "");
        refresh.disabled = loading;
        more.hidden = !loadError;
        more.disabled = loading;
    }
    function render(start = 0) {
        if (!start) {
            observer.disconnect();
            activePreviews.clear();
            grid.replaceChildren();
        }
        const query = search.value.toLocaleLowerCase("fr");
        const shown = items.slice(start).filter(item => `${item.conversationTitle} ${item.language || "image"} ${item.name || ""} ${item.code || ""}`.toLocaleLowerCase("fr").includes(query));
        for (const item of shown) {
            const card = centerNode("article", "library-card-desktop");
            const first = String(item.code || "").split("\n")[0].trim();
            const named = /^(?:#|\/\/|<!--|\/\*|--|%)/.test(first) ? first.match(/[\w-]+\.[\w]{1,8}/) : null;
            const extByLang = { python:"py", py:"py", javascript:"js", js:"js", typescript:"ts", ts:"ts", html:"html", css:"css", json:"json", text:"txt", txt:"txt", pdf:"pdf", pptx:"pptx", powerpoint:"pptx", svg:"svg" };
            const ext = named ? named[0].split(".").pop().toLowerCase() : extByLang[String(item.language || "").toLowerCase()];
            const name = item.kind === "attachment" ? item.name : named?.[0] || (ext ? `fichier.${ext}` : "Extrait");
            card.append(centerNode("strong", "", item.kind === "image" ? "Image générée" : name), centerNode("small", "", `${item.kind === "attachment" ? "Envoyé · " : ""}${item.conversationTitle}`));
            let preview;
            if (item.kind === "image") { preview = centerNode("div", "library-image-preview", "Chargement de l’image…"); preview.libraryItem = item; card.append(preview); }
            else if (item.kind === "attachment") card.append(centerNode("p", "settings-help", "Fichier envoyé depuis cet ordinateur"));
            else card.append(centerNode("pre", "", item.code.slice(0, 400)));
            const actions = centerNode("div", "library-card-actions");
            if (item.kind === "image") { const link = document.createElement("a"); link.dataset.imageDownload = ""; link.textContent = "Télécharger"; link.hidden = true; actions.append(link); }
            else if (item.kind === "attachment") {
                const previewButton = centerButton("Aperçu", async () => {
                    try { const blob = await attachmentPreviewBlob(item); if (!blob) throw new Error("L’original n’est plus disponible sur cet ordinateur."); await showAttachmentBlob(name, blob, { returnFocus: previewButton }); }
                    catch (error) { studioFeedback(error.message); }
                });
                actions.append(previewButton, centerButton("Télécharger", async () => {
                    try { const blob = await attachmentPreviewBlob(item); if (!blob) throw new Error("L’original n’est plus disponible sur cet ordinateur."); const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); }
                    catch (error) { studioFeedback(error.message); }
                }));
            } else {
                actions.append(centerButton("Copier", async () => { try { await navigator.clipboard.writeText(item.code); studioFeedback("Extrait copié."); } catch (error) { studioFeedback(error.message); } }));
                if (ext) {
                    const fileCode = ext === "pdf" && named ? item.code.slice(item.code.indexOf("\n") + 1) : item.code;
                    const previewButton = centerButton("Aperçu", async () => {
                        try { const blob = ext === "pptx" ? new Blob() : await classicGeneratedBlob(fileCode, ext); await showAttachmentBlob(name, blob, { presentation: ext === "pptx" ? fileCode : null, returnFocus: previewButton }); }
                        catch (error) { studioFeedback(`Aperçu impossible : ${error.message}`); }
                    });
                    actions.append(previewButton);
                    actions.append(centerButton("Télécharger", async () => {
                        try { const blob = await classicGeneratedBlob(fileCode, ext), url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); }
                        catch (error) { studioFeedback(`Création impossible : ${error.message}`); }
                    }));
                }
            }
            actions.append(centerButton("Ouvrir la discussion", async () => { try { if (isMotionOpen()) await closeMotionDesign(); if (isMotionOpen()) return; afterConversationOpened(await api.conversationsOpen(item.conversationId, { mode: "chat" })); browserHomeClosePage(); setAgentTab("conversation"); } catch (error) { studioFeedback(error.message); } }));
            card.append(actions); grid.append(card);
            if (preview) { activePreviews.set(item, preview); if (item.data) showImage(preview, item); else if (!item.loading) observer.observe(preview); }
        }
        updateStatus();
    }
    function libraryIsOpen() {
        return rememberedLibraryPage === page && page.isConnected && browserHomeCurrent === "library";
    }
    function scheduleNextPage() {
        clearTimeout(nextPageTimer);
        if (libraryIsOpen() && hasMore && !loading && !loadError) nextPageTimer = setTimeout(() => {
            if (libraryIsOpen()) load();
        }, 100);
    }
    resumeLibraryLoading = scheduleNextPage;
    async function load(force = false) {
        if (loading || (!force && !hasMore)) return;
        clearTimeout(nextPageTimer);
        const requestCursor = force ? "" : cursor;
        loading = true;
        loadError = "";
        updateStatus();
        try {
            const result = await api.accountLibraryPage(requestCursor, force);
            if (rememberedLibraryPage !== page) return;
            if (force) {
                items.length = 0;
                loadedCursors.clear();
                failed = limited = 0;
            }
            const start = items.length;
            items.push(...result.items);
            failed += result.failed;
            limited += result.limited || 0;
            loadedCursors.add(requestCursor);
            cursor = result.cursor;
            hasMore = Boolean(result.hasMore && cursor && !loadedCursors.has(cursor));
            render(start);
        } catch (error) {
            loadError = error.message;
            retryRefresh = force;
        } finally {
            loading = false;
            if (rememberedLibraryPage === page) {
                updateStatus();
                scheduleNextPage();
            }
        }
    }
    search.oninput = () => render();
    load();
};
const libraryActivity = document.createElement("button");
libraryActivity.type = "button"; libraryActivity.dataset.action = "library"; libraryActivity.title = "Bibliothèque"; libraryActivity.setAttribute("aria-label", "Bibliothèque");
libraryActivity.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h4v14H4zM10 4h4v15h-4zM16 6l3-1 3 13-3 1z"/></svg>';
libraryActivity.onclick = () => { setBrowserHomeOpen(true); browserHomeShow("library", { page: true }); };
codexActivity.insertBefore(libraryActivity, codexActivity.querySelector('[data-action="settings"]'));

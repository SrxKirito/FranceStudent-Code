/* Logos existants des fournisseurs ; aucun fournisseur n’est deviné si le modèle est inconnu. */
function historyModelLogo(value) {
    let model = value && typeof value === "object" ? value : { id: value, name: String(value || "") };
    const known = ui.models?.agents?.find(item => String(item.id) === String(model.id));
    if (known) model = { ...model, ...known };
    const logo = modelLogo(model, "history-model-logo");
    if (logo) { logo.alt = ""; logo.title = model.name || model.model || "Modèle"; logo.setAttribute("aria-hidden", "true"); }
    return logo;
}

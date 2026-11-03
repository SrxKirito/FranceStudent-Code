"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const scope = new AsyncLocalStorage();
const CORE = new Set(["list_directory", "read_file", "search_files", "semantic_search", "read_attachment", "project_sources", "view_image", "update_plan", "ask_user", "job_output", "job_stop"]);
const GROUPS = [
    { id: "files", label: "Modifier les fichiers", description: "Créer, modifier et organiser le projet", tools: ["create_directory", "write_file", "edit_file", "move_path", "copy_path", "delete_path", "remember"] },
    { id: "terminal", label: "Terminal et diagnostics", description: "Exécuter les commandes et vérifier le projet", tools: ["run_command", "diagnostics"] },
    { id: "web", label: "Recherche et navigateur", description: "Consulter le web et vérifier les interfaces", tools: ["web_search", "web_search_result", "web_fetch", "browse"] },
    { id: "skills", label: "Skills", description: "Charger les méthodes installées dans l’IDE", tools: ["use_skill"] },
    { id: "integrations", label: "MCP et GitHub", description: "Utiliser les services configurés sur l’ordinateur", tools: ["mcp_call", "github"] },
    { id: "creative", label: "Roblox et Blender", description: "Utiliser les outils des projets 3D", tools: ["roblox_check", "roblox_scene", "roblox_env", "rojo_serve", "roblox_playtest", "roblox_graph", "blender"] },
    { id: "delegation", label: "Analyse déléguée", description: "Confier une lecture à un sous-agent", tools: ["task"] }
];
function normalize(value) {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value) || value.length > GROUPS.length || value.some(id => typeof id !== "string" || !GROUPS.some(group => group.id === id)) || new Set(value).size !== value.length) throw new Error("Sélection d’outils invalide.");
    return GROUPS.filter(group => value.includes(group.id)).map(group => group.id);
}
function allowed(name) {
    const selected = scope.getStore();
    return !selected || CORE.has(name) || GROUPS.some(group => selected.includes(group.id) && group.tools.includes(name));
}
function assertAllowed(name) { if (!allowed(name)) throw new Error(`L’outil ${name} n’est pas sélectionné pour cette demande. Utilise les outils disponibles ou explique la limite à l’utilisateur.`); }
function run(value, callback) {
    // Inherit a parent's restriction when a nested agent is started.
    const selected = normalize(value), parent = scope.getStore();
    return scope.run(parent ? selected ? parent.filter(id => selected.includes(id)) : parent : selected, callback);
}
function catalog(text) {
    if (!scope.getStore()) return text;
    return text.split(/\n(?=(?:\d+\. |read_attachment —|ask_user —|effectcraft —|OUTILS —))/).filter(block => {
        const name = block.match(/^(?:\d+\. )?([a-z_]+) —/)?.[1];
        return !name || name === "final" || allowed(name);
    }).join("\n");
}
function summary() { const selected = scope.getStore(); return selected ? `OUTILS CHOISIS POUR CETTE DEMANDE — ${[...CORE, ...GROUPS.filter(group => selected.includes(group.id)).flatMap(group => group.tools)].join(", ")}. Les autres outils ne sont pas disponibles. Regroupe les lectures indépendantes avec calls, cherche avant de lire et ne relis pas un contenu inchangé sans raison. Cette sélection ne remplace jamais les confirmations et permissions de l’IDE.` : ""; }
module.exports = { normalize, allowed, assertAllowed, run, catalog, summary, current: () => scope.getStore() || null, groups: () => GROUPS.map(group => ({ ...group, tools: [...group.tools] })) };

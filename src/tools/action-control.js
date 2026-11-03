"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const { randomUUID } = require("node:crypto");
const context = new AsyncLocalStorage(), active = new Map();
function signal() { return context.getStore()?.signal; }
function onCancel(handler) {
    const current = signal();
    if (!current) return () => {};
    if (current.aborted) {
        handler();
        return () => {};
    }
    const listener = () => { try { handler(); } catch { /* Cancellation remains requested. */ } };
    current.addEventListener("abort", listener, { once: true });
    return () => current.removeEventListener("abort", listener);
}
function cancel(id) {
    const action = active.get(String(id));
    if (!action || action.signal.aborted) return false;
    action.controller.abort();
    action.publish({ id: action.id, state: "canceling", name: action.name });
    return true;
}
async function run(name, description, operation, externalSignal) {
    const backend = require("../ui-bridge").getUiBackend();
    externalSignal?.throwIfAborted();
    if (!require("../state").state.fullAccess || typeof backend.actionControl !== "function") {
        return externalSignal ? context.run({ signal: externalSignal }, operation) : operation();
    }
    const controller = new AbortController();
    const action = { id: randomUUID(), name, controller, signal: externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal, publish: data => backend.actionControl(data) };
    active.set(action.id, action);
    const mutations = new Set(["write_file", "edit_file", "delete_path", "move_path", "copy_path", "create_directory"]);
    const priorUndo = mutations.has(name) ? require("../project/memory").listUndo().length : null;
    action.publish({ id: action.id, name, description: String(description).slice(0, 500), state: "running" });
    let failed = false;
    try {
        const result = await context.run(action, async () => {
            await new Promise(resolve => {
                if (action.signal.aborted) return resolve();
                const finish = () => {
                    clearTimeout(timer);
                    action.signal.removeEventListener("abort", finish);
                    resolve();
                };
                const timer = setTimeout(finish, 600);
                action.signal.addEventListener("abort", finish, { once: true });
            });
            if (action.signal.aborted) throw new Error("Action annulée avant exécution.");
            return operation();
        });
        if (action.signal.aborted) throw new Error("Action annulée par l’utilisateur. Son résultat est écarté ; ne la relance pas. Continue les autres étapes utiles. Des effets déjà produits peuvent nécessiter une annulation séparée.");
        return result;
    } catch (error) {
        failed = true;
        if (action.signal.aborted) {
            const canceled = new Error("Action annulée par l’utilisateur ; ne la relance pas. Continue les autres étapes. Les effets déjà produits ne sont pas automatiquement annulés.", { cause: error });
            canceled.code = "ACTION_CANCELED";
            throw canceled;
        }
        throw error;
    }
    finally {
        active.delete(action.id);
        const undo = priorUndo == null ? null : require("./core/journal").listUndoEntries().find(entry => entry.index >= priorUndo);
        action.publish({ id: action.id, name, undo: undo ? { index: undo.index, at: undo.at, workspace: require("../state").state.workspace } : null, state: action.signal.aborted ? "canceled" : failed ? "failed" : "done" });
    }
}
module.exports = { run, cancel, signal, onCancel };

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const protocol = require("../src/agent/codex-protocol");
test("la réponse indiquant que l’écriture est impossible déclenche la vérification en mode agent", () => {
    const text = "Le fichier n’a pas été créé sur l’ordinateur : je ne dispose pas d’un outil permettant d’écrire dans ce dossier.";
    assert.equal(protocol.claimsWriteToolsUnavailable(text), true);
    assert.equal(protocol.claimsToolsUnavailable({type:"message", phase:"final_answer", text}), true);
    assert.equal(protocol.claimsToolsUnavailable({type:"message", phase:"final_answer", text:"Je n’ai pas encore vérifié le fichier."}), false);
});

test("la formulation exacte du refus de créer un fichier est reconnue", () => {
 const text = "Je ne peux pas créer directement de fichier sur votre ordinateur avec les outils dont je dispose. Contenu proposé pour bonjour.txt : Bonjour";
 assert.equal(protocol.claimsToolsUnavailable({type:"message", phase:"final_answer", text}), true);
});

test("un abandon de création sans outil est identifié pour une reprise bornée", () => {
 assert.equal(protocol.claimsFileOperationNotPerformed({type:"message",phase:"final_answer",text:"Je n’ai pas pu créer ni relire bonjour.txt dans cette réponse. Le fichier n’a donc pas été créé."}),true);
 assert.equal(protocol.claimsFileOperationNotPerformed({type:"message",phase:"final_answer",text:"Le fichier contient Bonjour."}),false);
});

test("une question d’accès GitHub sélectionne seulement une vérification en lecture", () => {
 const tools=[{type:"function",name:"github",namespace:"francestudent_integrations_direct"}];
 assert.deepEqual(protocol.githubAccessProbe(tools,"as tu acces a githhub ?").arguments,{action:"overview"});
 assert.equal(protocol.githubAccessProbe([],"as tu acces a github ?"),null);
 assert.equal(protocol.githubAccessProbe([{type:"function",name:"github",namespace:"autre"}],"as tu acces a github ?"),null);
 assert.equal(protocol.githubAccessProbe(tools,"tu peux créer un fichier ?"),null);
 assert.equal(protocol.githubAccessProbe(tools,"Crée une release GitHub"),null);
});

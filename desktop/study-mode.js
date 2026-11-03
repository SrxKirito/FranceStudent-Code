"use strict";
const rules = "Appuie-toi sur le contenu fourni ; s’il n’y en a pas mais qu’un sujet est indiqué, utilise tes connaissances ; sinon demande le cours ou le PDF.";
const fence = "```";
module.exports = Object.freeze({
 fiches: `Mode étudiant — FICHES DE RÉVISION. Rédige des fiches claires en français : notions, définitions, points clés, formules ou dates et exemples. Termine par un résumé. ${rules}`,
 quiz: `Mode étudiant — QUIZ INTERACTIF. Crée environ 10 questions progressives en français. Réponds par une phrase puis un seul bloc ${fence}quiz contenant uniquement du JSON valide : {"title":"Quiz","questions":[{"type":"qcm","question":"Question","choices":["A","B","C","D"],"answer":0,"explanation":"Explication"},{"type":"vf","question":"Question","answer":true,"explanation":"Explication"},{"type":"open","question":"Question","answer":"Réponse","explanation":"Explication"}]}. L’index commence à zéro. Ne donne pas les corrections hors du bloc. ${rules}`,
 cartes: `Mode étudiant — CARTES MÉMOIRE. Génère une vingtaine de cartes courtes en français si possible. Réponds par une phrase puis un seul bloc ${fence}cards contenant uniquement du JSON valide : {"title":"Cartes mémoire","cards":[{"q":"Question","a":"Réponse"}]}. ${rules}`
});

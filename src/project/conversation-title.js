'use strict';
// Titres locaux : aucun appel IA supplémentaire, aucun nom manuel réécrit.
function conversationTitle(input){
 let text=String(input||'').split(/\r?\n|```/)[0].replace(/\s+/g,' ').trim();
 const key=text.normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
 if(/(?:acces|accessible|peux.*(?:lire|voir)).*(?:fichier|dossier)|(?:quel|quoi).*(?:fichier|dossier).*(?:acces|voir)/.test(key))return 'Accès aux fichiers du projet';
 if(/optimis/.test(key)&&/requet|quota|token|consomm/.test(key))return 'Optimisation des requêtes et du quota';
 if(/(?:bug|erreur|corrig)/.test(key)&&/affich|interface|bouton/.test(key))return 'Correction de l’interface';
 text=text.replace(/^(?:bonjour|salut|bonsoir)[, !:.]*/i,'').replace(/^(?:(?:est.ce que )?(?:tu (?:peux|pourrais)|vous (?:pouvez|pourriez))\s+(?:me\s+)?|(?:peux|pourrais).tu\s+(?:me\s+)?|(?:s['’]il te pla[iî]t|stp)[, ]*)/i,'');
 const verbs=[[/^(?:cr[ée]+|cr[ée]er|g[ée]n[èe]re|g[ée]n[ée]rer)\s+(?:un|une|des)\s+images?\s+(?:de |d['’])?/i,'Image : '],[/^(?:cr[ée]+|cr[ée]er)\s+/i,'Création de '],[/^(?:corrige|corriger|r[ée]pare|r[ée]parer)\s+/i,'Correction de '],[/^(?:ajoute|ajouter)\s+/i,'Ajout de '],[/^(?:am[ée]liore|am[ée]liorer)\s+/i,'Amélioration de '],[/^(?:explique|expliquer)\s+/i,'Comprendre '],[/^(?:analyse|analyser|[ée]tudie|[ée]tudier)\s+/i,'Analyse de ']];
 for(const [pattern,replacement] of verbs)if(pattern.test(text)){text=text.replace(pattern,replacement);break;}
 text=text.replace(/[?!.,;: ]+$/,'').trim();if(!text)return 'Nouvelle discussion';
 text=text[0].toLocaleUpperCase('fr')+text.slice(1);
 return text.length>64?text.slice(0,61).replace(/\s+\S*$/,'')+'…':text;
}
module.exports={conversationTitle};

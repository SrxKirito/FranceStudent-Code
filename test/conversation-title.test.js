'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {conversationTitle}=require('../src/project/conversation-title');
test('les demandes courantes deviennent un sujet lisible sans requête IA',()=>{
 assert.equal(conversationTitle('tu as acces a quel fichier'),'Accès aux fichiers du projet');
 assert.equal(conversationTitle('Optimise les requêtes car le quota descend vite'),'Optimisation des requêtes et du quota');
 assert.equal(conversationTitle('Bonjour, peux-tu corriger les boutons de connexion ?'),'Correction de l’interface');
 assert.equal(conversationTitle('Crée une image de chat'),'Image : chat');
 assert.equal(conversationTitle(''),'Nouvelle discussion');
});

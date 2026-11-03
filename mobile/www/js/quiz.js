'use strict';

// Quiz interactifs et cartes mémoire du mode étudiant.
// Le modèle renvoie un bloc ```quiz ou ```cards contenant du JSON ; render.js appelle renderStudyBlock().

const FENCE = '`'.repeat(3);
const QUIZ_EXAMPLE = { title: 'Titre du quiz', questions: [
  { type: 'qcm', question: '...', choices: ['A', 'B', 'C', 'D'], answer: 0, explanation: '...' },
  { type: 'vf', question: '...', answer: true, explanation: '...' },
  { type: 'open', question: '...', answer: 'réponse attendue', explanation: '...' }
] };
const CARDS_EXAMPLE = { title: 'Titre', cards: [{ q: 'Question courte', a: 'Réponse concise' }] };
const STUDY_RULES = `Appuie-toi sur le contenu fourni ; s'il n'y en a pas mais qu'un sujet est indiqué, utilise tes connaissances ; sinon demande-moi le cours ou le PDF.`;
const QUIZ_INSTRUCTION = `Mode étudiant — QUIZ INTERACTIF. Crée un quiz en français d'environ 10 questions (QCM à 4 propositions, vrai/faux et quelques questions ouvertes) de difficulté progressive. Réponds par une courte phrase d'introduction puis UN SEUL bloc de code ${FENCE}quiz contenant uniquement du JSON valide (guillemets doubles, sans virgule finale), de cette forme : ${JSON.stringify(QUIZ_EXAMPLE)}. Pour un qcm, "answer" est l'index (dès 0) de la bonne proposition ; pour un vf, true ou false ; pour une question ouverte, la réponse attendue. Mets les explications dans "explanation" et n'écris aucune correction hors du bloc. ${STUDY_RULES}`;
const CARDS_INSTRUCTION = `Mode étudiant — CARTES MÉMOIRE. Génère une vingtaine de cartes mémoire (flashcards) en français si le contenu le permet, avec des questions courtes et des réponses concises. Réponds par une courte phrase d'introduction puis UN SEUL bloc de code ${FENCE}cards contenant uniquement du JSON valide (guillemets doubles, sans virgule finale), de cette forme : ${JSON.stringify(CARDS_EXAMPLE)}. ${STUDY_RULES}`;

// Détecte une demande explicite de quiz / cartes / fiches dans le message.
function detectStudyIntent(text) {
  const t = String(text || '');
  const ask = /(g[ée]n[èe]re|cr[ée]+|fais|fait|donne|pr[ée]pare|propose|r[ée]dige|produis|make|generate|create|teste|interroge)/i.test(t);
  if (!ask) return '';
  if (/(cartes?\s+(?:m[ée]moire|de\s+r[ée]vision)|flash\s?cards?)/i.test(t)) return 'cartes';
  if (/\b(quiz+|qcm|questionnaire|interro(?:gation)?|teste[- ]?moi|interroge[- ]?moi)\b/i.test(t)) return 'quiz';
  if (/fiches?\s+(?:de\s+)?r[ée]vision/i.test(t)) return 'fiches';
  return '';
}

function parseStudyJson(code) {
  const s = String(code || '').trim();
  try { return JSON.parse(s); } catch (e) { /* tentative suivante */ }
  try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); } catch (e) { return null; }
}

function normalizeQuiz(data) {
  const list = data && Array.isArray(data.questions) ? data.questions : [];
  const questions = [];
  for (const item of list) {
    if (!item || !item.question) continue;
    const q = { q: String(item.question), e: item.explanation ? String(item.explanation) : '' };
    const type = String(item.type || '').toLowerCase();
    const choices = Array.isArray(item.choices) ? item.choices.map(String) : null;
    const ans = String(item.answer);
    if (type === 'vf' || typeof item.answer === 'boolean' || (!choices && /^(vrai|faux|true|false)$/i.test(ans))) {
      q.c = ['Vrai', 'Faux'];
      q.a = item.answer === true || /^(vrai|true)$/i.test(ans) ? 0 : 1;
    } else if (choices && choices.length > 1) {
      let a = Number(item.answer);
      if (!Number.isInteger(a)) {
        a = choices.indexOf(ans);
        if (a < 0) a = 'ABCDEFGH'.indexOf(ans.trim().toUpperCase());
      }
      if (a < 0 || a >= choices.length) continue;
      q.c = choices;
      q.a = a;
    } else {
      q.a = item.answer == null ? '' : ans;
    }
    questions.push(q);
  }
  return { title: data && data.title ? String(data.title) : 'Quiz', questions };
}

function quizHtml(quiz) {
  const items = quiz.questions.map((q, i) => {
    const body = q.c
      ? `<div class="quiz-choices">${q.c.map((c, j) => `<button type="button" class="quiz-choice" data-c="${j}"><span class="quiz-letter">${String.fromCharCode(65 + j)}</span><span>${renderInline(c)}</span></button>`).join('')}</div>`
      : '<button type="button" class="quiz-reveal">Voir la réponse</button>';
    return `<div class="quiz-q" data-i="${i}"><div class="quiz-qtext"><b>${i + 1}.</b> ${renderInline(q.q)}</div>${body}<div class="quiz-feedback" hidden></div></div>`;
  }).join('');
  return `<div class="quiz-block" data-quiz="${escapeHtml(JSON.stringify(quiz))}"><div class="quiz-head"><span class="quiz-title">${escapeHtml(quiz.title)}</span><span class="quiz-score">0 / ${quiz.questions.length}</span></div>${items}<div class="quiz-result" hidden></div></div>`;
}

function cardsHtml(data) {
  const cards = data.cards.filter(c => c && c.q && c.a);
  const items = cards.map((c, i) => `<button type="button" class="flashcard"><span class="fc-num">Carte ${i + 1}</span><span class="fc-q">${renderInline(String(c.q))}</span><span class="fc-a">${renderInline(String(c.a))}</span><span class="fc-hint">Toucher pour retourner</span></button>`).join('');
  return `<div class="cards-block"><div class="quiz-head"><span class="quiz-title">${escapeHtml(data.title || 'Cartes mémoire')}</span><span class="quiz-score">${cards.length} cartes</span></div><div class="cards-grid">${items}</div></div>`;
}

// Retourne le HTML interactif, un indicateur de chargement (bloc encore ouvert) ou '' (bloc de code classique).
function renderStudyBlock(code, lang, open) {
  const kind = String(lang || '').toLowerCase();
  if (kind !== 'quiz' && kind !== 'cards') return '';
  const data = parseStudyJson(code);
  if (kind === 'quiz') {
    const quiz = data ? normalizeQuiz(data) : null;
    if (quiz && quiz.questions.length) return quizHtml(quiz);
  } else if (data && Array.isArray(data.cards) && data.cards.some(c => c && c.q && c.a)) {
    return cardsHtml(data);
  }
  if (!open) return '';
  return `<div class="study-loading"><span class="study-spinner"></span>${kind === 'quiz' ? 'Création du quiz…' : 'Création des cartes…'}</div>`;
}

function updateQuizScore(block, quiz) {
  const done = block.querySelectorAll('.quiz-q.answered');
  let good = 0;
  done.forEach(el => { if (el.dataset.ok === '1') good++; });
  const total = quiz.questions.length;
  block.querySelector('.quiz-score').textContent = good + ' / ' + total;
  if (done.length < total) return;
  const pct = Math.round(good * 100 / total);
  const note = pct >= 80 ? 'Excellent travail !' : pct >= 50 ? 'Pas mal, continue à réviser.' : 'Relis ton cours et réessaie.';
  const result = block.querySelector('.quiz-result');
  result.innerHTML = `<div class="quiz-final"><b>Score : ${good} / ${total} (${pct} %)</b><span>${note}</span></div><button type="button" class="quiz-retry">Recommencer</button>`;
  result.hidden = false;
  result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Gère les clics sur les quiz et cartes ; renvoie true si le clic a été traité.
function handleQuizClick(event) {
  const card = event.target.closest('.flashcard');
  if (card) {
    card.classList.toggle('flipped');
    return true;
  }
  const block = event.target.closest('.quiz-block');
  if (!block) return false;
  let quiz;
  try { quiz = JSON.parse(block.dataset.quiz); } catch (e) { return true; }
  if (event.target.closest('.quiz-retry')) {
    block.outerHTML = quizHtml(quiz);
    return true;
  }
  const qEl = event.target.closest('.quiz-q');
  if (!qEl || qEl.classList.contains('answered')) return true;
  const q = quiz.questions[Number(qEl.dataset.i)];
  if (!q) return true;
  const feedback = qEl.querySelector('.quiz-feedback');
  const explain = q.e ? `<div class="quiz-explain">${renderInline(q.e)}</div>` : '';
  const choice = event.target.closest('.quiz-choice');
  const reveal = event.target.closest('.quiz-reveal');
  const self = event.target.closest('.quiz-self');
  if (choice) {
    const picked = Number(choice.dataset.c);
    const ok = picked === q.a;
    qEl.classList.add('answered');
    qEl.dataset.ok = ok ? '1' : '0';
    qEl.querySelectorAll('.quiz-choice').forEach(b => {
      const j = Number(b.dataset.c);
      if (j === q.a) b.classList.add('correct');
      else if (j === picked) b.classList.add('wrong');
      b.disabled = true;
    });
    feedback.innerHTML = `<b>${ok ? '✓ Bonne réponse !' : '✗ Mauvaise réponse.'}</b>${explain}`;
    feedback.hidden = false;
  } else if (reveal) {
    reveal.hidden = true;
    feedback.innerHTML = `<div><b>Réponse attendue :</b> ${renderInline(q.a)}</div>${explain}<div class="quiz-selfrow"><button type="button" class="quiz-self" data-ok="1">Je savais</button><button type="button" class="quiz-self" data-ok="0">À revoir</button></div>`;
    feedback.hidden = false;
    return true;
  } else if (self) {
    qEl.classList.add('answered');
    qEl.dataset.ok = self.dataset.ok;
    const row = qEl.querySelector('.quiz-selfrow');
    if (row) row.remove();
  } else {
    return true;
  }
  updateQuizScore(block, quiz);
  return true;
}

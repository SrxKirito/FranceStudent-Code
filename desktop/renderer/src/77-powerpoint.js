"use strict";

const POWERPOINT_INSTRUCTION = 'Création PowerPoint. Crée une présentation visuelle et soignée. Réponds par une courte introduction puis un seul bloc pptx contenant du JSON valide : {"filename":"presentation.pptx","title":"Titre","subtitle":"Sous-titre","slides":[{"title":"Titre court","layout":"visual","illustration":"earth","bullets":["Idée clé","Explication concise"],"notes":"Explications orales","image":{"url":"URL HTTPS vérifiée facultative","caption":"Légende et crédit"}}]}. L’application produit un vrai PowerPoint modifiable et sait intégrer des images : ne dis jamais que le format est limité aux titres, points et notes. Choisis une illustration pertinente parmi energy, earth, science, technology, education, economy : elle sera réellement intégrée dans la diapositive. Les photos sont facultatives : utilise image.url seulement avec une URL directe de photo vérifiée dans les sources ou fournie par l’utilisateur, jamais de lien inventé. Sans photo, les illustrations intégrées sont utilisées automatiquement ; ne remplace pas les visuels par une note « Image suggérée ». Varie layout entre hero (ouverture ou section), visual (texte et image), cards (2 à 4 idées). Limite chaque diapositive à 2 à 4 points courts, 100 caractères par point environ ; place les détails dans notes. Respecte le nombre de diapositives demandé (1 à 40), sans ajouter de couverture. La première diapositive sert d’introduction. Évite les affirmations et chiffres inventés. Ne fournis ni Python ni JavaScript ni base64 ni faux lien de téléchargement. Utilise la langue de la demande et les documents joints. Si le sujet manque, demande-le avant de produire le fichier.';

function detectsPowerPointRequest(text) {
  const value = String(text || '');
  return /\b(power\s?point|pptx|diaporama|pr[ée]sentation)\b/i.test(value) &&
    /(cr[ée]+|g[ée]n[èe]re|fais|faire|pr[ée]pare|r[ée]alise|produis|make|create|generate|je veux|j.aimerais)/i.test(value);
}

function isPowerPointPrompt(text) {
  return String(text || '').startsWith('Création PowerPoint.');
}

function isPowerPointFollowup(text, conversation) {
  const messages = conversation && conversation.messages || [];
  const previous = messages.filter(m => m.role === 'user').pop();
  return Boolean(previous && isPowerPointPrompt(previous.prompt) &&
    /ajout|modifi|refai|recommence|amélior|change|remplace|avec.{0,30}(image|photo|visuel)|plus.{0,20}(beau|visuel|moderne)/i.test(text));
}

function parsePowerPoint(code) {
  const source = String(code || '').trim();
  if (source.length > 200000) throw new Error('Cette présentation est trop volumineuse.');
  let data;
  try { data = JSON.parse(source); } catch { throw new Error('La présentation est incomplète ou son format est invalide. Demandez de la régénérer.'); }
  if (!data || !Array.isArray(data.slides) || !data.slides.length || data.slides.length > 40) throw new Error('La présentation doit contenir entre 1 et 40 diapositives.');
  const text = (value, max, label) => {
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > max) throw new Error(label + ' invalide ou trop long.');
    return value.trim();
  };
  return {
    title: text(data.title, 180, 'Titre') || 'Présentation',
    subtitle: text(data.subtitle, 350, 'Sous-titre'),
    filename: typeof data.filename === 'string' ? data.filename : '',
    slides: data.slides.map((slide, index) => {
      if (!slide || typeof slide !== 'object') throw new Error('Diapositive invalide.');
      const bullets = slide.bullets ?? (typeof slide.content === 'string' ? slide.content.split('\n').filter(Boolean) : []);
      if (!Array.isArray(bullets) || bullets.length > 40) throw new Error('Liste de points invalide.');
      return {
        title: text(slide.title, 180, 'Titre de diapositive') || 'Diapositive ' + (index + 1),
        bullets: bullets.map(item => text(item, 3000, 'Point')).filter(Boolean),
        notes: text(slide.notes, 15000, 'Notes'),
        layout: ['hero', 'visual', 'cards'].includes(slide.layout) ? slide.layout : '',
        illustration: ['energy', 'earth', 'science', 'technology', 'education', 'economy'].includes(slide.illustration) ? slide.illustration : '',
        image: slide.image && typeof slide.image.url === 'string' && /^https:\/\//i.test(slide.image.url) ? {
          url: text(slide.image.url, 2048, 'URL image'), caption: text(slide.image.caption, 300, 'Légende')
        } : null
      };
    })
  };
}

function powerPointFileName(code) {
  let name = 'presentation';
  try {
    const data = parsePowerPoint(code);
    name = data.filename || data.title;
  } catch { /* Le téléchargement expliquera le problème de format. */ }
  name = name.replace(/\.pptx$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^\.+|[. ]+$/g, '').slice(0, 100);
  return (name || 'presentation') + '.pptx';
}

// Paginate dense content rather than dropping points or shrinking to unreadable text.
function powerPointPages(data) {
  const pages = [];
  for (const slide of data.slides) {
    let items = [], lines = 0, part = 0;
    const flush = () => {
      pages.push({ ...slide, title: slide.title + (part ? ' (suite)' : ''), bullets: items, notes: slide.notes });
      items = []; lines = 0; part++;
    };
    for (const bullet of slide.bullets) {
      // Keep each paragraph at a readable size while retaining every character.
      const segments = bullet.match(/[\s\S]{1,350}(?:\s|$)|[\s\S]{1,350}/g) || [];
      for (const segment of segments) {
        const cost = Math.ceil(segment.length / 48) + 1;
        if (items.length && lines + cost > 10) flush();
        items.push(segment.trim()); lines += cost;
      }
    }
    if (items.length || !part) flush();
  }
  return pages;
}

async function makePowerPoint(code) {
  const data = parsePowerPoint(code);
  const Generator = typeof PptxGenJS === 'function' ? PptxGenJS : window.pptxgen;
  if (typeof Generator !== 'function') throw new Error('Le générateur PowerPoint est indisponible. Relancez l’application.');
  const deck = new Generator();
  deck.layout = 'LAYOUT_WIDE';
  deck.author = 'FranceStudent';
  deck.subject = data.subtitle;
  deck.title = data.title;
  deck.lang = 'fr-FR';
  deck.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos', lang: 'fr-FR' };
  const pages = powerPointPages(data);
  for (const [index, page] of pages.entries()) {
    const slide = deck.addSlide();
    const hero = page.layout === 'hero' || (!page.layout && index === 0);
    const cards = !hero && (page.layout === 'cards' || (!page.layout && index % 3 === 2)) && page.bullets.length >= 2 && page.bullets.length <= 4 && page.bullets.every(item => item.length <= 150);
    const bg = hero ? '142D3B' : 'F5F4EE';
    const ink = hero ? 'EDF5EB' : '142D3B';
    const accent = hero ? '87DEC1' : '247D68';
    slide.background = { color: bg };
    const rect = (x,y,w,h,color) => slide.addShape(deck.ShapeType.rect, { x,y,w,h,fill:{color},line:{transparency:100} });
    const label = (value,x,y,w,h,size,color=ink,bold=false,extra={}) => slide.addText(value,{x,y,w,h,fontFace:'Aptos',fontSize:size,color,bold,margin:0,breakLine:false,fit:'shrink',valign:'mid',...extra});
    rect(.6,.5,.45,.06,accent);
    label(String(index+1).padStart(2,'0')+'  /  '+String(pages.length).padStart(2,'0'),1.2,.38,2,.3,10,accent,true);
    label(page.title,.65,.95,cards?12:7,hero?1.65:1.35,hero?36:30,ink,true);
    if (cards) {
      const n=Math.max(page.bullets.length,1), columns=n>2?2:n;
      page.bullets.forEach((item,i)=>{
        const x=.65+(i%columns)*6.1, y=2.65+Math.floor(i/columns)*1.8;
        rect(x,y,5.75,1.55,'FFFFFF'); rect(x,y,.05,1.55,accent);
        label(String(i+1).padStart(2,'0'),x+.25,y+.2,.5,.35,14,accent,true);
        label(item,x+.95,y+.18,4.5,1.15,22);
      });
    } else {
      if (page.bullets.length) {
        const runs=page.bullets.map(item=>({text:item,options:{bullet:{indent:17},hanging:4,breakLine:true}}));
        label(runs,.75,hero?3:2.65,6.65,hero?3.45:3.85,22,ink,false,{paraSpaceAfter:17,valign:'top'});
      } else if (index===0 && data.subtitle) label(data.subtitle,.75,3,6.4,2,25,ink);
      let picture = null;
      if (page.image) picture = await loadPowerPointPhoto(page.image.url);
      const key = page.illustration || powerPointIllustration(page.title+' '+page.bullets.join(' '));
      if (!picture && typeof POWERPOINT_VISUALS !== 'undefined') picture = POWERPOINT_VISUALS[key];
      if (picture) slide.addImage({data:picture,x:8,y:1.7,w:4.65,h:4.185});
      if (page.image && picture && picture !== (typeof POWERPOINT_VISUALS !== 'undefined' && POWERPOINT_VISUALS[key])) label(page.image.caption,8,6.3,4.65,.35,10,hero?'A6C0BE':'526B71');
    }
    rect(.65,6.92,12,.012,hero?'345360':'D3DCD6');
    label(data.title,.65,7.08,10.6,.2,9,hero?'A6C0BE':'526B71');
    label(String(index+1),11.65,7.04,1,.26,11,accent,true,{align:'right'});
    if (page.notes) slide.addNotes(page.notes);
  }
  return new Uint8Array(await deck.write({ outputType: 'arraybuffer', compression: true }));
}

function powerPointIllustration(text) {
  if (/énerg|energ|solaire|électri|electric/i.test(text)) return 'energy';
  if (/climat|terre|planet|environ|écolog|ocean|océan/i.test(text)) return 'earth';
  if (/scien|chim|moléc|molec|biolog|santé|physiq/i.test(text)) return 'science';
  if (/tech|numéri|digital|informati|intelligence|réseau/i.test(text)) return 'technology';
  if (/économ|econom|financ|marché|entreprise|croissance/i.test(text)) return 'economy';
  return 'education';
}

async function loadPowerPointPhoto(url) {
  // Le téléchargement se fait uniquement à la création explicite du fichier.
  if (typeof fetch !== 'function' || typeof FileReader !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
    if (!response.ok || !/^image\/(png|jpeg|webp)/i.test(response.headers.get('content-type') || '')) return null;
    const blob = await response.blob();
    if (blob.size > 8*1024*1024) return null;
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
    });
    // Recadrage sans déformation, au format de la zone de la diapositive.
    const image = new Image();
    image.src = data;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 1000; canvas.height = 900;
    const ctx = canvas.getContext('2d');
    const scale = Math.max(1000 / image.width, 900 / image.height);
    ctx.drawImage(image, (1000-image.width*scale)/2, (900-image.height*scale)/2, image.width*scale, image.height*scale);
    return canvas.toDataURL('image/png');
  } catch { return null; } finally { clearTimeout(timer); }
}

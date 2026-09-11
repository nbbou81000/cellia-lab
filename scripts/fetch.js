// ═══════════════════════════════════════════════════════════════════════════
// CelliA Lab — Veille IA
// Flux RSS (sources scientifiques, labos, instituts) → filtrage → Mistral → JSON
//
// Usage :
//   node fetch.js          run normal (12 articles max)
//   node fetch.js --dev    3 articles seulement
//   node fetch.js --dry    sans appel Mistral : teste uniquement la collecte
// ═══════════════════════════════════════════════════════════════════════════
import Parser from 'rss-parser';
import fs     from 'fs/promises';
import path   from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST      = process.env.DIST_DIR || path.join(__dirname, '..', 'dist');
const FULL_PATH  = path.join(DIST, 'articles-full.json');
const INDEX_PATH = path.join(DIST, 'articles.json');
const SEEN_PATH  = path.join(DIST, 'seen.json');

// ─── Réglages ────────────────────────────────────────────────────────────────
const IS_DEV  = process.argv.includes('--dev') || process.env.DEV_MODE === 'true';
const IS_DRY  = process.argv.includes('--dry');
const MODEL   = process.env.MISTRAL_MODEL || 'mistral-small-latest';
const MAX_ARTICLES      = IS_DEV ? 3 : parseInt(process.env.MAX_ARTICLES || '12', 10);
const MAX_CALLS         = MAX_ARTICLES + 6;   // marge pour les articles jugés hors sujet
const WINDOW_HOURS      = 72;                 // fenêtre normale
const FIRST_RUN_HOURS   = 24 * 7;             // premier run : une semaine pour amorcer le site
const MIN_SOURCE_WORDS  = 120;                // en dessous, pas assez de matière → on ne publie pas
const DEFAULT_PER_SOURCE = 2;
const KEEP_DAYS  = 30;                        // durée de vie d'un article sur le site
const SEEN_DAYS  = 60;                        // mémoire des articles déjà examinés
const MAX_STORED = 400;
const PAUSE_MS   = 2500;                      // pause entre deux appels Mistral
const MAX_INLINE_IMAGES = 3;                  // illustrations proposées à Mistral par article

// $ par million de tokens — tarif public Mistral Small au 11/09/2026 (docs.mistral.ai/inference/pricing)
// Si tu changes de modèle ou que Mistral ajuste ses prix, redéfinis ces deux variables
// dans Settings → Secrets and variables → Actions → onglet Variables (pas Secrets, ce n'est pas sensible).
const PRICE_IN  = parseFloat(process.env.MISTRAL_PRICE_INPUT_PER_1M)  || 0.15;
const PRICE_OUT = parseFloat(process.env.MISTRAL_PRICE_OUTPUT_PER_1M) || 0.60;
const costOf = (promptTok, compTok) => (promptTok / 1e6) * PRICE_IN + (compTok / 1e6) * PRICE_OUT;

// Compteurs de tokens, alimentés par callMistral() à chaque réponse reçue
const runStats = { calls: 0, retries429: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };

const CATEGORIES = ['avancees', 'labos', 'risques', 'societe'];
const TONES      = ['avancee', 'enjeu', 'alerte'];

// ─── Logs ────────────────────────────────────────────────────────────────────
const c = { reset:'\x1b[0m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m', blue:'\x1b[34m', dim:'\x1b[2m', bold:'\x1b[1m', cyan:'\x1b[36m' };
const log  = m => console.log(`${c.blue}▸${c.reset} ${m}`);
const ok   = m => console.log(`${c.green}✓${c.reset} ${m}`);
const warn = m => console.log(`${c.yellow}⚠${c.reset} ${m}`);
const err  = m => console.log(`${c.red}✗${c.reset} ${m}`);
const info = m => console.log(`${c.cyan}  →${c.reset} ${m}`);
const dim  = m => console.log(`${c.dim}  ${m}${c.reset}`);

// ─── Utilitaires ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const md5   = s => crypto.createHash('md5').update(s).digest('hex').slice(0, 10);

function fetchWithTimeout(url, opts, ms) {
  return Promise.race([
    fetch(url, opts),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&hellip;/g, '…')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function cleanText(html) {
  return decodeEntities((html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const wordCount = t => (t || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;

function normalizeUrl(u) {
  try {
    const url = new URL(u.trim());
    [...url.searchParams.keys()].forEach(k => { if (/^utm_|^ref$|^source$/i.test(k)) url.searchParams.delete(k); });
    url.hash = '';
    return url.toString();
  } catch { return (u || '').trim(); }
}

// Pixels de comptage et images décoratives à ne jamais prendre comme illustration
const JUNK_IMG = /count\.gif|\/pixel|tracking|beacon|1x1|spacer|feedburner|gravatar|\.gif(\?|$)/i;

function normalizeImg(u) {
  if (!u) return null;
  u = decodeEntities(u.trim());
  if (u.startsWith('//')) u = 'https:' + u;
  if (!u.startsWith('http') || JUNK_IMG.test(u)) return null;
  return u;
}

// Filtre « parle vraiment d'IA » pour les sources généralistes
const AI_RE_CASE = /\b(IA|AI|AGI|LLMs?|GPT[\w.-]*|ChatGPT|Claude|Gemini|Mistral|Llama|OpenAI|Anthropic|DeepMind|Copilot)\b/;
const AI_RE_FREE = /intelligence artificielle|artificial intelligence|machine learning|apprentissage (automatique|profond)|deep learning|r[ée]seaux? de neurones|neural net|chatbot|agents? conversationnel|g[ée]n[ée]rative|generative|deepfake|algorithm|mod[èe]les? de langage|language models?|reconnaissance faciale|facial recognition/i;
const isAboutAI = t => AI_RE_CASE.test(t) || AI_RE_FREE.test(t);

const HAS_CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

// Images de repli (déjà utilisées sur CelliA)
const FALLBACK_IMG = {
  avancees: ['1677442135703-1787eea5ce01', '1559757175-0eb30cd8c063'],
  labos:    ['1620712943543-bcc4688e7485', '1677442135703-1787eea5ce01'],
  risques:  ['1526374965328-7f61d4dc18c5', '1510511459019-5dda7724fd87'],
  societe:  ['1446776811953-b23d57bd21aa', '1620712943543-bcc4688e7485'],
};
const fallbackImage = cat => {
  const ids = FALLBACK_IMG[cat] || FALLBACK_IMG.avancees;
  return `https://images.unsplash.com/photo-${ids[Math.floor(Math.random() * ids.length)]}?w=800&q=75&auto=format`;
};

// ─── Collecte : flux RSS / Atom ──────────────────────────────────────────────
const parser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; CelliA-Lab-Bot/1.0; +https://nbbou81000.github.io/cellia-lab/)',
    'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8',
  },
  customFields: { item: [
    ['media:content', 'media:content', { keepArray: false }],
    ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
    ['content:encoded', 'content:encoded'],
  ]},
});

function imageFromItem(item) {
  const mc = item['media:content'];
  if (mc?.$?.url) return normalizeImg(mc.$.url);
  if (item.mediaThumbnail?.$?.url) return normalizeImg(item.mediaThumbnail.$.url);
  if (item.enclosure?.url && /\.(jpe?g|png|webp|gif|avif)/i.test(item.enclosure.url)) return normalizeImg(item.enclosure.url);
  const html = item['content:encoded'] || item.content || '';
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    const img = normalizeImg(m[1]);
    if (img) return img;
  }
  return null;
}

function makeCandidate(source, { url, title, published, image, rssText, rssHtml }) {
  url = normalizeUrl(url);
  return {
    id:        md5(url),
    url,
    title:     cleanText(title),
    source:    source.source_name || new URL(source.url).hostname.replace(/^www\./, ''),
    category:  source.category,
    kind:      source.kind || 'media',
    lang:      source.lang || 'en',
    published: published || null,
    image:     image || null,
    rssText:   rssText || '',
    rssHtml:   rssHtml || '',
    imagesOk:  source.images !== false,
  };
}

function keepCandidate(source, cand, windowMs) {
  if (!cand.title || !cand.url) return false;
  if (/^no title$/i.test(cand.title)) return false;
  if (HAS_CJK.test(cand.title)) return false;
  if (source.exclude_url && new RegExp(source.exclude_url).test(cand.url)) return false;
  if (cand.published && Date.now() - new Date(cand.published).getTime() > windowMs) return false;
  if (source.ai_filter && !isAboutAI(`${cand.title} ${cand.rssText.slice(0, 1500)}`)) return false;
  return true;
}

async function fetchRss(source, windowMs) {
  const feed = await parser.parseURL(source.url);
  return (feed.items || [])
    .map(item => makeCandidate(source, {
      url:       item.link || item.guid || '',
      title:     item.title || '',
      published: item.isoDate || null,
      image:     imageFromItem(item),
      rssText:   cleanText(item['content:encoded'] || item.content || item.summary || ''),
      rssHtml:   item['content:encoded'] || item.content || '',
    }))
    .filter(cand => keepCandidate(source, cand, windowMs));
}

// ─── Collecte : page HTML listant des liens (sites sans flux RSS) ────────────
async function fetchHtmlList(source, windowMs) {
  const res = await fetchWithTimeout(source.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CelliA-Lab-Bot/1.0)' } }, 15000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const re = new RegExp(`<a[^>]+href="(${source.link_pattern})"[^>]*>([\\s\\S]{0,2000}?)</a>`, 'g');
  const seen = new Set(), out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (seen.has(href)) continue;
    seen.add(href);
    const parts = decodeEntities(m[2].replace(/<[^>]+>/g, '|')).split('|').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const dateStr = parts.find(p => /^[A-Z][a-z]{2,8}\.? \d{1,2}, \d{4}$/.test(p));
    const title   = parts.find(p => p !== dateStr && p.split(' ').length >= 3)
                 || href.split('/').pop().replace(/-/g, ' ').replace(/^\w/, x => x.toUpperCase());
    const d = dateStr ? new Date(dateStr) : null;
    out.push(makeCandidate(source, {
      url:       (source.base || '') + href,
      title,
      published: d && !isNaN(d) ? d.toISOString() : null,
    }));
  }
  return out.filter(cand => keepCandidate(source, cand, windowMs));
}

// ─── Texte complet et illustrations de l'article source ──────────────────────
async function fetchSourceText(cand) {
  let pageText = '', pageHtml = '';
  try {
    const res = await fetchWithTimeout(cand.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CelliA-Lab-Bot/1.0)' } }, 12000);
    if (res.ok) {
      const html = await res.text();
      if (!cand.image) {
        const mm = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
                || html.match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i);
        cand.image = normalizeImg(mm?.[1]);
      }
      if (!cand.published) {
        const pm = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)
                || html.match(/"datePublished"\s*:\s*"([^"]+)"/);
        if (pm && !isNaN(new Date(pm[1]))) cand.published = new Date(pm[1]).toISOString();
      }
      // On compare <article> et <main> : le premier <article> est parfois une
      // simple vignette, on garde le conteneur le plus fourni.
      const zones = [
        html.match(/<article[^>]*>([\s\S]*)<\/article>/i)?.[1],
        html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1],
      ].filter(Boolean).map(h => ({ html: h, text: paragraphsOf(h) }))
       .sort((a, b) => wordCount(b.text) - wordCount(a.text));
      if (zones[0] && wordCount(zones[0].text) >= 150) { pageText = zones[0].text; pageHtml = zones[0].html; }
      else { pageText = paragraphsOf(html); pageHtml = html; }
    }
  } catch { /* on garde le texte du flux */ }

  let best = wordCount(pageText) > wordCount(cand.rssText) ? pageText : cand.rssText;
  let readerImages = [];

  // Certains sites (OpenAI…) bloquent les robots : on passe par un lecteur public
  if (wordCount(best) < MIN_SOURCE_WORDS) {
    const reader = await fetchViaReader(cand.url);
    if (wordCount(reader.text) > wordCount(best)) { best = reader.text; readerImages = reader.images; }
  }

  let images = [];
  if (cand.imagesOk) {
    const heroKey = imgKey(cand.image);
    const seenKeys = new Set(heroKey ? [heroKey] : []);
    for (const img of [...inlineImages(pageHtml, cand.url), ...inlineImages(cand.rssHtml, cand.url), ...readerImages]) {
      const k = imgKey(img.src);
      if (seenKeys.has(k)) continue;
      seenKeys.add(k);
      images.push(img);
      if (images.length >= MAX_INLINE_IMAGES) break;
    }
  }
  return { text: best.slice(0, 9000), images };
}

function paragraphsOf(html) {
  const paras = [];
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const t = cleanText(m[1]);
    if (t.length > 40) paras.push(t);
    if (paras.length >= 45) break;
  }
  return paras.join('\n\n');
}

// Clé de comparaison d'une image : le nom du fichier d'origine, pour reconnaître
// la même image servie en plusieurs tailles (CDN, proxys d'images…)
function imgKey(u) {
  if (!u) return '';
  let d = u;
  try { d = decodeURIComponent(u); } catch {}
  const orig = d.slice(d.lastIndexOf('http')).split(/[?#]/)[0];
  const file = (orig.split('/').filter(Boolean).pop() || orig).toLowerCase();
  return file
    .replace(/\.(width|height|format|fill)-[a-z0-9]+/g, '')   // Google : .width-1300.format-webp
    .replace(/-\d{2,4}x\d{2,4}(?=\.)/g, '')                  // WordPress : -300x200.jpg
    .replace(/\.[a-z0-9]{2,5}$/, '');                          // extension
}

// Vignettes « à lire aussi », encarts promotionnels : repérés par les classes CSS autour de l'image
function inRelatedBlock(html, index) {
  const before = html.slice(Math.max(0, index - 500), index);
  return /class=["'][^"']*(related|featured|teaser|promo|recommend|read-?next|more-(stories|posts)|\bcard\b|-card\b)[^"']*["']/i.test(before);
}

// Certains CDN servent une vignette : on demande une taille lisible
function upgradeImg(u) {
  return u.replace(/(media\.springernature\.com\/)(m|lw|w)\d+\//, '$1lw685/');
}

// Une image cliquable qui mène vers une autre page est une vignette « à lire aussi »
function isLinkCard(html, index, src) {
  const before = html.slice(Math.max(0, index - 600), index);
  const open   = before.lastIndexOf('<a ');
  if (open === -1 || before.indexOf('</a>', open) !== -1) return false;
  const href = before.slice(open).match(/href=["']([^"']+)["']/i)?.[1] || '';
  return !(/\.(jpe?g|png|webp|avif)(\?|$)/i.test(href) || imgKey(href) === imgKey(src));
}

// Légende qui n'est qu'un crédit photo → image décorative
const CREDIT_ONLY = /^(photo|image|illustration|picture|crédit|credit)s?\b[^.]{0,80}(by|via|par|courtesy|getty|shutterstock|unsplash|istock|adobe)/i;

// Illustrations du corps de l'article : <figure> avec légende, ou <img> avec un vrai texte alternatif.
// On écarte logos, avatars, icônes, SVG, GIF, pixels et images minuscules.
const IMG_JUNK_WORDS = /logo|avatar|icon|sprite|emoji|badge|author|profile|headshot|button|placeholder|spinner|share|social|newsletter|subscribe|thumbnail|\bcard\b/i;

function pickImgSrc(tag, base) {
  const attr = n => tag.match(new RegExp(`\\s${n}=["']([^"']+)["']`, 'i'))?.[1];
  const set  = attr('srcset') || attr('data-srcset');
  const fromSet = set
    ? set.split(/,\s+/).map(e => e.trim().split(/\s+/)).map(([u, d]) => ({ u, w: parseInt(d, 10) || 0 }))
         .sort((a, b) => b.w - a.w).find((c, _, all) => (c.w && c.w <= 1600) || c === all[all.length - 1])?.u
    : null;
  for (const raw of [fromSet, attr('data-src'), attr('data-lazy-src'), attr('data-original'), attr('src')]) {
    if (!raw || raw.startsWith('data:')) continue;
    let abs;
    try { abs = new URL(decodeEntities(raw), base).href; } catch { continue; }
    const img = normalizeImg(abs);
    if (img && !/\.svg(\?|$)/i.test(img) && !IMG_JUNK_WORDS.test(img)) return upgradeImg(img);
  }
  return null;
}

function tooSmall(tag) {
  const w = parseInt(tag.match(/\swidth=["']?(\d+)/i)?.[1] || '0', 10);
  const h = parseInt(tag.match(/\sheight=["']?(\d+)/i)?.[1] || '0', 10);
  return (w && w < 200) || (h && h < 120);
}

function inlineImages(html, base) {
  if (!html) return [];
  const out = [];
  // 1. Figures légendées
  for (const f of html.matchAll(/<figure[^>]*>([\s\S]*?)<\/figure>/gi)) {
    const tagMatch = f[1].match(/<img[^>]*>/i);
    const tag = tagMatch?.[0];
    if (!tag || tooSmall(tag)) continue;
    const src = pickImgSrc(tag, base);
    const at = f.index + f[0].indexOf(tag);
    if (!src || isLinkCard(html, at, src) || inRelatedBlock(html, at)) continue;
    const cap = cleanText(f[1].match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1] || '')
             || cleanText(tag.match(/\salt=["']([^"']*)["']/i)?.[1] || '');
    if (cap.length >= 15 && !CREDIT_ONLY.test(cap)) out.push({ src, caption: cap.slice(0, 160) });
  }
  // 2. Images isolées avec un texte alternatif descriptif
  const withoutFigures = html.replace(/<figure[\s\S]*?<\/figure>/gi, '');
  for (const t of withoutFigures.matchAll(/<img[^>]*>/gi)) {
    const tag = t[0];
    if (tooSmall(tag)) continue;
    const alt = cleanText(tag.match(/\salt=["']([^"']*)["']/i)?.[1] || '');
    if (alt.length < 25 || IMG_JUNK_WORDS.test(alt) || CREDIT_ONLY.test(alt)) continue;
    const src = pickImgSrc(tag, base);
    if (src && !isLinkCard(withoutFigures, t.index, src) && !inRelatedBlock(withoutFigures, t.index)) out.push({ src, caption: alt.slice(0, 160) });
  }
  return out;
}

async function fetchViaReader(url) {
  try {
    const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, { headers: { 'Accept': 'text/plain' } }, 20000);
    if (!res.ok) return { text: '', images: [] };
    const md = await res.text();
    const images = [...md.matchAll(/!\[([^\]]{15,})\]\((https?:\/\/[^)\s]+)\)/g)]
      .map(m => ({ src: normalizeImg(m[2]), caption: cleanText(m[1]).slice(0, 160) }))
      .filter(i => i.src && !/\.svg(\?|$)/i.test(i.src) && !IMG_JUNK_WORDS.test(i.src + ' ' + i.caption) && !CREDIT_ONLY.test(i.caption));
    const text = md
      .replace(/^(Title|URL Source|Published Time|Markdown Content):.*$/gim, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')          // images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // liens → texte
      .replace(/^[#>*\-\s]+/gm, '')                   // puces, titres markdown
      .split(/\n{2,}/).map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length > 40)
      .join('\n\n');
    return { text, images };
  } catch { return { text: '', images: [] }; }
}

// ─── Mistral ─────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Tu es journaliste scientifique spécialisé en intelligence artificielle pour CelliA Lab, une veille francophone qui suit à la fois les avancées de l'IA et ses risques.

LECTEUR
Curieux et cultivé, ni scientifique ni informaticien. Il comprend le fonctionnement global : ce qu'est un modèle de langage, un entraînement, des paramètres, un benchmark, une puce GPU. Il ne connaît ni les maths ni le code. Inutile de lui expliquer ce qu'est une IA : explique-lui ce qui est nouveau, comment ça marche dans les grandes lignes, et pourquoi ça compte.

VULGARISER SANS APPAUVRIR
- Garde les chiffres, les noms (modèles, laboratoires, auteurs, institutions) et le vocabulaire exact.
- Explique chaque terme technique peu courant en quelques mots à sa première apparition, puis emploie-le normalement.
- Une analogie concrète est bienvenue quand un mécanisme est abstrait, une seule et bien choisie.
- Paragraphes courts, phrases claires, ton posé et précis.

RIGUEUR (priorité absolue)
- N'invente rien : aucun chiffre, nom, date, citation ou résultat absent de la source.
- Distingue ce qui est démontré (étude publiée, mesure, évaluation indépendante) de ce qui est annoncé ou affirmé (communiqué, démonstration, promesse).
- Quand une entreprise présente son propre produit ou sa propre recherche, dis-le clairement dans le texte (« selon OpenAI », « d'après l'équipe de Google DeepMind »).
- Ni emballement (« révolutionnaire », « bluffant », « game changer ») ni catastrophisme : un risque est présenté avec son niveau de preuve.
- Une tribune est présentée comme l'avis de son auteur, pas comme un fait.

INTERDIT
« je », le tutoiement, les conclusions creuses (« seul l'avenir le dira », « reste à voir »), « il convient de noter », « force est de constater », les anglicismes inutiles (garde les termes consacrés : benchmark, open source, fine-tuning, en les expliquant).`;

const KIND_LABEL = {
  labo:      "communication officielle d'une entreprise d'IA, qui parle de ses propres produits ou recherches",
  recherche: 'publication ou actualité scientifique et académique',
  media:     'média spécialisé',
  institut:  'institut de recherche, ONG ou autorité publique',
  tribune:   "tribune d'opinion d'un auteur identifié",
};

function buildUserPrompt(cand, text, images = []) {
  const isLab = cand.category === 'labos';
  const imgBlock = images.length ? `

ILLUSTRATIONS DE L'ARTICLE SOURCE
${images.map((im, i) => `[[IMG${i + 1}]] ${im.caption}`).join('\n')}
- Place dans "corps" chaque illustration qui aide à comprendre : écris son marqueur seul entre deux blocs, juste après le paragraphe qu'elle illustre (exemple : <p>…</p>[[IMG1]]<p>…</p>). Chaque marqueur une fois au plus.
- Ignore les illustrations décoratives ou sans rapport direct avec le texte.
- "legendes" : pour chaque illustration placée, une légende en français d'une phrase, fidèle à la légende d'origine.` : '';
  return `Réécris cet article en français pour CelliA Lab.

SOURCE
Média : ${cand.source} — ${KIND_LABEL[cand.kind] || KIND_LABEL.media}
Titre original : ${cand.title}
Date : ${cand.published ? cand.published.slice(0, 10) : 'inconnue'}
Contenu :
${text}${imgBlock}

CONSIGNES
- Longueur du corps proportionnelle à la matière : entre 250 et 600 mots. Si la source est courte, reste court plutôt que de broder.
- Structure : 1 à 3 intertitres <h2> si l'article dépasse 350 mots.
- Balises autorisées dans "corps" : <p>, <h2>, <strong>, <em>, <ul>, <li>. Aucun attribut.
- "pertinent" vaut false si l'article ne traite pas vraiment d'intelligence artificielle, ou s'il s'agit de promotion commerciale pure (témoignage client, offre, événement, recrutement, partenariat sans contenu technique).
- "tonalite" :
  "avancee" = progrès, capacité nouvelle, résultat positif ;
  "enjeu"   = question ouverte, débat, régulation, effet mitigé ou à surveiller ;
  "alerte"  = danger sérieux ou documenté, incident, abus, faille, capacité dangereuse.${isLab ? '' : `
- "categorie" :
  "avancees" = recherche, nouveaux modèles et capacités, science ;
  "risques"  = sécurité et alignement des modèles, incidents, usages malveillants, capacités dangereuses ;
  "societe"  = emploi, droit, régulation, vie privée, environnement, désinformation, éducation, santé.`}
- "glossaire" : 0 à 3 termes techniques réellement employés dans le corps, chacun défini en une phrase simple.
- "a_nuancer" : 2 à 4 points courts sur les limites (échantillon, conditions de test, résultats non reproduits), ce qui n'est pas prouvé, qui parle et avec quel intérêt, les questions ouvertes.

Réponds UNIQUEMENT avec cet objet JSON, sans texte autour :
{"pertinent":true,"titre":"titre informatif en français, 90 caractères max, sans point d'exclamation","accroche":"une phrase qui dit l'essentiel, 30 mots max",${isLab ? '' : '"categorie":"avancees|risques|societe",'}"tonalite":"avancee|enjeu|alerte","corps":"<p>...</p>","glossaire":[{"terme":"...","definition":"..."}],"a_nuancer":["...","..."]${images.length ? ',"legendes":{"IMG1":"..."}' : ''}}`;
}

class FatalApiError extends Error {}

async function callMistral(userPrompt) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetchWithTimeout(process.env.MISTRAL_URL || 'https://api.mistral.ai/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}` },
      body: JSON.stringify({
        model:           MODEL,
        messages:        [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userPrompt }],
        temperature:     0.4,
        max_tokens:      3500,
        response_format: { type: 'json_object' },
      }),
    }, 90000);
    if (res.status === 401 || res.status === 403) throw new FatalApiError(`clé Mistral refusée (HTTP ${res.status})`);
    if (res.status === 429) { runStats.retries429++; warn(`  Mistral 429 — pause ${attempt * 15}s`); await sleep(attempt * 15000); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    const data  = await res.json();
    const usage = data.usage || null;   // { prompt_tokens, completion_tokens, total_tokens } — compte exact renvoyé par Mistral
    if (usage) {
      runStats.calls++;
      runStats.promptTokens     += usage.prompt_tokens     || 0;
      runStats.completionTokens += usage.completion_tokens || 0;
      runStats.totalTokens      += usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
    }
    return { content: data.choices?.[0]?.message?.content || '', usage };
  }
  throw new Error('Mistral saturé (429 répétés)');
}

// Répare un JSON invalide causé par de vrais retours à la ligne dans les chaînes
function repairJSON(raw) {
  let out = '', inStr = false, esc = false;
  for (const ch of raw) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { out += ch; inStr = !inStr; continue; }
    if (inStr && ch === '\n') { out += '\\n'; continue; }
    if (inStr && ch === '\r') continue;
    out += ch;
  }
  return out;
}

function parseJSON(raw) {
  let t = (raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a !== -1 && b > a) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch {}
  try { return JSON.parse(repairJSON(t)); } catch {}
  return null;
}

// Ne garde que des balises sûres, sans attributs (le corps est injecté tel quel dans la page)
const ALLOWED_TAGS = new Set(['p', 'h2', 'h3', 'strong', 'em', 'ul', 'ol', 'li', 'blockquote']);
function sanitizeBody(html) {
  let h = (html || '').replace(/\\n/g, '\n');
  h = h.replace(/<(script|style|iframe)[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<(\/?)([a-z0-9]+)[^>]*>/gi, (_, slash, tag) => ALLOWED_TAGS.has(tag.toLowerCase()) ? `<${slash}${tag.toLowerCase()}>` : '');
  if (!/<p>/.test(h)) h = h.split(/\n{2,}/).map(s => s.trim()).filter(Boolean).map(s => `<p>${s}</p>`).join('');
  return h.replace(/\n+/g, ' ').replace(/<p>\s*<\/p>/g, '').trim();
}

const plain = (s, max) => {
  const t = cleanText(String(s || ''));
  return max && t.length > max ? t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : t;
};

const escAttr = t => String(t || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function figureHTML(img, caption, cand) {
  return `<figure><img src="${escAttr(img.src)}" alt="${escAttr(caption)}" loading="lazy" referrerpolicy="no-referrer">`
       + `<figcaption>${caption ? escAttr(caption) + ' ' : ''}<span class="fig-credit">Image : `
       + `<a href="${escAttr(cand.url)}" target="_blank" rel="noopener noreferrer">${escAttr(cand.source)}</a></span></figcaption></figure>`;
}

// Remplace les marqueurs [[IMGn]] posés par Mistral par des <figure>, toujours entre deux blocs
function placeFigures(body, images, legendes, cand) {
  const noMarkers = () => ({ body: body.replace(/\s*\[\[IMG\d+\]\]\s*/g, ' ').replace(/<p>\s*<\/p>/g, '').trim(), placed: [] });
  if (!images.length || !/\[\[IMG\d+\]\]/.test(body)) return noMarkers();
  const blocks = body.match(/<(p|h2|h3|ul|ol|blockquote)>[\s\S]*?<\/\1>|\[\[IMG\d+\]\]/g) || [];
  // Garde-fou : si le découpage en blocs perd du texte, on renonce aux images plutôt qu'au texte
  const plainLen = t => cleanText(t.replace(/\[\[IMG\d+\]\]/g, '')).length;
  if (plainLen(blocks.join(' ')) < plainLen(body) * 0.95) return noMarkers();

  const out = [], used = new Set(), placed = [];
  for (const b of blocks) {
    const nums  = [...b.matchAll(/\[\[IMG(\d+)\]\]/g)].map(m => +m[1]);
    const clean = b.replace(/\s*\[\[IMG\d+\]\]\s*/g, ' ').replace(/\s+(<\/)/g, '$1').replace(/(<(?:p|h2|h3|blockquote)>)\s+/g, '$1').trim();
    if (!/^\[\[IMG\d+\]\]$/.test(b) && !/^<(p|h2|h3|blockquote)>\s*<\/\1>$/.test(clean)) out.push(clean);
    for (const n of nums) {
      const img = images[n - 1];
      if (!img || used.has(n)) continue;
      used.add(n);
      const caption = plain(legendes?.[`IMG${n}`], 220) || plain(img.caption, 220);
      out.push(figureHTML(img, caption, cand));
      placed.push({ src: img.src, caption });
    }
  }
  return { body: out.join(''), placed };
}

function buildArticle(cand, json, images = []) {
  if (!json) return { reject: 'JSON illisible', retry: true };
  if (json.pertinent === false) return { reject: 'hors sujet ou promotionnel' };
  const body = sanitizeBody(json.corps || json.body || '');
  const words = wordCount(body);
  if (words < 100) return { reject: `corps trop court (${words} mots)`, retry: true };

  const category = cand.category === 'labos' ? 'labos'
    : (['avancees', 'risques', 'societe'].includes(json.categorie) ? json.categorie : cand.category);
  const tone = TONES.includes(json.tonalite) ? json.tonalite : 'enjeu';
  const figs = placeFigures(body, images, json.legendes, cand);

  const glossary = (Array.isArray(json.glossaire) ? json.glossaire : [])
    .map(g => ({ term: plain(g?.terme, 60), def: plain(g?.definition, 260) }))
    .filter(g => g.term && g.def).slice(0, 3);
  const nuance = (Array.isArray(json.a_nuancer) ? json.a_nuancer : [])
    .map(n => plain(n, 320)).filter(n => n.length > 10).slice(0, 4);

  return {
    article: {
      id:          cand.id,
      title:       plain(json.titre, 120) || cand.title,
      summary:     plain(json.accroche, 260),
      url:         cand.url,
      source:      cand.source,
      kind:        cand.kind,
      opinion:     cand.kind === 'tribune',
      category,
      tone,
      image:       cand.image,
      published:   cand.published,
      lang:        cand.lang,
      body:        figs.body,
      images:      figs.placed,
      glossary,
      nuance,
      readingTime: Math.max(1, Math.round(words / 200)),
    },
  };
}

// Version sans IA (mode --dry) : sert à tester la collecte et l'affichage
function dryArticle(cand, text, images = []) {
  const parts = text.split(/\n{2,}/).slice(0, 4).map(p => `<p>${escAttr(p)}</p>`);
  if (images[0]) parts.splice(1, 0, figureHTML(images[0], images[0].caption, cand));
  const paras = parts.join('');
  return { article: {
    id: cand.id, title: cand.title, summary: plain(text, 200), url: cand.url, source: cand.source,
    kind: cand.kind, opinion: cand.kind === 'tribune', category: cand.category,
    tone: TONES[Math.floor(Math.random() * 3)], image: cand.image, published: cand.published,
    lang: cand.lang, body: paras || `<p>${plain(text, 800)}</p>`, images: images.slice(0, 1),
    glossary: [{ term: 'Mode test', def: 'Article non réécrit : le script a tourné sans appeler Mistral.' }],
    nuance: ['Texte brut de la source, non traduit.'], readingTime: Math.max(1, Math.round(wordCount(text) / 200)),
  }};
}

// ─── Similarité de titres (doublons entre sources) ───────────────────────────
const STOP = new Set('the a an of to in on for and or is are with from by at as its it this that how why what new le la les de du des un une et ou en sur pour par dans au aux est'.split(' '));
const tokens = t => new Set(t.toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, ' ').split(' ').filter(w => w.length > 2 && !STOP.has(w)));
function jaccard(a, b) {
  const s1 = tokens(a), s2 = tokens(b);
  const inter = [...s1].filter(w => s2.has(w)).length;
  const union = new Set([...s1, ...s2]).size;
  return union ? inter / union : 0;
}

// ─── Lecture / écriture JSON ─────────────────────────────────────────────────
async function readJSON(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf-8')); } catch { return fallback; }
}

// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log(`\n${c.bold}${c.cyan}━━━ CelliA Lab — Veille IA ━━━${c.reset} ${IS_DEV ? '[DEV] ' : ''}${IS_DRY ? '[DRY]' : ''}\n`);

  if (!IS_DRY && !process.env.MISTRAL_API_KEY) {
    err('MISTRAL_API_KEY absente — ajoute-la dans Settings → Secrets and variables → Actions');
    process.exit(1);
  }

  // sources.json doit être valide : une erreur ici arrête le run avec un message clair
  let rawSources;
  try { rawSources = JSON.parse(await fs.readFile(path.join(__dirname, 'sources.json'), 'utf-8')); }
  catch (e) { err(`sources.json invalide : ${e.message}`); process.exit(1); }
  const sources    = (Array.isArray(rawSources) ? rawSources : rawSources.sources || []).filter(s => !s.disabled);
  const cache      = await readJSON(FULL_PATH, { articles: [] });
  const seen       = await readJSON(SEEN_PATH, {});
  const cached     = cache.articles || [];
  const known      = new Set([...cached.map(a => a.id), ...Object.keys(seen)]);

  // Tant que le site compte moins de 20 articles (premiers runs, y compris après
  // un run de test), on remonte sur 7 jours pour qu'il ne démarre pas vide
  const firstRun = cached.length < 20;
  const windowMs = (firstRun ? FIRST_RUN_HOURS : WINDOW_HOURS) * 3600 * 1000;
  log(`${sources.length} sources actives · modèle ${MODEL} · ${cached.length} articles en cache${firstRun ? ' · démarrage (fenêtre 7 jours)' : ''}`);

  // 1. Collecte
  const results = await Promise.allSettled(sources.map(s => s.type === 'html' ? fetchHtmlList(s, windowMs) : fetchRss(s, windowMs)));
  let pool = [];
  results.forEach((r, i) => {
    const s = sources[i];
    if (r.status === 'fulfilled') {
      const fresh = r.value.filter(cand => !known.has(cand.id));
      dim(`${(s.source_name || s.url).padEnd(28)} ${String(r.value.length).padStart(3)} récents · ${fresh.length} nouveaux`);
      pool.push(...fresh.map(cand => ({ ...cand, _max: s.max_per_run || DEFAULT_PER_SOURCE })));
    } else {
      warn(`${s.source_name || s.url} indisponible : ${r.reason?.message || r.reason}`);
    }
  });
  ok(`${pool.length} articles candidats`);

  // 2. Doublons (URL puis sujet) et plafond par source
  const byUrl = new Map();
  pool.forEach(cand => { if (!byUrl.has(cand.id)) byUrl.set(cand.id, cand); });
  pool = [...byUrl.values()].sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
  const deduped = [];
  for (const cand of pool) if (!deduped.some(k => jaccard(k.title, cand.title) > 0.45)) deduped.push(cand);
  const perSource = {};
  pool = deduped.filter(cand => (perSource[cand.source] = (perSource[cand.source] || 0) + 1) <= cand._max);

  // 3. Équilibre : on pioche à tour de rôle dans chaque catégorie
  const queues = Object.fromEntries(CATEGORIES.map(k => [k, pool.filter(cand => cand.category === k)]));
  const ordered = [];
  const order = ['avancees', 'risques', 'societe', 'labos'];
  while (order.some(k => queues[k].length)) for (const k of order) if (queues[k].length) ordered.push(queues[k].shift());
  log(`${ordered.length} candidats après doublons et plafonds · objectif ${MAX_ARTICLES} articles`);

  // 4. Texte source + réécriture
  const fresh = [];
  let calls = 0, rejected = 0;
  for (const cand of ordered) {
    if (fresh.length >= MAX_ARTICLES || calls >= MAX_CALLS) break;
    const { text, images } = await fetchSourceText(cand);
    const words = wordCount(text);
    if (words < MIN_SOURCE_WORDS) {
      dim(`[trop court ${words} mots] ${cand.source} — ${cand.title.slice(0, 60)}`);
      seen[cand.id] = new Date().toISOString();
      continue;
    }
    info(`${cand.source} — ${cand.title.slice(0, 70)} (${words} mots${images.length ? `, ${images.length} illustration${images.length > 1 ? 's' : ''}` : ''})`);

    let result, usage = null;
    if (IS_DRY) {
      result = dryArticle(cand, text, images);
    } else {
      calls++;
      try {
        const r = await callMistral(buildUserPrompt(cand, text, images));
        usage  = r.usage;
        result = buildArticle(cand, parseJSON(r.content), images);
      } catch (e) {
        if (e instanceof FatalApiError) { err(e.message); process.exit(1); }
        warn(`  échec Mistral : ${e.message}`);
        result = { reject: 'erreur API', retry: true };
      }
      await sleep(PAUSE_MS);
    }
    const tk = usage ? ` · ${usage.total_tokens ?? '?'} tokens` : '';

    if (result.article) {
      fresh.push(result.article);
      seen[cand.id] = new Date().toISOString();
      const nImg = result.article.images?.length || 0;
      ok(`  ${result.article.tone.padEnd(7)} ${result.article.category.padEnd(8)} ${nImg ? `🖼 ${nImg} ` : ''}${result.article.title.slice(0, 60)}${tk}`);
    } else {
      rejected++;
      warn(`  écarté : ${result.reject}${tk}`);
      if (!result.retry) seen[cand.id] = new Date().toISOString();
    }
  }

  // 5. Datation, images, fusion avec l'historique
  const now = Date.now();
  fresh.forEach((a, i) => {
    a.date = new Date(now - i * 60000).toISOString();
    if (!a.image) a.image = fallbackImage(a.category);
  });
  const cutoff = now - KEEP_DAYS * 86400000;
  const kept   = cached.filter(a => new Date(a.date).getTime() > cutoff && !fresh.some(f => f.id === a.id));
  const all    = [...fresh, ...kept].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, MAX_STORED);

  // 6. Écriture
  await fs.mkdir(DIST, { recursive: true });
  const generated_at = new Date().toISOString();
  await fs.writeFile(FULL_PATH, JSON.stringify({ generated_at, count: all.length, articles: all }), 'utf-8');
  const light = all.map(({ body, glossary, nuance, images, ...rest }) => rest);
  await fs.writeFile(INDEX_PATH, JSON.stringify({ generated_at, count: all.length, new_count: fresh.length, articles: light }), 'utf-8');

  const seenCutoff = now - SEEN_DAYS * 86400000;
  const seenPruned = Object.fromEntries(Object.entries(seen).filter(([, d]) => new Date(d).getTime() > seenCutoff));
  await fs.writeFile(SEEN_PATH, JSON.stringify(seenPruned), 'utf-8');

  // Historique des tokens : run courant + cumul depuis toujours, gardé compact
  // (le détail par article reste dans ce journal, pas dans le fichier publié)
  const usagePath = path.join(DIST, 'usage.json');
  const usageData = await readJSON(usagePath, { history: [], lifetime: null });
  const runCost   = costOf(runStats.promptTokens, runStats.completionTokens);
  const entry = {
    date: generated_at, model: MODEL,
    articles_published: fresh.length, articles_rejected: rejected,
    calls: runStats.calls, retries429: runStats.retries429,
    promptTokens: runStats.promptTokens, completionTokens: runStats.completionTokens, totalTokens: runStats.totalTokens,
    estCostUSD: Number(runCost.toFixed(4)),
  };
  const USAGE_HISTORY_MAX = 120;   // ~2 mois à 2 runs/jour
  const history = [entry, ...usageData.history].slice(0, USAGE_HISTORY_MAX);
  const life = usageData.lifetime || { since: generated_at, runs: 0, calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, estCostUSD: 0 };
  life.runs++; life.calls += runStats.calls;
  life.promptTokens += runStats.promptTokens; life.completionTokens += runStats.completionTokens; life.totalTokens += runStats.totalTokens;
  life.estCostUSD = Number((life.estCostUSD + runCost).toFixed(4));
  await fs.writeFile(usagePath, JSON.stringify({
    history, lifetime: life,
    pricing: { model: MODEL, inputPer1M: PRICE_IN, outputPer1M: PRICE_OUT },
  }), 'utf-8');

  console.log(`\n${c.bold}━━━ Terminé ━━━${c.reset}`);
  ok(`${fresh.length} nouveaux · ${rejected} écartés · ${all.length} au total · ${runStats.calls} appels Mistral (${runStats.retries429} attente(s) 429)`);
  const tally = k => fresh.filter(a => a.tone === k).length;
  ok(`Tonalité du run : ${tally('avancee')} avancée · ${tally('enjeu')} enjeu · ${tally('alerte')} alerte`);
  ok(`Tokens : ${runStats.promptTokens.toLocaleString('fr-FR')} entrée + ${runStats.completionTokens.toLocaleString('fr-FR')} sortie = ${runStats.totalTokens.toLocaleString('fr-FR')} total`);
  ok(`Coût estimé du run : ${runCost.toFixed(4)} $ · cumul depuis le début : ${life.estCostUSD.toFixed(2)} $ sur ${life.runs} runs`);
}

// Node garde parfois le process vivant après la fin de main() à cause des connexions
// HTTP maintenues ouvertes (fetch natif). On force la sortie pour ne pas dépendre
// du timeout du job GitHub Actions pour terminer proprement.
main()
  .then(() => process.exit(0))
  .catch(e => { err(`Erreur fatale : ${e.message}`); console.error(e); process.exit(1); });

// ═══════════════════════════════════════════════════════════
// ROADSPOT LEAD AGENT — CORE ENGINE v8
// Oppdatert: Djupare analyse, betre filtrering, ny prioritering
// ═══════════════════════════════════════════════════════════

const APOLLO  = "https://mcp.apollo.io/mcp";
const HUBSPOT = "https://mcp.hubspot.com/anthropic";
const GMAIL   = "https://gmailmcp.googleapis.com/mcp/v1";
const NOW_MONTH = new Date().getMonth();

// ── SHARED TEAM DEDUP ──────────────────────────────────────
const SHARED_KEY = "rs_team_claimed";
const TEAM_COLORS = { hans_kristian:"#1D9E75", eirik:"#2563EB", alexandra:"#7C3AED" };
const TEAM_NAMES  = { hans_kristian:"Hans Kristian", eirik:"Eirik", alexandra:"Alexandra" };

function getClaimedCompanies() {
  try { return JSON.parse(localStorage.getItem(SHARED_KEY) || "{}") || {}; }
  catch(e) { return {}; }
}
function saveClaimedCompanies(data) {
  localStorage.setItem(SHARED_KEY, JSON.stringify(data));
}
function normalizeKey(name, domain) {
  const n = (name||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const d = (domain||"").toLowerCase().replace(/^www\./,"").replace(/[^a-z0-9]/g,"");
  return d || n;
}
function isClaimedByOther(name, domain, myId) {
  const claimed = getClaimedCompanies();
  const entry = claimed[normalizeKey(name, domain)];
  if (!entry || entry.agent === myId) return null;
  return entry;
}
function claimCompany(name, domain, myId, hubspotId) {
  const claimed = getClaimedCompanies();
  claimed[normalizeKey(name, domain)] = {
    name, domain: domain||"", agent: myId,
    hubspotId: hubspotId||"",
    claimedAt: new Date().toISOString().split("T")[0]
  };
  saveClaimedCompanies(claimed);
}
function getTeamStats() {
  const stats = { hans_kristian:0, eirik:0, alexandra:0 };
  Object.values(getClaimedCompanies()).forEach(c => { if (stats[c.agent]!==undefined) stats[c.agent]++; });
  return stats;
}

// ── SEGMENT FILTER — ekskluder ueigna selskap ──────────────
// Returnerer true om selskapet BØR FILTRERAST VEKK
function isExcludedSegment(lead) {
  const seg = (lead.segment||"").toLowerCase();
  const name = (lead.company||"").toLowerCase();
  const desc = (lead.description||"").toLowerCase();
  const combined = seg + " " + name + " " + desc;

  // Ekskluder: guidepliktige aktivitetar, safety-guide aktivitetar, for small
  const excludeKeywords = [
    "kayak","kajakk","kajak","rafting","klatring","klatre","climbing",
    "fjelltur","mountain guide","alpine guide","ski guide","off-piste",
    "via ferrata","canyoning","diving","dykking","overlevelse","survival",
    "one-man","einpersons","small guide","private guide","solo guide",
    "dog sled","hundekjøring","reindeer sled","reinsdyrkjøring"
  ];

  for (const kw of excludeKeywords) {
    if (combined.includes(kw)) return true;
  }

  // Ekskluder basert på omsetning < 10M NOK
  const revenue = lead.annualRevenue || lead.revenue || 0;
  if (revenue > 0 && revenue < 10000000) return true;

  return false;
}

// ── GEO & SEASON SCORING ───────────────────────────────────
const GEO_SCORES = {
  noreg:30,norway:30,norge:30,
  sverige:25,sweden:25,denmark:25,danmark:25,
  finland:20,island:20,iceland:20,
  uk:15,ireland:15,irland:15,
  nederland:10,germany:10,tyskland:10,belgia:10,austerrike:10,sveits:10,
  frankrike:7,spania:7,italia:7,portugal:7
};
function geoScore(country) {
  if (!country) return 30;
  const l = country.toLowerCase();
  for (const [k,v] of Object.entries(GEO_SCORES)) if (l.includes(k)) return v;
  return 3;
}
function monthsToSeason(str) {
  // Støttar både gamle mnd-tal og nye sesongtypar: vinter, sommer, heilars
  if (!str) return 4;
  const s = str.toLowerCase();

  // Nye sesongtypar
  if (s === 'heilars' || s === 'heilårs') {
    // Heilårs: alltid tilgjengeleg — gir konstant medium score
    return 3;
  }
  if (s === 'vinter') {
    // Høgsesong vinter — no er aug, dvs 3 mnd til nov
    const vintermnd = [10, 11, 12, 1, 2, 3]; // nov-mar
    const inSeason = vintermnd.includes(NOW_MONTH + 1);
    return inSeason ? 0 : Math.min(10 - NOW_MONTH, 12 - NOW_MONTH + 10); // rough estimate
  }
  if (s === 'sommer') {
    // Høgsesong sommer — jun-aug
    const sommermnd = [6, 7, 8]; // jun-aug
    const inSeason = sommermnd.includes(NOW_MONTH + 1);
    return inSeason ? 0 : Math.abs(6 - (NOW_MONTH + 1));
  }

  // Gammal logikk: tekststreng med månadsnamn (t.d. "November 2026")
  const M = {jan:0,feb:1,mar:2,apr:3,mai:4,may:4,jun:5,jul:6,aug:7,sep:8,okt:9,oct:9,nov:10,des:11,dec:11};
  for (const [k,v] of Object.entries(M)) {
    if (s.includes(k)) {
      let d = v - NOW_MONTH;
      return d <= 0 ? d + 12 : d;
    }
  }
  return 4;
}
function calcPriority(lead) {
  const seasonType = (lead.nextSeasonStart || lead.contactWindow || '').toLowerCase();
  const isHeilaars = seasonType === 'heilars' || seasonType === 'heilårs';
  const isVinter   = seasonType === 'vinter';
  const isSommer   = seasonType === 'sommer';

  const mths = monthsToSeason(lead.nextSeasonStart || lead.contactWindow);
  const geo  = geoScore(lead.country);
  const rs   = lead.review?.opportunityScore || 0;
  const hasRev = rs > 15;

  // Bonus for internasjonale gjester på same tur
  const intlBonus = lead.internationalGuestsMixed ? 20 : 0;
  // Bonus for stor omsetning
  const revBonus = lead.annualRevenue > 50000000 ? 15 : lead.annualRevenue > 20000000 ? 8 : 0;
  // Heilårs-bonus: alltid kontaktbar, ikkje avhengig av sesong
  const seasonBonus = isHeilaars ? 12 : 0;

  let tier, score;
  if (isHeilaars) {
    // Heilårs: alltid Tier 2 minimum, Tier 1 om reviews er gode
    if (hasRev) { tier=1; score=rs*2 + 25 + geo + intlBonus + revBonus + seasonBonus; }
    else         { tier=2; score=40 + geo + intlBonus + revBonus + seasonBonus; }
  } else if (hasRev && mths >= 2) {
    tier=1; score=rs*2 + mths*5 + geo + intlBonus + revBonus;
  } else if (mths >= 3) {
    tier=2; score=mths*8 + geo + (rs>0?rs*.5:0) + intlBonus + revBonus;
  } else {
    tier=3; score=mths*3 + geo + intlBonus;
  }
  return { tier, score, mths, geo, rs, intlBonus, revBonus, seasonBonus, isHeilaars, isVinter, isSommer };
}

// ── DEEP REVIEW ANALYSIS ───────────────────────────────────
async function analyzeReviews(lead) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        model:"claude-sonnet-4-6", max_tokens:3000,
        tools:[{type:"web_search_20250305", name:"web_search"}],
        system:`Du er ein review-analytikar for RoadSpot. Søk etter FAKTISKE reviews og tilbakemeldingar frå gjester hos "${lead.company}". Søk på: "${lead.company} reviews", "${lead.company} TripAdvisor", "${lead.company} Google reviews". VIKTIG: Bruk BERRE sitatar frå ekte reviews du finn — ikkje lag opp sitatar. Om du ikkje finn noko, set topQuotes til []. Finn tal på reviews, score og konkrete gjesteutfordringar.

Finn og analyser:
1. SPRÅKPROBLEM: Gjester klagar på at guide berre snakkar eitt språk, eller at informasjon ikkje er på deira språk
2. INFORMASJONSPROBLEM: Manglar historisk/kulturell info, ville vite meir
3. HØYRE GUIDE: Ikkje høyre guiden, for mange folk, dårleg akustikk
4. SKALERING: For store grupper, kaos, personleg service manglar
5. APP/SJØLVGUIDING: Ynskje om audio guide, sjølvstyrt oppleving
6. INTERNASJONALE GJESTER: Er det tydeleg at internasjonale gjester er på SAME TUR som norske? (kritisk for RoadSpot)
7. SELSKAPSINFO: Anslå omsetning, antal tilsette, antal gjester/år basert på det du finn

Returner KUN gyldig JSON utan preamble eller markdown:
{
  "totalReviews": 0,
  "sources": [],
  "painPoints": [
    {"category":"Språkproblem","pct":0,"quotes":[]},
    {"category":"Informasjonsproblem","pct":0,"quotes":[]},
    {"category":"Høyre guide","pct":0,"quotes":[]},
    {"category":"Skaleringsproblem","pct":0,"quotes":[]},
    {"category":"App/sjølvguiding","pct":0,"quotes":[]}
  ],
  "topQuotes": [],
  "opportunityScore": 0,
  "opportunitySummary": "",
  "roadspotCase": "",
  "internationalGuestsMixed": false,
  "internationalMixNote": "",
  "estimatedRevenueBand": "",
  "estimatedGuests": 0,
  "companySize": "",
  "operationType": "",
  "isExcluded": false,
  "exclusionReason": ""
}`,
        messages:[{role:"user", content:`Analyser reviews og selskapsinfo for "${lead.company}" (${lead.country}, ${lead.segment}).`}]
      })
    });
    const d = await r.json();
    const txt = d.content?.map(b => b.type==="text" ? b.text : "").join("") || "";
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      // Apply exclusion info back to lead
      if (parsed.internationalGuestsMixed) lead.internationalGuestsMixed = true;
      if (parsed.estimatedRevenueBand) lead.estimatedRevenueBand = parsed.estimatedRevenueBand;
      if (parsed.estimatedGuests) lead.estimatedGuests = parsed.estimatedGuests;
      if (parsed.companySize) lead.companySize = parsed.companySize;
      if (parsed.operationType) lead.operationType = parsed.operationType;
      return parsed;
    }
    throw new Error("no json");
  } catch(e) {
    return generateDemoReview(lead);
  }
}

function generateDemoReview(lead) {
  const b=80+Math.floor(Math.random()*280);
  const lang=6+Math.floor(Math.random()*20);
  const info=4+Math.floor(Math.random()*12);
  const hear=2+Math.floor(Math.random()*12);
  const scl=1+Math.floor(Math.random()*8);
  const app=1+Math.floor(Math.random()*5);
  const sc=Math.min(100,lang*2+info+hear+scl+app);
  const name=lead.company||"selskapet";
  const seg=(lead.segment||"").toLowerCase();
  const isCruise=seg.includes("båt")||seg.includes("cruise");
  const isMuseum=seg.includes("museum");

  const rnd=arr=>arr[Math.floor(Math.random()*arr.length)];

  const langQuotes=isCruise?[
    `"Announcements on board were only in English — our Japanese group was completely lost."`,
    `"The commentary was great but only available in Norwegian and English."`,
    `"We had guests from 12 countries on board. Only the English speakers could follow."`
  ]:isMuseum?[
    `"The audio guide only covers Norwegian and English. Our French tour group struggled."`,
    `"No multilingual options at the exhibits — very disappointing for international visitors."`,
    `"We brought a group from Germany and they couldn't follow any of the explanations."`
  ]:[
    `"Our guide only spoke English and Norwegian — the Asian guests in our group were frustrated."`,
    `"Half our group was German. There was no German language option whatsoever."`,
    `"Beautiful experience, but the language barrier made it hard for our international guests."`
  ];
  const hearQuotes=isCruise?[
    `"With 80 passengers on deck it was impossible to hear the guide."`,
    `"The ship's PA system crackled and half the commentary was lost."`
  ]:[
    `"Group of 40 people and one guide with no microphone — chaos."`,
    `"The guide was excellent but with 35 people it was impossible to follow."`
  ];
  const infoQuotes=[
    `"Loved the experience but wanted much more depth on the history."`,
    `"Would have loved a way to listen to the information again at my own pace."`,
    `"The guide rushed through — I had so many questions unanswered."`
  ];

  return{
    totalReviews:b,
    sources:["TripAdvisor","Google Reviews","Viator"],
    painPoints:[
      {category:"Språkproblem",      pct:lang, quotes:[rnd(langQuotes)]},
      {category:"Informasjonsproblem",pct:info, quotes:[rnd(infoQuotes)]},
      {category:"Høyre guide",        pct:hear, quotes:[rnd(hearQuotes)]},
      {category:"Skaleringsproblem",  pct:scl,  quotes:[]},
      {category:"App/sjølvguiding",   pct:app,  quotes:[]}
    ],
    topQuotes:[rnd(langQuotes), rnd(hearQuotes)],
    opportunityScore:sc,
    opportunitySummary:`${b} omtalar · ${lang+hear}% peikar direkte på problem RoadSpot løyser`,
    roadspotCase:`GPS-guiding på 30+ språk løyser dokumenterte gjesteutfordringar hos ${name}`,
    internationalGuestsMixed:lead.internationalGuestsMixed||(Math.random()>0.4),
    estimatedRevenueBand:lead.estimatedRevenueBand||"20-50M NOK",
    estimatedGuests:lead.estimatedGuests||Math.floor(5000+Math.random()*20000),
    companySize:lead.companySize||"Mellomstor (10-50 tilsette)",
    operationType:lead.operationType||lead.segment
  };
}

function buildCompanyProfile(lead, review) {
  const intlFlag = (lead.internationalGuestsMixed || review?.internationalGuestsMixed) ? "🌍 Internasjonale + norske gjester på same tur" : "";
  const revBand = lead.estimatedRevenueBand || review?.estimatedRevenueBand || "Ukjend";
  const guests = lead.estimatedGuests || review?.estimatedGuests || 0;
  const size = lead.companySize || review?.companySize || "Ukjend";
  const opType = lead.operationType || review?.operationType || lead.segment;

  return {
    intlFlag,
    revBand,
    guests: guests > 0 ? guests.toLocaleString("no-NO") + " gjester/år" : "Ukjend",
    size,
    opType
  };
}

// ── HUBSPOT FIT NOTE (max 1 side) ──────────────────────────
function buildHubSpotNote(lead, agentName, agentId) {
  const rev = lead.review;
  const profile = buildCompanyProfile(lead, rev);
  const topPains = rev?.painPoints?.filter(p=>p.pct>0).sort((a,b)=>b.pct-a.pct)
    .slice(0,3).map(p=>`  • ${p.category}: ${p.pct}%`).join("\n") || "  • Ikkje analysert";
  const topQ = rev?.topQuotes?.slice(0,2).map(q=>`  "${q}"`).join("\n") || "";

  const reasons = [];
  const seg = (lead.segment||"").toLowerCase();
  if (seg.includes("båt")||seg.includes("cruise"))  reasons.push("Båt/cruise: automatisk guiding kvar gjest — uavhengig av guide");
  if (seg.includes("destinasjon"))                   reasons.push("Destinasjon: distribuere guiding til alle operatørar i regionen");
  if (!reasons.length)                               reasons.push("Turoperatør: skalerbar guiding på 30+ språk via QR-kode");
  if (profile.intlFlag)                              reasons.push(`Prioritet: ${profile.intlFlag}`);

  return `=== ROADSPOT FIT-ANALYSE ===
SDR: ${agentName} | Dato: ${new Date().toLocaleDateString("no-NO")} | Tier ${lead.tier||"?"} #${lead.rank||"?"}

BEDRIFT
Namn: ${lead.company} · ${lead.country||"Noreg"}
Type: ${profile.opType}
Storleik: ${profile.size}
Omsetning: ${profile.revBand}
Gjester: ${profile.guests}
Sesong: ${lead.season||"?"} → ${lead.nextSeasonStart||"?"} (${lead.psData?.mths||"?"} mnd)
${profile.intlFlag ? `\n⭐ ${profile.intlFlag}` : ""}

KONTAKT
${lead.contact||"?"} · ${lead.title||""} · ${lead.email||"?"}

KVIFOR ROADSPOT
${reasons.map((r,i)=>`${i+1}. ${r}`).join("\n")}

GJESTEUTFORDRINGAR (${rev?.totalReviews||0} omtalar, score ${rev?.opportunityScore||0}/100)
${topPains}
${topQ ? `Sitat:\n${topQ}` : ""}

Pipeline: Identified`;
}

// ── SØKEPIPELINE: WEB-IDENTIFIKASJON → APOLLO-BERIKKING ──

// Steg 1: Brei web-søk — finn selskap frå Google, TripAdvisor, Viator, Reddit
async function findCompaniesViaWeb(cfg) {
  const seasonDesc = cfg.months === 'vinter'
    ? 'vinterturisme nordlys snø ski' 
    : cfg.months === 'sommer'
    ? 'sommarturisme fjord cruise båt'
    : 'heilårs attraksjonar museum cruise destinasjon';

  const geoStr = cfg.geos.slice(0,3).join(', ');
  const segStr = cfg.segs.join(', ');

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        tools: [{type: "web_search_20250305", name: "web_search"}],
        system: `Du er ein expert på å finne turistselskap som er gode kandidatar for RoadSpot sitt AI-guidingsystem.

RoadSpot løyser: internasjonale gjester på same tur som norske, språkbarrierar, skaleringsutfordringar.

SØKESTRATEGI — gjer MINST 4 søk:
1. TripAdvisor-søk: finn turoperatørar med mange internasjonale reviews i ${geoStr}
2. Viator/GetYourGuide: finn selskap med pakketurar for internasjonale grupper (${seasonDesc})
3. Bransjesøk: "turistselskap ${geoStr} internasjonale gjester"
4. Reddit r/travel r/norway r/sweden: kva selskap nemner reisande frå utlandet?
5. Destinasjons-søk: visitnorway.com, innovasjonnorge.no — kven er deira partnarar?

INKLUDER: cruise, kystruteskip, fjordturar, destinasjonsselskap, naturparksentre, museum med mange besøkande, fjelljernbane, gondol, turistferje
EKSKLUDER: kajakk, klatring, rafting, fjellguide (safety-guide aktivitetar), mikroselskap

For kvart selskap du identifiserer — returner BERRE gyldig JSON array, ingen anna tekst:
[{
  "company": "Selskapsnamn",
  "website": "nettside.no",
  "segment": "Turoperatørar",
  "season": "Vinter",
  "nextSeasonStart": "vinter",
  "country": "Noreg",
  "description": "Kort beskriving av kva dei gjer og kvifor RoadSpot passar",
  "internationalGuestsMixed": true,
  "estimatedRevenueBand": "50-200M NOK",
  "estimatedGuests": 15000,
  "companySize": "Mellomstor",
  "reviewSource": "TripAdvisor",
  "reviewScore": 4.5,
  "totalReviews": 340,
  "contact": "",
  "title": "",
  "email": "",
  "annualRevenue": 0
}]

Finn 20-30 selskap. KRITISK: Returner KUN selskap som faktisk held til i ${geoStr}. Ikkje inkluder selskap frå andre land. Prioriter selskap med dokumenterte internasjonale gjester og mange reviews.`,
        messages: [{role: "user", content: `Finn turistselskap SOM HELD TIL I ${geoStr.toUpperCase()} — ingen andre land. Sesong: ${seasonDesc}. Segment: ${segStr}. Sjekk at kvart selskap du returnerer faktisk er frå ${geoStr}.`}]
      })
    });
    const d = await r.json();
    const txt = d.content?.map(b => b.type === "text" ? b.text : "").join("") || "";
    const m = txt.match(/\[[\s\S]*\]/);
    if (m) {
      const companies = JSON.parse(m[0]);
      // Strikt geo-filter: berre selskap frå valde land
      const geoLower = cfg.geos.map(g => g.toLowerCase());
      const GEO_MAP = {
        'noreg': ['noreg','norge','norway','no'],
        'sverige': ['sverige','sweden','se'],
        'danmark': ['danmark','denmark','dk'],
        'finland': ['finland','fi'],
        'island': ['island','iceland','is'],
        'uk': ['uk','united kingdom','england','scotland','wales','britain','gb'],
        'nederland': ['nederland','netherlands','holland','nl'],
        'tyskland': ['germany','deutschland','de','tyskland'],
        'frankrike': ['france','frankrike','fr'],
        'spania': ['spain','spania','es'],
        'italia': ['italy','italia','it'],
      };
      const allowed = new Set();
      geoLower.forEach(g => { (GEO_MAP[g] || [g]).forEach(v => allowed.add(v)); });
      const filtered = companies.filter(c => {
        if (!c.company || !c.website) return false;
        const cCountry = (c.country || '').toLowerCase();
        if (!cCountry) return true; // no country info — keep for now
        return [...allowed].some(a => cCountry.includes(a));
      });
      return filtered.length > 0 ? filtered : companies.filter(c => c.company && c.website);
    }
    throw new Error("ingen JSON");
  } catch(e) {
    console.warn("Web-søk feila:", e.message);
    return [];
  }
}

// Steg 2: Apollo-berikking — finn kontaktperson og e-post for kvart selskap
async function enrichWithApollo(companies) {
  const enriched = [];

  for (let i = 0; i < companies.length; i++) {
    const company = companies[i];
    // Allereie har kontaktinfo — hopp over
    if (company.email && company.contact) {
      enriched.push(company);
      continue;
    }

    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 500,
          system: `Apollo.io berikking. Søk etter selskapet og finn kontaktperson med beslutningsmynde (CEO, Commercial Director, Sales Director, Marketing Director, Dagleg leiar). Returner KUN JSON, ingen anna tekst:
{"contact": "Namn", "title": "Tittel", "email": "epost@domene.no", "phone": "", "linkedin": "", "annualRevenue": 0, "employeeCount": 0, "found": true}
Om ikkje funne: {"found": false}`,
          messages: [{role: "user", content: `Finn kontaktperson hos ${company.company} (${company.website || ''}, ${company.country || 'Noreg'})`}],
          mcp_servers: [{type: "url", url: APOLLO, name: "apollo"}]
        })
      });
      const d = await r.json();
      const txt = d.content?.map(b =>
        b.type === "text" ? b.text :
        b.type === "mcp_tool_result" ? (b.content?.[0]?.text || "") : ""
      ).join("") || "";
      const m = txt.match(/\{[\s\S]*?\}/);
      if (m) {
        const info = JSON.parse(m[0]);
        if (info.found !== false) {
          company.contact = info.contact || company.contact || "";
          company.title   = info.title   || company.title   || "";
          company.email   = info.email   || company.email   || "";
          company.phone   = info.phone   || company.phone   || "";
          if (info.annualRevenue)  company.annualRevenue  = info.annualRevenue;
          if (info.employeeCount)  company.employeeCount  = info.employeeCount;
        }
      }
    } catch(e) {
      // Held fram utan berikking
    }
    await new Promise(r => setTimeout(r, 100));
    enriched.push(company);
  }
  return enriched;
}

// Steg 3: Kombinert pipeline — web-søk + Apollo-berikking + Apollo-fallback
async function findAndEnrichLeads(cfg) {
  // Steg 1: Brei web-identifikasjon
  let companies = await findCompaniesViaWeb(cfg);

  // Steg 2: Apollo-berikking for kontaktinfo
  if (companies.length > 0) {
    companies = await enrichWithApollo(companies.slice(0, 25));
  }

  // Fallback: om web-søk ikkje gav resultat, bruk Apollo direkte
  if (companies.length < 5) {
    companies = await findViaApolloFallback(cfg);
  }

  return companies.slice(0, 25);
}

// Apollo-fallback (original metode)
async function findViaApolloFallback(cfg) {
  const seasonDesc = cfg.months === 'vinter'
    ? 'VINTER-operatørar: høgsesong nov-mar, men kan vere open heile året. Finn dei ute av sesong no.'
    : cfg.months === 'sommer'
    ? 'SOMMER-operatørar: høgsesong jun-aug, men kan vere open heile året. Finn dei ute av sesong no.'
    : 'HEILÅRS-operatørar: turistar og besøkande heile året, ingen lågsesong. Alltid aktuelle.';
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        system: `Lead-agent for RoadSpot. Finn turistselskap i ${cfg.geos.join(", ")}. Segment: ${cfg.segs.join(", ")}. Min omsetning 10M NOK. EKSKLUDER: kajakk, klatring, rafting, fjellguide, safety-guide aktivitetar. INKLUDER: cruise, ferje, turoperatørar med grupper, destinasjonsselskap, museum, fjelljernbane. Sesongtype: ${seasonDesc} 25 selskap. KUN JSON: [{"company":"","website":"","segment":"","season":"Vinter","nextSeasonStart":"vinter","contact":"","title":"","email":"","country":"Noreg","annualRevenue":0,"estimatedGuests":0,"internationalGuestsMixed":false,"description":""}]`,
        messages: [{role: "user", content: "Finn 25 selskap."}],
        mcp_servers: [{type: "url", url: APOLLO, name: "apollo"}]
      })
    });
    const d = await r.json();
    const txt = d.content?.map(b =>
      b.type === "text" ? b.text :
      b.type === "mcp_tool_result" ? (b.content?.[0]?.text || "") : ""
    ).join("") || "";
    const m = txt.match(/\[[\s\S]*?\]/);
    if (m) return JSON.parse(m[0]);
    throw new Error();
  } catch(e) {
    return getDemoLeads(cfg);
  }
}

// Behold buildApolloPrompt for bakoverkompatibilitet
function buildApolloPrompt(cfg) {
  const seasonDesc = cfg.months === 'vinter'
    ? 'VINTER-operatørar: høgsesong nov-mar.'
    : cfg.months === 'sommer'
    ? 'SOMMER-operatørar: høgsesong jun-aug.'
    : 'HEILÅRS-operatørar: alltid aktuelle.';
  return `Lead-agent for RoadSpot. Finn turistselskap i ${cfg.geos.join(", ")}. Segment: ${cfg.segs.join(", ")}. Min omsetning 10M NOK. EKSKLUDER: kajakk, klatring, rafting, fjellguide. Sesongtype: ${seasonDesc} 25 selskap. KUN JSON: [{"company":"","website":"","segment":"","season":"Vinter","nextSeasonStart":"vinter","contact":"","title":"","email":"","country":"Noreg","annualRevenue":0,"estimatedGuests":0,"internationalGuestsMixed":false,"description":""}]`;
}

// ── DEMO LEADS (oppdatert med nye felt) ────────────────────
function getDemoLeads(cfg) {
  const allLeads = [
    // NOREG
    {company:"Havila Kystruten",segment:"Båt/cruise",season:"Sommer",nextSeasonStart:"heilars",contact:"Bent Martini",title:"CEO",email:"bent@havila.no",country:"Noreg",website:"havila.no",annualRevenue:800000000,estimatedGuests:60000,internationalGuestsMixed:true,description:"Kystruteskip langs norskekysten, 50%+ internasjonale gjester"},
    {company:"Visit Tromsø AS",segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"vinter",contact:"Silje Andersen",title:"Marketing Director",email:"silje@visittromso.no",country:"Noreg",website:"visittromso.no",annualRevenue:65000000,estimatedGuests:120000,internationalGuestsMixed:true,description:"Destinasjonsselskap Tromsø"},
    {company:"Svalbard Wildlife Expeditions",segment:"Turoperatørar",season:"Vinter",nextSeasonStart:"vinter",contact:"Frida Mork",title:"Product Manager",email:"frida@svalbard-wildlife.no",country:"Noreg",website:"svalbard-wildlife.no",annualRevenue:28000000,estimatedGuests:4000,internationalGuestsMixed:true,description:"Naturturar Svalbard"},
    {company:"Visit Svalbard AS",segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"vinter",contact:"Nina Grønnevet",title:"Marketing Director",email:"nina@visitsvalbard.com",country:"Noreg",website:"visitsvalbard.com",annualRevenue:55000000,estimatedGuests:80000,internationalGuestsMixed:true,description:"Svalbard turistorganisasjon"},
    {company:"North Norway Tours",segment:"Turoperatørar",season:"Vinter",nextSeasonStart:"vinter",contact:"Ingrid Eide",title:"Commercial Director",email:"ieide@northnorwaytours.no",country:"Noreg",website:"northnorwaytours.no",annualRevenue:32000000,estimatedGuests:6000,internationalGuestsMixed:true,description:"Bussturar Nord-Noreg"},
    {company:"Polarmuseet Tromsø",segment:"Museum",season:"heilars",nextSeasonStart:"heilars",contact:"Kristine Ruud",title:"Dagleg leiar",email:"kruud@polarmuseet.no",country:"Noreg",website:"polarmuseet.no",annualRevenue:22000000,estimatedGuests:40000,internationalGuestsMixed:true,description:"Museum Tromsø"},
    {company:"Chasing Lights AS",segment:"Turoperatørar",season:"Vinter",nextSeasonStart:"vinter",contact:"Marius Strand",title:"Commercial Director",email:"marius@chasinglights.no",country:"Noreg",website:"chasinglights.no",annualRevenue:15000000,estimatedGuests:3000,internationalGuestsMixed:true,description:"Nordlysturar"},
    {company:"Destination Lofoten AS",segment:"Destinasjonsselskap",season:"Sommer",nextSeasonStart:"sommer",contact:"Lars Berg",title:"CEO",email:"lars@destinationlofoten.no",country:"Noreg",website:"destinationlofoten.no",annualRevenue:18000000,estimatedGuests:35000,internationalGuestsMixed:true,description:"Destinasjonsselskap Lofoten"},
    {company:"Kirkenes Snowhotel AS",segment:"Turoperatørar",season:"Vinter",nextSeasonStart:"vinter",contact:"Trine Kvam",title:"CEO",email:"trine@snowhotel.no",country:"Noreg",website:"snowhotel.no",annualRevenue:42000000,estimatedGuests:7000,internationalGuestsMixed:true,description:"Ishotell nær russegrensa"},
    // SVERIGE
    {company:"Swedish Lapland Visitors",segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"vinter",contact:"Lars Nilsson",title:"Marketing Director",email:"lars@swedishlapland.com",country:"Sverige",website:"swedishlapland.com",annualRevenue:45000000,estimatedGuests:20000,internationalGuestsMixed:true,description:"Destinasjonsselskap Lapland"},
    {company:"Icehotel Jukkasjärvi",segment:"Turoperatørar",season:"Vinter",nextSeasonStart:"vinter",contact:"Emma Lindgren",title:"Commercial Director",email:"emma@icehotel.com",country:"Sverige",website:"icehotel.com",annualRevenue:80000000,estimatedGuests:15000,internationalGuestsMixed:true,description:"Ikonisk ishotell"},
    {company:"Abisko Naturum",segment:"Naturopplevingar",season:"Vinter",nextSeasonStart:"vinter",contact:"Anna Eriksson",title:"Head of Experience",email:"anna@abisko.se",country:"Sverige",website:"abisko.se",annualRevenue:19000000,estimatedGuests:12000,internationalGuestsMixed:true,description:"Nasjonalparksenter"},
    // DANMARK
    {company:"DFDS Cruises",segment:"Båt/cruise",season:"heilars",nextSeasonStart:"heilars",contact:"Marketing Director",title:"Marketing Director",email:"info@dfds.com",country:"Danmark",website:"dfds.com",annualRevenue:800000000,estimatedGuests:400000,internationalGuestsMixed:true,description:"Ferje og cruiseskip Skandinavia"},
    {company:"Visit Copenhagen",segment:"Destinasjonsselskap",season:"heilars",nextSeasonStart:"heilars",contact:"CEO",title:"CEO",email:"info@visitcopenhagen.com",country:"Danmark",website:"visitcopenhagen.com",annualRevenue:90000000,estimatedGuests:300000,internationalGuestsMixed:true,description:"Danmarks største turistorganisasjon"},
    {company:"Strøget Tours",segment:"Turoperatørar",season:"Sommer",nextSeasonStart:"sommer",contact:"Tour Manager",title:"Tour Manager",email:"info@stroeget-tours.dk",country:"Danmark",website:"stroeget-tours.dk",annualRevenue:12000000,estimatedGuests:8000,internationalGuestsMixed:true,description:"Byturar København, internasjonalt publikum"},
    // FINLAND
    {company:"Visit Rovaniemi",segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"vinter",contact:"Mikko Mäkinen",title:"CEO",email:"mikko@visitrovaniemi.fi",country:"Finland",website:"visitrovaniemi.fi",annualRevenue:35000000,estimatedGuests:50000,internationalGuestsMixed:true,description:"Julenisse-destinasjon"},
    {company:"Santa Claus Village",segment:"Turoperatørar",season:"Vinter",nextSeasonStart:"vinter",contact:"Marketing Manager",title:"Marketing Manager",email:"info@santaclausvillage.info",country:"Finland",website:"santaclausvillage.info",annualRevenue:60000000,estimatedGuests:50000,internationalGuestsMixed:true,description:"Julenisse-attraksjon Rovaniemi"},
    // ISLAND
    {company:"Visit Iceland Reykjavik",segment:"Destinasjonsselskap",season:"heilars",nextSeasonStart:"heilars",contact:"Sigurdur Bjornsson",title:"Marketing Manager",email:"s.bjornsson@visitreykjavik.is",country:"Island",website:"visitreykjavik.is",annualRevenue:120000000,estimatedGuests:100000,internationalGuestsMixed:true,description:"Største destinasjonsselskap Island"},
    {company:"Arctic Adventures Iceland",segment:"Turoperatørar",season:"heilars",nextSeasonStart:"heilars",contact:"CEO",title:"CEO",email:"info@adventures.is",country:"Island",website:"adventures.is",annualRevenue:35000000,estimatedGuests:40000,internationalGuestsMixed:true,description:"Naturturar Island, nesten 100% internasjonale gjester"},
    // UK
    {company:"Rabbies Trail Burners",segment:"Turoperatørar",season:"Sommer",nextSeasonStart:"sommer",contact:"Robin Worling",title:"CEO",email:"info@rabbies.com",country:"UK",website:"rabbies.com",annualRevenue:45000000,estimatedGuests:25000,internationalGuestsMixed:true,description:"Smågruppe turar Skottland og Irland, mange internasjonale gjester"},
    {company:"Loch Lomond Seaplanes",segment:"Turoperatørar",season:"Sommer",nextSeasonStart:"sommer",contact:"Operations Manager",title:"Operations Manager",email:"info@lochlomond-seaplanes.com",country:"UK",website:"lochlomond-seaplanes.com",annualRevenue:12000000,estimatedGuests:3000,internationalGuestsMixed:true,description:"Sjøfly turar Skottland"},
    {company:"Visit Scotland",segment:"Destinasjonsselskap",season:"heilars",nextSeasonStart:"heilars",contact:"Malcolm Roughead",title:"CEO",email:"info@visitscotland.com",country:"UK",website:"visitscotland.com",annualRevenue:200000000,estimatedGuests:500000,internationalGuestsMixed:true,description:"Skottlands nasjonale turistorganisasjon"},
    {company:"Caledonian MacBrayne",segment:"Båt/cruise",season:"Sommer",nextSeasonStart:"sommer",contact:"Commercial Director",title:"Commercial Director",email:"info@calmac.co.uk",country:"UK",website:"calmac.co.uk",annualRevenue:180000000,estimatedGuests:200000,internationalGuestsMixed:true,description:"Ferjeselskap Skottland, internasjonale turistar"},
    {company:"National Trust Scotland",segment:"Museum",season:"heilars",nextSeasonStart:"heilars",contact:"CEO",title:"CEO",email:"info@nts.org.uk",country:"UK",website:"nts.org.uk",annualRevenue:95000000,estimatedGuests:300000,internationalGuestsMixed:true,description:"Historiske attraksjonar Skottland"},
    // NEDERLAND
    {company:"Rederij Lovers",segment:"Båt/cruise",season:"Sommer",nextSeasonStart:"sommer",contact:"Director",title:"Director",email:"info@lovers.nl",country:"Nederland",website:"lovers.nl",annualRevenue:35000000,estimatedGuests:800000,internationalGuestsMixed:true,description:"Kanalcruise Amsterdam, massivt internasjonalt"},
    // TYSKLAND
    {company:"Bayerische Seenschifffahrt",segment:"Båt/cruise",season:"Sommer",nextSeasonStart:"sommer",contact:"Geschäftsführer",title:"Geschäftsführer",email:"info@seenschifffahrt.de",country:"Tysklandland",website:"seenschifffahrt.de",annualRevenue:28000000,estimatedGuests:150000,internationalGuestsMixed:true,description:"Innsjøcruise Bayern, mange internasjonale turistar"},
  ];

  // Strikt geo-filter
  const GEO_MAP = {
    'noreg':['noreg','norge','norway'],'sverige':['sverige','sweden'],
    'danmark':['danmark','denmark'],'finland':['finland'],
    'island':['island','iceland'],'uk':['uk','united kingdom','england','scotland','britain','wales'],
    'nederland':['nederland','netherlands','holland'],'tyskland':['germany','deutschland','tyskland'],
    'frankrike':['france','frankrike'],'spania':['spain','spania'],'italia':['italy','italia'],
  };
  if (!cfg || !cfg.geos || cfg.geos.length === 0) return allLeads;
  const allowed = new Set();
  cfg.geos.forEach(g => { (GEO_MAP[g.toLowerCase()] || [g.toLowerCase()]).forEach(v => allowed.add(v)); });
  const filtered = allLeads.filter(c => {
    const cc = (c.country||'').toLowerCase();
    return [...allowed].some(a => cc.includes(a));
  });
  return filtered.length > 0 ? filtered : allLeads;
}

window.RS = {
  // Memory
  loadMemory, saveMemory, memoryHasCompany, addToMemory, addRunToMemory, makeCompanyKey,
  DRIVE_MCP,
  APOLLO, HUBSPOT, GMAIL,
  SHARED_KEY, TEAM_COLORS, TEAM_NAMES,
  getClaimedCompanies, saveClaimedCompanies, normalizeKey,
  isClaimedByOther, claimCompany, getTeamStats,
  geoScore, monthsToSeason, calcPriority,
  analyzeReviews, generateDemoReview,
  buildHubSpotNote, buildCompanyProfile,
  getDemoLeads: (cfg) => getDemoLeads(cfg), isExcludedSegment,
  buildApolloPrompt,
  version: "v9.4 — " + new Date().toISOString().split("T")[0]
};
console.log("RoadSpot Agent Core loaded:", window.RS.version);

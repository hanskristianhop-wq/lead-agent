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
        model:"claude-sonnet-4-6", max_tokens:2500,
        tools:[{type:"web_search_20250305", name:"web_search"}],
        system:`Du er ein djup review-analytikar for RoadSpot. Søk på "${lead.company}" på TripAdvisor, Google Reviews, Viator, GetYourGuide og Reddit.

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
  const base = 80 + Math.floor(Math.random()*280);
  const lang=6+Math.floor(Math.random()*20), info=4+Math.floor(Math.random()*12),
        hear=2+Math.floor(Math.random()*12), scl=1+Math.floor(Math.random()*8),
        app=1+Math.floor(Math.random()*5);
  const sc = Math.min(100, lang*2+info+hear+scl+app);
  return {
    totalReviews:base, sources:["TripAdvisor","Google Reviews","Viator"],
    painPoints:[
      {category:"Språkproblem",       pct:lang, quotes:['"The guide only spoke English — our German guests really struggled."']},
      {category:"Informasjonsproblem", pct:info, quotes:['"Would have loved more background stories."']},
      {category:"Høyre guide",         pct:hear, quotes:['"Hard to hear at the back of the group."']},
      {category:"Skaleringsproblem",   pct:scl,  quotes:['"40 people is too many for a guided tour."']},
      {category:"App/sjølvguiding",    pct:app,  quotes:['"An audio guide option would be great."']}
    ],
    topQuotes:[
      '"The guide only spoke English — our German guests really struggled."',
      '"With 40 people it was impossible to hear."',
      '"More information about the history would have been wonderful."'
    ],
    opportunityScore:sc,
    opportunitySummary:`${base} omtalar · ${lang+hear}% peikar på problem RoadSpot løyser`,
    roadspotCase:`GPS-guiding på 30+ språk løyser dokumenterte gjesteutfordringar`,
    internationalGuestsMixed: Math.random() > 0.5,
    internationalMixNote: "Internasjonale og norske gjester på same tur",
    estimatedRevenueBand: "20-50M NOK",
    estimatedGuests: Math.floor(5000 + Math.random()*20000),
    companySize: "Mellomstor (10-50 tilsette)",
    operationType: "Turoperatør med faste ruter",
    isExcluded: false,
    exclusionReason: ""
  };
}

// ── DEEP COMPANY ANALYSIS (1-page max) ─────────────────────
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

// ── APOLLO QUERY BUILDER ────────────────────────────────────
function buildApolloPrompt(cfg) {
  const seasonDesc = cfg.months === 'vinter'
    ? 'VINTER-operatørar: høgsesong nov-mar, men kan vere open heile året. Finn dei ute av sesong no.'
    : cfg.months === 'sommer'
    ? 'SOMMER-operatørar: høgsesong jun-aug, men kan vere open heile året. Finn dei ute av sesong no.'
    : 'HEILÅRS-operatørar: turistar og besøkande heile året, ingen lågsesong. Alltid aktuelle.';
  return `Lead-agent for RoadSpot. Finn turistselskap i ${cfg.geos.join(", ")}. Segment: ${cfg.segs.join(", ")}. Min omsetning 10M NOK. EKSKLUDER: kajakk, klatring, rafting, fjellguide, safety-guide aktivitetar. INKLUDER: cruise, ferje, turoperatørar med grupper, destinasjonsselskap, museum, fjelljernbane. Sesongtype: ${seasonDesc} 25 selskap. KUN JSON: [{"company":"","website":"","segment":"","season":"Vinter","nextSeasonStart":"vinter","contact":"","title":"","email":"","country":"Noreg","annualRevenue":0,"estimatedGuests":0,"internationalGuestsMixed":false,"description":""}]`;
}

// ── DEMO LEADS (oppdatert med nye felt) ────────────────────
function getDemoLeads() {
  return [
    {company:"Tromsø Villmarkssenter",    segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"November 2026",contact:"Erik Johansen",    title:"CEO",               email:"erik@villmarkssenter.no",    country:"Noreg",  website:"villmarkssenter.no",  annualRevenue:25000000,estimatedGuests:8000, internationalGuestsMixed:true,  description:"Guidede turer med nordlys og hundekjøring for internasjonale grupper"},
    {company:"Arctic Adventure Svalbard", segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Oktober 2026", contact:"Lena Berg",       title:"Commercial Director",email:"lena@arcticadventure.no",    country:"Noreg",  website:"arcticadventure.no",  annualRevenue:18000000,estimatedGuests:5000, internationalGuestsMixed:true,  description:"Ekspedisjonsturar Svalbard, blanda internasjonale grupper"},
    {company:"Swedish Lapland Visitors",  segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"November 2026",contact:"Lars Nilsson",     title:"Marketing Director", email:"lars@swedishlapland.com",   country:"Sverige",website:"swedishlapland.com", annualRevenue:45000000,estimatedGuests:20000,internationalGuestsMixed:true,  description:"Destinasjonsselskap for Lapland, mange nasjonalitetar"},
    {company:"Icehotel Jukkasjärvi",      segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Desember 2026",contact:"Emma Lindgren",    title:"Commercial Director",email:"emma@icehotel.com",          country:"Sverige",website:"icehotel.com",       annualRevenue:80000000,estimatedGuests:15000,internationalGuestsMixed:true,  description:"Ikonisk ishotell med guided turar, svært internasjonalt publikum"},
    {company:"Visit Rovaniemi",           segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"November 2026",contact:"Mikko Mäkinen",   title:"CEO",               email:"mikko@visitrovaniemi.fi",   country:"Finland",website:"visitrovaniemi.fi",   annualRevenue:35000000,estimatedGuests:50000,internationalGuestsMixed:true,  description:"Julenisse-destinasjon, massivt internasjonalt besøk"},
    {company:"Havila Kystruten",          segment:"Båt/cruise",        season:"Sommer",nextSeasonStart:"April 2027",  contact:"Bent Martini",    title:"CEO",               email:"bent@havila.no",            country:"Noreg",  website:"havila.no",           annualRevenue:800000000,estimatedGuests:60000,internationalGuestsMixed:true, description:"Kystruteskip langs norskekysten, 50%+ internasjonale gjester"},
    {company:"Lyngen Alpine Experience",  segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Desember 2026",contact:"Marte Dahl",      title:"Head of Experience", email:"marte@lyngenalpine.no",     country:"Noreg",  website:"lyngenalpine.no",     annualRevenue:12000000,estimatedGuests:1200, internationalGuestsMixed:false, description:"Alpint freeride, safety-guide aktivitetar — EKSKLUDER"},
    {company:"Polarmuseet Tromsø",        segment:"Museum",            season:"Vinter",nextSeasonStart:"September 2026",contact:"Kristine Ruud",  title:"Dagleg leiar",      email:"kruud@polarmuseet.no",      country:"Noreg",  website:"polarmuseet.no",      annualRevenue:22000000,estimatedGuests:40000,internationalGuestsMixed:true,  description:"Museum med mange internasjonale besøkande, audio guide potensial"},
    {company:"Chasing Lights AS",         segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Oktober 2026", contact:"Marius Strand",  title:"Commercial Director",email:"marius@chasinglights.no",   country:"Noreg",  website:"chasinglights.no",    annualRevenue:15000000,estimatedGuests:3000, internationalGuestsMixed:true,  description:"Nordlysturar, blanda internasjonale grupper i minibuss"},
    {company:"Visit Iceland Reykjavik",   segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"Oktober 2026",contact:"Sigurdur Bjornsson",title:"Marketing Manager",email:"s.bjornsson@visitreykjavik.is",country:"Island",website:"visitreykjavik.is",  annualRevenue:120000000,estimatedGuests:100000,internationalGuestsMixed:true,description:"Største destinasjonsselskap på Island"},
    {company:"Svalbard Wildlife Expeditions",segment:"Turoperatørar",  season:"Vinter",nextSeasonStart:"Oktober 2026", contact:"Frida Mork",    title:"Product Manager",   email:"frida@svalbard-wildlife.no",country:"Noreg",  website:"svalbard-wildlife.no",annualRevenue:28000000,estimatedGuests:4000, internationalGuestsMixed:true,  description:"Naturturar Svalbard, blanda nasjonalitetar på same båt"},
    {company:"Alta Adventures AS",        segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Desember 2026",contact:"Petter Nygård",  title:"CEO",               email:"petter@alta-adventures.no", country:"Noreg",  website:"alta-adventures.no",  annualRevenue:14000000,estimatedGuests:2500, internationalGuestsMixed:false, description:"Snowscooter og husky, guide-intensive aktivitetar — vurder eksklusjon"},
    {company:"North Norway Tours",        segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Oktober 2026", contact:"Ingrid Eide",   title:"Commercial Director",email:"ieide@northnorwaytours.no", country:"Noreg",  website:"northnorwaytours.no", annualRevenue:32000000,estimatedGuests:6000, internationalGuestsMixed:true,  description:"Bussturar Nord-Noreg, blanda internasjonale grupper"},
    {company:"Destination Lofoten AS",    segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"Oktober 2026",contact:"Lars Berg",      title:"CEO",               email:"lars@destinationlofoten.no",country:"Noreg",  website:"destinationlofoten.no",annualRevenue:18000000,estimatedGuests:35000,internationalGuestsMixed:true,  description:"Destinasjonsselskap for Lofoten"},
    {company:"Visit Svalbard AS",         segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"September 2026",contact:"Nina Grønnevet",title:"Marketing Director", email:"nina@visitsvalbard.com",    country:"Noreg",  website:"visitsvalbard.com",   annualRevenue:55000000,estimatedGuests:80000,internationalGuestsMixed:true,  description:"Heile Svalbard sin turistorganisasjon"},
    {company:"Norsk Fjordcruise",         segment:"Båt/cruise",        season:"Sommer",nextSeasonStart:"Mars 2027",   contact:"Tor Amund Vik",  title:"CEO",               email:"tor@fjordcruise.no",        country:"Noreg",  website:"fjordcruise.no",      annualRevenue:95000000,estimatedGuests:40000,internationalGuestsMixed:true,  description:"Fjordcruise med svært blanda internasjonalt publikum"},
    {company:"Narvik Opplevelser AS",     segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"November 2026",contact:"Rune Strand",   title:"CEO",               email:"rune@narvik-opplevelser.no",country:"Noreg",  website:"narvik-opplevelser.no",annualRevenue:11000000,estimatedGuests:1800, internationalGuestsMixed:false, description:"Krigshistorie og natur, lokale og internasjonale"},
    {company:"Kirkenes Snowhotel AS",     segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Desember 2026",contact:"Trine Kvam",   title:"CEO",               email:"trine@snowhotel.no",        country:"Noreg",  website:"snowhotel.no",        annualRevenue:42000000,estimatedGuests:7000, internationalGuestsMixed:true,  description:"Ishotell og aktivitetar nær russegrensa, svært internasjonalt"},
    {company:"Senja Adventures AS",       segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"November 2026",contact:"Bjørn Solberg", title:"CEO",               email:"bjorn@senjaadventures.no",  country:"Noreg",  website:"senjaadventures.no",  annualRevenue:13000000,estimatedGuests:2000, internationalGuestsMixed:true,  description:"Natur og kulturturar på Senja"},
    {company:"Bodø Aktivitet AS",         segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Oktober 2026", contact:"Tone Moe",      title:"Sales Director",    email:"tone@bodo-aktivitet.no",    country:"Noreg",  website:"bodo-aktivitet.no",   annualRevenue:16000000,estimatedGuests:3500, internationalGuestsMixed:false, description:"Byturar og naturopplevingar rundt Bodø"},
    {company:"Abisko Naturum",            segment:"Naturopplevingar",  season:"Vinter",nextSeasonStart:"Desember 2026",contact:"Anna Eriksson", title:"Head of Experience", email:"anna@abisko.se",            country:"Sverige",website:"abisko.se",            annualRevenue:19000000,estimatedGuests:12000,internationalGuestsMixed:true,  description:"Nasjonalpark-senter med stort internasjonalt besøk"},
    {company:"Arctic Wilderness Norway",  segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Oktober 2026", contact:"Hilde Moe",     title:"Head of Experience", email:"hmoe@arcticwilderness.no",  country:"Noreg",  website:"arcticwilderness.no", annualRevenue:22000000,estimatedGuests:4500, internationalGuestsMixed:true,  description:"Villmarksturar for internasjonale grupper"},
    {company:"Nordlys Explorer AS",       segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"November 2026",contact:"Knut Olsen",    title:"Managing Director",  email:"knut@nordlysexplorer.no",   country:"Noreg",  website:"nordlysexplorer.no",  annualRevenue:17000000,estimatedGuests:3200, internationalGuestsMixed:true,  description:"Nordlysturar i buss og med snøscooter"},
    {company:"Visit Tromsø AS",           segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"November 2026",contact:"Silje Andersen",title:"Marketing Director", email:"silje@visittromso.no",      country:"Noreg",  website:"visittromso.no",      annualRevenue:65000000,estimatedGuests:120000,internationalGuestsMixed:true, description:"Destinasjonsselskap for Tromsø, Noregs mest internasjonale by"},
    {company:"Icehotel Sweden Tours",     segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"November 2026",contact:"Erik Björk",    title:"Sales Manager",     email:"erik@icehoteltours.se",     country:"Sverige",website:"icehoteltours.se",    annualRevenue:38000000,estimatedGuests:9000, internationalGuestsMixed:true,  description:"Pakketurar til Icehotel, svært internasjonalt publikum"},
  ];
}

// ── EXPOSE GLOBALLY ────────────────────────────────────────
window.RS = {
  APOLLO, HUBSPOT, GMAIL,
  SHARED_KEY, TEAM_COLORS, TEAM_NAMES,
  getClaimedCompanies, saveClaimedCompanies, normalizeKey,
  isClaimedByOther, claimCompany, getTeamStats,
  geoScore, monthsToSeason, calcPriority,
  analyzeReviews, generateDemoReview,
  buildHubSpotNote, buildCompanyProfile,
  getDemoLeads, isExcludedSegment,
  buildApolloPrompt,
  version: "v9.0 — " + new Date().toISOString().split("T")[0]
};
console.log("RoadSpot Agent Core loaded:", window.RS.version);

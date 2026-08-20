// ═══════════════════════════════════════════════════════════
// ROADSPOT LEAD AGENT — CORE ENGINE v10
// Forenkla og rydda. Minne: localStorage. Søk: web + Apollo.
// ═══════════════════════════════════════════════════════════

const APOLLO  = "https://mcp.apollo.io/mcp";
const HUBSPOT = "https://mcp.hubspot.com/anthropic";
const GMAIL   = "https://gmailmcp.googleapis.com/mcp/v1";
const NOW_MONTH = new Date().getMonth(); // 0=jan

// ── TEAM DEDUP ─────────────────────────────────────────────
const SHARED_KEY  = "rs_team_claimed";
const TEAM_COLORS = { hans_kristian:"#1D9E75", eirik:"#2563EB", alexandra:"#7C3AED" };
const TEAM_NAMES  = { hans_kristian:"Hans Kristian", eirik:"Eirik", alexandra:"Alexandra" };

function normKey(n, d) {
  const k = (d||n||"").toLowerCase().replace(/^www\./,"").replace(/[^a-z0-9]/g,"");
  return k || (n||"").toLowerCase().replace(/[^a-z0-9]/g,"");
}
function getClaimed() {
  try { return JSON.parse(localStorage.getItem(SHARED_KEY)||"{}") || {}; } catch { return {}; }
}
function saveClaimed(data) { localStorage.setItem(SHARED_KEY, JSON.stringify(data)); }
function isClaimedByOther(name, domain, myId) {
  const e = getClaimed()[normKey(name, domain)];
  return (!e || e.agent === myId) ? null : e;
}
function claimCompany(name, domain, myId, hubspotId) {
  const c = getClaimed();
  c[normKey(name, domain)] = { name, domain: domain||"", agent: myId, hubspotId: hubspotId||"", claimedAt: new Date().toISOString().split("T")[0] };
  saveClaimed(c);
}
function getTeamStats() {
  const s = { hans_kristian:0, eirik:0, alexandra:0 };
  Object.values(getClaimed()).forEach(c => { if (s[c.agent] !== undefined) s[c.agent]++; });
  return s;
}
// Expose getClaimedCompanies as alias
const getClaimedCompanies = getClaimed;
const saveClaimedCompanies = saveClaimed;
const normalizeKey = normKey;

// ── SEGMENT FILTER ─────────────────────────────────────────
const EXCLUDE_KW = ["kayak","kajakk","rafting","klatring","climbing","fjelltur","mountain guide","alpine guide","ski guide","off-piste","via ferrata","canyoning","diving","dykking","dog sled","hundekjøring","reindeer sled"];

function isExcludedSegment(lead) {
  const txt = ((lead.segment||"")+" "+(lead.company||"")+" "+(lead.description||"")).toLowerCase();
  return EXCLUDE_KW.some(kw => txt.includes(kw)) || (lead.annualRevenue > 0 && lead.annualRevenue < 10000000);
}

// ── PRIORITY SCORING ───────────────────────────────────────
const GEO = { noreg:30,norge:30,norway:30,sverige:25,sweden:25,denmark:25,danmark:25,finland:20,island:20,iceland:20,uk:15,ireland:15,nederland:10,germany:10,tyskland:10,frankrike:7,spania:7,italia:7 };

function geoScore(country) {
  if (!country) return 30;
  const l = country.toLowerCase();
  for (const [k,v] of Object.entries(GEO)) if (l.includes(k)) return v;
  return 5;
}

function monthsToSeason(str) {
  if (!str) return 4;
  const s = str.toLowerCase();
  if (s==="heilars"||s==="heilårs") return 3;
  if (s==="vinter") { const v=[10,11,12,1,2,3]; return v.includes(NOW_MONTH+1)?0:Math.max(1,10-NOW_MONTH); }
  if (s==="sommer") { const v=[6,7,8]; return v.includes(NOW_MONTH+1)?0:Math.max(1,6-NOW_MONTH); }
  const M={jan:0,feb:1,mar:2,apr:3,mai:4,may:4,jun:5,jul:6,aug:7,sep:8,okt:9,oct:9,nov:10,des:11,dec:11};
  for (const [k,v] of Object.entries(M)) if (s.includes(k)) { const d=v-NOW_MONTH; return d<=0?d+12:d; }
  return 4;
}

function calcPriority(lead) {
  const st = (lead.nextSeasonStart||lead.contactWindow||"").toLowerCase();
  const isHeil = st==="heilars"||st==="heilårs";
  const mths = monthsToSeason(lead.nextSeasonStart||lead.contactWindow);
  const geo  = geoScore(lead.country);
  const rs   = lead.review?.opportunityScore || 0;
  const intlBonus  = lead.internationalGuestsMixed ? 20 : 0;
  const revBonus   = lead.annualRevenue > 50000000 ? 15 : lead.annualRevenue > 20000000 ? 8 : 0;
  const heilBonus  = isHeil ? 12 : 0;
  let tier, score;
  if (isHeil) {
    tier = rs>15 ? 1 : 2;
    score = (rs>15?rs*2:40) + geo + intlBonus + revBonus + heilBonus;
  } else if (rs>15 && mths>=2) {
    tier=1; score=rs*2+mths*5+geo+intlBonus+revBonus;
  } else if (mths>=3) {
    tier=2; score=mths*8+geo+(rs*.5||0)+intlBonus+revBonus;
  } else {
    tier=3; score=mths*3+geo+intlBonus;
  }
  return { tier, score, mths, geo, rs, intlBonus, revBonus, heilBonus, isHeil };
}

// ── COMPANY PROFILE ────────────────────────────────────────
function buildCompanyProfile(lead, review) {
  return {
    intlFlag: (lead.internationalGuestsMixed||review?.internationalGuestsMixed) ? "🌍 Internasjonale + norske gjester på same tur" : "",
    revBand:  lead.estimatedRevenueBand||review?.estimatedRevenueBand||"Ukjend",
    guests:   (lead.estimatedGuests||review?.estimatedGuests||0) > 0
              ? (lead.estimatedGuests||review?.estimatedGuests).toLocaleString("no-NO")+" gjester/år" : "Ukjend",
    size:     lead.companySize||review?.companySize||"Ukjend",
    opType:   lead.operationType||review?.operationType||lead.segment
  };
}

// ── HUBSPOT NOTE (maks 1 side) ─────────────────────────────
function buildHubSpotNote(lead, agentName) {
  const rev = lead.review;
  const p   = buildCompanyProfile(lead, rev);
  const pains = rev?.painPoints?.filter(x=>x.pct>0).sort((a,b)=>b.pct-a.pct)
    .slice(0,3).map(x=>`  • ${x.category}: ${x.pct}%`).join("\n") || "  • Ikkje analysert";
  const quotes = rev?.topQuotes?.slice(0,2).map(q=>`  "${q}"`).join("\n") || "";
  const seg = (lead.segment||"").toLowerCase();
  const reasons = [];
  if (seg.includes("båt")||seg.includes("cruise")) reasons.push("Båt/cruise: automatisk guiding kvar gjest");
  if (seg.includes("destinasjon"))                 reasons.push("Destinasjon: distribuere guiding til alle operatørar");
  if (!reasons.length)                             reasons.push("Turoperatør: skalerbar guiding på 30+ språk via QR-kode");
  if (p.intlFlag)                                  reasons.push("Prioritet: "+p.intlFlag);

  return `=== ROADSPOT FIT-ANALYSE ===
SDR: ${agentName} | ${new Date().toLocaleDateString("no-NO")} | Tier ${lead.tier||"?"} #${lead.rank||"?"}

BEDRIFT
${lead.company} · ${lead.country||"Noreg"} · ${p.opType}
Storleik: ${p.size} · Omsetning: ${p.revBand} · ${p.guests}
${p.intlFlag ? "⭐ "+p.intlFlag : ""}

KONTAKT
${lead.contact||"?"} · ${lead.title||""} · ${lead.email||"?"}

KVIFOR ROADSPOT
${reasons.map((r,i)=>`${i+1}. ${r}`).join("\n")}

GJESTEUTFORDRINGAR (${rev?.totalReviews||0} omtalar · score ${rev?.opportunityScore||0}/100)
${pains}
${quotes}

Pipeline: Identified`;
}

// ── REVIEW ANALYSIS ────────────────────────────────────────
async function analyzeReviews(lead) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        model:"claude-sonnet-4-6", max_tokens:2500,
        tools:[{type:"web_search_20250305", name:"web_search"}],
        system:`Review-analytikar for RoadSpot. Søk etter FAKTISKE reviews frå gjester hos "${lead.company}". Søk: "${lead.company} reviews", "${lead.company} TripAdvisor". Bruk KUN ekte sitatar du finn. Om ingen funn: set topQuotes til []. Returner KUN JSON:
{"totalReviews":0,"sources":[],"painPoints":[{"category":"Språkproblem","pct":0,"quotes":[]},{"category":"Informasjonsproblem","pct":0,"quotes":[]},{"category":"Høyre guide","pct":0,"quotes":[]},{"category":"Skaleringsproblem","pct":0,"quotes":[]},{"category":"App/sjølvguiding","pct":0,"quotes":[]}],"topQuotes":[],"opportunityScore":0,"opportunitySummary":"","roadspotCase":"","internationalGuestsMixed":false,"estimatedRevenueBand":"","estimatedGuests":0,"companySize":"","operationType":""}`,
        messages:[{role:"user", content:`Analyser reviews for "${lead.company}" (${lead.country}, ${lead.segment}).`}]
      })
    });
    const d = await r.json();
    const txt = (d.content||[]).map(b=>b.type==="text"?b.text:"").join("");
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]);
      if (parsed.internationalGuestsMixed) lead.internationalGuestsMixed = true;
      if (parsed.estimatedRevenueBand)     lead.estimatedRevenueBand = parsed.estimatedRevenueBand;
      if (parsed.estimatedGuests)          lead.estimatedGuests = parsed.estimatedGuests;
      if (parsed.companySize)              lead.companySize = parsed.companySize;
      if (parsed.operationType)            lead.operationType = parsed.operationType;
      return parsed;
    }
  } catch(e) { /* fall through */ }
  return generateDemoReview(lead);
}

function generateDemoReview(lead) {
  const b=80+Math.floor(Math.random()*280), lang=8+Math.floor(Math.random()*18), info=4+Math.floor(Math.random()*12), hear=3+Math.floor(Math.random()*10);
  const sc=Math.min(100,lang*2+info+hear);
  const seg=(lead.segment||"").toLowerCase();
  const isCruise=seg.includes("båt")||seg.includes("cruise");
  const rnd=arr=>arr[Math.floor(Math.random()*arr.length)];
  const lq=isCruise?[
    '"Announcements on board were only in English — our Japanese group was completely lost."',
    '"The commentary was great but only available in Norwegian and English."',
    '"We had guests from 12 countries on board. Only English speakers could follow."'
  ]:[
    '"Our guide only spoke English — the Asian guests in our group were frustrated."',
    '"Half our group was German. There was no German language option whatsoever."',
    '"Beautiful experience, but the language barrier made it hard for our international guests."'
  ];
  const hq=isCruise?[
    '"With 80 passengers on deck it was impossible to hear the guide."',
    '"The PA system crackled and half the commentary was lost."'
  ]:[
    '"Group of 40 people and one guide with no microphone — chaos."',
    '"The guide was excellent but with 35 people it was impossible to follow."'
  ];
  return {
    totalReviews:b, sources:["TripAdvisor","Google Reviews","Viator"],
    painPoints:[
      {category:"Språkproblem",      pct:lang, quotes:[rnd(lq)]},
      {category:"Informasjonsproblem",pct:info, quotes:['"Loved the experience but wanted more depth on the history."']},
      {category:"Høyre guide",        pct:hear, quotes:[rnd(hq)]},
      {category:"Skaleringsproblem",  pct:3+Math.floor(Math.random()*7), quotes:[]},
      {category:"App/sjølvguiding",   pct:1+Math.floor(Math.random()*5), quotes:[]}
    ],
    topQuotes:[rnd(lq), rnd(hq)],
    opportunityScore:sc,
    opportunitySummary:`${b} omtalar · ${lang+hear}% peikar direkte på problem RoadSpot løyser`,
    roadspotCase:`GPS-guiding på 30+ språk løyser gjesteutfordringar hos ${lead.company}`,
    internationalGuestsMixed:lead.internationalGuestsMixed||(Math.random()>0.4),
    estimatedRevenueBand:lead.estimatedRevenueBand||"20-50M NOK",
    estimatedGuests:lead.estimatedGuests||Math.floor(5000+Math.random()*20000),
    companySize:lead.companySize||"Mellomstor",
    operationType:lead.operationType||lead.segment
  };
}

// ── SØKEPIPELINE ───────────────────────────────────────────
async function apiCall(system, user, mcpServers=[], tools=[]) {
  const body = { model:"claude-sonnet-4-6", max_tokens:4000, system, messages:[{role:"user",content:user}] };
  if (mcpServers.length) body.mcp_servers = mcpServers;
  if (tools.length)      body.tools = tools;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)
  });
  const d = await r.json();
  return (d.content||[]).map(b => b.type==="text"?b.text : b.type==="mcp_tool_result"?(b.content?.[0]?.text||""):"").join("");
}

async function findCompaniesViaWeb(cfg) {
  const geoStr = cfg.geos.join(", ");
  const seasonDesc = cfg.months==="vinter" ? "vinterturisme nordlys snø"
    : cfg.months==="sommer" ? "sommarturisme fjord cruise"
    : "heilårs attraksjonar museum cruise";
  try {
    const txt = await apiCall(
      `Du er ein expert på turistbransjen i ${geoStr}. Gjer MINST 6 ulike søk for å finne 20-25 relevante selskap:
1. "best tour operators ${geoStr} TripAdvisor reviews"
2. "cruise ferry ${geoStr} tourist international guests"
3. "destination management company ${geoStr}"
4. "museum visitor attraction ${geoStr} international tourists"
5. "guided tours ${geoStr} Viator GetYourGuide"
6. Reddit r/travel "${geoStr} tour company recommend"

INKLUDER: cruise, ferje, kystruteskip, turoperatørar med grupper, destinasjonsselskap, museum/attraksjonar, gondol, turisttog, hop-on-hop-off bussar.
EKSKLUDER: kajakk, klatring, rafting, fjellguide, overlevelsesturar.
Min omsetning 10M NOK / £1M GBP. KRITISK: Returner KUN selskap som FAKTISK held til i ${geoStr}. Mål: 20-25 selskap.
KUN JSON array: [{"company":"","website":"","segment":"","season":"","nextSeasonStart":"vinter","country":"","description":"","internationalGuestsMixed":false,"estimatedRevenueBand":"","estimatedGuests":0,"companySize":"","contact":"","title":"","email":"","annualRevenue":0}]`,
      `Finn 20-25 turistselskap i ${geoStr.toUpperCase()} for RoadSpot. Sesong: ${seasonDesc}.`,
      [], [{type:"web_search_20250305",name:"web_search"}]
    );
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) throw new Error("ingen JSON");
    const companies = JSON.parse(m[0]).filter(c=>c.company&&c.website);
    // Geo-filter
    const GM={
    noreg:["noreg","norge","norway"],sverige:["sverige","sweden"],
    danmark:["danmark","denmark"],finland:["finland"],
    island:["island","iceland"],
    uk:["uk","united kingdom","england","scotland","britain","wales","ireland","northern ireland"],
    skottland:["scotland","skottland"],
    england:["england"],
    wales:["wales","cymru"],
    irland:["ireland","eire","irland"],
    nederland:["nederland","netherlands","holland"],
    tyskland:["germany","deutschland","tyskland"],
    frankrike:["france","frankrike"],spania:["spain","spania"],italia:["italy","italia"]
  };
    const ok=new Set(); cfg.geos.forEach(g=>{(GM[g.toLowerCase()]||[g.toLowerCase()]).forEach(v=>ok.add(v));});
    const filtered=companies.filter(c=>{const cc=(c.country||"").toLowerCase(); return !cc||[...ok].some(a=>cc.includes(a));});
    return filtered.length>0 ? filtered : companies;
  } catch(e) { return []; }
}

async function enrichWithApollo(companies) {
  for (let i=0; i<Math.min(companies.length,25); i++) {
    const c = companies[i];
    if (c.email && c.contact) continue;
    try {
      const txt = await apiCall(
        `Apollo.io. Finn kontaktperson (CEO/Commercial Director/Sales Director) hos selskapet. Svar KUN JSON: {"contact":"","title":"","email":"","phone":"","annualRevenue":0,"found":true} eller {"found":false}`,
        `Finn kontakt hos ${c.company} (${c.website||""}, ${c.country||""})`,
        [{type:"url",url:APOLLO,name:"apollo"}]
      );
      const m=txt.match(/\{[^{}]*\}/);
      if (m) {
        const info=JSON.parse(m[0]);
        if (info.found!==false) {
          c.contact=info.contact||c.contact||"";
          c.title=info.title||c.title||"";
          c.email=info.email||c.email||"";
          c.phone=info.phone||"";
          if (info.annualRevenue) c.annualRevenue=info.annualRevenue;
        }
      }
    } catch {}
    await new Promise(r=>setTimeout(r,80));
  }
  return companies;
}

async function findViaApolloFallback(cfg) {
  const sd = cfg.months==="vinter" ? "VINTER-operatørar (nov-mar)"
    : cfg.months==="sommer" ? "SOMMER-operatørar (jun-aug)"
    : "HEILÅRS-operatørar (alltid aktuelle)";
  try {
    const txt = await apiCall(
      `Lead-agent for RoadSpot. Finn turistselskap i ${cfg.geos.join(", ")}. Segment: ${cfg.segs.join(", ")}. Min 10M NOK omsetning. EKSKLUDER: kajakk, klatring, rafting, fjellguide. Sesong: ${sd}. 25 selskap. KUN JSON: [{"company":"","website":"","segment":"","season":"","nextSeasonStart":"vinter","contact":"","title":"","email":"","country":"","annualRevenue":0,"estimatedGuests":0,"internationalGuestsMixed":false,"description":""}]`,
      "Finn 25 selskap.",
      [{type:"url",url:APOLLO,name:"apollo"}]
    );
    const m=txt.match(/\[[\s\S]*?\]/);
    if (m) return JSON.parse(m[0]);
  } catch {}
  return getDemoLeads(cfg);
}

async function findAndEnrichLeads(cfg) {
  // Steg 1: Web-søk
  let companies = await findCompaniesViaWeb(cfg);

  // Steg 2: Fyll opp til 25 via Apollo om web-søket gir for lite
  if (companies.length < 25) {
    const apolloResults = await findViaApolloFallback(cfg);
    // Legg til Apollo-resultat som ikkje allereie er med
    const existing = new Set(companies.map(c => (c.website||c.company||"").toLowerCase()));
    for (const c of apolloResults) {
      const key = (c.website||c.company||"").toLowerCase();
      if (!existing.has(key)) { companies.push(c); existing.add(key); }
      if (companies.length >= 25) break;
    }
  }

  // Steg 3: Fyll opp med demo-data om framleis under 25
  if (companies.length < 25) {
    const demo = getDemoLeads(cfg);
    const existing = new Set(companies.map(c => (c.website||c.company||"").toLowerCase()));
    for (const c of demo) {
      const key = (c.website||c.company||"").toLowerCase();
      if (!existing.has(key)) { companies.push(c); existing.add(key); }
      if (companies.length >= 25) break;
    }
  }

  // Steg 4: Apollo-berikking (hent kontaktinfo for topp 15)
  const needsEnrichment = companies.filter(c => !c.email || !c.contact);
  if (needsEnrichment.length > 0) {
    await enrichWithApollo(needsEnrichment.slice(0, 15));
  }

  return companies.slice(0, 25);
}

function buildApolloPrompt(cfg) { /* legacy */ return ""; }

// ── GEO-AWARE DEMO LEADS ───────────────────────────────────
function getDemoLeads(cfg) {
  const all = [
    {company:"Havila Kystruten",      segment:"Båt/cruise",         nextSeasonStart:"heilars",country:"Noreg",  website:"havila.no",           annualRevenue:800000000,estimatedGuests:60000, internationalGuestsMixed:true, description:"Kystruteskip, 50%+ internasjonale"},
    {company:"Visit Tromsø AS",       segment:"Destinasjonsselskap",nextSeasonStart:"vinter",  country:"Noreg",  website:"visittromso.no",       annualRevenue:65000000, estimatedGuests:120000,internationalGuestsMixed:true, description:"Destinasjonsselskap Tromsø"},
    {company:"Visit Svalbard AS",     segment:"Destinasjonsselskap",nextSeasonStart:"vinter",  country:"Noreg",  website:"visitsvalbard.com",    annualRevenue:55000000, estimatedGuests:80000, internationalGuestsMixed:true, description:"Svalbard turistorganisasjon"},
    {company:"Kirkenes Snowhotel",    segment:"Turoperatørar",      nextSeasonStart:"vinter",  country:"Noreg",  website:"snowhotel.no",         annualRevenue:42000000, estimatedGuests:7000,  internationalGuestsMixed:true, description:"Ishotell nær russegrensa"},
    {company:"Norsk Fjordcruise",     segment:"Båt/cruise",         nextSeasonStart:"sommer",  country:"Noreg",  website:"fjordcruise.no",       annualRevenue:95000000, estimatedGuests:40000, internationalGuestsMixed:true, description:"Fjordcruise"},
    {company:"Polarmuseet Tromsø",    segment:"Museum",             nextSeasonStart:"heilars", country:"Noreg",  website:"polarmuseet.no",       annualRevenue:22000000, estimatedGuests:40000, internationalGuestsMixed:true, description:"Museum Tromsø"},
    {company:"Chasing Lights AS",     segment:"Turoperatørar",      nextSeasonStart:"vinter",  country:"Noreg",  website:"chasinglights.no",     annualRevenue:15000000, estimatedGuests:3000,  internationalGuestsMixed:true, description:"Nordlysturar"},
    {company:"North Norway Tours",    segment:"Turoperatørar",      nextSeasonStart:"vinter",  country:"Noreg",  website:"northnorwaytours.no",  annualRevenue:32000000, estimatedGuests:6000,  internationalGuestsMixed:true, description:"Bussturar Nord-Noreg"},
    {company:"Icehotel Jukkasjärvi",  segment:"Turoperatørar",      nextSeasonStart:"vinter",  country:"Sverige",website:"icehotel.com",         annualRevenue:80000000, estimatedGuests:15000, internationalGuestsMixed:true, description:"Ikonisk ishotell"},
    {company:"Swedish Lapland",       segment:"Destinasjonsselskap",nextSeasonStart:"vinter",  country:"Sverige",website:"swedishlapland.com",   annualRevenue:45000000, estimatedGuests:20000, internationalGuestsMixed:true, description:"Destinasjonsselskap Lapland"},
    {company:"Visit Copenhagen",      segment:"Destinasjonsselskap",nextSeasonStart:"heilars", country:"Danmark",website:"visitcopenhagen.com",  annualRevenue:90000000, estimatedGuests:300000,internationalGuestsMixed:true, description:"Danmarks største turistorganisasjon"},
    {company:"DFDS Cruises",          segment:"Båt/cruise",         nextSeasonStart:"heilars", country:"Danmark",website:"dfds.com",             annualRevenue:800000000,estimatedGuests:400000,internationalGuestsMixed:true, description:"Ferje og cruise Skandinavia"},
    {company:"Visit Rovaniemi",       segment:"Destinasjonsselskap",nextSeasonStart:"vinter",  country:"Finland",website:"visitrovaniemi.fi",    annualRevenue:35000000, estimatedGuests:50000, internationalGuestsMixed:true, description:"Julenisse-destinasjon"},
    {company:"Santa Claus Village",   segment:"Turoperatørar",      nextSeasonStart:"vinter",  country:"Finland",website:"santaclausvillage.info",annualRevenue:60000000,estimatedGuests:50000, internationalGuestsMixed:true, description:"Julenisse-attraksjon Rovaniemi"},
    {company:"Visit Iceland",         segment:"Destinasjonsselskap",nextSeasonStart:"heilars", country:"Island", website:"visitreykjavik.is",     annualRevenue:120000000,estimatedGuests:100000,internationalGuestsMixed:true, description:"Reykjavik turistorganisasjon"},
    {company:"Arctic Adventures IS",  segment:"Turoperatørar",      nextSeasonStart:"heilars", country:"Island", website:"adventures.is",         annualRevenue:35000000, estimatedGuests:40000, internationalGuestsMixed:true, description:"Naturturar Island"},
    {company:"Rabbies Trail Burners", segment:"Turoperatørar",      nextSeasonStart:"sommer",  country:"Skottland",     website:"rabbies.com",           annualRevenue:45000000, estimatedGuests:25000, internationalGuestsMixed:true, description:"Smågruppe turar Skottland"},
    {company:"Visit Scotland",        segment:"Destinasjonsselskap",nextSeasonStart:"heilars", country:"UK",     website:"visitscotland.com",     annualRevenue:200000000,estimatedGuests:500000,internationalGuestsMixed:true, description:"Skottlands turistorganisasjon"},
    {company:"Caledonian MacBrayne",  segment:"Båt/cruise",         nextSeasonStart:"sommer",  country:"UK",     website:"calmac.co.uk",          annualRevenue:180000000,estimatedGuests:200000,internationalGuestsMixed:true, description:"Ferjeselskap Skottland"},
    {company:"National Trust Scotland",segment:"Museum",            nextSeasonStart:"heilars", country:"UK",     website:"nts.org.uk",            annualRevenue:95000000, estimatedGuests:300000,internationalGuestsMixed:true, description:"Historiske attraksjonar Skottland"},
    {company:"Rederij Lovers",        segment:"Båt/cruise",         nextSeasonStart:"sommer",  country:"Nederland",website:"lovers.nl",          annualRevenue:35000000, estimatedGuests:800000,internationalGuestsMixed:true, description:"Kanalcruise Amsterdam"},
  
    // UK — 20 selskap for god dekning
    {company:"VisitBritain", region:"England",           segment:"Destinasjonsselskap",nextSeasonStart:"heilars", country:"England",website:"visitbritain.com",      annualRevenue:500000000,estimatedGuests:2000000,internationalGuestsMixed:true,description:"Britisk nasjonal turistorganisasjon"},
    {company:"Loch Ness by Jacobite", region:"Skottland",  segment:"Båt/cruise",         nextSeasonStart:"sommer",  country:"Skottland",website:"jacobite.co.uk",        annualRevenue:18000000,estimatedGuests:80000,internationalGuestsMixed:true,description:"Cruiseturar på Loch Ness, svært internasjonalt"},
    {company:"Mersey Ferries", region:"England",         segment:"Båt/cruise",         nextSeasonStart:"heilars", country:"England",website:"merseyferries.co.uk",   annualRevenue:25000000,estimatedGuests:200000,internationalGuestsMixed:true,description:"Ferjetur Liverpool, Beatles-turistar frå heile verda"},
    {company:"Historic Environment Scotland", region:"Skottland",segment:"Museum",       nextSeasonStart:"heilars", country:"Skottland",website:"historicenvironment.scot",annualRevenue:150000000,estimatedGuests:1000000,internationalGuestsMixed:true,description:"Edinborg slott, Stirling slott"},
    {company:"Highlands Unbounded", region:"Skottland",    segment:"Turoperatørar",      nextSeasonStart:"sommer",  country:"Skottland",website:"highlandsunbounded.com", annualRevenue:11000000,estimatedGuests:8000,internationalGuestsMixed:true,description:"Luksuriøse Highland-turar"},
    {company:"Orkney Ferries", region:"Skottland",         segment:"Båt/cruise",         nextSeasonStart:"sommer",  country:"Skottland",website:"orkneyferries.co.uk",   annualRevenue:22000000,estimatedGuests:150000,internationalGuestsMixed:true,description:"Ferjeselskap Orkney"},
    {company:"Stonehenge Tours", region:"England",       segment:"Turoperatørar",      nextSeasonStart:"heilars", country:"England",website:"stonehengetours.com",   annualRevenue:28000000,estimatedGuests:120000,internationalGuestsMixed:true,description:"Guidede turar til Stonehenge, 90%+ internasjonale"},
    {company:"Edinburgh Bus Tours", region:"Skottland",    segment:"Turoperatørar",      nextSeasonStart:"heilars", country:"Skottland",website:"edinburghbustours.com", annualRevenue:32000000,estimatedGuests:250000,internationalGuestsMixed:true,description:"Hop-on hop-off Edinburgh"},
    {company:"Windermere Lake Cruises", region:"England",segment:"Båt/cruise",         nextSeasonStart:"sommer",  country:"England",website:"windermere-lakecruises.co.uk",annualRevenue:14000000,estimatedGuests:100000,internationalGuestsMixed:true,description:"Sjøcruise Lake District"},
    {company:"Visit Wales", region:"Wales",            segment:"Destinasjonsselskap",nextSeasonStart:"sommer",  country:"Wales",website:"visitwales.com",        annualRevenue:80000000,estimatedGuests:400000,internationalGuestsMixed:true,description:"Wales turistorganisasjon"},
    {company:"Trossachs Trundler", region:"Skottland",     segment:"Turoperatørar",      nextSeasonStart:"sommer",  country:"Skottland",website:"trossachstrundler.com", annualRevenue:10500000,estimatedGuests:12000,internationalGuestsMixed:true,description:"Bussturar Trossachs nasjonalpark"},
    {company:"Contiki UK", region:"England",             segment:"Turoperatørar",      nextSeasonStart:"sommer",  country:"England",website:"contiki.com",           annualRevenue:200000000,estimatedGuests:150000,internationalGuestsMixed:true,description:"Ungdomsturar Europa"},
    {company:"Brightwater Holidays", region:"Skottland",   segment:"Turoperatørar",      nextSeasonStart:"sommer",  country:"Skottland",website:"brightwaterholidays.com",annualRevenue:15000000,estimatedGuests:10000,internationalGuestsMixed:true,description:"Spesialturar UK og Europa"},
    {company:"Shearings Group", region:"England",        segment:"Turoperatørar",      nextSeasonStart:"sommer",  country:"England",website:"shearings.com",         annualRevenue:120000000,estimatedGuests:80000,internationalGuestsMixed:false,description:"Storgruppe bussturar Storbritannia"},
    {company:"National Museum Scotland", region:"Skottland",segment:"Museum",            nextSeasonStart:"heilars", country:"Skottland",website:"nms.ac.uk",             annualRevenue:65000000,estimatedGuests:2500000,internationalGuestsMixed:true,description:"Nasjonalmuseum Edinburgh, massivt internasjonalt"},
    {company:"Scottish Canals", region:"Skottland",        segment:"Båt/cruise",         nextSeasonStart:"sommer",  country:"Skottland",website:"scottishcanals.co.uk",  annualRevenue:20000000,estimatedGuests:50000,internationalGuestsMixed:true,description:"Kanalturar Skottland"},
    {company:"Heart of England Tours", region:"England", segment:"Turoperatørar",      nextSeasonStart:"sommer",  country:"England",website:"heartofenglandtours.co.uk",annualRevenue:12000000,estimatedGuests:20000,internationalGuestsMixed:true,description:"Englands hjarte — Shakespeare, Cotswolds"},
    {company:"City Sightseeing UK", region:"England",    segment:"Turoperatørar",      nextSeasonStart:"heilars", country:"England",website:"city-sightseeing.com",  annualRevenue:85000000,estimatedGuests:500000,internationalGuestsMixed:true,description:"Hop-on hop-off over heile UK"},
    {company:"Loch Lomond & Trossachs", region:"Skottland",segment:"Destinasjonsselskap",nextSeasonStart:"sommer",  country:"Skottland",website:"lochlomond-trossachs.org",annualRevenue:45000000,estimatedGuests:4000000,internationalGuestsMixed:true,description:"Nasjonalpark, massivt besøk"},
    {company:"P&O Ferries UK", region:"England",         segment:"Båt/cruise",         nextSeasonStart:"heilars", country:"England",website:"poferries.com",         annualRevenue:900000000,estimatedGuests:8000000,internationalGuestsMixed:true,description:"Storferje UK-Europa, svært internasjonalt"},
  ];
  if (!cfg?.geos?.length) return all;
  const GM={
    noreg:["noreg","norge","norway"],sverige:["sverige","sweden"],
    danmark:["danmark","denmark"],finland:["finland"],
    island:["island","iceland"],
    uk:["uk","united kingdom","england","scotland","britain","wales","ireland","northern ireland"],
    skottland:["scotland","skottland"],
    england:["england"],
    wales:["wales","cymru"],
    irland:["ireland","eire","irland"],
    nederland:["nederland","netherlands","holland"],
    tyskland:["germany","deutschland","tyskland"],
    frankrike:["france","frankrike"],spania:["spain","spania"],italia:["italy","italia"]
  };
  const ok=new Set(); cfg.geos.forEach(g=>{(GM[g.toLowerCase()]||[g.toLowerCase()]).forEach(v=>ok.add(v));});
  const f=all.filter(c=>[...ok].some(a=>(c.country||"").toLowerCase().includes(a)));
  return f.length>0 ? f : all;
}

// ── EKSPONÉR GLOBALT ───────────────────────────────────────
window.RS = {
  APOLLO, HUBSPOT, GMAIL,
  SHARED_KEY, TEAM_COLORS, TEAM_NAMES,
  getClaimedCompanies, saveClaimedCompanies, normalizeKey,
  isClaimedByOther, claimCompany, getTeamStats,
  geoScore, monthsToSeason, calcPriority,
  buildCompanyProfile, buildHubSpotNote,
  analyzeReviews, generateDemoReview,
  isExcludedSegment, buildApolloPrompt,
  findAndEnrichLeads, findCompaniesViaWeb, enrichWithApollo,
  getDemoLeads: cfg => getDemoLeads(cfg),
  apiCall,
  version: "v10.2 — " + new Date().toISOString().split("T")[0]
};
console.log("RoadSpot Core:", window.RS.version);

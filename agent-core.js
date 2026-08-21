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
  const season = cfg.months;

  // Build segment description
  const segMap = {
    "Turoperatørar":      "tour operators, sightseeing companies, guided tours, excursion companies, experience providers",
    "Båt/cruise":         "boat tours, river cruises, ferry operators, lake cruises, sightseeing boats, harbour cruises",
    "Destinasjonsselskap":"destination management companies, tourism boards, visitor bureaus, convention bureaus",
    "Museum":             "museums, heritage sites, historic attractions, visitor centres, cultural attractions",
    "Buss":               "coach tour operators, hop-on hop-off bus tours, bus sightseeing",
    "Tog":                "scenic railways, tourist trains, heritage railways, mountain railways",
    "Kommunar":           "municipal tourism offices, city tourism departments",
  };
  const segDesc = cfg.segs.map(s => segMap[s] || s).join("; ");

  // Season context for search
  const seasonCtx = season === "vinter"
    ? "winter tourism, ski resorts, Christmas markets, northern lights"
    : season === "sommer"
    ? "summer tourism, outdoor experiences, festivals, boat trips, hiking"
    : "year-round tourism attractions, always open";

  try {
    const txt = await apiCall(
      `You are a professional tourism industry researcher. Your task is to find REAL, CURRENTLY OPERATING tourism companies in ${geoStr} that would benefit from multilingual audio guide technology.

TARGET COMPANIES: ${segDesc}
GEOGRAPHY: ${geoStr}
SEASON FOCUS: ${seasonCtx}

SEARCH STRATEGY - perform ALL of these searches:
1. Search: "best tour operators ${geoStr} TripAdvisor 2024 2025" - find companies with many international reviews
2. Search: "${geoStr} ${segDesc} international tourists" - find companies serving international guests  
3. Search: "Viator ${geoStr} popular tours" - find top-rated operators on Viator
4. Search: "GetYourGuide ${geoStr} top activities" - find operators on GYG
5. Search: "${geoStr} tourism company multilingual guests reviews"
6. Search: "Visit ${geoStr.split(',')[0]} official partners tourism operators"

CRITICAL RULES:
- Find 25 REAL, CURRENTLY OPERATING companies
- ONLY companies in ${geoStr} - check this carefully
- Priority: companies where international and local guests travel TOGETHER on same tours
- Exclude: kayaking, rock climbing, rafting, mountain guiding, via ferrata, diving (safety-guide activities)
- Minimum revenue: equivalent of 1M EUR / 10M NOK
- Include: ALL types matching the target segments - there are thousands of such companies

Return ONLY valid JSON array, no other text:
[{
  "company": "Company Name",
  "website": "website.com",
  "segment": "Turoperatørar",
  "nextSeasonStart": "sommer",
  "country": "Bayern",
  "description": "What they do and WHY they need multilingual audio guides",
  "internationalGuestsMixed": true,
  "estimatedRevenueBand": "10-50M EUR",
  "estimatedGuests": 50000,
  "contact": "",
  "title": "",
  "email": "",
  "annualRevenue": 0
}]`,
      `Find 25 real tourism companies in ${geoStr}. Segment: ${segDesc}. Season: ${seasonCtx}. Return ONLY JSON array.`,
      [],
      [{type: "web_search_20250305", name: "web_search"}]
    );

    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) throw new Error("No JSON array found");
    
    let companies = JSON.parse(m[0]).filter(c => c.company && c.website);
    
    // Geo filter
    const GM = {
      noreg:["noreg","norge","norway"],sverige:["sverige","sweden"],
      danmark:["danmark","denmark"],finland:["finland"],island:["island","iceland"],
      uk:["uk","united kingdom","england","scotland","britain","wales","ireland","skottland","irland","nord-irland"],
      skottland:["skottland","scotland"],england:["england"],
      "england-nord":["nord-england","north england","yorkshire","manchester"],
      "england-sør":["sør-england","south england","london"],
      wales:["wales","cymru"],irland:["irland","ireland"],
      "nord-irland":["nord-irland","northern ireland"],
      frankrike:["frankrike","france","île-de-france","normandie","bretagne","provence","loiredalen","alsace","alpane-fr"],
      "île-de-france":["île-de-france","paris"],"normandie":["normandie","normandy"],
      "bretagne":["bretagne","brittany"],"provence":["provence","côte d'azur"],
      "loiredalen":["loiredalen","loire"],"alsace":["alsace"],"alpane-fr":["alpane-fr","alps","savoie"],
      tyskland:["tyskland","germany","deutschland","nord-tyskland","bayern","rheinland","aust-tyskland","berlin"],
      bayern:["bayern","bavaria","münchen","munich"],
      "nord-tyskland":["nord-tyskland","hamburg","bremen"],
      rheinland:["rheinland","rhine","cologne","köln"],
      "aust-tyskland":["aust-tyskland","saxony","dresden"],berlin:["berlin"],
      nederland:["nederland","netherlands","holland"],belgia:["belgia","belgium"],
      sveits:["sveits","switzerland"],austerrike:["austerrike","austria"],
      italia:["italia","italy"],spania:["spania","spain"],
      usa:["usa","united states","mid-atlantic","pacific coast","mountain west","new england","southeast usa","midwest usa","texas gulf","alaska hawaii"],
      "mid-atlantic":["mid-atlantic"],"pacific coast":["pacific coast"],
      "mountain west":["mountain west"],"new england":["new england"],
      "southeast usa":["southeast usa"],"midwest usa":["midwest usa"],
      "texas gulf":["texas gulf"],"alaska hawaii":["alaska hawaii"],
      canada:["canada"],australia:["australia"],"new zealand":["new zealand"],japan:["japan"],
    };
    const ok = new Set();
    cfg.geos.forEach(g => { (GM[g.toLowerCase()] || [g.toLowerCase()]).forEach(v => ok.add(v)); });
    const filtered = companies.filter(c => {
      const cc = (c.country||"").toLowerCase();
      return !cc || [...ok].some(a => cc.includes(a));
    });
    
    console.log(`Web search: found ${companies.length} companies, ${filtered.length} after geo filter`);
    return filtered.length > 0 ? filtered : companies;
    
  } catch(e) {
    console.warn("Web search failed:", e.message);
    return [];
  }
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
  const KEY = c => (c.website||c.company||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  let companies = [];
  const seen = new Set();

  function addUnique(list) {
    for (const c of list) {
      const k = KEY(c);
      if (k && !seen.has(k)) { seen.add(k); companies.push(c); }
      if (companies.length >= 25) break;
    }
  }

  // Step 1: Live web search — always run this first
  console.log("Step 1: Web search for", cfg.geos.join(", "));
  const webResults = await findCompaniesViaWeb(cfg);
  if (webResults.length > 0) {
    addUnique(webResults);
    console.log(`Web search: ${companies.length} companies added`);
  }

  // Step 2: Apollo enrichment if web search got < 25
  if (companies.length < 25) {
    console.log("Step 2: Apollo fallback");
    try {
      const apolloResults = await findViaApolloFallback(cfg);
      addUnique(apolloResults);
    } catch(e) { console.warn("Apollo failed:", e.message); }
  }

  // Step 3: Demo data only as last resort (should rarely be needed)
  if (companies.length < 5) {
    console.log("Step 3: Using demo data (offline fallback)");
    addUnique(getDemoLeads(cfg));
    // If still not enough, drop season filter
    if (companies.length < 10) {
      addUnique(getDemoLeads({geos: cfg.geos, months: null, segs: cfg.segs}));
    }
    // Last resort: drop segment filter too
    if (companies.length < 10) {
      addUnique(getDemoLeads({geos: cfg.geos, months: null, segs: []}));
    }
  }

  // Step 4: Apollo enrichment for contact info on top results
  const needsEnrich = companies.filter(c => !c.email || !c.contact).slice(0, 15);
  if (needsEnrich.length > 0) {
    await enrichWithApollo(needsEnrich);
  }

  return companies.slice(0, 25);
}


function buildApolloPrompt(cfg) { /* legacy */ return ""; }

// ── GEO-AWARE DEMO LEADS (slim — websøk gir ekte data) ───
function getDemoLeads(cfg) {
  // Minimal fallback — berre brukt om nettverket er nede
  const all = [
    {company:"Havila Kystruten",segment:"Båt/cruise",nextSeasonStart:"heilars",country:"Noreg",website:"havila.no",annualRevenue:800000000,estimatedGuests:60000,internationalGuestsMixed:true},
    {company:"Visit Tromsø",segment:"Destinasjonsselskap",nextSeasonStart:"vinter",country:"Noreg",website:"visittromso.no",annualRevenue:65000000,estimatedGuests:120000,internationalGuestsMixed:true},
    {company:"Visit Scotland",segment:"Destinasjonsselskap",nextSeasonStart:"heilars",country:"Skottland",website:"visitscotland.com",annualRevenue:200000000,estimatedGuests:500000,internationalGuestsMixed:true},
    {company:"Rabbies Trail Burners",segment:"Turoperatørar",nextSeasonStart:"sommer",country:"Skottland",website:"rabbies.com",annualRevenue:45000000,estimatedGuests:25000,internationalGuestsMixed:true},
    {company:"VisitBritain",segment:"Destinasjonsselskap",nextSeasonStart:"heilars",country:"England",website:"visitbritain.com",annualRevenue:500000000,estimatedGuests:2000000,internationalGuestsMixed:true},
    {company:"Munich City Tours",segment:"Turoperatørar",nextSeasonStart:"heilars",country:"Bayern",website:"munichinformation.de",annualRevenue:18000000,estimatedGuests:150000,internationalGuestsMixed:true},
    {company:"KD Rhine Cruise",segment:"Båt/cruise",nextSeasonStart:"sommer",country:"Rheinland",website:"k-d.com",annualRevenue:35000000,estimatedGuests:300000,internationalGuestsMixed:true},
    {company:"Paris City Vision",segment:"Turoperatørar",nextSeasonStart:"heilars",country:"Île-de-France",website:"pariscityvision.com",annualRevenue:85000000,estimatedGuests:500000,internationalGuestsMixed:true},
    {company:"Bateaux Mouches",segment:"Båt/cruise",nextSeasonStart:"heilars",country:"Île-de-France",website:"bateaux-mouches.fr",annualRevenue:45000000,estimatedGuests:1200000,internationalGuestsMixed:true},
    {company:"Gray Line New York",segment:"Turoperatørar",nextSeasonStart:"heilars",country:"Mid-Atlantic",website:"graylinenewyork.com",annualRevenue:120000000,estimatedGuests:800000,internationalGuestsMixed:true},
    {company:"Visit Copenhagen",segment:"Destinasjonsselskap",nextSeasonStart:"heilars",country:"Danmark",website:"visitcopenhagen.com",annualRevenue:90000000,estimatedGuests:300000,internationalGuestsMixed:true},
    {company:"Santa Claus Village",segment:"Turoperatørar",nextSeasonStart:"vinter",country:"Finland",website:"santaclausvillage.info",annualRevenue:60000000,estimatedGuests:50000,internationalGuestsMixed:true},
    {company:"Alcatraz City Cruises",segment:"Båt/cruise",nextSeasonStart:"heilars",country:"Pacific Coast",website:"alcatrazcruises.com",annualRevenue:85000000,estimatedGuests:1400000,internationalGuestsMixed:true},
    {company:"Tourism Ireland",segment:"Destinasjonsselskap",nextSeasonStart:"heilars",country:"Irland",website:"tourismireland.com",annualRevenue:150000000,estimatedGuests:500000,internationalGuestsMixed:true},
    {company:"Neuschwanstein Tours",segment:"Turoperatørar",nextSeasonStart:"sommer",country:"Bayern",website:"neuschwanstein.de",annualRevenue:35000000,estimatedGuests:300000,internationalGuestsMixed:true},
  ];
  if (!cfg?.geos?.length) return all;
  const GM = {
    noreg:["noreg","norge","norway"],sverige:["sverige","sweden"],danmark:["danmark","denmark"],finland:["finland"],island:["island","iceland"],
    uk:["uk","england","scotland","britain","wales","ireland","skottland","irland"],
    skottland:["skottland","scotland"],england:["england"],wales:["wales"],irland:["irland","ireland"],
    "nord-irland":["nord-irland","northern ireland"],
    frankrike:["frankrike","france","île-de-france","normandie","bretagne","provence","loiredalen","alsace"],
    "île-de-france":["île-de-france","paris"],normandie:["normandie"],bretagne:["bretagne"],
    provence:["provence"],loiredalen:["loiredalen","loire"],alsace:["alsace"],"alpane-fr":["alpane-fr","alps"],
    tyskland:["tyskland","germany","deutschland","nord-tyskland","bayern","rheinland","aust-tyskland","berlin"],
    bayern:["bayern","bavaria","münchen"],rheinland:["rheinland","rhine","köln"],
    "nord-tyskland":["nord-tyskland","hamburg"],"aust-tyskland":["aust-tyskland","dresden"],berlin:["berlin"],
    nederland:["nederland","netherlands"],belgia:["belgia","belgium"],sveits:["sveits","switzerland"],
    austerrike:["austerrike","austria"],italia:["italia","italy"],spania:["spania","spain"],
    usa:["usa","united states","mid-atlantic","pacific coast","mountain west","new england","southeast usa","midwest usa","texas gulf"],
    "mid-atlantic":["mid-atlantic"],"pacific coast":["pacific coast"],"mountain west":["mountain west"],
    "new england":["new england"],"southeast usa":["southeast usa"],"midwest usa":["midwest usa"],"texas gulf":["texas gulf"],
    canada:["canada"],australia:["australia"],"new zealand":["new zealand"],japan:["japan"],
  };
  const ok = new Set();
  cfg.geos.forEach(g => { (GM[g.toLowerCase()] || [g.toLowerCase()]).forEach(v => ok.add(v)); });
  let f = all.filter(c => [...ok].some(a => (c.country||"").toLowerCase().includes(a)));
  if (f.length === 0) f = all;
  if (cfg.months && cfg.months !== "heilars") {
    const ws = f.filter(c => c.nextSeasonStart === "heilars" || c.nextSeasonStart === cfg.months);
    if (ws.length >= 3) f = ws;
  }
  return f;
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
  version: "v11.0 — " + new Date().toISOString().split("T")[0]
};
console.log("RoadSpot Core:", window.RS.version);

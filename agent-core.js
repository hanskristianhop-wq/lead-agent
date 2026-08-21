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

// ── GEO-AWARE DEMO LEADS ───────────────────────────────────
function getDemoLeads(cfg) {
  const all = [
    // NOREG
    {company:"Havila Kystruten",           segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Noreg",        website:"havila.no",                    annualRevenue:800000000,estimatedGuests:60000,  internationalGuestsMixed:true},
    {company:"Norsk Fjordcruise",          segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Noreg",        website:"fjordcruise.no",                annualRevenue:95000000, estimatedGuests:40000,  internationalGuestsMixed:true},
    {company:"Visit Tromsø AS",            segment:"Destinasjonsselskap", nextSeasonStart:"vinter", country:"Noreg",        website:"visittromso.no",                annualRevenue:65000000, estimatedGuests:120000, internationalGuestsMixed:true},
    {company:"Visit Svalbard AS",          segment:"Destinasjonsselskap", nextSeasonStart:"vinter", country:"Noreg",        website:"visitsvalbard.com",             annualRevenue:55000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"North Norway Tours",         segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Noreg",        website:"northnorwaytours.no",           annualRevenue:32000000, estimatedGuests:6000,   internationalGuestsMixed:true},
    {company:"Kirkenes Snowhotel",         segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Noreg",        website:"snowhotel.no",                  annualRevenue:42000000, estimatedGuests:7000,   internationalGuestsMixed:true},
    {company:"Polarmuseet Tromsø",         segment:"Museum",              nextSeasonStart:"heilars",country:"Noreg",        website:"polarmuseet.no",                annualRevenue:22000000, estimatedGuests:40000,  internationalGuestsMixed:true},
    // SVERIGE
    {company:"Icehotel Jukkasjärvi",       segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Sverige",      website:"icehotel.com",                  annualRevenue:80000000, estimatedGuests:15000,  internationalGuestsMixed:true},
    {company:"Swedish Lapland Visitors",   segment:"Destinasjonsselskap", nextSeasonStart:"vinter", country:"Sverige",      website:"swedishlapland.com",            annualRevenue:45000000, estimatedGuests:20000,  internationalGuestsMixed:true},
    {company:"Abisko Naturum",             segment:"Naturopplevingar",    nextSeasonStart:"vinter", country:"Sverige",      website:"abisko.se",                     annualRevenue:19000000, estimatedGuests:12000,  internationalGuestsMixed:true},
    // DANMARK
    {company:"Visit Copenhagen",           segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Danmark",      website:"visitcopenhagen.com",           annualRevenue:90000000, estimatedGuests:300000, internationalGuestsMixed:true},
    {company:"DFDS Cruises",               segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Danmark",      website:"dfds.com",                      annualRevenue:800000000,estimatedGuests:400000, internationalGuestsMixed:true},
    {company:"Strøget Tours Copenhagen",   segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Danmark",      website:"stroegettours.dk",              annualRevenue:12000000, estimatedGuests:25000,  internationalGuestsMixed:true},
    // FINLAND
    {company:"Visit Rovaniemi",            segment:"Destinasjonsselskap", nextSeasonStart:"vinter", country:"Finland",      website:"visitrovaniemi.fi",             annualRevenue:35000000, estimatedGuests:50000,  internationalGuestsMixed:true},
    {company:"Santa Claus Village",        segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Finland",      website:"santaclausvillage.info",        annualRevenue:60000000, estimatedGuests:50000,  internationalGuestsMixed:true},
    {company:"Visit Finland",              segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Finland",      website:"visitfinland.com",              annualRevenue:80000000, estimatedGuests:100000, internationalGuestsMixed:true},
    // ISLAND
    {company:"Visit Iceland Reykjavik",    segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Island",       website:"visitreykjavik.is",             annualRevenue:120000000,estimatedGuests:100000, internationalGuestsMixed:true},
    {company:"Arctic Adventures Iceland",  segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Island",       website:"adventures.is",                 annualRevenue:35000000, estimatedGuests:40000,  internationalGuestsMixed:true},
    // SKOTTLAND
    {company:"Visit Scotland",             segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Skottland",    website:"visitscotland.com",             annualRevenue:200000000,estimatedGuests:500000, internationalGuestsMixed:true},
    {company:"Rabbies Trail Burners",      segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Skottland",    website:"rabbies.com",                   annualRevenue:45000000, estimatedGuests:25000,  internationalGuestsMixed:true},
    {company:"Caledonian MacBrayne",       segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Skottland",    website:"calmac.co.uk",                  annualRevenue:180000000,estimatedGuests:200000, internationalGuestsMixed:true},
    {company:"Loch Ness by Jacobite",      segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Skottland",    website:"jacobite.co.uk",                annualRevenue:18000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"Edinburgh Bus Tours",        segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Skottland",    website:"edinburghbustours.com",         annualRevenue:32000000, estimatedGuests:250000, internationalGuestsMixed:true},
    {company:"Historic Environment Scotland",segment:"Museum",            nextSeasonStart:"heilars",country:"Skottland",    website:"historicenvironment.scot",      annualRevenue:150000000,estimatedGuests:1000000,internationalGuestsMixed:true},
    {company:"Highlands Unbounded",        segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Skottland",    website:"highlandsunbounded.com",        annualRevenue:11000000, estimatedGuests:8000,   internationalGuestsMixed:true},
    {company:"Orkney Ferries",             segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Skottland",    website:"orkneyferries.co.uk",           annualRevenue:22000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"National Museum Scotland",   segment:"Museum",              nextSeasonStart:"heilars",country:"Skottland",    website:"nms.ac.uk",                     annualRevenue:65000000, estimatedGuests:2500000,internationalGuestsMixed:true},
    {company:"Loch Lomond & Trossachs",    segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Skottland",    website:"lochlomond-trossachs.org",      annualRevenue:45000000, estimatedGuests:4000000,internationalGuestsMixed:true},
    {company:"Scottish Canals",            segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Skottland",    website:"scottishcanals.co.uk",          annualRevenue:20000000, estimatedGuests:50000,  internationalGuestsMixed:true},
    {company:"Brightwater Holidays",       segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Skottland",    website:"brightwaterholidays.com",       annualRevenue:15000000, estimatedGuests:10000,  internationalGuestsMixed:true},
    // ENGLAND
    {company:"VisitBritain",               segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"England",      website:"visitbritain.com",              annualRevenue:500000000,estimatedGuests:2000000,internationalGuestsMixed:true},
    {company:"P&O Ferries UK",             segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"England",      website:"poferries.com",                 annualRevenue:900000000,estimatedGuests:8000000,internationalGuestsMixed:true},
    {company:"City Sightseeing UK",        segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"England",      website:"city-sightseeing.com",          annualRevenue:85000000, estimatedGuests:500000, internationalGuestsMixed:true},
    {company:"Stonehenge Tours",           segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"England",      website:"stonehengetours.com",           annualRevenue:28000000, estimatedGuests:120000, internationalGuestsMixed:true},
    {company:"Mersey Ferries",             segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"England",      website:"merseyferries.co.uk",           annualRevenue:25000000, estimatedGuests:200000, internationalGuestsMixed:true},
    {company:"Windermere Lake Cruises",    segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"England",      website:"windermere-lakecruises.co.uk",  annualRevenue:14000000, estimatedGuests:100000, internationalGuestsMixed:true},
    {company:"Heart of England Tours",     segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"England",      website:"heartofenglandtours.co.uk",     annualRevenue:12000000, estimatedGuests:20000,  internationalGuestsMixed:true},
    {company:"Contiki UK",                 segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"England",      website:"contiki.com",                   annualRevenue:200000000,estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"Shearings Group",            segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"England",      website:"shearings.com",                 annualRevenue:120000000,estimatedGuests:80000,  internationalGuestsMixed:false},
    {company:"National Trust England",     segment:"Museum",              nextSeasonStart:"heilars",country:"England",      website:"nationaltrust.org.uk",          annualRevenue:400000000,estimatedGuests:5000000,internationalGuestsMixed:true},
    // WALES
    {company:"Visit Wales",                segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Wales",        website:"visitwales.com",                annualRevenue:80000000, estimatedGuests:400000, internationalGuestsMixed:true},
    {company:"Brecon Beacons Tourism",     segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Wales",        website:"breconbeacons.org",             annualRevenue:15000000, estimatedGuests:50000,  internationalGuestsMixed:true},
    // IRLAND
    {company:"Wild Rover Tours",           segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Irland",       website:"wildrovertours.com",            annualRevenue:22000000, estimatedGuests:30000,  internationalGuestsMixed:true},
    {company:"Tourism Ireland",            segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Irland",       website:"tourismireland.com",            annualRevenue:150000000,estimatedGuests:500000, internationalGuestsMixed:true},
    {company:"Failte Ireland",             segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Irland",       website:"failteireland.ie",              annualRevenue:90000000, estimatedGuests:300000, internationalGuestsMixed:true},
    // NORD-IRLAND
    {company:"Tourism Northern Ireland",   segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Nord-Irland",  website:"tourismni.com",                 annualRevenue:40000000, estimatedGuests:100000, internationalGuestsMixed:true},
    // TYSKLAND - TUROPERATØRAR (utvida)
    {company:"Bayerische Zugspitzbahn",    segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Bayern",       website:"zugspitze.de",                  annualRevenue:45000000, estimatedGuests:200000, internationalGuestsMixed:true},
    {company:"Romantic Road Coach",        segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Bayern",       website:"romanticroadcoach.de",           annualRevenue:22000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"Munich City Tours",          segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Bayern",       website:"munichinformation.de",           annualRevenue:18000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"Neuschwanstein Tours",       segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Bayern",       website:"neuschwanstein.de",              annualRevenue:35000000, estimatedGuests:300000, internationalGuestsMixed:true},
    {company:"Hamburg Hafen Rundfahrt",    segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Nord-Tyskland",website:"hamburg.de/hafenrundfahrt",      annualRevenue:25000000, estimatedGuests:400000, internationalGuestsMixed:true},
    {company:"Reederei Cassen Eils",       segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Nord-Tyskland",website:"cassen-eils.de",                 annualRevenue:18000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"Berlin City Tour",           segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Berlin",       website:"berlincitytour.de",              annualRevenue:25000000, estimatedGuests:200000, internationalGuestsMixed:true},
    {company:"Spree River Cruise Berlin",  segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Berlin",       website:"stern-und-kreis.de",             annualRevenue:20000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"KD Rhine Cruise",            segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Rheinland",    website:"k-d.com",                        annualRevenue:35000000, estimatedGuests:300000, internationalGuestsMixed:true},
    {company:"Cologne Cathedral Tours",    segment:"Museum",              nextSeasonStart:"heilars",country:"Rheinland",    website:"koelner-dom.de",                 annualRevenue:15000000, estimatedGuests:500000, internationalGuestsMixed:true},
    {company:"Loreley Cruises",            segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Rheinland",    website:"loreley-tourist.de",             annualRevenue:14000000, estimatedGuests:60000,  internationalGuestsMixed:true},
    {company:"Dresden Dampfschifffahrt",   segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Aust-Tyskland",website:"saechsische-dampfschifffahrt.de",annualRevenue:22000000, estimatedGuests:180000, internationalGuestsMixed:true},
    {company:"Leipzig City Tour",          segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Aust-Tyskland",website:"leipzig.travel",                 annualRevenue:12000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"Zugspitze Winter Tours",     segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Bayern",       website:"zugspitze-winter.de",            annualRevenue:30000000, estimatedGuests:120000, internationalGuestsMixed:true},
    {company:"Füssen Königsschlösser",     segment:"Museum",              nextSeasonStart:"heilars",country:"Bayern",       website:"fuessen.de",                     annualRevenue:40000000, estimatedGuests:1500000,internationalGuestsMixed:true},
    {company:"Schwarzwald Tourismus",      segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Tyskland",     website:"schwarzwald-tourismus.info",     annualRevenue:30000000, estimatedGuests:100000, internationalGuestsMixed:true},
    {company:"Mosel Schifffahrt",          segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Rheinland",    website:"moselschifffahrt.de",            annualRevenue:16000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"Deutsche Bahn Sightseeing",  segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Tyskland",     website:"bahn.de/sightseeing",            annualRevenue:500000000,estimatedGuests:2000000,internationalGuestsMixed:true},
    {company:"Heidelberg Castle Tours",    segment:"Museum",              nextSeasonStart:"sommer", country:"Tyskland",     website:"schloss-heidelberg.de",          annualRevenue:25000000, estimatedGuests:1000000,internationalGuestsMixed:true},
    {company:"Rhine Valley Bike Tours",    segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Rheinland",    website:"rhinevalley-biketours.com",      annualRevenue:12000000, estimatedGuests:15000,  internationalGuestsMixed:true},
    // NEDERLAND
    {company:"Rederij Lovers",             segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Nederland",    website:"lovers.nl",                     annualRevenue:35000000, estimatedGuests:800000, internationalGuestsMixed:true},
    {company:"Keukenhof Gardens",          segment:"Museum",              nextSeasonStart:"sommer", country:"Nederland",    website:"keukenhof.nl",                  annualRevenue:45000000, estimatedGuests:1500000,internationalGuestsMixed:true},
    {company:"Holland America Tours",      segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Nederland",    website:"hollandamerica.com",            annualRevenue:200000000,estimatedGuests:200000, internationalGuestsMixed:true},
    // FRANKRIKE - ÎLE-DE-FRANCE
    {company:"Paris City Vision",          segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Île-de-France",website:"pariscityvision.com",           annualRevenue:85000000, estimatedGuests:500000, internationalGuestsMixed:true},
    {company:"Bateaux Mouches",            segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Île-de-France",website:"bateaux-mouches.fr",            annualRevenue:45000000, estimatedGuests:1200000,internationalGuestsMixed:true},
    {company:"Chateau de Versailles Tours",segment:"Museum",              nextSeasonStart:"heilars",country:"Île-de-France",website:"chateauversailles.fr",          annualRevenue:200000000,estimatedGuests:8000000,internationalGuestsMixed:true},
    // FRANKRIKE - NORMANDIE
    {company:"Normandy American Tours",    segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Normandie",    website:"normandy-tours.com",            annualRevenue:18000000, estimatedGuests:40000,  internationalGuestsMixed:true},
    {company:"Mont Saint-Michel Tours",    segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Normandie",    website:"mtsaintmichel-tours.com",       annualRevenue:22000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    // FRANKRIKE - BRETAGNE
    {company:"Brittany Ferries",           segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Bretagne",     website:"brittany-ferries.fr",           annualRevenue:900000000,estimatedGuests:2000000,internationalGuestsMixed:true},
    // FRANKRIKE - PROVENCE
    {company:"Riviera Bar Crawl Nice",     segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Provence",     website:"rivierabarcrawl.com",           annualRevenue:12000000, estimatedGuests:50000,  internationalGuestsMixed:true},
    {company:"Provence Tourisme",          segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Provence",     website:"provence-tourisme.com",         annualRevenue:40000000, estimatedGuests:200000, internationalGuestsMixed:true},
    // FRANKRIKE - LOIREDALEN
    {company:"Loire Valley Cycling",       segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Loiredalen",   website:"loirecycling.com",              annualRevenue:11000000, estimatedGuests:15000,  internationalGuestsMixed:true},
    // FRANKRIKE - ALSACE
    {company:"Alsace Tourisme",            segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Alsace",       website:"alsace.com",                    annualRevenue:25000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    // FRANKRIKE - ALPANE
    {company:"Chamonix Mont Blanc",        segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Alpane-FR",    website:"chamonix.com",                  annualRevenue:35000000, estimatedGuests:100000, internationalGuestsMixed:true},
    // TYSKLAND
    {company:"Deutschland Tourismus",      segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Tyskland",     website:"germany.travel",                annualRevenue:300000000,estimatedGuests:500000, internationalGuestsMixed:true},
    // TYSKLAND - BAYERN
    {company:"Bayern Tourismus",           segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Bayern",       website:"bayern.by",                     annualRevenue:150000000,estimatedGuests:400000, internationalGuestsMixed:true},
    {company:"Bayerische Seenschifffahrt", segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Bayern",       website:"seenschifffahrt.de",            annualRevenue:28000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"Zugspitze Tours",            segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Bayern",       website:"zugspitze.de",                  annualRevenue:45000000, estimatedGuests:200000, internationalGuestsMixed:true},
    // TYSKLAND - NORD
    {company:"Hamburger Hafen City Tours", segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Nord-Tyskland",website:"hamburger-hafen.de",            annualRevenue:22000000, estimatedGuests:100000, internationalGuestsMixed:true},
    {company:"HADAG Hamburg",              segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Nord-Tyskland",website:"hadag.de",                      annualRevenue:18000000, estimatedGuests:200000, internationalGuestsMixed:true},
    // TYSKLAND - RHEINLAND
    {company:"KD Rhein Cruise",            segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Rheinland",    website:"k-d.com",                       annualRevenue:35000000, estimatedGuests:300000, internationalGuestsMixed:true},
    // TYSKLAND - BERLIN
    {company:"Berlin Walks Tours",         segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Berlin",       website:"berlinwalks.com",               annualRevenue:18000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"Berliner Unterwelten",       segment:"Museum",              nextSeasonStart:"heilars",country:"Berlin",       website:"berliner-unterwelten.de",        annualRevenue:12000000, estimatedGuests:60000,  internationalGuestsMixed:true},
    // USA - MID-ATLANTIC
    {company:"Gray Line New York",         segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Mid-Atlantic", website:"graylinenewyork.com",           annualRevenue:120000000,estimatedGuests:800000, internationalGuestsMixed:true},
    {company:"Circle Line NYC",            segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Mid-Atlantic", website:"circleline42.com",              annualRevenue:45000000, estimatedGuests:500000, internationalGuestsMixed:true},
    // USA - PACIFIC COAST
    {company:"Alcatraz City Cruises",      segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Pacific Coast",website:"alcatrazcruises.com",           annualRevenue:85000000, estimatedGuests:1400000,internationalGuestsMixed:true},
    {company:"San Francisco Bay Cruises",  segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Pacific Coast",website:"sfbaycruises.com",              annualRevenue:30000000, estimatedGuests:300000, internationalGuestsMixed:true},
    // USA - MOUNTAIN WEST
    {company:"Grand Canyon Tours",         segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Mountain West",website:"grandcanyontours.com",          annualRevenue:65000000, estimatedGuests:200000, internationalGuestsMixed:true},
    {company:"Glacier National Park Tours",segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Mountain West",website:"glacierparktours.com",          annualRevenue:22000000, estimatedGuests:30000,  internationalGuestsMixed:true},
    // USA - NEW ENGLAND
    {company:"New England Cruise",         segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"New England",  website:"newenglandcruise.com",          annualRevenue:35000000, estimatedGuests:50000,  internationalGuestsMixed:true},
    {company:"Boston Duck Tours",          segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"New England",  website:"bostonducktours.com",           annualRevenue:28000000, estimatedGuests:200000, internationalGuestsMixed:true},
    // USA - SOUTHEAST
    {company:"Everglades Airboat Tours",   segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Southeast USA",website:"evergladesairboattours.com",    annualRevenue:20000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"Nashville City Tours",       segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Southeast USA",website:"nashvillecitytours.com",        annualRevenue:28000000, estimatedGuests:120000, internationalGuestsMixed:true},
    // USA - MIDWEST
    {company:"Chicago Architecture Center",segment:"Museum",              nextSeasonStart:"heilars",country:"Midwest USA",  website:"architecture.org",             annualRevenue:18000000, estimatedGuests:100000, internationalGuestsMixed:true},
    {company:"Great Lakes Cruise",         segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Midwest USA",  website:"greatlakescruising.com",        annualRevenue:40000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    // USA - TEXAS
    {company:"San Antonio River Walk Tours",segment:"Turoperatørar",      nextSeasonStart:"heilars",country:"Texas Gulf",   website:"sariverwalk.com",               annualRevenue:22000000, estimatedGuests:200000, internationalGuestsMixed:true},
    // ITALIA
    {company:"Colosseum Tours Rome",       segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Italia",       website:"colosseumtours.com",            annualRevenue:45000000, estimatedGuests:500000, internationalGuestsMixed:true},
    {company:"Venice Water Taxi",          segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Italia",       website:"veneziaunica.it",               annualRevenue:30000000, estimatedGuests:800000, internationalGuestsMixed:true},
    // SPANIA
    {company:"Barcelona City Tours",       segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Spania",       website:"barcelonacitytours.com",        annualRevenue:35000000, estimatedGuests:400000, internationalGuestsMixed:true},
    {company:"Flamenco Experience Sevilla",segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Spania",       website:"flamencoexperience.com",        annualRevenue:15000000, estimatedGuests:100000, internationalGuestsMixed:true},
    // CANADA
    {company:"Niagara Falls Tours",        segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Canada",       website:"niagarafallstours.com",         annualRevenue:55000000, estimatedGuests:400000, internationalGuestsMixed:true},
    {company:"Rocky Mountaineer",          segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Canada",       website:"rockymountaineer.com",          annualRevenue:200000000,estimatedGuests:100000, internationalGuestsMixed:true},
    // AUSTRALIA
    {company:"Sydney Harbour Cruises",     segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Australia",    website:"sydneyharbourcruises.com.au",   annualRevenue:40000000, estimatedGuests:300000, internationalGuestsMixed:true},
    {company:"Great Barrier Reef Tours",   segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Australia",    website:"greatbarrierreeftours.com",    annualRevenue:65000000, estimatedGuests:200000, internationalGuestsMixed:true},
    // NEW ZEALAND
    {company:"Fiordland Cruises",          segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"New Zealand",  website:"fiordlandcruises.co.nz",        annualRevenue:35000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    // JAPAN
    {company:"Hato Bus Tokyo",             segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Japan",        website:"hatobus.com",                   annualRevenue:85000000, estimatedGuests:500000, internationalGuestsMixed:true},
    {company:"Kyoto Walk Tours",           segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Japan",        website:"kyotowalk.com",                 annualRevenue:20000000, estimatedGuests:100000, internationalGuestsMixed:true},

    // SVERIGE (manglande)
    {company:"Stockholm Sightseeing",      segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Sverige",      website:"stromma.com",                   annualRevenue:45000000, estimatedGuests:300000, internationalGuestsMixed:true},
    // ENGLAND-NORD (eige country-felt)
    {company:"York City Sightseeing",      segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Nord-England", website:"yorkpass.com",                  annualRevenue:20000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"Lake District Cruises",      segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Nord-England", website:"lakedistrict.gov.uk",           annualRevenue:15000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    // ENGLAND-SØR (eige country-felt)
    {company:"Thames River Sightseeing",   segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Sør-England",  website:"thamesclippers.com",            annualRevenue:55000000, estimatedGuests:400000, internationalGuestsMixed:true},
    {company:"London Eye River Cruise",    segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Sør-England",  website:"londoneye.com",                 annualRevenue:85000000, estimatedGuests:600000, internationalGuestsMixed:true},
    // WALES (manglande)
    {company:"Snowdonia National Park Tours",segment:"Turoperatørar",     nextSeasonStart:"sommer", country:"Wales",        website:"snowdonia.gov.wales",           annualRevenue:18000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    // FRANKRIKE REGIONAR (manglande)
    {company:"Normandie Tourisme",         segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Normandie",    website:"normandie-tourisme.fr",         annualRevenue:30000000, estimatedGuests:100000, internationalGuestsMixed:true},
    {company:"Provence Tourisme Office",   segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Provence",     website:"myprovence.fr",                 annualRevenue:35000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"Chamonix Mont-Blanc Tours",  segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Alpane-FR",    website:"chamonix-mont-blanc.com",       annualRevenue:40000000, estimatedGuests:120000, internationalGuestsMixed:true},
    {company:"Chateaux Loire Valley",      segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Loiredalen",   website:"loirechateaux.com",             annualRevenue:15000000, estimatedGuests:50000,  internationalGuestsMixed:true},
    {company:"Alsace Wine Route Tours",    segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Alsace",       website:"alsace-wines.com",              annualRevenue:12000000, estimatedGuests:40000,  internationalGuestsMixed:true},
    // TYSKLAND REGIONAR (manglande)
    {company:"Mosel River Cruises",        segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Rheinland",    website:"moselcruises.de",               annualRevenue:20000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"Dresden City Tours",         segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Aust-Tyskland",website:"dresden.de/tourismus",          annualRevenue:18000000, estimatedGuests:100000, internationalGuestsMixed:true},
    // USA (manglande regionar)
    {company:"New England Aquarium",       segment:"Museum",              nextSeasonStart:"heilars",country:"New England",  website:"neaq.org",                      annualRevenue:25000000, estimatedGuests:200000, internationalGuestsMixed:true},
    {company:"Hawaii Dolphin Tours",       segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Alaska Hawaii",website:"dolphintours.com",              annualRevenue:18000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    // ANDRE (manglande)
    {company:"Bruges Boat Tours",          segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Belgia",       website:"brugesboattours.com",           annualRevenue:12000000, estimatedGuests:100000, internationalGuestsMixed:true},
    {company:"Lake Lucerne Navigation",    segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Sveits",       website:"lakelucerne.ch",                annualRevenue:35000000, estimatedGuests:200000, internationalGuestsMixed:true},
    {company:"Salzburg Sightseeing Tours", segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Austerrike",   website:"salzburg.info/tourismus",       annualRevenue:22000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"Niagara Falls Tours Canada", segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Canada",       website:"niagarafalls.com",              annualRevenue:55000000, estimatedGuests:400000, internationalGuestsMixed:true},
    ];

  if (!cfg?.geos?.length) return all;

  const GM = {
    noreg:["noreg","norge","norway"],
    sverige:["sverige","sweden"],
    danmark:["danmark","denmark"],
    finland:["finland"],
    island:["island","iceland"],
    uk:["uk","united kingdom","england","scotland","britain","wales","ireland",
        "skottland","irland","nord-irland"],
    skottland:["skottland","scotland"],
    england:["england"],
    "england-nord":["nord-england","north england","yorkshire","manchester","liverpool","newcastle","nord-england"],
    "england-sør":["sør-england","south england","london","southeast","sør-england"],
    "england-sør":["sør-england","south england"],
    wales:["wales","cymru"],
    irland:["irland","ireland","eire"],
    "nord-irland":["nord-irland","northern ireland"],
    frankrike:["frankrike","france","île-de-france","normandie","bretagne","provence","loiredalen","alsace","alpane-fr"],
    "île-de-france":["île-de-france","ile de france","paris"],
    normandie:["normandie","normandy"],
    bretagne:["bretagne","brittany"],
    provence:["provence","côte d'azur","nice"],
    loiredalen:["loiredalen","loire"],
    alsace:["alsace","strasbourg"],
    "alpane-fr":["alpane-fr","alps","savoie","chamonix"],
    tyskland:["tyskland","germany","deutschland","nord-tyskland","bayern","rheinland","aust-tyskland","berlin"],
    bayern:["bayern","bavaria","münchen","munich"],
    "nord-tyskland":["nord-tyskland","hamburg","bremen","north germany"],
    rheinland:["rheinland","rhine","cologne","köln","düsseldorf"],
    "aust-tyskland":["aust-tyskland","saxony","sachsen","dresden","leipzig"],
    berlin:["berlin"],
    nederland:["nederland","netherlands","holland"],
    belgia:["belgia","belgium"],
    sveits:["sveits","switzerland","schweiz"],
    austerrike:["austerrike","austria","österreich"],
    italia:["italia","italy"],
    spania:["spania","spain","españa"],
    usa:["usa","united states","america","mid-atlantic","pacific coast","mountain west",
         "new england","southeast usa","midwest usa","texas gulf","alaska hawaii"],
    "mid-atlantic":["mid-atlantic"],
    "pacific coast":["pacific coast"],
    "mountain west":["mountain west"],
    "new england":["new england"],
    "southeast usa":["southeast usa"],
    "midwest usa":["midwest usa"],
    "texas gulf":["texas gulf"],
    "alaska hawaii":["alaska hawaii"],
    canada:["canada"],
    australia:["australia"],
    "new zealand":["new zealand"],
    japan:["japan"],
  };

  const ok = new Set();
  cfg.geos.forEach(g => { (GM[g.toLowerCase()] || [g.toLowerCase()]).forEach(v => ok.add(v)); });
  let f = all.filter(c => [...ok].some(a => (c.country||"").toLowerCase().includes(a)));
  if (f.length === 0) f = all;

  if (cfg.months && cfg.months !== "heilars") {
    const ws = f.filter(c => c.nextSeasonStart === "heilars" || c.nextSeasonStart === cfg.months);
    if (ws.length >= 3) f = ws;
  }

  // Segment-filter — berre bruk om det gir nok resultat
  if (cfg.segs && cfg.segs.length > 0) {
    const ws = f.filter(c => cfg.segs.some(s =>
      (c.segment||"").toLowerCase().includes(s.toLowerCase().split("/")[0])
    ));
    // Berre filtrer på segment om det gir minst 8 treff
    if (ws.length >= 8) f = ws;
    // Mellom 3-7: berik med resten (geo+sesong utan segmentfilter)
    else if (ws.length >= 3) {
      const extra = f.filter(c => !ws.includes(c));
      f = [...ws, ...extra];
    }
    // Under 3: ignorer segmentfilter — vis alle geo+sesong-treff
  }

  // Garantert minimum: om framleis for få, ta alle frå same geo utan sesongfilter
  if (f.length < 10 && cfg.geos?.length > 0) {
    const ok2 = new Set();
    cfg.geos.forEach(g => { (GM[g.toLowerCase()] || [g.toLowerCase()]).forEach(v => ok2.add(v)); });
    const geoOnly = all.filter(c => [...ok2].some(a => (c.country||"").toLowerCase().includes(a)));
    const seen = new Set(f.map(c => c.company));
    for (const c of geoOnly) {
      if (!seen.has(c.company)) { f.push(c); seen.add(c.company); }
    }
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
console.log("RoadSpot Core:", window.RS.version);// ── SØKEMOTOR: 500 KANDIDATAR → 25 BESTE FOR ROADSPOT ────

// Segment → engelsk søketerm
const SEG_TERMS = {
  "Turoperatørar":       "tour operators sightseeing guided tours excursion companies",
  "Båt/cruise":          "boat tours river cruises ferry operators harbour cruises",
  "Destinasjonsselskap": "destination management company DMC tourism board visitor bureau",
  "Museum":              "museum heritage site visitor attraction cultural centre",
  "Buss":                "hop-on hop-off bus tours coach sightseeing",
  "Tog":                 "scenic railway tourist train heritage railway mountain railway",
  "Kommunar":            "municipal tourism city tourism department",
};

// ── STEG 1: Finn 500 kandidatar frå GYG, Viator, TripAdvisor, Google ──
async function findCandidates(cfg) {
  const geoStr = cfg.geos.join(", ");
  const segStr = cfg.segs.map(s => SEG_TERMS[s] || s).join("; ");
  const season = cfg.months === "vinter" ? "winter Christmas markets northern lights skiing"
    : cfg.months === "sommer" ? "summer outdoor boat trips festivals hiking"
    : "year-round always open";
  const year = new Date().getFullYear();

  try {
    const txt = await apiCall(
      `You are a tourism industry researcher. Find as many REAL, CURRENTLY OPERATING tourism companies as possible in ${geoStr}.

Do ALL of these searches to build a wide list of 40-60 candidates:
1. site:getyourguide.com "${geoStr}" tours ${year}
2. site:viator.com "${geoStr}" experiences ${year}  
3. site:tripadvisor.com "Things to Do" "${geoStr}" top rated
4. "${geoStr}" ${segStr} international tourists reviews ${year}
5. "best tour operators" "${geoStr}" ${season} multilingual
6. "visit ${geoStr.split(",")[0].trim()}" official tourism partners operators
7. "${geoStr}" tourism company audio guide language problem reviews

INCLUDE: all types matching — ${segStr}
EXCLUDE only: kayaking rock climbing rafting mountain guiding via ferrata diving
MIN SIZE: 10M NOK / 1M EUR revenue equivalent
GEOGRAPHY: ONLY companies physically located in ${geoStr}

Return ONLY a JSON array (40-60 companies), no other text:
[{"company":"Name","website":"domain.com","segment":"Turoperatørar","country":"Bayern","nextSeasonStart":"sommer","description":"What they do","sources":["getyourguide","tripadvisor"],"estimatedGuests":0,"internationalGuestsMixed":false}]`,
      `Find 40-60 tourism companies in ${geoStr}. Type: ${segStr}. Season: ${season} ${year}.`,
      [], [{type:"web_search_20250305", name:"web_search"}]
    );
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const companies = JSON.parse(m[0]).filter(c => c.company && c.website);
    console.log(`Steg 1: ${companies.length} kandidatar funne`);
    return companies;
  } catch(e) {
    console.warn("Steg 1 feila:", e.message);
    return [];
  }
}

// ── STEG 2: Rask screening — kryss-ref + aktiv-sjekk ──────
async function screenCandidates(candidates, cfg) {
  if (candidates.length === 0) return [];
  const year = new Date().getFullYear();
  const prevYear = year - 1;

  // Batch: sjekk alle kandidatar i eitt søk
  const names = candidates.map(c => c.company).slice(0, 60).join(", ");
  
  try {
    const txt = await apiCall(
      `You are screening tourism companies for RoadSpot audio guide technology.
      
For each company in the list, search for recent reviews (${prevYear}-${year}) and score them.
RoadSpot helps when: international + local guests on SAME tour, language barriers, audio problems, large groups.

Search for EACH company: "[company name] reviews ${year} language audio multilingual international"

For each company return a score object. Return ONLY JSON array:
[{
  "company": "exact name from input",
  "active": true,
  "internationalMixed": true,
  "hasLanguageProblem": true,
  "hasAudioProblem": true,
  "hasScaleProblem": true,
  "reviewSnippet": "actual quote from a recent review if found",
  "reviewSource": "tripadvisor/google/viator",
  "reviewYear": ${year},
  "roadspotScore": 85,
  "roadspotReason": "Why RoadSpot fits this specific company"
}]`,
      `Screen these companies for RoadSpot fit. Search reviews ${prevYear}-${year} for each:
${names}`,
      [], [{type:"web_search_20250305", name:"web_search"}]
    );
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) return candidates.slice(0, 25);
    const scores = JSON.parse(m[0]);
    
    // Merge scores into candidates
    const scored = candidates.map(c => {
      const s = scores.find(sc => sc.company?.toLowerCase().includes(c.company?.toLowerCase().slice(0,10)));
      if (!s) return {...c, roadspotScore: 30, active: true};
      return {
        ...c,
        active: s.active !== false,
        internationalGuestsMixed: s.internationalMixed || c.internationalGuestsMixed,
        reviewSnippet: s.reviewSnippet || "",
        reviewSource: s.reviewSource || "",
        reviewYear: s.reviewYear || year,
        roadspotScore: s.roadspotScore || 30,
        roadspotReason: s.roadspotReason || "",
        hasLanguageProblem: s.hasLanguageProblem || false,
        hasAudioProblem: s.hasAudioProblem || false,
      };
    });

    // Filter: berre aktive, sort by roadspotScore
    const active = scored.filter(c => c.active !== false);
    active.sort((a,b) => (b.roadspotScore||0) - (a.roadspotScore||0));
    console.log(`Steg 2: ${active.length} aktive etter screening, topp score: ${active[0]?.roadspotScore}`);
    return active;
  } catch(e) {
    console.warn("Steg 2 feila:", e.message);
    return candidates;
  }
}

// ── STEG 3: Djup analyse av topp 25 ───────────────────────
async function deepAnalyze(candidates) {
  const top25 = candidates.slice(0, 25);
  const year = new Date().getFullYear();
  
  try {
    const names = top25.map((c,i) => `${i+1}. ${c.company} (${c.country||""}, ${c.website||""})"`).join("
");
    const txt = await apiCall(
      `Deep analysis for RoadSpot sales. For each company find:
1. A SPECIFIC TOUR they offer where international and local guests travel together
2. REAL review quotes (${year-1}-${year}) about language, audio, guide problems  
3. Cross-reference: confirm company exists on 2+ of: GetYourGuide, Viator, TripAdvisor, their own website
4. Contact person if findable (CEO, Sales Director, Commercial Director)
5. Estimated annual revenue and guest numbers

Return ONLY JSON array:
[{
  "company": "exact name",
  "verified": true,
  "verifiedSources": ["getyourguide","tripadvisor"],
  "keyTour": "Name of specific tour",
  "keyTourDescription": "This tour has 60% international guests, groups of 30-40 people",
  "realReviewQuote": "actual quote from guest review",
  "realReviewSource": "TripAdvisor/Google",
  "realReviewYear": 2026,
  "contact": "",
  "title": "",
  "email": "",
  "annualRevenue": 0,
  "estimatedGuests": 0,
  "companySize": "Mellomstor",
  "roadspotPitch": "For their Rhine cruise tours — 40% international guests + language problem = perfect fit"
}]`,
      `Deep analyze these top companies:
${names}`,
      [], [{type:"web_search_20250305", name:"web_search"}]
    );
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) return top25;
    const details = JSON.parse(m[0]);
    
    // Merge deep analysis
    return top25.map(c => {
      const d = details.find(dd => dd.company?.toLowerCase().includes(c.company?.toLowerCase().slice(0,8)));
      if (!d) return c;
      return {
        ...c,
        verified: d.verified,
        verifiedSources: d.verifiedSources || c.sources || [],
        keyTour: d.keyTour || "",
        keyTourDescription: d.keyTourDescription || "",
        realReviewQuote: d.realReviewQuote || c.reviewSnippet || "",
        realReviewSource: d.realReviewSource || c.reviewSource || "",
        contact: d.contact || c.contact || "",
        title: d.title || c.title || "",
        email: d.email || c.email || "",
        annualRevenue: d.annualRevenue || c.annualRevenue || 0,
        estimatedGuests: d.estimatedGuests || c.estimatedGuests || 0,
        companySize: d.companySize || "",
        roadspotPitch: d.roadspotPitch || c.roadspotReason || "",
      };
    });
  } catch(e) {
    console.warn("Steg 3 feila:", e.message);
    return top25;
  }
}

// ── HOVUD-PIPELINE: finn 500 → lever 25 ───────────────────
async function findAndEnrichLeads(cfg) {
  const KEY = c => (c.website||c.company||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const seen = new Set();
  
  // Hent allereie behandla selskap frå minne
  let memory = null;
  try { memory = await loadMemory(); } catch {}
  const memKeys = new Set(Object.keys(memory?.companies || {}));

  function addUnique(list) {
    const result = [];
    for (const c of list) {
      const k = KEY(c);
      if (!k || seen.has(k) || memKeys.has(k)) continue;
      seen.add(k);
      result.push(c);
    }
    return result;
  }

  let companies = [];

  // Steg 1: Breitt websøk — 40-60 kandidatar
  const candidates = await findCandidates(cfg);
  const newCandidates = addUnique(candidates);
  
  // Steg 2: Screening av kandidatar (kryss-ref + aktiv-sjekk)
  let screened = [];
  if (newCandidates.length > 0) {
    screened = await screenCandidates(newCandidates, cfg);
  }

  // Steg 3: Djup analyse av topp 25
  if (screened.length > 0) {
    companies = await deepAnalyze(screened.slice(0, 30));
    companies = addUnique(companies);
  }

  // Fallback: Apollo om websøk gav for lite
  if (companies.length < 10) {
    console.log("Fallback: Apollo-søk");
    const apolloResults = await findViaApolloFallback(cfg);
    companies.push(...addUnique(apolloResults));
  }

  // Siste fallback: demo-data
  if (companies.length < 5) {
    console.log("Fallback: demo-data");
    companies.push(...addUnique(getDemoLeads(cfg)));
  }

  // Apollo-berikking for kontaktinfo
  const needsContact = companies.filter(c => !c.email || !c.contact).slice(0, 15);
  if (needsContact.length > 0) {
    await enrichWithApollo(needsContact);
  }

  return companies.slice(0, 25);
}


// ── GEO-AWARE DEMO LEADS ───────────────────────────────────
function getDemoLeads(cfg) {
  const all = [
    // NOREG
    {company:"Havila Kystruten",           segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Noreg",        website:"havila.no",                    annualRevenue:800000000,estimatedGuests:60000,  internationalGuestsMixed:true},
    {company:"Norsk Fjordcruise",          segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Noreg",        website:"fjordcruise.no",                annualRevenue:95000000, estimatedGuests:40000,  internationalGuestsMixed:true},
    {company:"Visit Tromsø AS",            segment:"Destinasjonsselskap", nextSeasonStart:"vinter", country:"Noreg",        website:"visittromso.no",                annualRevenue:65000000, estimatedGuests:120000, internationalGuestsMixed:true},
    {company:"Visit Svalbard AS",          segment:"Destinasjonsselskap", nextSeasonStart:"vinter", country:"Noreg",        website:"visitsvalbard.com",             annualRevenue:55000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"North Norway Tours",         segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Noreg",        website:"northnorwaytours.no",           annualRevenue:32000000, estimatedGuests:6000,   internationalGuestsMixed:true},
    {company:"Kirkenes Snowhotel",         segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Noreg",        website:"snowhotel.no",                  annualRevenue:42000000, estimatedGuests:7000,   internationalGuestsMixed:true},
    {company:"Polarmuseet Tromsø",         segment:"Museum",              nextSeasonStart:"heilars",country:"Noreg",        website:"polarmuseet.no",                annualRevenue:22000000, estimatedGuests:40000,  internationalGuestsMixed:true},
    // SVERIGE
    {company:"Icehotel Jukkasjärvi",       segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Sverige",      website:"icehotel.com",                  annualRevenue:80000000, estimatedGuests:15000,  internationalGuestsMixed:true},
    {company:"Swedish Lapland Visitors",   segment:"Destinasjonsselskap", nextSeasonStart:"vinter", country:"Sverige",      website:"swedishlapland.com",            annualRevenue:45000000, estimatedGuests:20000,  internationalGuestsMixed:true},
    {company:"Abisko Naturum",             segment:"Naturopplevingar",    nextSeasonStart:"vinter", country:"Sverige",      website:"abisko.se",                     annualRevenue:19000000, estimatedGuests:12000,  internationalGuestsMixed:true},
    // DANMARK
    {company:"Visit Copenhagen",           segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Danmark",      website:"visitcopenhagen.com",           annualRevenue:90000000, estimatedGuests:300000, internationalGuestsMixed:true},
    {company:"DFDS Cruises",               segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Danmark",      website:"dfds.com",                      annualRevenue:800000000,estimatedGuests:400000, internationalGuestsMixed:true},
    {company:"Strøget Tours Copenhagen",   segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Danmark",      website:"stroegettours.dk",              annualRevenue:12000000, estimatedGuests:25000,  internationalGuestsMixed:true},
    // FINLAND
    {company:"Visit Rovaniemi",            segment:"Destinasjonsselskap", nextSeasonStart:"vinter", country:"Finland",      website:"visitrovaniemi.fi",             annualRevenue:35000000, estimatedGuests:50000,  internationalGuestsMixed:true},
    {company:"Santa Claus Village",        segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Finland",      website:"santaclausvillage.info",        annualRevenue:60000000, estimatedGuests:50000,  internationalGuestsMixed:true},
    {company:"Visit Finland",              segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Finland",      website:"visitfinland.com",              annualRevenue:80000000, estimatedGuests:100000, internationalGuestsMixed:true},
    // ISLAND
    {company:"Visit Iceland Reykjavik",    segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Island",       website:"visitreykjavik.is",             annualRevenue:120000000,estimatedGuests:100000, internationalGuestsMixed:true},
    {company:"Arctic Adventures Iceland",  segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Island",       website:"adventures.is",                 annualRevenue:35000000, estimatedGuests:40000,  internationalGuestsMixed:true},
    // SKOTTLAND
    {company:"Visit Scotland",             segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Skottland",    website:"visitscotland.com",             annualRevenue:200000000,estimatedGuests:500000, internationalGuestsMixed:true},
    {company:"Rabbies Trail Burners",      segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Skottland",    website:"rabbies.com",                   annualRevenue:45000000, estimatedGuests:25000,  internationalGuestsMixed:true},
    {company:"Caledonian MacBrayne",       segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Skottland",    website:"calmac.co.uk",                  annualRevenue:180000000,estimatedGuests:200000, internationalGuestsMixed:true},
    {company:"Loch Ness by Jacobite",      segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Skottland",    website:"jacobite.co.uk",                annualRevenue:18000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"Edinburgh Bus Tours",        segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Skottland",    website:"edinburghbustours.com",         annualRevenue:32000000, estimatedGuests:250000, internationalGuestsMixed:true},
    {company:"Historic Environment Scotland",segment:"Museum",            nextSeasonStart:"heilars",country:"Skottland",    website:"historicenvironment.scot",      annualRevenue:150000000,estimatedGuests:1000000,internationalGuestsMixed:true},
    {company:"Highlands Unbounded",        segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Skottland",    website:"highlandsunbounded.com",        annualRevenue:11000000, estimatedGuests:8000,   internationalGuestsMixed:true},
    {company:"Orkney Ferries",             segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Skottland",    website:"orkneyferries.co.uk",           annualRevenue:22000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"National Museum Scotland",   segment:"Museum",              nextSeasonStart:"heilars",country:"Skottland",    website:"nms.ac.uk",                     annualRevenue:65000000, estimatedGuests:2500000,internationalGuestsMixed:true},
    {company:"Loch Lomond & Trossachs",    segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Skottland",    website:"lochlomond-trossachs.org",      annualRevenue:45000000, estimatedGuests:4000000,internationalGuestsMixed:true},
    {company:"Scottish Canals",            segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Skottland",    website:"scottishcanals.co.uk",          annualRevenue:20000000, estimatedGuests:50000,  internationalGuestsMixed:true},
    {company:"Brightwater Holidays",       segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Skottland",    website:"brightwaterholidays.com",       annualRevenue:15000000, estimatedGuests:10000,  internationalGuestsMixed:true},
    // ENGLAND
    {company:"VisitBritain",               segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"England",      website:"visitbritain.com",              annualRevenue:500000000,estimatedGuests:2000000,internationalGuestsMixed:true},
    {company:"P&O Ferries UK",             segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"England",      website:"poferries.com",                 annualRevenue:900000000,estimatedGuests:8000000,internationalGuestsMixed:true},
    {company:"City Sightseeing UK",        segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"England",      website:"city-sightseeing.com",          annualRevenue:85000000, estimatedGuests:500000, internationalGuestsMixed:true},
    {company:"Stonehenge Tours",           segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"England",      website:"stonehengetours.com",           annualRevenue:28000000, estimatedGuests:120000, internationalGuestsMixed:true},
    {company:"Mersey Ferries",             segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"England",      website:"merseyferries.co.uk",           annualRevenue:25000000, estimatedGuests:200000, internationalGuestsMixed:true},
    {company:"Windermere Lake Cruises",    segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"England",      website:"windermere-lakecruises.co.uk",  annualRevenue:14000000, estimatedGuests:100000, internationalGuestsMixed:true},
    {company:"Heart of England Tours",     segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"England",      website:"heartofenglandtours.co.uk",     annualRevenue:12000000, estimatedGuests:20000,  internationalGuestsMixed:true},
    {company:"Contiki UK",                 segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"England",      website:"contiki.com",                   annualRevenue:200000000,estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"Shearings Group",            segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"England",      website:"shearings.com",                 annualRevenue:120000000,estimatedGuests:80000,  internationalGuestsMixed:false},
    {company:"National Trust England",     segment:"Museum",              nextSeasonStart:"heilars",country:"England",      website:"nationaltrust.org.uk",          annualRevenue:400000000,estimatedGuests:5000000,internationalGuestsMixed:true},
    // WALES
    {company:"Visit Wales",                segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Wales",        website:"visitwales.com",                annualRevenue:80000000, estimatedGuests:400000, internationalGuestsMixed:true},
    {company:"Brecon Beacons Tourism",     segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Wales",        website:"breconbeacons.org",             annualRevenue:15000000, estimatedGuests:50000,  internationalGuestsMixed:true},
    // IRLAND
    {company:"Wild Rover Tours",           segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Irland",       website:"wildrovertours.com",            annualRevenue:22000000, estimatedGuests:30000,  internationalGuestsMixed:true},
    {company:"Tourism Ireland",            segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Irland",       website:"tourismireland.com",            annualRevenue:150000000,estimatedGuests:500000, internationalGuestsMixed:true},
    {company:"Failte Ireland",             segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Irland",       website:"failteireland.ie",              annualRevenue:90000000, estimatedGuests:300000, internationalGuestsMixed:true},
    // NORD-IRLAND
    {company:"Tourism Northern Ireland",   segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Nord-Irland",  website:"tourismni.com",                 annualRevenue:40000000, estimatedGuests:100000, internationalGuestsMixed:true},
    // TYSKLAND - TUROPERATØRAR (utvida)
    {company:"Bayerische Zugspitzbahn",    segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Bayern",       website:"zugspitze.de",                  annualRevenue:45000000, estimatedGuests:200000, internationalGuestsMixed:true},
    {company:"Romantic Road Coach",        segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Bayern",       website:"romanticroadcoach.de",           annualRevenue:22000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"Munich City Tours",          segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Bayern",       website:"munichinformation.de",           annualRevenue:18000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"Neuschwanstein Tours",       segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Bayern",       website:"neuschwanstein.de",              annualRevenue:35000000, estimatedGuests:300000, internationalGuestsMixed:true},
    {company:"Hamburg Hafen Rundfahrt",    segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Nord-Tyskland",website:"hamburg.de/hafenrundfahrt",      annualRevenue:25000000, estimatedGuests:400000, internationalGuestsMixed:true},
    {company:"Reederei Cassen Eils",       segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Nord-Tyskland",website:"cassen-eils.de",                 annualRevenue:18000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"Berlin City Tour",           segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Berlin",       website:"berlincitytour.de",              annualRevenue:25000000, estimatedGuests:200000, internationalGuestsMixed:true},
    {company:"Spree River Cruise Berlin",  segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Berlin",       website:"stern-und-kreis.de",             annualRevenue:20000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"KD Rhine Cruise",            segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Rheinland",    website:"k-d.com",                        annualRevenue:35000000, estimatedGuests:300000, internationalGuestsMixed:true},
    {company:"Cologne Cathedral Tours",    segment:"Museum",              nextSeasonStart:"heilars",country:"Rheinland",    website:"koelner-dom.de",                 annualRevenue:15000000, estimatedGuests:500000, internationalGuestsMixed:true},
    {company:"Loreley Cruises",            segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Rheinland",    website:"loreley-tourist.de",             annualRevenue:14000000, estimatedGuests:60000,  internationalGuestsMixed:true},
    {company:"Dresden Dampfschifffahrt",   segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Aust-Tyskland",website:"saechsische-dampfschifffahrt.de",annualRevenue:22000000, estimatedGuests:180000, internationalGuestsMixed:true},
    {company:"Leipzig City Tour",          segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Aust-Tyskland",website:"leipzig.travel",                 annualRevenue:12000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"Zugspitze Winter Tours",     segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Bayern",       website:"zugspitze-winter.de",            annualRevenue:30000000, estimatedGuests:120000, internationalGuestsMixed:true},
    {company:"Füssen Königsschlösser",     segment:"Museum",              nextSeasonStart:"heilars",country:"Bayern",       website:"fuessen.de",                     annualRevenue:40000000, estimatedGuests:1500000,internationalGuestsMixed:true},
    {company:"Schwarzwald Tourismus",      segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Tyskland",     website:"schwarzwald-tourismus.info",     annualRevenue:30000000, estimatedGuests:100000, internationalGuestsMixed:true},
    {company:"Mosel Schifffahrt",          segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Rheinland",    website:"moselschifffahrt.de",            annualRevenue:16000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"Deutsche Bahn Sightseeing",  segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Tyskland",     website:"bahn.de/sightseeing",            annualRevenue:500000000,estimatedGuests:2000000,internationalGuestsMixed:true},
    {company:"Heidelberg Castle Tours",    segment:"Museum",              nextSeasonStart:"sommer", country:"Tyskland",     website:"schloss-heidelberg.de",          annualRevenue:25000000, estimatedGuests:1000000,internationalGuestsMixed:true},
    {company:"Rhine Valley Bike Tours",    segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Rheinland",    website:"rhinevalley-biketours.com",      annualRevenue:12000000, estimatedGuests:15000,  internationalGuestsMixed:true},
    // NEDERLAND
    {company:"Rederij Lovers",             segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Nederland",    website:"lovers.nl",                     annualRevenue:35000000, estimatedGuests:800000, internationalGuestsMixed:true},
    {company:"Keukenhof Gardens",          segment:"Museum",              nextSeasonStart:"sommer", country:"Nederland",    website:"keukenhof.nl",                  annualRevenue:45000000, estimatedGuests:1500000,internationalGuestsMixed:true},
    {company:"Holland America Tours",      segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Nederland",    website:"hollandamerica.com",            annualRevenue:200000000,estimatedGuests:200000, internationalGuestsMixed:true},
    // FRANKRIKE - ÎLE-DE-FRANCE
    {company:"Paris City Vision",          segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Île-de-France",website:"pariscityvision.com",           annualRevenue:85000000, estimatedGuests:500000, internationalGuestsMixed:true},
    {company:"Bateaux Mouches",            segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Île-de-France",website:"bateaux-mouches.fr",            annualRevenue:45000000, estimatedGuests:1200000,internationalGuestsMixed:true},
    {company:"Chateau de Versailles Tours",segment:"Museum",              nextSeasonStart:"heilars",country:"Île-de-France",website:"chateauversailles.fr",          annualRevenue:200000000,estimatedGuests:8000000,internationalGuestsMixed:true},
    // FRANKRIKE - NORMANDIE
    {company:"Normandy American Tours",    segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Normandie",    website:"normandy-tours.com",            annualRevenue:18000000, estimatedGuests:40000,  internationalGuestsMixed:true},
    {company:"Mont Saint-Michel Tours",    segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Normandie",    website:"mtsaintmichel-tours.com",       annualRevenue:22000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    // FRANKRIKE - BRETAGNE
    {company:"Brittany Ferries",           segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Bretagne",     website:"brittany-ferries.fr",           annualRevenue:900000000,estimatedGuests:2000000,internationalGuestsMixed:true},
    // FRANKRIKE - PROVENCE
    {company:"Riviera Bar Crawl Nice",     segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Provence",     website:"rivierabarcrawl.com",           annualRevenue:12000000, estimatedGuests:50000,  internationalGuestsMixed:true},
    {company:"Provence Tourisme",          segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Provence",     website:"provence-tourisme.com",         annualRevenue:40000000, estimatedGuests:200000, internationalGuestsMixed:true},
    // FRANKRIKE - LOIREDALEN
    {company:"Loire Valley Cycling",       segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Loiredalen",   website:"loirecycling.com",              annualRevenue:11000000, estimatedGuests:15000,  internationalGuestsMixed:true},
    // FRANKRIKE - ALSACE
    {company:"Alsace Tourisme",            segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Alsace",       website:"alsace.com",                    annualRevenue:25000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    // FRANKRIKE - ALPANE
    {company:"Chamonix Mont Blanc",        segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Alpane-FR",    website:"chamonix.com",                  annualRevenue:35000000, estimatedGuests:100000, internationalGuestsMixed:true},
    // TYSKLAND
    {company:"Deutschland Tourismus",      segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Tyskland",     website:"germany.travel",                annualRevenue:300000000,estimatedGuests:500000, internationalGuestsMixed:true},
    // TYSKLAND - BAYERN
    {company:"Bayern Tourismus",           segment:"Destinasjonsselskap", nextSeasonStart:"heilars",country:"Bayern",       website:"bayern.by",                     annualRevenue:150000000,estimatedGuests:400000, internationalGuestsMixed:true},
    {company:"Bayerische Seenschifffahrt", segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Bayern",       website:"seenschifffahrt.de",            annualRevenue:28000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"Zugspitze Tours",            segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Bayern",       website:"zugspitze.de",                  annualRevenue:45000000, estimatedGuests:200000, internationalGuestsMixed:true},
    // TYSKLAND - NORD
    {company:"Hamburger Hafen City Tours", segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Nord-Tyskland",website:"hamburger-hafen.de",            annualRevenue:22000000, estimatedGuests:100000, internationalGuestsMixed:true},
    {company:"HADAG Hamburg",              segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Nord-Tyskland",website:"hadag.de",                      annualRevenue:18000000, estimatedGuests:200000, internationalGuestsMixed:true},
    // TYSKLAND - RHEINLAND
    {company:"KD Rhein Cruise",            segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Rheinland",    website:"k-d.com",                       annualRevenue:35000000, estimatedGuests:300000, internationalGuestsMixed:true},
    // TYSKLAND - BERLIN
    {company:"Berlin Walks Tours",         segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Berlin",       website:"berlinwalks.com",               annualRevenue:18000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"Berliner Unterwelten",       segment:"Museum",              nextSeasonStart:"heilars",country:"Berlin",       website:"berliner-unterwelten.de",        annualRevenue:12000000, estimatedGuests:60000,  internationalGuestsMixed:true},
    // USA - MID-ATLANTIC
    {company:"Gray Line New York",         segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Mid-Atlantic", website:"graylinenewyork.com",           annualRevenue:120000000,estimatedGuests:800000, internationalGuestsMixed:true},
    {company:"Circle Line NYC",            segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Mid-Atlantic", website:"circleline42.com",              annualRevenue:45000000, estimatedGuests:500000, internationalGuestsMixed:true},
    // USA - PACIFIC COAST
    {company:"Alcatraz City Cruises",      segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Pacific Coast",website:"alcatrazcruises.com",           annualRevenue:85000000, estimatedGuests:1400000,internationalGuestsMixed:true},
    {company:"San Francisco Bay Cruises",  segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Pacific Coast",website:"sfbaycruises.com",              annualRevenue:30000000, estimatedGuests:300000, internationalGuestsMixed:true},
    // USA - MOUNTAIN WEST
    {company:"Grand Canyon Tours",         segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Mountain West",website:"grandcanyontours.com",          annualRevenue:65000000, estimatedGuests:200000, internationalGuestsMixed:true},
    {company:"Glacier National Park Tours",segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Mountain West",website:"glacierparktours.com",          annualRevenue:22000000, estimatedGuests:30000,  internationalGuestsMixed:true},
    // USA - NEW ENGLAND
    {company:"New England Cruise",         segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"New England",  website:"newenglandcruise.com",          annualRevenue:35000000, estimatedGuests:50000,  internationalGuestsMixed:true},
    {company:"Boston Duck Tours",          segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"New England",  website:"bostonducktours.com",           annualRevenue:28000000, estimatedGuests:200000, internationalGuestsMixed:true},
    // USA - SOUTHEAST
    {company:"Everglades Airboat Tours",   segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Southeast USA",website:"evergladesairboattours.com",    annualRevenue:20000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"Nashville City Tours",       segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Southeast USA",website:"nashvillecitytours.com",        annualRevenue:28000000, estimatedGuests:120000, internationalGuestsMixed:true},
    // USA - MIDWEST
    {company:"Chicago Architecture Center",segment:"Museum",              nextSeasonStart:"heilars",country:"Midwest USA",  website:"architecture.org",             annualRevenue:18000000, estimatedGuests:100000, internationalGuestsMixed:true},
    {company:"Great Lakes Cruise",         segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Midwest USA",  website:"greatlakescruising.com",        annualRevenue:40000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    // USA - TEXAS
    {company:"San Antonio River Walk Tours",segment:"Turoperatørar",      nextSeasonStart:"heilars",country:"Texas Gulf",   website:"sariverwalk.com",               annualRevenue:22000000, estimatedGuests:200000, internationalGuestsMixed:true},
    // ITALIA
    {company:"Colosseum Tours Rome",       segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Italia",       website:"colosseumtours.com",            annualRevenue:45000000, estimatedGuests:500000, internationalGuestsMixed:true},
    {company:"Venice Water Taxi",          segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Italia",       website:"veneziaunica.it",               annualRevenue:30000000, estimatedGuests:800000, internationalGuestsMixed:true},
    // SPANIA
    {company:"Barcelona City Tours",       segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Spania",       website:"barcelonacitytours.com",        annualRevenue:35000000, estimatedGuests:400000, internationalGuestsMixed:true},
    {company:"Flamenco Experience Sevilla",segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Spania",       website:"flamencoexperience.com",        annualRevenue:15000000, estimatedGuests:100000, internationalGuestsMixed:true},
    // CANADA
    {company:"Niagara Falls Tours",        segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Canada",       website:"niagarafallstours.com",         annualRevenue:55000000, estimatedGuests:400000, internationalGuestsMixed:true},
    {company:"Rocky Mountaineer",          segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Canada",       website:"rockymountaineer.com",          annualRevenue:200000000,estimatedGuests:100000, internationalGuestsMixed:true},
    // AUSTRALIA
    {company:"Sydney Harbour Cruises",     segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Australia",    website:"sydneyharbourcruises.com.au",   annualRevenue:40000000, estimatedGuests:300000, internationalGuestsMixed:true},
    {company:"Great Barrier Reef Tours",   segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Australia",    website:"greatbarrierreeftours.com",    annualRevenue:65000000, estimatedGuests:200000, internationalGuestsMixed:true},
    // NEW ZEALAND
    {company:"Fiordland Cruises",          segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"New Zealand",  website:"fiordlandcruises.co.nz",        annualRevenue:35000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    // JAPAN
    {company:"Hato Bus Tokyo",             segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Japan",        website:"hatobus.com",                   annualRevenue:85000000, estimatedGuests:500000, internationalGuestsMixed:true},
    {company:"Kyoto Walk Tours",           segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Japan",        website:"kyotowalk.com",                 annualRevenue:20000000, estimatedGuests:100000, internationalGuestsMixed:true},

    // SVERIGE (manglande)
    {company:"Stockholm Sightseeing",      segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Sverige",      website:"stromma.com",                   annualRevenue:45000000, estimatedGuests:300000, internationalGuestsMixed:true},
    // ENGLAND-NORD (eige country-felt)
    {company:"York City Sightseeing",      segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Nord-England", website:"yorkpass.com",                  annualRevenue:20000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"Lake District Cruises",      segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Nord-England", website:"lakedistrict.gov.uk",           annualRevenue:15000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    // ENGLAND-SØR (eige country-felt)
    {company:"Thames River Sightseeing",   segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Sør-England",  website:"thamesclippers.com",            annualRevenue:55000000, estimatedGuests:400000, internationalGuestsMixed:true},
    {company:"London Eye River Cruise",    segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Sør-England",  website:"londoneye.com",                 annualRevenue:85000000, estimatedGuests:600000, internationalGuestsMixed:true},
    // WALES (manglande)
    {company:"Snowdonia National Park Tours",segment:"Turoperatørar",     nextSeasonStart:"sommer", country:"Wales",        website:"snowdonia.gov.wales",           annualRevenue:18000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    // FRANKRIKE REGIONAR (manglande)
    {company:"Normandie Tourisme",         segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Normandie",    website:"normandie-tourisme.fr",         annualRevenue:30000000, estimatedGuests:100000, internationalGuestsMixed:true},
    {company:"Provence Tourisme Office",   segment:"Destinasjonsselskap", nextSeasonStart:"sommer", country:"Provence",     website:"myprovence.fr",                 annualRevenue:35000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"Chamonix Mont-Blanc Tours",  segment:"Turoperatørar",       nextSeasonStart:"vinter", country:"Alpane-FR",    website:"chamonix-mont-blanc.com",       annualRevenue:40000000, estimatedGuests:120000, internationalGuestsMixed:true},
    {company:"Chateaux Loire Valley",      segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Loiredalen",   website:"loirechateaux.com",             annualRevenue:15000000, estimatedGuests:50000,  internationalGuestsMixed:true},
    {company:"Alsace Wine Route Tours",    segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Alsace",       website:"alsace-wines.com",              annualRevenue:12000000, estimatedGuests:40000,  internationalGuestsMixed:true},
    // TYSKLAND REGIONAR (manglande)
    {company:"Mosel River Cruises",        segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Rheinland",    website:"moselcruises.de",               annualRevenue:20000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    {company:"Dresden City Tours",         segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Aust-Tyskland",website:"dresden.de/tourismus",          annualRevenue:18000000, estimatedGuests:100000, internationalGuestsMixed:true},
    // USA (manglande regionar)
    {company:"New England Aquarium",       segment:"Museum",              nextSeasonStart:"heilars",country:"New England",  website:"neaq.org",                      annualRevenue:25000000, estimatedGuests:200000, internationalGuestsMixed:true},
    {company:"Hawaii Dolphin Tours",       segment:"Turoperatørar",       nextSeasonStart:"heilars",country:"Alaska Hawaii",website:"dolphintours.com",              annualRevenue:18000000, estimatedGuests:80000,  internationalGuestsMixed:true},
    // ANDRE (manglande)
    {company:"Bruges Boat Tours",          segment:"Båt/cruise",          nextSeasonStart:"heilars",country:"Belgia",       website:"brugesboattours.com",           annualRevenue:12000000, estimatedGuests:100000, internationalGuestsMixed:true},
    {company:"Lake Lucerne Navigation",    segment:"Båt/cruise",          nextSeasonStart:"sommer", country:"Sveits",       website:"lakelucerne.ch",                annualRevenue:35000000, estimatedGuests:200000, internationalGuestsMixed:true},
    {company:"Salzburg Sightseeing Tours", segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Austerrike",   website:"salzburg.info/tourismus",       annualRevenue:22000000, estimatedGuests:150000, internationalGuestsMixed:true},
    {company:"Niagara Falls Tours Canada", segment:"Turoperatørar",       nextSeasonStart:"sommer", country:"Canada",       website:"niagarafalls.com",              annualRevenue:55000000, estimatedGuests:400000, internationalGuestsMixed:true},
    ];

  if (!cfg?.geos?.length) return all;

  const GM = {
    noreg:["noreg","norge","norway"],
    sverige:["sverige","sweden"],
    danmark:["danmark","denmark"],
    finland:["finland"],
    island:["island","iceland"],
    uk:["uk","united kingdom","england","scotland","britain","wales","ireland",
        "skottland","irland","nord-irland"],
    skottland:["skottland","scotland"],
    england:["england"],
    "england-nord":["nord-england","north england","yorkshire","manchester","liverpool","newcastle","nord-england"],
    "england-sør":["sør-england","south england","london","southeast","sør-england"],
    "england-sør":["sør-england","south england"],
    wales:["wales","cymru"],
    irland:["irland","ireland","eire"],
    "nord-irland":["nord-irland","northern ireland"],
    frankrike:["frankrike","france","île-de-france","normandie","bretagne","provence","loiredalen","alsace","alpane-fr"],
    "île-de-france":["île-de-france","ile de france","paris"],
    normandie:["normandie","normandy"],
    bretagne:["bretagne","brittany"],
    provence:["provence","côte d'azur","nice"],
    loiredalen:["loiredalen","loire"],
    alsace:["alsace","strasbourg"],
    "alpane-fr":["alpane-fr","alps","savoie","chamonix"],
    tyskland:["tyskland","germany","deutschland","nord-tyskland","bayern","rheinland","aust-tyskland","berlin"],
    bayern:["bayern","bavaria","münchen","munich"],
    "nord-tyskland":["nord-tyskland","hamburg","bremen","north germany"],
    rheinland:["rheinland","rhine","cologne","köln","düsseldorf"],
    "aust-tyskland":["aust-tyskland","saxony","sachsen","dresden","leipzig"],
    berlin:["berlin"],
    nederland:["nederland","netherlands","holland"],
    belgia:["belgia","belgium"],
    sveits:["sveits","switzerland","schweiz"],
    austerrike:["austerrike","austria","österreich"],
    italia:["italia","italy"],
    spania:["spania","spain","españa"],
    usa:["usa","united states","america","mid-atlantic","pacific coast","mountain west",
         "new england","southeast usa","midwest usa","texas gulf","alaska hawaii"],
    "mid-atlantic":["mid-atlantic"],
    "pacific coast":["pacific coast"],
    "mountain west":["mountain west"],
    "new england":["new england"],
    "southeast usa":["southeast usa"],
    "midwest usa":["midwest usa"],
    "texas gulf":["texas gulf"],
    "alaska hawaii":["alaska hawaii"],
    canada:["canada"],
    australia:["australia"],
    "new zealand":["new zealand"],
    japan:["japan"],
  };

  const ok = new Set();
  cfg.geos.forEach(g => { (GM[g.toLowerCase()] || [g.toLowerCase()]).forEach(v => ok.add(v)); });
  let f = all.filter(c => [...ok].some(a => (c.country||"").toLowerCase().includes(a)));
  if (f.length === 0) f = all;

  if (cfg.months && cfg.months !== "heilars") {
    const ws = f.filter(c => c.nextSeasonStart === "heilars" || c.nextSeasonStart === cfg.months);
    if (ws.length >= 3) f = ws;
  }

  // Segment-filter — berre bruk om det gir nok resultat
  if (cfg.segs && cfg.segs.length > 0) {
    const ws = f.filter(c => cfg.segs.some(s =>
      (c.segment||"").toLowerCase().includes(s.toLowerCase().split("/")[0])
    ));
    // Berre filtrer på segment om det gir minst 8 treff
    if (ws.length >= 8) f = ws;
    // Mellom 3-7: berik med resten (geo+sesong utan segmentfilter)
    else if (ws.length >= 3) {
      const extra = f.filter(c => !ws.includes(c));
      f = [...ws, ...extra];
    }
    // Under 3: ignorer segmentfilter — vis alle geo+sesong-treff
  }

  // Garantert minimum: om framleis for få, ta alle frå same geo utan sesongfilter
  if (f.length < 10 && cfg.geos?.length > 0) {
    const ok2 = new Set();
    cfg.geos.forEach(g => { (GM[g.toLowerCase()] || [g.toLowerCase()]).forEach(v => ok2.add(v)); });
    const geoOnly = all.filter(c => [...ok2].some(a => (c.country||"").toLowerCase().includes(a)));
    const seen = new Set(f.map(c => c.company));
    for (const c of geoOnly) {
      if (!seen.has(c.company)) { f.push(c); seen.add(c.company); }
    }
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

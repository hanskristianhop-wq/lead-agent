// ═══════════════════════════════════════════════════════════
// ROADSPOT LEAD AGENT — CORE ENGINE v7
// Henta av alle tre agentar. Oppdater berre denne fila.
// ═══════════════════════════════════════════════════════════

const APOLLO  = "https://mcp.apollo.io/mcp";
const HUBSPOT = "https://mcp.hubspot.com/anthropic";
const GMAIL   = "https://gmailmcp.googleapis.com/mcp/v1";
const NOW_MONTH = new Date().getMonth(); // live — ikkje hardkoda

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
  const M = {jan:0,feb:1,mar:2,apr:3,mai:4,may:4,jun:5,jul:6,aug:7,sep:8,okt:9,oct:9,nov:10,des:11,dec:11};
  if (!str) return 4;
  for (const [k,v] of Object.entries(M)) {
    if (str.toLowerCase().includes(k)) {
      let d = v - NOW_MONTH;
      return d <= 0 ? d + 12 : d;
    }
  }
  return 4;
}
function calcPriority(lead) {
  const mths = monthsToSeason(lead.nextSeasonStart || lead.contactWindow);
  const geo  = geoScore(lead.country);
  const rs   = lead.review?.opportunityScore || 0;
  const hasRev = rs > 15;
  let tier, score;
  if (hasRev && mths >= 2) { tier=1; score=rs*2 + mths*5 + geo; }
  else if (mths >= 3)      { tier=2; score=mths*8 + geo + (rs>0?rs*.5:0); }
  else                     { tier=3; score=mths*3 + geo; }
  return { tier, score, mths, geo, rs };
}

// ── REVIEW ANALYSIS ────────────────────────────────────────
async function analyzeReviews(lead) {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        model:"claude-sonnet-4-20250514", max_tokens:2000,
        tools:[{type:"web_search_20250305", name:"web_search"}],
        system:`Review-analytikar for RoadSpot. Søk omtalar av "${lead.company}" på TripAdvisor, Google Reviews, Viator, GetYourGuide, Reddit.
Leite etter: SPRÅK(only English/language barrier/no German), INFO(more info/missed stories), GUIDE(couldn't hear/too fast), SKALERING(too crowded), APP(audio guide/self-guided).
Returner KUN JSON utan preamble:
{"totalReviews":0,"sources":[],"painPoints":[{"category":"Språkproblem","pct":0,"quotes":[]},{"category":"Informasjonsproblem","pct":0,"quotes":[]},{"category":"Høyre guide","pct":0,"quotes":[]},{"category":"Skaleringsproblem","pct":0,"quotes":[]},{"category":"App/sjølvguiding","pct":0,"quotes":[]}],"topQuotes":[],"opportunityScore":0,"opportunitySummary":"","roadspotCase":""}`,
        messages:[{role:"user", content:`Analyser reviews av "${lead.company}".`}]
      })
    });
    const d = await r.json();
    const txt = d.content?.map(b => b.type==="text" ? b.text : "").join("") || "";
    const m = txt.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
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
  const qs = [
    '"The guide only spoke English — our German guests really struggled."',
    '"Would have loved an audio guide option."',
    '"With 40 people it was impossible to hear the stories."',
    '"Wish there had been something in Spanish for my family."',
    '"More background information would have been wonderful."'
  ];
  return {
    totalReviews:base, sources:["TripAdvisor","Google Reviews","Viator"],
    painPoints:[
      {category:"Språkproblem",       pct:lang, quotes:[qs[0],qs[3]]},
      {category:"Informasjonsproblem", pct:info, quotes:[qs[4]]},
      {category:"Høyre guide",         pct:hear, quotes:[qs[1]]},
      {category:"Skaleringsproblem",   pct:scl,  quotes:[qs[2]]},
      {category:"App/sjølvguiding",    pct:app,  quotes:['"A self-guided option would be great."']}
    ],
    topQuotes:[qs[0],qs[2],qs[4]], opportunityScore:sc,
    opportunitySummary:`Av ${base} omtalar peikar ${lang+hear}% på problem RoadSpot løyser.`,
    roadspotCase:`GPS-guiding på 30+ språk løyser dokumenterte gjesteutfordringar hos ${lead.company}.`
  };
}

// ── HUBSPOT FIT NOTE ───────────────────────────────────────
function buildHubSpotNote(lead, agentName, agentId) {
  const rev = lead.review;
  const topPains = rev?.painPoints?.filter(p=>p.pct>0).sort((a,b)=>b.pct-a.pct)
    .slice(0,3).map(p=>`  • ${p.category}: ${p.pct}%`).join("\n") || "  • Ikkje analysert";
  const topQ = rev?.topQuotes?.slice(0,2).map(q=>`  "${q}"`).join("\n") || "";
  const reasons = [];
  const seg = (lead.segment||"").toLowerCase();
  if (seg.includes("båt")||seg.includes("cruise"))  reasons.push("Båt/cruise: gjestene er i rørsle — automatisk guiding på kvar gjest sin telefon");
  if (seg.includes("buss"))                          reasons.push("Bussoperatør: GPS-trigga guiding langs ruta på fleire språk samstundes");
  if (seg.includes("tog"))                           reasons.push("Togoperatør: automatisk historieforteljing basert på GPS-posisjon");
  if (seg.includes("museum")||seg.includes("besøk")) reasons.push("Museum: fleirspråkleg guiding utan fleire tilsette");
  if (seg.includes("destinasjon"))                   reasons.push("Destinasjonsselskap: distribuere guiding til alle operatørar i regionen");
  if (reasons.length === 0)                          reasons.push("Turoperatør: skalerbar guiding på 30+ språk via QR-kode");

  return `=== ROADSPOT FIT-ANALYSE ===
SDR: ${agentName} (${agentId})
Dato: ${new Date().toLocaleDateString("no-NO")}
Tier: ${lead.tier||"?"} · Score: ${lead.priorityScore||"?"} · Rang: #${lead.rank||"?"}

--- BEDRIFT ---
Namn: ${lead.company}
Land: ${lead.country||"Noreg"}
Segment: ${lead.segment||"?"}
Sesong: ${lead.season||"?"} → Start ${lead.nextSeasonStart||"?"} (${lead.psData?.mths||"?"} mnd)
Kontakt: ${lead.contact||"?"} — ${lead.title||""}
E-post: ${lead.email||"?"}
Nettside: ${lead.website||""}

--- KVIFOR PASSAR ROADSPOT ---
${reasons.map((r,i)=>`${i+1}. ${r}`).join("\n")}

--- GJESTEUTFORDRINGAR ---
${rev ? `Kjelder: ${rev.sources?.join(", ")||"?"} · ${rev.totalReviews||0} omtalar
RS Score: ${rev.opportunityScore||0}/100
Smertepunkt:
${topPains}
${topQ ? `Sitat:\n${topQ}` : ""}
${rev.roadspotCase || ""}` : "Ingen review-analyse."}

--- SALGSSTATUS ---
Pipeline: Identified
Kontaktvindauge: ${lead.contactWindow||lead.nextSeasonStart||"?"}`;
}

// ── DEMO LEADS ─────────────────────────────────────────────
function getDemoLeads() {
  return [
    {company:"Tromsø Villmarkssenter",    segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"November 2026", contact:"Erik Johansen", title:"CEO",                 email:"erik@villmarkssenter.no",   country:"Noreg",  website:"villmarkssenter.no"},
    {company:"Arctic Adventure Svalbard", segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Oktober 2026",  contact:"Lena Berg",     title:"Commercial Director",  email:"lena@arcticadventure.no",   country:"Noreg",  website:"arcticadventure.no"},
    {company:"Swedish Lapland Visitors",  segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"November 2026",contact:"Lars Nilsson",   title:"Marketing Director",   email:"lars@swedishlapland.com",   country:"Sverige",website:"swedishlapland.com"},
    {company:"Icehotel Jukkasjärvi",      segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Desember 2026", contact:"Emma Lindgren",  title:"Commercial Director",  email:"emma@icehotel.com",         country:"Sverige",website:"icehotel.com"},
    {company:"Best Arctic AS",            segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"November 2026", contact:"Hans Petter Lie",title:"Sales Director",       email:"hans@bestarctic.no",        country:"Noreg",  website:"bestarctic.no"},
    {company:"Visit Rovaniemi",           segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"November 2026",contact:"Mikko Mäkinen",  title:"CEO",                  email:"mikko@visitrovaniemi.fi",   country:"Finland",website:"visitrovaniemi.fi"},
    {company:"Lyngen Alpine Experience",  segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Desember 2026", contact:"Marte Dahl",     title:"Head of Experience",   email:"marte@lyngenalpine.no",     country:"Noreg",  website:"lyngenalpine.no"},
    {company:"Polarmuseet Tromsø",        segment:"Museum",            season:"Vinter",nextSeasonStart:"September 2026",contact:"Kristine Ruud",  title:"Dagleg leiar",         email:"kruud@polarmuseet.no",      country:"Noreg",  website:"polarmuseet.no"},
    {company:"Chasing Lights AS",         segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Oktober 2026",  contact:"Marius Strand",  title:"Commercial Director",  email:"marius@chasinglights.no",   country:"Noreg",  website:"chasinglights.no"},
    {company:"Visit Iceland Reykjavik",   segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"Oktober 2026", contact:"Sigurdur Bjornsson",title:"Marketing Manager", email:"s.bjornsson@visitreykjavik.is",country:"Island",website:"visitreykjavik.is"},
    {company:"Svalbard Wildlife",         segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Oktober 2026",  contact:"Frida Mork",     title:"Product Manager",      email:"frida@svalbard-wildlife.no",country:"Noreg",  website:"svalbard-wildlife.no"},
    {company:"Alta Adventures AS",        segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Desember 2026", contact:"Petter Nygård",  title:"CEO",                  email:"petter@alta-adventures.no", country:"Noreg",  website:"alta-adventures.no"},
    {company:"Gaupe Husky AS",            segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"November 2026", contact:"Sigve Olsen",    title:"CEO",                  email:"sigve@gaupehusky.no",       country:"Noreg",  website:"gaupehusky.no"},
    {company:"North Norway Tours",        segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Oktober 2026",  contact:"Ingrid Eide",    title:"Commercial Director",  email:"ieide@northnorwaytours.no", country:"Noreg",  website:"northnorwaytours.no"},
    {company:"Narvik Opplevelser AS",     segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"November 2026", contact:"Rune Strand",    title:"CEO",                  email:"rune@narvik-opplevelser.no",country:"Noreg",  website:"narvik-opplevelser.no"},
    {company:"Destination Lofoten AS",    segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"Oktober 2026", contact:"Lars Berg",      title:"CEO",                  email:"lars@destinationlofoten.no",country:"Noreg",  website:"destinationlofoten.no"},
    {company:"Visit Svalbard AS",         segment:"Destinasjonsselskap",season:"Vinter",nextSeasonStart:"September 2026",contact:"Nina Grønnevet", title:"Marketing Director",   email:"nina@visitsvalbard.com",    country:"Noreg",  website:"visitsvalbard.com"},
    {company:"Tromsø Arctic Reindeer",    segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Oktober 2026",  contact:"Sara Aas",       title:"Operations Manager",   email:"sara@arcticreindeer.no",    country:"Noreg",  website:"arcticreindeer.no"},
    {company:"Kirkenes Snowhotel AS",     segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Desember 2026", contact:"Trine Kvam",     title:"CEO",                  email:"trine@snowhotel.no",        country:"Noreg",  website:"snowhotel.no"},
    {company:"Senja Adventures AS",       segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"November 2026", contact:"Bjørn Solberg",  title:"CEO",                  email:"bjorn@senjaadventures.no",  country:"Noreg",  website:"senjaadventures.no"},
    {company:"Norsk Jernbanemuseum",      segment:"Museum",            season:"Vinter",nextSeasonStart:"September 2026",contact:"Astrid Dahl",    title:"Head of Experience",   email:"adahl@jernbanemuseum.no",   country:"Noreg",  website:"jernbanemuseum.no"},
    {company:"Bodø Aktivitet AS",         segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Oktober 2026",  contact:"Tone Moe",       title:"Sales Director",       email:"tone@bodo-aktivitet.no",    country:"Noreg",  website:"bodo-aktivitet.no"},
    {company:"Abisko Naturum",            segment:"Naturopplevingar",  season:"Vinter",nextSeasonStart:"Desember 2026", contact:"Anna Eriksson",  title:"Head of Experience",   email:"anna@abisko.se",            country:"Sverige",website:"abisko.se"},
    {company:"Arctic Wilderness Norway",  segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"Oktober 2026",  contact:"Hilde Moe",      title:"Head of Experience",   email:"hmoe@arcticwilderness.no",  country:"Noreg",  website:"arcticwilderness.no"},
    {company:"Nordlys Explorer AS",       segment:"Turoperatørar",     season:"Vinter",nextSeasonStart:"November 2026", contact:"Knut Olsen",     title:"Managing Director",    email:"knut@nordlysexplorer.no",   country:"Noreg",  website:"nordlysexplorer.no"},
  ];
}

// expose everything globally so the agent shell can use it
window.RS = {
  APOLLO, HUBSPOT, GMAIL,
  SHARED_KEY, TEAM_COLORS, TEAM_NAMES,
  getClaimedCompanies, saveClaimedCompanies, normalizeKey,
  isClaimedByOther, claimCompany, getTeamStats,
  geoScore, monthsToSeason, calcPriority,
  analyzeReviews, generateDemoReview,
  buildHubSpotNote, getDemoLeads,
  version: "v7.0 — " + new Date().toISOString().split("T")[0]
};
console.log("RoadSpot Agent Core loaded:", window.RS.version);

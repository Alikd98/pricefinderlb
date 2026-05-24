const USD_LBP = 89500;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const GL = {lb:"lb",ae:"ae",sa:"sa",kw:"kw",qa:"qa",eg:"eg",jo:"jo",tr:"tr",gb:"gb",us:"us",de:"de",fr:"fr",ca:"ca",cn:"cn",jp:"jp",in:"in",int:"us"};
const SUFFIX = {lb:"Lebanon",ae:"UAE",sa:"Saudi Arabia",kw:"Kuwait",qa:"Qatar",eg:"Egypt",jo:"Jordan",tr:"Turkey",gb:"UK",us:"USA",de:"Germany",fr:"France",ca:"Canada",cn:"China",jp:"Japan",in:"India",int:""};

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS });
  }

  const KEY = (env && (env.SERPAPI_KEY || env.SERP_API_KEY))
    || "1ac93e1b523032744af388c43aa269c2126b6d91ac1d34c1342317864d2b2d60";

  let query, country;
  try {
    const b = await request.json();
    query   = (b.query   || "").trim();
    country = (b.country || "lb").trim();
  } catch {
    return R({ error: "Bad request" }, 400);
  }

  if (!query) return R({ error: "Missing query" }, 400);

  const gl     = GL[country] || "lb";
  const suffix = SUFFIX[country] !== undefined ? SUFFIX[country] : "Lebanon";
  const q1 = suffix ? `${query} ${suffix} price buy` : `${query} price buy`;
  const q2 = suffix ? `${query} ${suffix}` : query;

  try {
    const [r1, r2] = await Promise.allSettled([
      serp({ api_key: KEY, engine: "google",          q: q1, gl, hl: "en", num: "10" }),
      serp({ api_key: KEY, engine: "google_shopping", q: q2, gl, hl: "en", num: "10" }),
    ]);

    const organic  = r1.status === "fulfilled" ? (r1.value.organic_results  || []) : [];
    const shopping = r2.status === "fulfilled" ? (r2.value.shopping_results || []) : [];

    let fallback = "";
    for (const o of organic) { if (o.thumbnail) { fallback = o.thumbnail; break; } }

    const stores = [];
    const seen   = new Set();

    for (const s of shopping) {
      try {
        const name = (s.source || s.seller || dom(s.link) || "").trim();
        if (!name || name.length < 2) continue;
        const price = shopPrice(s.extracted_price, s.price);
        if (!price) continue;
        const k = slug(name);
        if (seen.has(k)) continue;
        seen.add(k);
        const qty = getQty(s.title || "");
        stores.push({ store:name, url:s.link||s.product_link||"", total_price_usd:f2(price), quantity:qty, price_per_unit_usd:f4(price/qty), type:"online", location:suffix||"International", notes:(s.title||"").slice(0,120), image:s.thumbnail||s.image||fallback });
      } catch (_) {}
    }

    for (const o of organic) {
      try {
        const name = dom(o.displayed_link || o.link || "");
        if (!name || name.length < 2) continue;
        const k = slug(name);
        if (seen.has(k)) continue;
        const text  = (o.snippet || "") + " " + (o.title || "");
        const price = orgPrice(text);
        if (!price) continue;
        seen.add(k);
        const qty = getQty(text);
        stores.push({ store:name, url:o.link||"", total_price_usd:f2(price), quantity:qty, price_per_unit_usd:f4(price/qty), type:"online", location:suffix||"International", notes:(o.snippet||"").slice(0,120), image:o.thumbnail||fallback });
      } catch (_) {}
    }

    stores.sort((a, b) => a.price_per_unit_usd - b.price_per_unit_usd);
    return R({ stores: stores.slice(0, 8) }, 200);

  } catch (e) {
    return R({ error: e.message || "Server error" }, 500);
  }
}

function R(body, status) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

async function serp(params) {
  const url = "https://serpapi.com/search.json?" + new URLSearchParams(params).toString();
  const r = await fetch(url);
  const t = await r.text();
  if (!t) throw new Error("Empty SerpAPI response");
  return JSON.parse(t);
}

function shopPrice(extracted, display) {
  if (typeof extracted === "number" && extracted >= 0.5) {
    return extracted > 500000 ? f4(extracted / USD_LBP) : extracted;
  }
  if (display) {
    const s = String(display).replace(/,(?=\d{3})/g, "");
    const m = s.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/);
    if (m) { const v = parseFloat(m[1]); if (v >= 0.1 && v <= 100000) return v; }
  }
  return null;
}

function orgPrice(text) {
  if (!text) return null;
  for (const p of [/\$\s*([1-9][0-9,]*(?:\.[0-9]{1,2})?)/, /USD\s*([1-9][0-9,]*(?:\.[0-9]{1,2})?)/i]) {
    const m = text.match(p);
    if (m) { const v = parseFloat(m[1].replace(/,/g,"")); if (v>=0.1&&v<=100000) return v; }
  }
  const lbp = text.match(/([1-9][0-9,\s]*)\s*(?:LBP|ل\.ل)/i);
  if (lbp) { const v = parseFloat(lbp[1].replace(/[,\s]/g,"")); if (v>=1000) return f4(v/USD_LBP); }
  return null;
}

function getQty(text) {
  const m = (text||"").match(/(?:pack\s+of|box\s+of|lot\s+of|qty\s*:?\s*)([0-9]+)|([0-9]+)\s*(?:pcs?|pieces?|cards?|rolls?|sheets?|units?)\b/i);
  if (m) { const n=parseInt(m[1]||m[2]); if(n>1&&n<=100000) return n; }
  return 1;
}

function dom(url) {
  try {
    const h = url.replace(/^https?:\/\//i,"").split("/")[0].replace(/^www\./i,"");
    const n = h.split(".")[0];
    return n&&n.length>1?n.replace(/[-_]/g," ").replace(/\b\w/g,c=>c.toUpperCase()):"";
  } catch { return ""; }
}

function slug(s) { return s.toLowerCase().replace(/\s+/g,"").slice(0,24); }
function f2(v)   { return Math.round(v*100)/100; }
function f4(v)   { return Math.round(v*10000)/10000; }

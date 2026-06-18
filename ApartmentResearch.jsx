import { useState, useRef, useEffect, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const DIMENSIONS = ["noise", "maintenance", "safety", "parking", "internet", "commute", "value"];
const DIM_LABELS = { noise: "Noise", maintenance: "Maintenance", safety: "Safety", parking: "Parking", internet: "Internet", commute: "Commute", value: "Value" };
const DIM_ICONS  = { noise: "🔊", maintenance: "🔧", safety: "🔒", parking: "🚗", internet: "📶", commute: "🚌", value: "💰" };

// ─── Style helpers ─────────────────────────────────────────────────────────────
function scoreBg(s)        { return s >= 7 ? "bg-emerald-50 border-emerald-400" : s >= 4 ? "bg-amber-50 border-amber-400" : "bg-red-50 border-red-400"; }
function scoreTextColor(s) { return s >= 7 ? "text-emerald-700" : s >= 4 ? "text-amber-700" : "text-red-700"; }
function scoreBarColor(s)  { return s >= 7 ? "bg-emerald-500" : s >= 4 ? "bg-amber-400" : "bg-red-500"; }

// ─── Gist persistence ─────────────────────────────────────────────────────────
const GITHUB_TOKEN   = import.meta.env.VITE_GITHUB_TOKEN || "";
const INDEX_GIST_KEY = "apt-reviews-index-gist-id";
const INDEX_FILE     = "apartment-reviews-index.json";
const gistEnabled    = () => Boolean(GITHUB_TOKEN);

async function gistFetch(path, opts = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`GitHub ${r.status}: ${t}`); }
  if (r.status === 204) return null;
  return r.json();
}

async function getOrCreateIndex() {
  const id = localStorage.getItem(INDEX_GIST_KEY);
  if (id) {
    try {
      const g = await gistFetch(`/gists/${id}`);
      return { id, entries: JSON.parse(g.files[INDEX_FILE]?.content || "[]") };
    } catch {}
  }
  const g = await gistFetch("/gists", {
    method: "POST",
    body: JSON.stringify({ description: "Apartment Reviews – Index", public: false, files: { [INDEX_FILE]: { content: "[]" } } }),
  });
  localStorage.setItem(INDEX_GIST_KEY, g.id);
  return { id: g.id, entries: [] };
}

async function saveIndex(indexId, entries) {
  await gistFetch(`/gists/${indexId}`, {
    method: "PATCH",
    body: JSON.stringify({ files: { [INDEX_FILE]: { content: JSON.stringify(entries) } } }),
  });
}

async function createSearchGist(apartmentName, payload) {
  const slug     = apartmentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  const filename = `${slug}-${Date.now()}.json`;
  const g = await gistFetch("/gists", {
    method: "POST",
    body: JSON.stringify({ description: `Apartment Research: ${apartmentName}`, public: false, files: { [filename]: { content: JSON.stringify(payload, null, 2) } } }),
  });
  return { gistId: g.id, filename };
}

async function patchSearchGist(gistId, filename, payload) {
  await gistFetch(`/gists/${gistId}`, {
    method: "PATCH",
    body: JSON.stringify({ files: { [filename]: { content: JSON.stringify(payload, null, 2) } } }),
  });
}

async function fetchSearchGist(gistId) {
  const g        = await gistFetch(`/gists/${gistId}`);
  const filename = Object.keys(g.files)[0];
  return { data: JSON.parse(g.files[filename].content), filename };
}

async function deleteSearchGist(gistId) {
  await gistFetch(`/gists/${gistId}`, { method: "DELETE" });
}

// ─── Google Maps loader ────────────────────────────────────────────────────────
let mapsLoadPromise = null;
let mapsAuthError  = null;

window.gm_authFailure = () => {
  mapsAuthError    = new Error("Google Maps API key is invalid or unauthorized. Make sure the Places API is enabled for your key.");
  mapsLoadPromise  = null;
};

function loadGoogleMaps(apiKey) {
  mapsAuthError = null;
  if (window.google?.maps?.places) return Promise.resolve();
  if (mapsLoadPromise) return mapsLoadPromise;

  mapsLoadPromise = new Promise((resolve, reject) => {
    const callbackName = "__gmInit_" + Date.now();
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      delete window[callbackName];
      if (err) { mapsLoadPromise = null; reject(err); } else resolve();
    };
    const timeout = setTimeout(() => done(mapsAuthError || new Error("Google Maps took too long — check your API key.")), 10000);
    window[callbackName] = () => { clearTimeout(timeout); done(null); };
    const script  = document.createElement("script");
    script.src    = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&callback=${callbackName}`;
    script.async  = true;
    script.onerror = () => { clearTimeout(timeout); done(new Error("Failed to load Google Maps — check your API key.")); };
    document.head.appendChild(script);
  });
  return mapsLoadPromise;
}

function getPlaceWithReviews(name, addr) {
  return new Promise((resolve, reject) => {
    const container = document.createElement("div");
    container.style.display = "none";
    document.body.appendChild(container);
    const cleanup = () => { try { document.body.removeChild(container); } catch {} };
    const hang = setTimeout(() => { cleanup(); reject(mapsAuthError || new Error("Places API timed out — check your API key.")); }, 12000);
    let map;
    try { map = new window.google.maps.Map(container, { center: { lat: 0, lng: 0 }, zoom: 1 }); }
    catch (e) { clearTimeout(hang); cleanup(); reject(new Error("Failed to init Google Maps: " + e.message)); return; }
    const svc = new window.google.maps.places.PlacesService(map);
    svc.findPlaceFromQuery({ query: `${name} ${addr}`, fields: ["place_id", "name"] }, (results, status) => {
      if (status !== window.google.maps.places.PlacesServiceStatus.OK || !results?.[0]) {
        clearTimeout(hang); cleanup();
        reject(new Error(status === "REQUEST_DENIED"
          ? "Google Places API key is invalid or unauthorized."
          : `Couldn't find this apartment (status: ${status}).`));
        return;
      }
      svc.getDetails({ placeId: results[0].place_id, fields: ["name", "formatted_address", "reviews", "rating", "url"] }, (place, ds) => {
        clearTimeout(hang); cleanup();
        if (ds !== window.google.maps.places.PlacesServiceStatus.OK || !place) {
          reject(new Error(`Couldn't load place details (status: ${ds}).`)); return;
        }
        resolve(place);
      });
    });
  });
}

// ─── Claude ───────────────────────────────────────────────────────────────────
async function callClaude(messages, systemPrompt, claudeKey) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      ...(claudeKey ? { "x-api-key": claudeKey } : {}),
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1500, system: systemPrompt, messages }),
  });
  if (!r.ok) { const t = await r.text().catch(() => r.statusText); throw new Error(`Claude API error ${r.status}: ${t}`); }
  return (await r.json()).content[0].text;
}

function formatReviewsForPrompt(reviews) {
  return reviews.map((r, i) => `Review #${i + 1} by ${r.author_name} (rated ${r.rating}/5):\n"${r.text}"`).join("\n\n");
}

function parseSourcesFromResponse(text, reviews) {
  const idx         = text.search(/\n?Sources:/i);
  const mainContent = idx > -1 ? text.slice(0, idx).trim() : text.trim();
  const section     = idx > -1 ? text.slice(idx) : "";
  const sources     = [];
  for (const m of section.matchAll(/Review #(\d+)\s*\(([^)]+)\)/gi)) {
    const ri = parseInt(m[1]) - 1;
    const rv = reviews[ri];
    if (rv) sources.push({ reviewIndex: ri, name: m[2].trim(), rating: rv.rating, text: rv.text, url: rv.author_url || null });
  }
  return { mainContent, sources };
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function StarRow({ rating }) {
  const filled = Math.min(5, Math.max(0, Math.round(rating || 0)));
  return (
    <span className="text-amber-400 text-xs tracking-tight">
      {"★".repeat(filled)}{"☆".repeat(5 - filled)}
    </span>
  );
}

function Spinner({ size = "h-5 w-5" }) {
  return (
    <svg className={`animate-spin ${size}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function MarkdownText({ text }) {
  const lines = text.split("\n");
  const elements = [];
  let listItems = [];

  const flushList = () => {
    if (!listItems.length) return;
    elements.push(
      <ul key={`ul-${elements.length}`} className="list-disc list-outside ml-4 space-y-0.5 my-1">
        {listItems.map((item, i) => <li key={i}>{inlineFormat(item)}</li>)}
      </ul>
    );
    listItems = [];
  };

  const inlineFormat = (str) => {
    // Split on **bold** and *italic* markers
    const parts = str.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith("**") && part.endsWith("**"))
        return <strong key={i}>{part.slice(2, -2)}</strong>;
      if (part.startsWith("*") && part.endsWith("*"))
        return <em key={i}>{part.slice(1, -1)}</em>;
      return part;
    });
  };

  lines.forEach((line, i) => {
    const bulletMatch = line.match(/^[-•*]\s+(.+)/);
    if (bulletMatch) {
      listItems.push(bulletMatch[1]);
    } else {
      flushList();
      if (line.trim() === "") {
        elements.push(<br key={`br-${i}`} />);
      } else {
        elements.push(<p key={`p-${i}`} className="my-0.5">{inlineFormat(line)}</p>);
      }
    }
  });
  flushList();

  return <div className="text-sm leading-relaxed space-y-0.5">{elements}</div>;
}

function SourceChip({ src }) {
  const [open, setOpen] = useState(false);
  const chip = (
    <span className="inline-flex items-center gap-1.5 text-xs bg-white border border-slate-300 rounded-full px-2.5 py-1 font-medium text-slate-600 hover:bg-slate-50 transition-colors cursor-pointer select-none">
      <span>{src.name}</span><StarRow rating={src.rating} />
    </span>
  );
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {src.url ? <a href={src.url} target="_blank" rel="noopener noreferrer">{chip}</a> : chip}
        {src.text && <button onClick={() => setOpen(!open)} className="text-xs text-blue-500 hover:text-blue-700 underline underline-offset-2 transition-colors">{open ? "Hide review" : "View review"}</button>}
      </div>
      {open && src.text && <div className="text-xs text-slate-600 italic bg-slate-50 border border-slate-200 rounded-lg p-2.5 ml-1 leading-relaxed">"{src.text}"</div>}
    </div>
  );
}

function SaveBadge({ status }) {
  if (status === "idle") return null;
  const map = {
    saving: { cls: "bg-slate-100 text-slate-500", icon: <Spinner size="h-3 w-3" />, label: "Saving…" },
    saved:  { cls: "bg-emerald-50 text-emerald-600", icon: "✓", label: "Saved to Gist" },
    error:  { cls: "bg-red-50 text-red-500", icon: "⚠", label: "Save failed" },
  };
  const { cls, icon, label } = map[status] || {};
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>
      {icon}{label}
    </span>
  );
}

function SavedSearchCard({ entry, active, loading, onLoad, onDelete }) {
  const date = new Date(entry.savedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return (
    <div
      className={`group rounded-xl border p-3 cursor-pointer transition-all ${active ? "border-blue-400 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"}`}
      onClick={onLoad}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0">
          <p className={`text-sm font-semibold truncate ${active ? "text-blue-800" : "text-slate-800"}`}>{entry.apartmentName}</p>
          <p className="text-xs text-slate-400 truncate mt-0.5">{entry.address}</p>
          <p className="text-xs text-slate-400 mt-1">{date}</p>
        </div>
        <button
          onClick={e => { e.stopPropagation(); onDelete(); }}
          className="shrink-0 opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-400 transition-all text-base leading-none mt-0.5"
          title="Delete"
        >✕</button>
      </div>
      {loading && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-blue-500">
          <Spinner size="h-3 w-3" /> Loading…
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function ApartmentResearch() {
  const placesKey = import.meta.env.VITE_GOOGLE_PLACES_API_KEY || "";
  const claudeKey = import.meta.env.VITE_ANTHROPIC_API_KEY     || "";

  // ── Research state
  const [aptName,   setAptName]   = useState("");
  const [aptAddress, setAptAddress] = useState("");
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);
  const [placeInfo, setPlaceInfo] = useState(null);
  const [reviews,   setReviews]   = useState([]);
  const [report,    setReport]    = useState(null);

  // ── Chat state
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput,    setChatInput]    = useState("");
  const [chatLoading,  setChatLoading]  = useState(false);
  const chatEndRef = useRef(null);

  // ── Persistence state
  const [savedSearches,  setSavedSearches]  = useState([]);
  const [indexGistId,    setIndexGistId]    = useState(null);
  const [currentGistId,  setCurrentGistId]  = useState(null);
  const [currentFilename,setCurrentFilename]= useState(null);
  const [saveStatus,     setSaveStatus]     = useState("idle");   // idle|saving|saved|error
  const [loadingGistId,  setLoadingGistId]  = useState(null);
  const [sidebarOpen,    setSidebarOpen]    = useState(true);
  const chatDirtyRef = useRef(false);  // true only when user sent a new message (not a restore)

  // ── Load saved searches on mount
  useEffect(() => {
    if (!gistEnabled()) return;
    (async () => {
      try {
        const { id, entries } = await getOrCreateIndex();
        setIndexGistId(id);
        setSavedSearches(entries.slice().reverse()); // newest first
      } catch (e) {
        console.warn("Could not load saved searches:", e.message);
      }
    })();
  }, []);

  // ── Scroll chat to bottom
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages, chatLoading]);

  // ── Auto-save when report first loads
  useEffect(() => {
    if (!report || !gistEnabled() || !indexGistId) return;
    (async () => {
      setSaveStatus("saving");
      try {
        const payload = { apartmentName: aptName, address: aptAddress, savedAt: new Date().toISOString(), placeInfo, reviews, report, chatHistory: [] };
        const { gistId, filename } = await createSearchGist(aptName, payload);
        setCurrentGistId(gistId);
        setCurrentFilename(filename);

        // Update index
        const newEntry = { gistId, filename, apartmentName: aptName, address: aptAddress, savedAt: payload.savedAt };
        const { entries } = await getOrCreateIndex();
        const updated = [...entries, newEntry];
        await saveIndex(indexGistId, updated);
        setSavedSearches(updated.slice().reverse());
        setSaveStatus("saved");
      } catch (e) {
        console.warn("Save failed:", e.message);
        setSaveStatus("error");
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);

  // ── Auto-update gist when chat changes (only on new user messages)
  useEffect(() => {
    if (!chatDirtyRef.current || !currentGistId || !currentFilename || !gistEnabled()) return;
    chatDirtyRef.current = false;
    (async () => {
      try {
        const payload = { apartmentName: aptName, address: aptAddress, savedAt: new Date().toISOString(), placeInfo, reviews, report, chatHistory: chatMessages };
        await patchSearchGist(currentGistId, currentFilename, payload);
        // Update savedAt in index
        const { id: idxId, entries } = await getOrCreateIndex();
        const updated = entries.map(e => e.gistId === currentGistId ? { ...e, savedAt: payload.savedAt } : e);
        await saveIndex(idxId, updated);
        setSavedSearches(updated.slice().reverse());
      } catch (e) {
        console.warn("Chat sync failed:", e.message);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages]);

  // ── Research pipeline
  const handleResearch = async () => {
    if (!aptName.trim() || !aptAddress.trim()) { setError("Please enter an apartment name and address."); return; }
    if (!placesKey || !claudeKey) { setError("API keys missing — check your .env file."); return; }
    setLoading(true); setError(null); setReport(null); setPlaceInfo(null);
    setReviews([]); setChatMessages([]); setCurrentGistId(null); setCurrentFilename(null);
    setSaveStatus("idle"); chatDirtyRef.current = false;

    try {
      await loadGoogleMaps(placesKey);
      const place = await getPlaceWithReviews(aptName.trim(), aptAddress.trim());
      const googleReviews = place.reviews || [];
      if (!googleReviews.length) throw new Error("No Google reviews found. Try a different name or address.");
      const trimmed = googleReviews.slice(0, 5);
      setReviews(trimmed);
      setPlaceInfo({ name: place.name, address: place.formatted_address });

      const reviewText   = formatReviewsForPrompt(trimmed);
      const systemPrompt = `You are an expert apartment analyst. Analyze resident reviews and score the apartment across 7 dimensions. Respond ONLY with valid JSON — no markdown fences, no preamble.

Schema:
{
  "scores": {
    "noise":       { "score": <1-10>, "reason": "<one line from reviews>" },
    "maintenance": { "score": <1-10>, "reason": "<one line from reviews>" },
    "safety":      { "score": <1-10>, "reason": "<one line from reviews>" },
    "parking":     { "score": <1-10>, "reason": "<one line from reviews>" },
    "internet":    { "score": <1-10>, "reason": "<one line from reviews>" },
    "commute":     { "score": <1-10>, "reason": "<one line from reviews>" },
    "value":       { "score": <1-10>, "reason": "<one line from reviews>" }
  },
  "happy_here": "<2-3 sentences: Would someone who works at Wells Fargo Las Colinas (Irving, TX) and attends Lewisville Jamatkhana frequently be happy here?>"
}`;
      const raw  = await callClaude([{ role: "user", content: `Apartment: ${aptName}\nAddress: ${aptAddress}\n\nReviews:\n\n${reviewText}` }], systemPrompt, claudeKey);
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { const m = raw.match(/\{[\s\S]*\}/); if (!m) throw new Error("Claude returned unexpected format."); parsed = JSON.parse(m[0]); }
      setReport(parsed);
    } catch (e) {
      setError(e.message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  // ── Load saved search
  const handleLoadSearch = useCallback(async (entry) => {
    if (loadingGistId) return;
    setLoadingGistId(entry.gistId);
    try {
      const { data } = await fetchSearchGist(entry.gistId);
      chatDirtyRef.current = false;
      setAptName(data.apartmentName);
      setAptAddress(data.address);
      setPlaceInfo(data.placeInfo);
      setReviews(data.reviews || []);
      setReport(data.report);
      setChatMessages(data.chatHistory || []);
      setCurrentGistId(entry.gistId);
      setCurrentFilename(entry.filename);
      setSaveStatus("saved");
      setError(null);
    } catch (e) {
      setError("Failed to load saved search: " + e.message);
    } finally {
      setLoadingGistId(null);
    }
  }, [loadingGistId]);

  // ── Delete saved search
  const handleDeleteSearch = useCallback(async (entry) => {
    try {
      await deleteSearchGist(entry.gistId);
      const { id: idxId, entries } = await getOrCreateIndex();
      const updated = entries.filter(e => e.gistId !== entry.gistId);
      await saveIndex(idxId, updated);
      setSavedSearches(updated.slice().reverse());
      if (currentGistId === entry.gistId) {
        setReport(null); setPlaceInfo(null); setReviews([]); setChatMessages([]);
        setCurrentGistId(null); setCurrentFilename(null); setSaveStatus("idle");
      }
    } catch (e) {
      console.warn("Delete failed:", e.message);
    }
  }, [currentGistId]);

  // ── Chat
  const handleChat = useCallback(async (message) => {
    const msg = message.trim();
    if (!msg || chatLoading || !reviews.length) return;
    setChatMessages(prev => [...prev, { role: "user", content: msg }]);
    setChatInput("");
    setChatLoading(true);
    chatDirtyRef.current = true;

    const reviewText   = formatReviewsForPrompt(reviews);
    const systemPrompt = `You are a helpful assistant answering questions about an apartment based ONLY on the following resident reviews. If the reviews don't mention the topic, say so explicitly. Do not make up information.\n\nEnd every answer with a "Sources" section listing which review numbers you drew from, like:\nSources: Review #1 (John D.), Review #3 (Maria S.)\n\nResident Reviews:\n${reviewText}`;

    try {
      const history = chatMessages.map(m => ({ role: m.role, content: m.rawContent || m.content }));
      history.push({ role: "user", content: msg });
      const responseText = await callClaude(history, systemPrompt, claudeKey);
      const { mainContent, sources } = parseSourcesFromResponse(responseText, reviews);
      setChatMessages(prev => [...prev, { role: "assistant", content: mainContent, rawContent: responseText, sources }]);
    } catch (e) {
      setChatMessages(prev => [...prev, { role: "assistant", content: `Error: ${e.message}`, sources: [] }]);
    } finally {
      setChatLoading(false);
    }
  }, [chatLoading, reviews, chatMessages, claudeKey]);

  const suggestions  = ["Is parking safe at night?", "How is maintenance response time?", "Any noise complaints?"];
  const redditUrl    = `https://www.reddit.com/search/?q=${encodeURIComponent(`"${aptName}" reviews`)}&sort=relevance`;
  const apartmentsUrl= `https://www.apartments.com/search-results/?query=${encodeURIComponent(aptName)}`;
  const mapsUrl      = `https://www.google.com/maps/search/${encodeURIComponent(aptAddress)}`;

  const hasSidebar   = gistEnabled() && savedSearches.length > 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 to-blue-50">
      <div className={`flex ${hasSidebar ? "max-w-5xl" : "max-w-2xl"} mx-auto py-10 px-4 gap-6 transition-all`}>

        {/* ── Sidebar ──────────────────────────────────────────────── */}
        {gistEnabled() && (
          <div className={`shrink-0 transition-all duration-300 ${sidebarOpen && hasSidebar ? "w-60" : "w-0 overflow-hidden"}`}>
            <div className="w-60 space-y-2 sticky top-10">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-slate-700">Saved Searches</h2>
                <span className="text-xs text-slate-400">{savedSearches.length}</span>
              </div>
              {savedSearches.length === 0 && (
                <p className="text-xs text-slate-400 leading-relaxed">Your researched apartments will appear here.</p>
              )}
              {savedSearches.map(entry => (
                <SavedSearchCard
                  key={entry.gistId}
                  entry={entry}
                  active={currentGistId === entry.gistId}
                  loading={loadingGistId === entry.gistId}
                  onLoad={() => handleLoadSearch(entry)}
                  onDelete={() => handleDeleteSearch(entry)}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Main content ─────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 space-y-6">

          {/* Header */}
          <div className="text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 shadow-md mb-4">
              <span className="text-2xl">🏢</span>
            </div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Apartment Research Tool</h1>
            <p className="text-slate-500 mt-1.5 text-sm">AI-powered analysis from real Google reviews</p>
          </div>

          {/* ── Input card ─────────────────────────────────────────── */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-slate-800 flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-bold">1</span>
                Enter Apartment Details
              </h2>
              <div className="flex items-center gap-2">
                <SaveBadge status={saveStatus} />
                {gistEnabled() && hasSidebar && (
                  <button onClick={() => setSidebarOpen(!sidebarOpen)} className="text-xs text-slate-400 hover:text-slate-600 transition-colors">
                    {sidebarOpen ? "Hide history" : "Show history"}
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-3.5">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Apartment Name</label>
                <input type="text" value={aptName} onChange={e => setAptName(e.target.value)} onKeyDown={e => e.key === "Enter" && handleResearch()} placeholder="e.g. The Alexan Las Colinas" className="w-full px-3.5 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Apartment Address</label>
                <input type="text" value={aptAddress} onChange={e => setAptAddress(e.target.value)} onKeyDown={e => e.key === "Enter" && handleResearch()} placeholder="e.g. 400 E Las Colinas Blvd, Irving, TX 75039" className="w-full px-3.5 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow" />
              </div>
              <button onClick={handleResearch} disabled={loading} className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-xl transition-colors flex items-center justify-center gap-2 text-sm shadow-sm">
                {loading ? <><Spinner /><span>Researching apartment…</span></> : <><span>🔍</span><span>Research This Apartment</span></>}
              </button>
            </div>

            {error && (
              <div className="mt-4 flex items-start gap-2.5 p-3.5 bg-red-50 border border-red-200 rounded-xl">
                <span className="text-red-500 mt-0.5 shrink-0">⚠️</span>
                <p className="text-red-700 text-sm leading-relaxed">{error}</p>
              </div>
            )}

            {!gistEnabled() && (
              <p className="mt-3 text-xs text-slate-400 text-center">
                Add <code className="bg-slate-100 px-1 rounded">VITE_GITHUB_TOKEN</code> to .env to enable search history
              </p>
            )}
          </div>

          {/* ── Report card ────────────────────────────────────────── */}
          {report && placeInfo && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <div className="mb-5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h2 className="text-xl font-bold text-slate-900 leading-tight">{placeInfo.name}</h2>
                    <p className="text-slate-500 text-sm mt-0.5">{placeInfo.address}</p>
                  </div>
                  <span className="shrink-0 text-xs text-slate-400 bg-slate-100 rounded-full px-2 py-1 mt-1">{reviews.length} review{reviews.length !== 1 ? "s" : ""}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
                {DIMENSIONS.map(dim => {
                  const d = report.scores?.[dim];
                  if (!d) return null;
                  return (
                    <div key={dim} className={`border-2 rounded-xl p-3.5 ${scoreBg(d.score)}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-base">{DIM_ICONS[dim]}</span>
                        <span className={`text-2xl font-extrabold ${scoreTextColor(d.score)}`}>{d.score}</span>
                      </div>
                      <div className="mb-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">{DIM_LABELS[dim]}</span>
                          <span className="text-xs text-slate-400">/ 10</span>
                        </div>
                        <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${scoreBarColor(d.score)}`} style={{ width: `${d.score * 10}%` }} />
                        </div>
                      </div>
                      <p className="text-xs text-slate-600 leading-snug">{d.reason}</p>
                    </div>
                  );
                })}
              </div>

              <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-base">🏠</div>
                  <div>
                    <h3 className="font-semibold text-blue-900 text-sm mb-1">Would you be happy here?</h3>
                    <p className="text-blue-800 text-sm leading-relaxed">{report.happy_here}</p>
                    <p className="text-blue-400 text-xs mt-1.5 italic">Context: Wells Fargo Las Colinas (Irving, TX) + Lewisville Jamatkhana</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Quick links ────────────────────────────────────────── */}
          {report && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <h2 className="text-base font-semibold text-slate-800 mb-3 flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-bold">2</span>
                Quick Research Links
              </h2>
              <div className="flex flex-wrap gap-2.5">
                <a href={redditUrl}     target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 px-4 py-2.5 bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-sm font-semibold transition-colors shadow-sm">🤖 Search Reddit</a>
                <a href={apartmentsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 px-4 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-semibold transition-colors shadow-sm">🏘️ Apartments.com</a>
                <a href={mapsUrl}       target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-semibold transition-colors shadow-sm">📍 Google Maps Reviews</a>
              </div>
            </div>
          )}

          {/* ── RAG Chatbot ────────────────────────────────────────── */}
          {report && reviews.length > 0 && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <h2 className="text-base font-semibold text-slate-800 mb-1 flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-bold">3</span>
                Ask About This Apartment
              </h2>
              <p className="text-xs text-slate-400 mb-4 ml-8">Answers grounded in the Google reviews only</p>

              <div className="flex flex-wrap gap-2 mb-4">
                {suggestions.map(s => (
                  <button key={s} onClick={() => handleChat(s)} disabled={chatLoading} className="px-3.5 py-1.5 bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-700 rounded-full text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed">{s}</button>
                ))}
              </div>

              {chatMessages.length > 0 && (
                <div className="space-y-3 mb-4 max-h-[480px] overflow-y-auto px-1 py-1">
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`flex items-end gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                      {msg.role === "assistant" && <div className="shrink-0 w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-sm mb-0.5">🤖</div>}
                      <div className={`max-w-[85%] flex flex-col gap-1.5 ${msg.role === "user" ? "items-end" : "items-start"}`}>
                        <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${msg.role === "user" ? "bg-blue-600 text-white rounded-br-sm" : "bg-slate-100 text-slate-800 rounded-bl-sm"}`}>
                          {msg.role === "user"
                            ? <p className="whitespace-pre-wrap">{msg.content}</p>
                            : <MarkdownText text={msg.content} />}
                        </div>
                        {msg.role === "assistant" && msg.sources?.length > 0 && (
                          <div className="space-y-1.5 px-1">
                            <p className="text-xs text-slate-400 font-medium">Sources cited:</p>
                            {msg.sources.map((src, j) => <SourceChip key={j} src={src} />)}
                          </div>
                        )}
                      </div>
                      {msg.role === "user" && <div className="shrink-0 w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-sm text-white mb-0.5">U</div>}
                    </div>
                  ))}
                  {chatLoading && (
                    <div className="flex items-end gap-2 justify-start">
                      <div className="shrink-0 w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-sm">🤖</div>
                      <div className="bg-slate-100 rounded-2xl rounded-bl-sm px-4 py-3">
                        <div className="flex items-center gap-1">
                          <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                          <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "120ms" }} />
                          <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: "240ms" }} />
                        </div>
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>
              )}

              <div className="flex gap-2">
                <input type="text" value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChat(chatInput); } }} placeholder="Ask anything about this apartment…" disabled={chatLoading} className="flex-1 px-3.5 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-slate-50 transition-shadow" />
                <button onClick={() => handleChat(chatInput)} disabled={chatLoading || !chatInput.trim()} className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold transition-colors flex items-center gap-1.5 shrink-0">
                  {chatLoading ? <Spinner size="h-4 w-4" /> : <span>Send</span>}
                </button>
              </div>
            </div>
          )}

          <p className="text-center text-xs text-slate-400 pb-4">
            Review data from Google Places · Analysis by Claude Sonnet · For research purposes
          </p>
        </div>
      </div>
    </div>
  );
}

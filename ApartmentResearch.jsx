import { useState, useRef, useEffect, useCallback } from "react";
import { onAuthStateChanged } from "firebase/auth";
import {
  doc, getDoc, setDoc, collection, addDoc, updateDoc, deleteDoc,
  query, orderBy, getDocs,
} from "firebase/firestore";
import { auth, db, signInWithGoogle, signInAsGuest, signOutUser } from "./src/firebase.js";

// ─── Constants ────────────────────────────────────────────────────────────────
const DIMENSIONS = ["noise", "maintenance", "safety", "parking", "internet", "commute", "value"];
const DIM_LABELS = { noise: "Noise", maintenance: "Maintenance", safety: "Safety", parking: "Parking", internet: "Internet", commute: "Commute", value: "Value" };
const DIM_ICONS  = { noise: "🔊", maintenance: "🔧", safety: "🔒", parking: "🚗", internet: "📶", commute: "🚌", value: "💰" };

// ─── Style helpers ─────────────────────────────────────────────────────────────
function scoreBg(s)        { return s >= 7 ? "bg-emerald-50 border-emerald-400" : s >= 4 ? "bg-amber-50 border-amber-400" : "bg-red-50 border-red-400"; }
function scoreTextColor(s) { return s >= 7 ? "text-emerald-700" : s >= 4 ? "text-amber-700" : "text-red-700"; }
function scoreBarColor(s)  { return s >= 7 ? "bg-emerald-500" : s >= 4 ? "bg-amber-400" : "bg-red-500"; }

// ─── Firestore persistence ─────────────────────────────────────────────────────
const EMPTY_PROFILE = { workAddress: "", otherDestinations: [{ label: "", address: "" }], otherNotes: "", budget: "", hasPets: false, priorityDims: [] };

async function loadProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { ...EMPTY_PROFILE, ...snap.data() } : EMPTY_PROFILE;
}

async function saveProfile(uid, profile) {
  await setDoc(doc(db, "users", uid), profile, { merge: true });
}

async function listSearches(uid) {
  const snap = await getDocs(query(collection(db, "users", uid, "searches"), orderBy("savedAt", "desc")));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function createSearch(uid, payload) {
  const ref = await addDoc(collection(db, "users", uid, "searches"), payload);
  return ref.id;
}

async function patchSearch(uid, searchId, payload) {
  await updateDoc(doc(db, "users", uid, "searches", searchId), payload);
}

async function fetchSearch(uid, searchId) {
  const snap = await getDoc(doc(db, "users", uid, "searches", searchId));
  return snap.exists() ? snap.data() : null;
}

async function deleteSearch(uid, searchId) {
  await deleteDoc(doc(db, "users", uid, "searches", searchId));
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

function findPlaceOnce(svc, query) {
  return new Promise((resolve) => {
    svc.findPlaceFromQuery({ query, fields: ["place_id", "name"] }, (results, status) => {
      if (status !== window.google.maps.places.PlacesServiceStatus.OK || !results?.[0]) {
        resolve({ status, place: null }); return;
      }
      svc.getDetails({ placeId: results[0].place_id, fields: ["name", "formatted_address", "reviews", "rating", "url"] }, (place, ds) => {
        resolve({ status: ds, place: ds === window.google.maps.places.PlacesServiceStatus.OK ? place : null });
      });
    });
  });
}

function getPlaceWithReviews(name, addr) {
  return new Promise(async (resolve, reject) => {
    const container = document.createElement("div");
    container.style.display = "none";
    document.body.appendChild(container);
    const cleanup = () => { try { document.body.removeChild(container); } catch {} };
    const hang = setTimeout(() => { cleanup(); reject(mapsAuthError || new Error("Places API timed out — check your API key.")); }, 12000);
    let map;
    try { map = new window.google.maps.Map(container, { center: { lat: 0, lng: 0 }, zoom: 1 }); }
    catch (e) { clearTimeout(hang); cleanup(); reject(new Error("Failed to init Google Maps: " + e.message)); return; }
    const svc = new window.google.maps.places.PlacesService(map);

    // A full street address combined with the name can make Places resolve to the literal
    // geocoded address point (no reviews) instead of the named business listing, so the
    // name alone is tried first since that's what actually finds the reviewable POI.
    let { status, place } = await findPlaceOnce(svc, name);
    if (!place || !place.reviews?.length) {
      const fallback = await findPlaceOnce(svc, `${name} ${addr}`);
      if (fallback.place) { status = fallback.status; place = fallback.place; }
    }

    clearTimeout(hang); cleanup();
    if (!place) {
      reject(new Error(status === "REQUEST_DENIED"
        ? "Google Places API key is invalid or unauthorized."
        : `Couldn't find this apartment (status: ${status}).`));
      return;
    }
    resolve(place);
  });
}

function getCommuteInfo(originAddr, destAddr) {
  return new Promise((resolve) => {
    if (!originAddr?.trim() || !destAddr?.trim() || !window.google?.maps) { resolve(null); return; }
    try {
      const svc = new window.google.maps.DistanceMatrixService();
      svc.getDistanceMatrix({
        origins: [originAddr],
        destinations: [destAddr],
        travelMode: window.google.maps.TravelMode.DRIVING,
      }, (response, status) => {
        const el = response?.rows?.[0]?.elements?.[0];
        if (status !== "OK" || !el || el.status !== "OK") { resolve(null); return; }
        resolve({ distanceText: el.distance.text, durationText: el.duration.text });
      });
    } catch { resolve(null); }
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
    saved:  { cls: "bg-emerald-50 text-emerald-600", icon: "✓", label: "Saved" },
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

  // ── Auth state
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => { setUser(u); setAuthLoading(false); });
    return unsub;
  }, []);

  // ── Research state
  const [aptName,   setAptName]   = useState("");
  const [aptAddress, setAptAddress] = useState("");
  const [workAddress, setWorkAddress] = useState("");
  const [otherDestinations, setOtherDestinations] = useState([{ label: "", address: "" }]);
  const [otherNotes, setOtherNotes] = useState("");
  const [budget, setBudget] = useState("");
  const [hasPets, setHasPets] = useState(false);
  const [priorityDims, setPriorityDims] = useState([]);
  const profileLoadedRef = useRef(false); // guards against writing the empty default back over Firestore before the real profile loads
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
  const [currentSearchId,setCurrentSearchId]= useState(null);
  const [saveStatus,     setSaveStatus]     = useState("idle");   // idle|saving|saved|error
  const [loadingSearchId,setLoadingSearchId]= useState(null);
  const [sidebarOpen,    setSidebarOpen]    = useState(true);
  const chatDirtyRef = useRef(false);  // true only when user sent a new message (not a restore)

  // ── Load profile + saved searches when the user signs in
  useEffect(() => {
    profileLoadedRef.current = false;
    if (!user) { setSavedSearches([]); return; }
    (async () => {
      try {
        const profile = await loadProfile(user.uid);
        setWorkAddress(profile.workAddress);
        setOtherDestinations(profile.otherDestinations.length ? profile.otherDestinations : [{ label: "", address: "" }]);
        setOtherNotes(profile.otherNotes);
        setBudget(profile.budget);
        setHasPets(profile.hasPets);
        setPriorityDims(profile.priorityDims);
        profileLoadedRef.current = true;

        const searches = await listSearches(user.uid);
        setSavedSearches(searches);
      } catch (e) {
        console.warn("Could not load profile/saved searches:", e.message);
      }
    })();
  }, [user]);

  // ── Scroll chat to bottom
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages, chatLoading]);

  // ── Persist user priorities to Firestore (personal preferences, not tied to one search)
  useEffect(() => {
    if (!user || !profileLoadedRef.current) return;
    saveProfile(user.uid, { workAddress, otherDestinations, otherNotes, budget, hasPets, priorityDims })
      .catch(e => console.warn("Profile save failed:", e.message));
  }, [user, workAddress, otherDestinations, otherNotes, budget, hasPets, priorityDims]);

  const updateDestination = (i, field, value) => {
    setOtherDestinations(prev => prev.map((d, idx) => idx === i ? { ...d, [field]: value } : d));
  };
  const addDestination = () => setOtherDestinations(prev => [...prev, { label: "", address: "" }]);
  const removeDestination = (i) => setOtherDestinations(prev => prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i));

  const togglePriorityDim = (dim) => {
    setPriorityDims(prev => prev.includes(dim) ? prev.filter(d => d !== dim) : [...prev, dim]);
  };

  // ── Auto-save when report first loads
  useEffect(() => {
    if (!report || !user) return;
    (async () => {
      setSaveStatus("saving");
      try {
        const payload = { apartmentName: aptName, address: aptAddress, savedAt: new Date().toISOString(), placeInfo, reviews, report, chatHistory: [] };
        const id = await createSearch(user.uid, payload);
        setCurrentSearchId(id);
        setSavedSearches(prev => [{ id, ...payload }, ...prev]);
        setSaveStatus("saved");
      } catch (e) {
        console.warn("Save failed:", e.message);
        setSaveStatus("error");
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);

  // ── Auto-update saved search when chat changes (only on new user messages)
  useEffect(() => {
    if (!chatDirtyRef.current || !currentSearchId || !user) return;
    chatDirtyRef.current = false;
    (async () => {
      try {
        const savedAt = new Date().toISOString();
        await patchSearch(user.uid, currentSearchId, { savedAt, chatHistory: chatMessages });
        setSavedSearches(prev => prev.map(e => e.id === currentSearchId ? { ...e, savedAt } : e)
          .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt)));
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
    setReviews([]); setChatMessages([]); setCurrentSearchId(null);
    setSaveStatus("idle"); chatDirtyRef.current = false;

    try {
      await loadGoogleMaps(placesKey);
      const place = await getPlaceWithReviews(aptName.trim(), aptAddress.trim());
      const googleReviews = place.reviews || [];
      if (!googleReviews.length) throw new Error("No Google reviews found. Try a different name or address.");
      const trimmed = googleReviews.slice(0, 5);
      setReviews(trimmed);
      setPlaceInfo({ name: place.name, address: place.formatted_address });

      const reviewText = formatReviewsForPrompt(trimmed);

      const workCommute = await getCommuteInfo(place.formatted_address, workAddress.trim());
      const validDestinations = otherDestinations.filter(d => d.address.trim());
      const otherCommutes = await Promise.all(validDestinations.map(d => getCommuteInfo(place.formatted_address, d.address.trim())));

      const contextLines = [];
      if (workAddress.trim()) {
        contextLines.push(`Work location: ${workAddress.trim()}` + (workCommute ? ` (commute: ${workCommute.durationText}, ${workCommute.distanceText})` : ""));
      }
      validDestinations.forEach((d, i) => {
        const commute = otherCommutes[i];
        const label = d.label.trim() || `Frequent destination ${i + 1}`;
        contextLines.push(`${label}: ${d.address.trim()}` + (commute ? ` (commute: ${commute.durationText}, ${commute.distanceText})` : ""));
      });
      if (budget.trim()) contextLines.push(`Budget: ${budget.trim()}`);
      if (hasPets) contextLines.push(`Has pets`);
      if (priorityDims.length) contextLines.push(`Especially cares about: ${priorityDims.map(d => DIM_LABELS[d]).join(", ")}`);
      if (otherNotes.trim()) contextLines.push(`Other priorities: ${otherNotes.trim()}`);
      const contextSummary = contextLines.join("\n");

      const happyHereInstruction = contextSummary
        ? `<2-3 sentences: Given the following about the person —\n${contextSummary}\n— would they be happy living here? Weigh their stated priorities (including any commute times given) directly against what the reviews say.>`
        : `<2-3 sentences: Based on the reviews, who would be happy living here and who wouldn't?>`;
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
  "happy_here": "${happyHereInstruction}"
}`;
      const raw  = await callClaude([{ role: "user", content: `Apartment: ${aptName}\nAddress: ${aptAddress}\n\nReviews:\n\n${reviewText}` }], systemPrompt, claudeKey);
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { const m = raw.match(/\{[\s\S]*\}/); if (!m) throw new Error("Claude returned unexpected format."); parsed = JSON.parse(m[0]); }
      parsed.userContext = contextSummary;
      setReport(parsed);
    } catch (e) {
      setError(e.message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  // ── Load saved search
  const handleLoadSearch = useCallback(async (entry) => {
    if (loadingSearchId || !user) return;
    setLoadingSearchId(entry.id);
    try {
      const data = await fetchSearch(user.uid, entry.id);
      if (!data) throw new Error("Search not found.");
      chatDirtyRef.current = false;
      setAptName(data.apartmentName);
      setAptAddress(data.address);
      setPlaceInfo(data.placeInfo);
      setReviews(data.reviews || []);
      setReport(data.report);
      setChatMessages(data.chatHistory || []);
      setCurrentSearchId(entry.id);
      setSaveStatus("saved");
      setError(null);
    } catch (e) {
      setError("Failed to load saved search: " + e.message);
    } finally {
      setLoadingSearchId(null);
    }
  }, [loadingSearchId, user]);

  // ── Delete saved search
  const handleDeleteSearch = useCallback(async (entry) => {
    if (!user) return;
    try {
      await deleteSearch(user.uid, entry.id);
      setSavedSearches(prev => prev.filter(e => e.id !== entry.id));
      if (currentSearchId === entry.id) {
        setReport(null); setPlaceInfo(null); setReviews([]); setChatMessages([]);
        setCurrentSearchId(null); setSaveStatus("idle");
      }
    } catch (e) {
      console.warn("Delete failed:", e.message);
    }
  }, [currentSearchId, user]);

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

  const hasSidebar = savedSearches.length > 0;

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-100 to-blue-50 flex items-center justify-center">
        <Spinner size="h-8 w-8 text-slate-400" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-100 to-blue-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 max-w-sm w-full text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 shadow-md mb-4">
            <span className="text-2xl">🏢</span>
          </div>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">Apartment Research Tool</h1>
          <p className="text-slate-500 mt-1.5 text-sm mb-6">Sign in to save your priorities and research history to your account.</p>
          <button
            onClick={() => signInWithGoogle().catch(e => setError(e.message))}
            className="w-full flex items-center justify-center gap-2.5 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 font-semibold py-2.5 px-4 rounded-xl transition-colors text-sm shadow-sm"
          >
            <svg className="w-4 h-4" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20.5H24v7h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5-5C33.9 6.1 29.2 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l5.7 4.2C13.6 15.1 18.4 12 24 12c3.1 0 5.8 1.1 8 3l5-5C33.9 6.1 29.2 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.4-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20.5H24v7h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.2 5.2C40.9 35.2 44 30 44 24c0-1.3-.1-2.7-.4-3.5z"/></svg>
            Sign in with Google
          </button>
          <button
            onClick={() => signInAsGuest().catch(e => setError(e.message))}
            className="w-full text-slate-400 hover:text-slate-600 text-xs mt-3 transition-colors"
          >
            Just want to try it out? Continue as guest
          </button>
          {error && <p className="text-red-600 text-xs mt-3">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 to-blue-50">
      <div className={`flex ${hasSidebar ? "max-w-5xl" : "max-w-2xl"} mx-auto py-10 px-4 gap-6 transition-all`}>

        {/* ── Sidebar ──────────────────────────────────────────────── */}
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
                key={entry.id}
                entry={entry}
                active={currentSearchId === entry.id}
                loading={loadingSearchId === entry.id}
                onLoad={() => handleLoadSearch(entry)}
                onDelete={() => handleDeleteSearch(entry)}
              />
            ))}
          </div>
        </div>

        {/* ── Main content ─────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 space-y-6">

          {/* Header */}
          <div className="text-center relative">
            <button
              onClick={() => signOutUser()}
              className="absolute right-0 top-0 text-xs text-slate-400 hover:text-slate-600 transition-colors flex items-center gap-1.5"
              title={user.email}
            >
              {user.photoURL && <img src={user.photoURL} alt="" className="w-5 h-5 rounded-full" />}
              Sign out
            </button>
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 shadow-md mb-4">
              <span className="text-2xl">🏢</span>
            </div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Apartment Research Tool</h1>
            <p className="text-slate-500 mt-1.5 text-sm">AI-powered analysis from real Google reviews</p>
            {user.isAnonymous && (
              <p className="text-amber-600 bg-amber-50 border border-amber-200 rounded-full inline-block px-3 py-1 text-xs mt-3">
                Browsing as guest — your data won't be saved if you sign out or clear cookies. <button onClick={() => signInWithGoogle().catch(e => setError(e.message))} className="underline font-medium hover:text-amber-700">Sign in with Google</button> to keep it.
              </p>
            )}
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
                {hasSidebar && (
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
              <div className="pt-1 border-t border-slate-100">
                <p className="text-xs font-medium text-slate-500 mt-2.5 mb-2">Your priorities <span className="text-slate-400 font-normal">(optional — tailors "Would you be happy here?")</span></p>
                <div className="space-y-2.5">
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">Work address</label>
                    <input type="text" value={workAddress} onChange={e => setWorkAddress(e.target.value)} placeholder="e.g. 250 E John Carpenter Fwy, Irving, TX" className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">Other frequent destinations</label>
                    <div className="space-y-1.5">
                      {otherDestinations.map((d, i) => (
                        <div key={i} className="flex gap-1.5">
                          <input type="text" value={d.label} onChange={e => updateDestination(i, "label", e.target.value)} placeholder="Label (e.g. place of worship)" className="w-32 px-2.5 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow shrink-0" />
                          <input type="text" value={d.address} onChange={e => updateDestination(i, "address", e.target.value)} placeholder="Address" className="flex-1 px-2.5 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow min-w-0" />
                          <button type="button" onClick={() => removeDestination(i)} disabled={otherDestinations.length === 1} className="text-slate-400 hover:text-red-500 disabled:opacity-30 disabled:cursor-not-allowed px-1 shrink-0" aria-label="Remove destination">✕</button>
                        </div>
                      ))}
                    </div>
                    <button type="button" onClick={addDestination} className="mt-1.5 text-xs text-blue-600 hover:text-blue-700 font-medium">+ Add another destination</button>
                  </div>
                  <div className="flex gap-2.5">
                    <div className="flex-1">
                      <label className="block text-xs text-slate-600 mb-1">Budget</label>
                      <input type="text" value={budget} onChange={e => setBudget(e.target.value)} placeholder="e.g. up to $1,800/mo" className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow" />
                    </div>
                    <label className="flex items-center gap-1.5 text-xs text-slate-600 select-none mt-5 shrink-0">
                      <input type="checkbox" checked={hasPets} onChange={e => setHasPets(e.target.checked)} className="rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                      Have pets
                    </label>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">What matters most to you?</label>
                    <div className="flex flex-wrap gap-1.5">
                      {DIMENSIONS.map(dim => (
                        <button key={dim} type="button" onClick={() => togglePriorityDim(dim)}
                          className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${priorityDims.includes(dim) ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-slate-300 text-slate-600 hover:border-blue-400"}`}>
                          {DIM_ICONS[dim]} {DIM_LABELS[dim]}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">Anything else that matters</label>
                    <textarea value={otherNotes} onChange={e => setOtherNotes(e.target.value)} rows={2} placeholder="e.g. light sleeper, work from home, tight move-in timeline" className="w-full px-3.5 py-2 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow resize-none" />
                  </div>
                </div>
                <p className="text-xs text-slate-400 mt-2">Commute times are calculated automatically. Saved on this device for next time.</p>
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
                    {report.userContext && (
                      <p className="text-blue-400 text-xs mt-1.5 italic">Context: {report.userContext}</p>
                    )}
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

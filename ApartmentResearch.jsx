import { useState, useRef, useEffect, useCallback } from "react";

const DIMENSIONS = ["noise", "maintenance", "safety", "parking", "internet", "commute", "value"];

const DIM_LABELS = {
  noise: "Noise",
  maintenance: "Maintenance",
  safety: "Safety",
  parking: "Parking",
  internet: "Internet",
  commute: "Commute",
  value: "Value",
};

const DIM_ICONS = {
  noise: "🔊",
  maintenance: "🔧",
  safety: "🔒",
  parking: "🚗",
  internet: "📶",
  commute: "🚌",
  value: "💰",
};

function scoreBg(score) {
  if (score >= 7) return "bg-emerald-50 border-emerald-400";
  if (score >= 4) return "bg-amber-50 border-amber-400";
  return "bg-red-50 border-red-400";
}

function scoreTextColor(score) {
  if (score >= 7) return "text-emerald-700";
  if (score >= 4) return "text-amber-700";
  return "text-red-700";
}

function scoreBarColor(score) {
  if (score >= 7) return "bg-emerald-500";
  if (score >= 4) return "bg-amber-400";
  return "bg-red-500";
}

function StarRow({ rating }) {
  return (
    <span className="text-amber-400 text-xs">
      {"★".repeat(Math.min(5, Math.max(0, rating || 0)))}
      {"☆".repeat(Math.max(0, 5 - (rating || 0)))}
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

function SourceChip({ src, reviewIdx }) {
  const [open, setOpen] = useState(false);
  const chip = (
    <span className="inline-flex items-center gap-1.5 text-xs bg-white border border-slate-300 rounded-full px-2.5 py-1 font-medium text-slate-600 hover:bg-slate-50 transition-colors cursor-pointer select-none">
      <span>{src.name}</span>
      <StarRow rating={src.rating} />
    </span>
  );

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {src.url ? (
          <a href={src.url} target="_blank" rel="noopener noreferrer">{chip}</a>
        ) : (
          chip
        )}
        {src.text && (
          <button
            onClick={() => setOpen(!open)}
            className="text-xs text-blue-500 hover:text-blue-700 underline underline-offset-2 transition-colors"
          >
            {open ? "Hide review" : "View review"}
          </button>
        )}
      </div>
      {open && src.text && (
        <div className="text-xs text-slate-600 italic bg-slate-50 border border-slate-200 rounded-lg p-2.5 ml-1 leading-relaxed">
          "{src.text}"
        </div>
      )}
    </div>
  );
}

let mapsLoadPromise = null;
let mapsAuthError = null;

// Google Maps calls this global when the API key is invalid/unauthorized
window.gm_authFailure = () => {
  mapsAuthError = new Error("Google Maps API key is invalid or unauthorized. Make sure the Places API is enabled for your key.");
  mapsLoadPromise = null;
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
      if (err) { mapsLoadPromise = null; reject(err); }
      else resolve();
    };

    const timeout = setTimeout(
      () => done(mapsAuthError || new Error("Google Maps took too long — check your API key and that the Places API is enabled.")),
      10000
    );

    window[callbackName] = () => { clearTimeout(timeout); done(null); };

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&callback=${callbackName}`;
    script.async = true;
    script.onerror = () => { clearTimeout(timeout); done(new Error("Failed to load Google Maps — check your API key and that the Places API is enabled.")); };
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

    // Guard against hung callbacks (invalid key, network issue, etc.)
    const hang = setTimeout(() => {
      cleanup();
      reject(mapsAuthError || new Error("Places API request timed out — your API key may be invalid or lack Places API access."));
    }, 12000);

    let map;
    try {
      map = new window.google.maps.Map(container, { center: { lat: 0, lng: 0 }, zoom: 1 });
    } catch (e) {
      clearTimeout(hang); cleanup();
      reject(new Error("Failed to initialize Google Maps: " + e.message));
      return;
    }

    const svc = new window.google.maps.places.PlacesService(map);

    svc.findPlaceFromQuery(
      { query: `${name} ${addr}`, fields: ["place_id", "name"] },
      (results, status) => {
        if (status !== window.google.maps.places.PlacesServiceStatus.OK || !results?.[0]) {
          clearTimeout(hang); cleanup();
          const msg = status === "REQUEST_DENIED"
            ? "Google Places API key is invalid or unauthorized. Check that the Places API is enabled."
            : `Google Places couldn't find this apartment (status: ${status}). Double-check the name and address.`;
          reject(new Error(msg));
          return;
        }

        svc.getDetails(
          { placeId: results[0].place_id, fields: ["name", "formatted_address", "reviews", "rating", "url"] },
          (place, detailStatus) => {
            clearTimeout(hang); cleanup();
            if (detailStatus !== window.google.maps.places.PlacesServiceStatus.OK || !place) {
              reject(new Error(`Couldn't load place details (status: ${detailStatus}).`));
              return;
            }
            resolve(place);
          }
        );
      }
    );
  });
}

async function callClaude(messages, systemPrompt, claudeKey) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      ...(claudeKey ? { "x-api-key": claudeKey } : {}),
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: systemPrompt,
      messages,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`Claude API error ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  return data.content[0].text;
}

function formatReviewsForPrompt(reviews) {
  return reviews.map((r, i) =>
    `Review #${i + 1} by ${r.author_name} (rated ${r.rating}/5):\n"${r.text}"`
  ).join("\n\n");
}

function parseSourcesFromResponse(text, reviews) {
  const sourcesIdx = text.search(/\n?Sources:/i);
  const mainContent = sourcesIdx > -1 ? text.slice(0, sourcesIdx).trim() : text.trim();
  const sourcesSection = sourcesIdx > -1 ? text.slice(sourcesIdx) : "";

  const sources = [];
  if (sourcesSection) {
    const refs = [...sourcesSection.matchAll(/Review #(\d+)\s*\(([^)]+)\)/gi)];
    for (const m of refs) {
      const idx = parseInt(m[1]) - 1;
      const review = reviews[idx];
      if (review) {
        sources.push({
          reviewIndex: idx,
          name: m[2].trim(),
          rating: review.rating,
          text: review.text,
          url: review.author_url || null,
        });
      }
    }
  }
  return { mainContent, sources };
}

export default function ApartmentResearch() {
  const placesKey = import.meta.env.VITE_GOOGLE_PLACES_API_KEY || "";
  const claudeKey = import.meta.env.VITE_ANTHROPIC_API_KEY || "";

  const [aptName, setAptName] = useState("");
  const [aptAddress, setAptAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [placeInfo, setPlaceInfo] = useState(null);
  const [reviews, setReviews] = useState([]);
  const [report, setReport] = useState(null);

  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, chatLoading]);

  const handleResearch = async () => {
    if (!aptName.trim() || !aptAddress.trim()) {
      setError("Please enter an apartment name and address.");
      return;
    }
    if (!placesKey || !claudeKey) {
      setError("API keys are missing — add VITE_GOOGLE_PLACES_API_KEY and VITE_ANTHROPIC_API_KEY to your .env file.");
      return;
    }
    setLoading(true);
    setError(null);
    setReport(null);
    setPlaceInfo(null);
    setReviews([]);
    setChatMessages([]);

    try {
      await loadGoogleMaps(placesKey.trim());
      const place = await getPlaceWithReviews(aptName.trim(), aptAddress.trim());

      const googleReviews = place.reviews || [];
      if (googleReviews.length === 0) {
        throw new Error("No Google reviews found for this apartment. Try a different name or address.");
      }

      const trimmedReviews = googleReviews.slice(0, 5);
      setReviews(trimmedReviews);
      setPlaceInfo({ name: place.name, address: place.formatted_address });

      const reviewText = formatReviewsForPrompt(trimmedReviews);
      const systemPrompt = `You are an expert apartment analyst. Analyze resident reviews and score the apartment across 7 dimensions. Respond ONLY with valid JSON — no markdown fences, no preamble, no trailing text outside the JSON object.

JSON schema (strict):
{
  "scores": {
    "noise":       { "score": <integer 1-10>, "reason": "<one concise line citing the reviews>" },
    "maintenance": { "score": <integer 1-10>, "reason": "<one concise line citing the reviews>" },
    "safety":      { "score": <integer 1-10>, "reason": "<one concise line citing the reviews>" },
    "parking":     { "score": <integer 1-10>, "reason": "<one concise line citing the reviews>" },
    "internet":    { "score": <integer 1-10>, "reason": "<one concise line citing the reviews>" },
    "commute":     { "score": <integer 1-10>, "reason": "<one concise line citing the reviews>" },
    "value":       { "score": <integer 1-10>, "reason": "<one concise line citing the reviews>" }
  },
  "happy_here": "<2-3 sentence answer to: Would someone who works at Wells Fargo Las Colinas (Irving, TX) and attends Lewisville Jamatkhana frequently be happy here? Base your answer strictly on what the reviews say.>"
}`;

      const raw = await callClaude(
        [{ role: "user", content: `Apartment: ${aptName}\nAddress: ${aptAddress}\n\nReviews:\n\n${reviewText}` }],
        systemPrompt,
        claudeKey.trim()
      );

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Try to extract JSON if Claude added stray text
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("Claude returned an unexpected response format. Please try again.");
        parsed = JSON.parse(match[0]);
      }

      setReport(parsed);
    } catch (err) {
      setError(err.message || "An unexpected error occurred. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleChat = useCallback(async (message) => {
    const msg = message.trim();
    if (!msg || chatLoading || reviews.length === 0) return;

    setChatMessages(prev => [...prev, { role: "user", content: msg }]);
    setChatInput("");
    setChatLoading(true);

    const reviewText = formatReviewsForPrompt(reviews);
    const systemPrompt = `You are a helpful assistant answering questions about a specific apartment based ONLY on the following resident reviews. If the reviews don't mention the topic, say so explicitly. Do not make up information or draw on outside knowledge.

End every answer with a "Sources" section listing which review numbers you drew from, formatted exactly like this:
Sources: Review #1 (John D.), Review #3 (Maria S.)

Resident Reviews:
${reviewText}`;

    try {
      // Build history for context (exclude source-parsed metadata)
      const history = chatMessages.map(m => ({ role: m.role, content: m.rawContent || m.content }));
      history.push({ role: "user", content: msg });

      const responseText = await callClaude(history, systemPrompt, claudeKey.trim());
      const { mainContent, sources } = parseSourcesFromResponse(responseText, reviews);

      setChatMessages(prev => [...prev, {
        role: "assistant",
        content: mainContent,
        rawContent: responseText,
        sources,
      }]);
    } catch (err) {
      setChatMessages(prev => [...prev, {
        role: "assistant",
        content: `Sorry, I ran into an error: ${err.message}`,
        sources: [],
      }]);
    } finally {
      setChatLoading(false);
    }
  }, [chatLoading, reviews, chatMessages]);

  const suggestions = [
    "Is parking safe at night?",
    "How is maintenance response time?",
    "Any noise complaints?",
  ];

  const redditUrl = `https://www.reddit.com/search/?q=${encodeURIComponent(`"${aptName}" reviews`)}&sort=relevance`;
  const apartmentsUrl = `https://www.apartments.com/search-results/?query=${encodeURIComponent(aptName)}`;
  const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(aptAddress)}`;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 to-blue-50 py-10 px-4">
      <div className="max-w-2xl mx-auto space-y-6">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 shadow-md mb-4">
            <span className="text-2xl">🏢</span>
          </div>
          <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Apartment Research Tool</h1>
          <p className="text-slate-500 mt-1.5 text-sm">AI-powered analysis from real Google reviews</p>
        </div>

        {/* ── Input Card ─────────────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <h2 className="text-base font-semibold text-slate-800 mb-4 flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-bold">1</span>
            Enter Apartment Details
          </h2>

          <div className="space-y-3.5">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Apartment Name</label>
              <input
                type="text"
                value={aptName}
                onChange={e => setAptName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleResearch()}
                placeholder="e.g. The Alexan Las Colinas"
                className="w-full px-3.5 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Apartment Address</label>
              <input
                type="text"
                value={aptAddress}
                onChange={e => setAptAddress(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleResearch()}
                placeholder="e.g. 400 E Las Colinas Blvd, Irving, TX 75039"
                className="w-full px-3.5 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
              />
            </div>
            <button
              onClick={handleResearch}
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-60 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-xl transition-colors flex items-center justify-center gap-2 text-sm shadow-sm"
            >
              {loading ? (
                <>
                  <Spinner />
                  <span>Researching apartment…</span>
                </>
              ) : (
                <>
                  <span>🔍</span>
                  <span>Research This Apartment</span>
                </>
              )}
            </button>
          </div>

          {error && (
            <div className="mt-4 flex items-start gap-2.5 p-3.5 bg-red-50 border border-red-200 rounded-xl">
              <span className="text-red-500 text-base mt-0.5 shrink-0">⚠️</span>
              <p className="text-red-700 text-sm leading-relaxed">{error}</p>
            </div>
          )}
        </div>

        {/* ── Report Card ────────────────────────────────────────────────── */}
        {report && placeInfo && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
            <div className="mb-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-xl font-bold text-slate-900 leading-tight">{placeInfo.name}</h2>
                  <p className="text-slate-500 text-sm mt-0.5">{placeInfo.address}</p>
                </div>
                <span className="shrink-0 text-xs text-slate-400 bg-slate-100 rounded-full px-2 py-1 mt-1">
                  {reviews.length} review{reviews.length !== 1 ? "s" : ""}
                </span>
              </div>
            </div>

            {/* Score Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
              {DIMENSIONS.map(dim => {
                const d = report.scores?.[dim];
                if (!d) return null;
                const pct = `${(d.score / 10) * 100}%`;
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
                        <div className={`h-full rounded-full ${scoreBarColor(d.score)} transition-all`} style={{ width: pct }} />
                      </div>
                    </div>
                    <p className="text-xs text-slate-600 leading-snug">{d.reason}</p>
                  </div>
                );
              })}
            </div>

            {/* Happy Here Callout */}
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-4">
              <div className="flex items-start gap-3">
                <div className="shrink-0 w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center text-base">🏠</div>
                <div>
                  <h3 className="font-semibold text-blue-900 text-sm mb-1">Would you be happy here?</h3>
                  <p className="text-blue-800 text-sm leading-relaxed">{report.happy_here}</p>
                  <p className="text-blue-400 text-xs mt-1.5 italic">Context: Wells Fargo Las Colinas (Irving, TX) worker + frequent Lewisville Jamatkhana attendee</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Quick Links ────────────────────────────────────────────────── */}
        {report && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
            <h2 className="text-base font-semibold text-slate-800 mb-3 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-bold">2</span>
              Quick Research Links
            </h2>
            <div className="flex flex-wrap gap-2.5">
              <a
                href={redditUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-orange-500 hover:bg-orange-600 text-white rounded-xl text-sm font-semibold transition-colors shadow-sm"
              >
                <span>🤖</span> Search Reddit
              </a>
              <a
                href={apartmentsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-semibold transition-colors shadow-sm"
              >
                <span>🏘️</span> Apartments.com
              </a>
              <a
                href={mapsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-semibold transition-colors shadow-sm"
              >
                <span>📍</span> Google Maps Reviews
              </a>
            </div>
          </div>
        )}

        {/* ── RAG Chatbot ────────────────────────────────────────────────── */}
        {report && reviews.length > 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
            <h2 className="text-base font-semibold text-slate-800 mb-1 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-bold">3</span>
              Ask About This Apartment
            </h2>
            <p className="text-xs text-slate-400 mb-4 ml-8">Answers are grounded in the Google reviews only</p>

            {/* Suggestion Chips */}
            <div className="flex flex-wrap gap-2 mb-4">
              {suggestions.map(s => (
                <button
                  key={s}
                  onClick={() => handleChat(s)}
                  disabled={chatLoading}
                  className="px-3.5 py-1.5 bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-700 rounded-full text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {s}
                </button>
              ))}
            </div>

            {/* Chat History */}
            {chatMessages.length > 0 && (
              <div className="space-y-3 mb-4 max-h-[480px] overflow-y-auto px-1 py-1">
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`flex items-end gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                    {msg.role === "assistant" && (
                      <div className="shrink-0 w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-sm mb-0.5">🤖</div>
                    )}
                    <div className={`max-w-[85%] ${msg.role === "user" ? "items-end" : "items-start"} flex flex-col gap-1.5`}>
                      <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                        msg.role === "user"
                          ? "bg-blue-600 text-white rounded-br-sm"
                          : "bg-slate-100 text-slate-800 rounded-bl-sm"
                      }`}>
                        <p className="whitespace-pre-wrap">{msg.content}</p>
                      </div>
                      {msg.role === "assistant" && msg.sources?.length > 0 && (
                        <div className="space-y-1.5 px-1">
                          <p className="text-xs text-slate-400 font-medium">Sources cited:</p>
                          {msg.sources.map((src, j) => (
                            <SourceChip key={j} src={src} reviewIdx={src.reviewIndex} />
                          ))}
                        </div>
                      )}
                    </div>
                    {msg.role === "user" && (
                      <div className="shrink-0 w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-sm text-white mb-0.5">U</div>
                    )}
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

            {/* Input Row */}
            <div className="flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChat(chatInput); } }}
                placeholder="Ask anything about this apartment…"
                disabled={chatLoading}
                className="flex-1 px-3.5 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-slate-50 transition-shadow"
              />
              <button
                onClick={() => handleChat(chatInput)}
                disabled={chatLoading || !chatInput.trim()}
                className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-sm font-semibold transition-colors flex items-center gap-1.5 shrink-0"
              >
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
  );
}

# Apartment Research Tool

An AI-powered apartment research tool that pulls real Google Maps reviews and uses Claude to score apartments across 7 dimensions, with a sourced RAG chatbot for follow-up questions.

## What it does

1. **Sign in with Google** — your priorities and research history are tied to your account
2. **Looks up the apartment** on Google Places by name + address
3. **Fetches up to 5 recent Google reviews**
4. **Sends the reviews to Claude Sonnet** which scores the apartment across 7 dimensions (Noise, Maintenance, Safety, Parking, Internet, Commute, Value) — each with a 1–10 score and a one-line justification pulled from the reviews
5. **Answers a personal fit question** — "Would you be happy here?" tailored to your own work address, other frequent destinations (each with a real driving commute time via Google Distance Matrix), budget, pets, and whichever of the 7 dimensions matter most to you
6. **Quick links** to Reddit, Apartments.com, and Google Maps for further research
7. **RAG chatbot** to ask freeform questions — answers are grounded strictly in the fetched reviews and cite sources by reviewer name and rating, with collapsible raw review text
8. **Saves every search** (report, reviews, chat history) to your account in Firestore — revisit it anytime from the sidebar

## Setup

### 1. Clone and install

```bash
git clone https://github.com/ambijani/apartment-reviews.git
cd apartment-reviews
npm install
```

### 2. Create a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → Add project
2. **Build → Authentication** → Get started → enable the **Google** sign-in provider
3. **Build → Firestore Database** → Create database (production mode)
4. **Project settings → Your apps** → register a Web app → copy the `firebaseConfig` values
5. Deploy the included security rules (`firestore.rules`) via the Firebase console's Firestore Rules tab, or with the Firebase CLI: `firebase deploy --only firestore:rules`

### 3. Add API keys

Copy the example env file and fill in your keys:

```bash
cp .env.example .env
```

Edit `.env`:

```
VITE_ANTHROPIC_API_KEY=sk-ant-...
VITE_GOOGLE_PLACES_API_KEY=AIza...
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

**Getting the keys:**
- **Anthropic API key**: [console.anthropic.com](https://console.anthropic.com)
- **Google Places API key**: [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Enable **Places API** and **Distance Matrix API** → Create credentials
- **Firebase config**: from the Firebase project you created above (not secret — access is controlled by Firestore security rules, not by hiding these values)

### 4. Run

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Deploying to GitHub Pages

This repo already includes a working GitHub Actions workflow at `.github/workflows/deploy.yml` that builds and deploys to GitHub Pages on every push to `main`.

**Setup:**

1. Add the following repo secrets (Settings → Secrets and variables → Actions): `VITE_ANTHROPIC_API_KEY`, `VITE_GOOGLE_PLACES_API_KEY`, `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`
2. In repo Settings → Pages, set the source to **GitHub Actions** (`gh api repos/<owner>/<repo>/pages --method PUT --field build_type=workflow` if doing it via CLI)
3. In the Firebase console → Authentication → Settings → **Authorized domains**, add your GitHub Pages domain (e.g. `ambijani.github.io`) — Google sign-in will fail on unauthorized domains

`VITE_ANTHROPIC_API_KEY` and `VITE_GOOGLE_PLACES_API_KEY` get baked into the compiled JavaScript bundle at build time — anyone who inspects the bundle can extract them. Only deploy this way if you're comfortable with that (or have scoped the keys to specific HTTP referrers in Google Cloud Console). The Firebase config values are not secret regardless.

Once deployed, the site is live at: `https://ambijani.github.io/apartment-reviews/`

## Tech stack

- [React 19](https://react.dev) + [Vite](https://vitejs.dev)
- [Tailwind CSS](https://tailwindcss.com) (via CDN)
- [Firebase Auth](https://firebase.google.com/docs/auth) (Google sign-in) + [Firestore](https://firebase.google.com/docs/firestore) (per-user priorities and saved searches)
- [Google Places API](https://developers.google.com/maps/documentation/javascript/places) + [Distance Matrix API](https://developers.google.com/maps/documentation/distance-matrix) (JavaScript SDK)
- [Claude Sonnet 4.6](https://anthropic.com) via the Anthropic Messages API

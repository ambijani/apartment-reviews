# Apartment Research Tool

An AI-powered apartment research tool that pulls real Google Maps reviews and uses Claude to score apartments across 7 dimensions, with a sourced RAG chatbot for follow-up questions.

## What it does

1. **Looks up the apartment** on Google Places by name + address
2. **Fetches up to 5 recent Google reviews**
3. **Sends the reviews to Claude Sonnet** which scores the apartment across 7 dimensions (Noise, Maintenance, Safety, Parking, Internet, Commute, Value) — each with a 1–10 score and a one-line justification pulled from the reviews
4. **Answers a personal fit question**: "Would someone who works at Wells Fargo Las Colinas (Irving, TX) and attends Lewisville Jamatkhana frequently be happy here?"
5. **Quick links** to Reddit, Apartments.com, and Google Maps for further research
6. **RAG chatbot** to ask freeform questions — answers are grounded strictly in the fetched reviews and cite sources by reviewer name and rating, with collapsible raw review text

## Setup

### 1. Clone and install

```bash
git clone https://github.com/ambijani/apartment-reviews.git
cd apartment-reviews
npm install
```

### 2. Add API keys

Copy the example env file and fill in your keys:

```bash
cp .env.example .env
```

Edit `.env`:

```
VITE_ANTHROPIC_API_KEY=sk-ant-...
VITE_GOOGLE_PLACES_API_KEY=AIza...
```

**Getting the keys:**
- **Anthropic API key**: [console.anthropic.com](https://console.anthropic.com)
- **Google Places API key**: [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Enable **Places API (New)** → Create credentials

### 3. Run

```bash
npm run dev
```

Open [http://localhost:5177](http://localhost:5177).

## Deploying to GitHub Pages

**Yes, it works on GitHub Pages** — with one important caveat: `VITE_*` environment variables are baked into the compiled JavaScript bundle at build time. Anyone who inspects the bundle can extract your API keys. Only deploy this way if the site is for personal use and you're comfortable with that tradeoff (or if you've scoped the API keys to specific referrers in Google Cloud Console).

### Steps

**1. Set the base path** in `vite.config.js` so assets resolve correctly under the `/apartment-reviews/` subpath:

```js
export default defineConfig({
  plugins: [react()],
  base: '/apartment-reviews/',
});
```

**2. Add a GitHub Actions workflow** at `.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm run build
        env:
          VITE_ANTHROPIC_API_KEY: ${{ secrets.VITE_ANTHROPIC_API_KEY }}
          VITE_GOOGLE_PLACES_API_KEY: ${{ secrets.VITE_GOOGLE_PLACES_API_KEY }}
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
```

**3. Add secrets** in GitHub → Settings → Secrets and variables → Actions:
- `VITE_ANTHROPIC_API_KEY`
- `VITE_GOOGLE_PLACES_API_KEY`

**4. Enable GitHub Pages** in the repo Settings → Pages → Source: **Deploy from a branch** → branch: `gh-pages`.

Push to `main` and the workflow will build and deploy automatically. The site will be live at:
`https://ambijani.github.io/apartment-reviews/`

## Tech stack

- [React 19](https://react.dev) + [Vite](https://vitejs.dev)
- [Tailwind CSS](https://tailwindcss.com) (via CDN)
- [Google Places API](https://developers.google.com/maps/documentation/javascript/places) (JavaScript SDK)
- [Claude Sonnet 4.6](https://anthropic.com) via the Anthropic Messages API

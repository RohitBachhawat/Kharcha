# Kharcha — Family Expense Tracker

A privacy-first, AI-powered expense tracker built for Indian families. Log expenses in plain English or Hinglish, paste bank SMS, upload bills — Kharcha parses everything and saves it to your Google Sheet automatically.

**Live Demo:** [kharcha.vercel.app](https://kharcha.vercel.app)

---

## Features

- **Natural language input** — type `chai 20 tapri` or `sabzi 120 kal` and it just works
- **Hinglish support** — auto-translates common Hindi words to English
- **Bank SMS parsing** — paste any UPI/bank SMS and transaction details are extracted
- **Bill/receipt scanning** — upload a photo of a bill and all line items are parsed
- **Two sheets** — separate tracking for regular household expenses and wedding (Shaadi) expenses
- **Smart categorisation** — auto-detects Food, Transport, Utilities, Health, etc.
- **Payment mode** — Cash or Online (auto-detected from UPI/card keywords)
- **Recent entries** — filterable by type (Expenses/Shaadi) and date range
- **Summary dashboard** — monthly totals, 3-month bar chart, drill into any month
- **Edit & move** — tap any entry to edit or move it between sheets
- **Offline-first** — caches data locally, loads instantly on repeat visits
- **PWA-ready** — installable on Android and iOS

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML, CSS, JavaScript — no framework |
| Backend | Google Apps Script (Web App) |
| Database | Google Sheets |
| AI | Google Gemini API (gemini-3.1-flash-lite) |
| Hosting | Vercel (free tier) |

---

## How It Works

```
User input (text/SMS/image)
        ↓
Local fast parser (instant, no API call)
        ↓ if complex
Gemini API via Apps Script proxy
        ↓
Review sheet (user confirms/edits)
        ↓
Google Sheets (Expenses or Shaadi tab)
```

---

## Repository Structure

```
kharcha/
├── index.html        # Entire frontend — single file app
├── Code.gs           # Google Apps Script backend
├── vercel.json       # Vercel build config (injects env vars)
├── .env.example      # Reference for required environment variables
└── README.md
```

---

## Setup Guide

### Prerequisites

- A Google account
- A free [Gemini API key](https://aistudio.google.com)
- A [Vercel account](https://vercel.com) (free)
- A [GitHub account](https://github.com)

---

### Step 1 — Set up Google Sheets

1. Create a new Google Sheet
2. Note the **Spreadsheet ID** from the URL:
   `https://docs.google.com/spreadsheets/d/`**`YOUR_SHEET_ID`**`/edit`

---

### Step 2 — Deploy Apps Script

1. Go to [script.google.com](https://script.google.com) and create a new project
2. Delete the default code and paste the contents of `Code.gs`
3. Replace `SHEET_ID` on line 4 with your Spreadsheet ID from Step 1
4. Click **Deploy → New Deployment**
5. Set type to **Web App**
6. Set **Execute as:** Me
7. Set **Who has access:** Anyone
8. Click Deploy and copy the **Web App URL**

---

### Step 3 — Fork and Deploy to Vercel

1. Fork this repository to your GitHub account
2. Go to [vercel.com](https://vercel.com) → New Project → Import your fork
3. Before deploying, add these **Environment Variables** in the Vercel dashboard:

| Variable | Value |
|---|---|
| `SCRIPT_URL` | Your Apps Script Web App URL from Step 2 |
| `GEMINI_KEY` | Your Gemini API key from aistudio.google.com |

4. Click **Deploy**
5. Your app is live at `your-project.vercel.app`

---

### Step 4 — First Use

1. Open your deployed URL
2. Tap ⚙️ → enter your name under **Your Name** → Save
3. Start logging expenses

> **For family members:** Just share your Vercel URL. They only need to enter their name in ⚙️ — no API keys or URLs needed.

---

## Local Development

```bash
git clone https://github.com/RohitBachhawat/kharcha.git
cd kharcha
```

Open `index.html` in a browser. The app will prompt you to enter your Script URL and Gemini API key via the ⚙️ settings screen since environment variables aren't injected locally.

No build step, no `npm install`, no dependencies.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SCRIPT_URL` | Yes | Google Apps Script Web App URL |
| `GEMINI_KEY` | Yes | Gemini API key for AI parsing |

See `.env.example` for reference.

---

## Known Limitations

- **Single spreadsheet per deployment** — each deployed instance connects to one Google Sheet. Multiple families need separate forks and deployments.
- **Gemini API rate limits** — the free tier allows ~15 requests/minute. Complex inputs (bank SMS, multi-item bills) may hit this under heavy use.
- **Apps Script execution limits** — Google enforces a 6-minute execution limit and 20,000 requests/day on free accounts. Sufficient for family use.
- **Client-side API key** — the Gemini key is injected into the HTML at build time. Anyone with access to your deployed URL's source can view it. For a family app this is acceptable; for public deployments consider proxying through Apps Script instead.
- **No authentication** — anyone with your Vercel URL can add entries. Designed for trusted family use, not public access.
- **Image parsing accuracy** — bill scanning uses Gemini Vision. Handwritten, low-contrast, or multi-column receipts may parse incorrectly. Always review before confirming.

---

## Contributing

This is currently a solo project. Bug reports and suggestions are welcome via [GitHub Issues](https://github.com/RohitBachhawat/kharcha/issues). PRs are welcome for bug fixes.

---

## License

This project does not currently have a license. All rights reserved until one is chosen. If you'd like to use or adapt this project, please open an issue to discuss.

> **Tip on choosing a license:** MIT lets anyone use, modify and distribute freely with attribution. If you're unsure, MIT is the most common choice for open source projects. You can add it by creating a `LICENSE` file with the MIT text and your name.

---

## Acknowledgements

- [Google Gemini](https://aistudio.google.com) for the AI parsing backbone
- [Google Apps Script](https://developers.google.com/apps-script) for the serverless backend
- [Vercel](https://vercel.com) for free hosting
- [JetBrains Mono](https://www.jetbrains.com/legalnotices/font/) and [Syne](https://fonts.google.com/specimen/Syne) for typography

---

*Built with ❤️ for Indian families — [Rohit Bachhawat](https://github.com/RohitBachhawat)*

# 🛍️ Shopify Proactive Engagement System

A smart, privacy-first engagement tool for Shopify stores. It watches how visitors browse your store—pages they view, products they linger on, items they add to cart—and uses AI to decide the perfect moment to show a helpful, non-intrusive message that encourages them to complete a purchase.

**No personal information is ever collected.** The system only tracks anonymous browsing patterns (page views, clicks, time on page) and uses them to generate timely, relevant nudges.

---

## 📋 Table of Contents

- [How It Works](#how-it-works)
- [Project Structure](#project-structure)
- [Setup & Installation](#setup--installation)
- [Environment Variables](#environment-variables)
- [Adding the Tracker to Your Shopify Store](#adding-the-tracker-to-your-shopify-store)
- [Testing & Verification](#testing--verification)
- [Security & Privacy](#security--privacy)
- [Troubleshooting](#troubleshooting)

---

## How It Works

The system has two parts:

| Part | What It Does |
|------|-------------|
| **Tracker Script** (`engagement-tracker.js`) | A small JavaScript snippet that runs on your Shopify storefront. It watches for page views, product clicks, and Add-to-Cart actions, then sends anonymous data to your backend every 30 seconds. |
| **Backend Server** (`server/`) | A Node.js API that receives the browsing data, analyzes it with Claude AI, and decides whether to show the visitor a helpful message (e.g., *"Need help choosing? Check our best sellers!"*). |

**Flow:**

```
Visitor browses your store
        ↓
Tracker collects anonymous events (page views, clicks, time)
        ↓
Events are sent to your backend API every 30 seconds
        ↓
Backend asks Claude AI: "Should we nudge this visitor?"
        ↓
If yes → a gentle slide-up message appears on the storefront
(Only once per session — never spammy)
```

---

## Project Structure

```
Engagement_Tracker/
├── engagement-tracker.js    ← The snippet you paste into Shopify
├── README.md                ← You are here
└── server/
    ├── index.js             ← Backend API server
    ├── package.json         ← Dependencies list
    ├── .env                 ← Your secret keys (never commit this!)
    └── .gitignore           ← Keeps secrets out of version control
```

---

## Setup & Installation

### Prerequisites

- **Node.js** (version 18 or newer) — [Download here](https://nodejs.org/)
- **An Anthropic API key** — [Get one here](https://console.anthropic.com/)

### Step 1: Clone or download this project

Place the project folder anywhere on your computer.

### Step 2: Install dependencies

Open a terminal, navigate to the `server/` folder, and run:

```bash
cd server
npm install
```

This will download all the required packages (Express, CORS, Helmet, etc.).

### Step 3: Configure your environment variables

Inside the `server/` folder, open the `.env` file in any text editor and fill in your values. See the [Environment Variables](#environment-variables) section below for details.

### Step 4: Start the server

```bash
npm start
```

You should see output like:

```
✔  Engagement Tracker API listening on :3000
   Model : claude-sonnet-4-20250514
   CORS  : https://your-store.myshopify.com
```

> **Tip:** During development, use `npm run dev` instead — it will auto-restart when you make changes.

---

## Environment Variables

All configuration lives in the `server/.env` file. Here's what each variable does:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | ✅ Yes | — | Your Anthropic API key. Starts with `sk-ant-`. The server will not start without this. |
| `ANTHROPIC_MODEL` | No | `claude-sonnet-4-20250514` | Which Claude model to use. The default works great for most stores. |
| `PORT` | No | `3000` | The port your server runs on. Change this if port 3000 is already in use. |
| `NODE_ENV` | No | `development` | Set to `production` when deploying to a live server. |
| `ALLOWED_ORIGINS` | No | `*` (all origins) | Your Shopify store URL(s). Comma-separated if you have multiple. Example: `https://your-store.myshopify.com` |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Time window for rate limiting (in milliseconds). Default is 1 minute. |
| `RATE_LIMIT_MAX` | No | `30` | Maximum requests per IP within the time window. |

### Example `.env` file

```env
# Required
ANTHROPIC_API_KEY=sk-ant-your-key-here

# Optional (defaults shown)
ANTHROPIC_MODEL=claude-sonnet-4-20250514
PORT=3000
NODE_ENV=development
ALLOWED_ORIGINS=https://your-store.myshopify.com
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=30
```

> ⚠️ **Never share your API key or commit the `.env` file to GitHub.** The included `.gitignore` already prevents this.

---

## Adding the Tracker to Your Shopify Store

These steps add the tracking snippet to every page of your store. You will be editing your theme's main layout file — this is safe and easy to undo.

### Step 1: Open the Shopify Theme Editor

1. Log in to your **Shopify Admin** panel (`https://your-store.myshopify.com/admin`).
2. In the left sidebar, click **Online Store** → **Themes**.
3. Find your live (published) theme and click the **⋯ (three dots)** button next to it.
4. Select **Edit code** from the dropdown menu.

   ![Shopify Edit Code menu location](https://shopify.dev/assets/themes/tools/code-editor-702f71d21e2c07b8a80bedc6bacecc74.png)

### Step 2: Open `theme.liquid`

1. In the code editor's left sidebar, look under the **Layout** folder.
2. Click on **`theme.liquid`** to open it.

   > `theme.liquid` is the master template — it wraps every page of your store. Adding the snippet here means it will automatically run on every page your visitors see.

### Step 3: Update the API endpoint in the tracker

Before pasting the snippet, you need to tell it where your backend server is running:

1. Open `engagement-tracker.js` in a text editor on your computer.
2. Find this line near the top (around line 17):

   ```js
   var API_ENDPOINT = 'https://your-api.com/analyze';
   ```

3. Replace `https://your-api.com/analyze` with the actual URL where your backend is hosted. For example:

   ```js
   var API_ENDPOINT = 'https://my-engagement-api.onrender.com/analyze';
   ```

4. Copy the entire contents of `engagement-tracker.js`.

### Step 4: Paste the snippet into `theme.liquid`

1. In the Shopify code editor, scroll to the **bottom** of `theme.liquid`.
2. Find the closing `</body>` tag. It looks like this:

   ```html
     ...other code...
     </body>
   </html>
   ```

3. Paste the tracker script **just before** the `</body>` tag, wrapped in `<script>` tags:

   ```html
     <!-- Engagement Tracker – Proactive Engagement System -->
     <script>
       // Paste the ENTIRE contents of engagement-tracker.js here
     </script>

     </body>
   </html>
   ```

4. Click the green **Save** button in the top-right corner.

### ✅ That's it!

The tracker is now live on your store. It will silently monitor anonymous browsing patterns and show helpful messages when the AI determines it's the right moment.

> **Important Notes:**
> - **Only edit `theme.liquid`** — do not modify any checkout templates, as they have restrictions on most Shopify plans.
> - To remove the tracker later, simply delete the `<script>...</script>` block you pasted and click Save.

---

## Testing & Verification

Once the snippet is live on your store, follow these steps to verify everything is working.

### 1. Check that events are being recorded

1. Open your Shopify store in **Google Chrome** (or any modern browser).
2. Right-click anywhere on the page and select **Inspect** (or press `F12` / `Cmd+Option+I` on Mac).
3. Click the **Console** tab at the top of the panel that opens.
4. Type the following command and press Enter:

   ```js
   JSON.parse(sessionStorage.getItem('_et_q'))
   ```

5. You should see an array of event objects. Look for entries like:

   ```json
   [
     {
       "type": "page_view",
       "timestamp": "2026-04-07T12:00:00.000Z",
       "sessionId": "a1b2c3d4-...",
       "url": "https://your-store.myshopify.com/",
       "payload": { "pageType": "home", "title": "Your Store Name" }
     }
   ]
   ```

   > If you see an array with events, the tracker is working! 🎉

### 2. Check the session ID

```js
sessionStorage.getItem('_et_sid')
```

This should return a unique ID string like `"a1b2c3d4-e5f6-4789-abcd-ef0123456789"`. This stays the same for the entire browsing session.

### 3. Test click tracking

1. Navigate to a product page on your store.
2. Click the **Add to Cart** button.
3. Go back to the Console and run:

   ```js
   JSON.parse(sessionStorage.getItem('_et_q'))
   ```

4. You should now see a `click` event with `"isAddToCart": true` in the list.

### 4. Verify the backend receives data

1. Make sure your backend server is running (`npm start` in the `server/` folder).
2. Watch the server's terminal output — you should see incoming requests.
3. You can also check the health endpoint by visiting `http://localhost:3000/health` in your browser. You should see:

   ```json
   { "status": "ok", "uptime": 123.456 }
   ```

### 5. Check if a modal has been shown this session

```js
sessionStorage.getItem('_et_modal')
```

- Returns `"1"` if a message has already been shown this session.
- Returns `null` if no message has been triggered yet.

### 6. Reset the session (for re-testing)

To start fresh and test the full flow again:

```js
sessionStorage.clear()
```

Then refresh the page. This clears all tracker data and allows modals to trigger again.

---

## Security & Privacy

This system is built with privacy as a core principle:

- ✅ **No PII (Personally Identifiable Information)** is ever collected — no names, emails, addresses, or payment details.
- ✅ **No cookies** are used — session data lives only in `sessionStorage` and is automatically cleared when the browser tab closes.
- ✅ **Click tracking skips sensitive fields** — password inputs, credit card fields, and similar elements are automatically excluded.
- ✅ **Rate limiting** protects the backend from abuse (30 requests/minute per IP by default).
- ✅ **CORS restrictions** ensure only your Shopify store can talk to the API.
- ✅ **Helmet.js** adds security headers to every API response.
- ✅ **API keys are never exposed** to the browser — only the backend communicates with Claude AI.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| **Server won't start** — says "Missing required env var" | Make sure your `.env` file exists in the `server/` folder and contains a valid `ANTHROPIC_API_KEY`. |
| **No events in `sessionStorage`** | Check that the script is pasted correctly in `theme.liquid`, just before `</body>`. Open the browser console and look for red error messages. |
| **Events are recorded but nothing is sent to the backend** | Verify the `API_ENDPOINT` in the tracker matches your actual server URL (including `/analyze` at the end). |
| **CORS errors in the console** | Add your Shopify store URL to `ALLOWED_ORIGINS` in your `.env` file. Example: `ALLOWED_ORIGINS=https://your-store.myshopify.com` |
| **Modal never shows up** | The AI only triggers messages after 60+ seconds of browsing, and never on checkout pages. Browse longer or visit multiple product pages to trigger it. Also check that `sessionStorage.getItem('_et_modal')` isn't already `"1"` (run `sessionStorage.clear()` to reset). |
| **"Too many requests" error** | The rate limiter is working. Wait a minute or increase `RATE_LIMIT_MAX` in `.env`. |

---

## License

MIT — use it however you like.

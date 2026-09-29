# Iron 91

A 91-day gym + diet challenge tracker. Check in at the gym by GPS, prove it with a live photo that Claude compares against your gym, check out after your session. Meals, water, weekly weigh-ins, points, streaks, ranks, badges.

Stack: FastAPI (Python 3.13) + Postgres. No build step, no frontend framework.

## Rules (all editable in Setup)

- A day counts only with: **GPS check-in** within 150 m of the gym → **live photo that matches your gym** → **GPS check-out** at least 45 min after check-in.
- +5 per verified gym day. +2 each time the streak hits 5, 10, 15…
- Missed gym day: −5, or **−10 during the first 20 "Iron" days**.
- Over the daily calorie limit: −5 (can stack with a missed day).
- A day under the calorie floor (default 1,500) is flagged, never rewarded.

## Deploy: Render + Neon (both free)

Render's free Postgres is deleted after 30 days, so the database lives on Neon's free tier instead.

1. **Neon** — sign up at https://neon.com/signup, create a project (region: AWS Frankfurt), copy the connection string (`postgresql://…?sslmode=require`).
2. **GitHub** — push this folder to a new repo.
3. **Render** — Dashboard → New → Blueprint → pick the repo. It reads `render.yaml` and asks for:
   - `DATABASE_URL` — the Neon string
   - `APP_PASSWORD` — the password you'll log in with
   - `ANTHROPIC_API_KEY` — from https://platform.claude.com (turns on the photo check)
4. Open the `onrender.com` URL on your phone → log in → Setup → then Share → **Add to Home Screen**.

Tables are created automatically on first start.

## Run locally (PowerShell)

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:DATABASE_URL = "postgresql://USER:PASS@HOST/neondb?sslmode=require"
$env:APP_PASSWORD = "pick-a-password"
$env:ANTHROPIC_API_KEY = "sk-ant-..."   # optional; without it photos save as "unverified"
uvicorn app:app --reload
```

Open http://localhost:8000. GPS and camera work on localhost in a desktop browser; on the phone use the Render URL (HTTPS is required for both).

## First-night checklist

- Setup: start weight, calorie limit, gym location (stand in the gym and tap *Use my current location*, or paste coordinates from Google Maps).
- Before day 1 everything is a **practice round** — test check-in and photos freely, nothing counts.
- Delete any reference photos you took outside the gym (Wall tab). On day 1, take 3 reference shots of the gym from different spots.

## Good to know

- **Cold starts:** a free Render service sleeps after 15 min idle and takes about a minute to wake. Open the app when you leave home, not at the gym door.
- **Photo check cost:** Claude Haiku 4.5 compares today's photo with up to 3 reference photos — roughly half a US cent per check. Photos are sent to the Anthropic API for this check. If the API is down, the photo is saved as "unverified" and still counts (GPS already proved you were there); a "no match" verdict does not count. 6 attempts per day.
- **Water reminders** fire while the app is open. A website can't notify you on a schedule when it's closed, so put recurring water reminders in your phone as well.
- **Anti-cheat:** daily photos come from the live camera only (no gallery), carry a round/date stamp, and meals can only be added or deleted for today and yesterday.

| Env var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `APP_PASSWORD` | yes | Login password |
| `ANTHROPIC_API_KEY` | for photo check | Claude vision check |
| `SESSION_SECRET` | auto on Render | Signs the login cookie |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-haiku-4-5-20251001` |

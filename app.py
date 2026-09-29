"""Iron 91: a 91-day gym + diet challenge tracker. FastAPI + Postgres."""
import base64
import datetime as dt
import hashlib
import hmac
import json
import math
import os
import time
from contextlib import asynccontextmanager
from zoneinfo import ZoneInfo

import httpx
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from pydantic import BaseModel

DATABASE_URL = os.environ["DATABASE_URL"]
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "dev-only-secret")
AI_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
AI_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")
if not APP_PASSWORD:
    raise SystemExit("Set the APP_PASSWORD environment variable first.")
TOKEN = hmac.new(SESSION_SECRET.encode(), APP_PASSWORD.encode(), hashlib.sha256).hexdigest()
COOKIE = "iron91"
PUBLIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")

DEFAULTS = {
    "name": "", "start": None, "days": 91, "tz": "UTC",
    "start_kg": None, "goal_loss": 15, "kcal_limit": None, "kcal_floor": 1500,
    "gym": None, "radius_m": 150, "min_session_min": 45,
    "pts_gym": 5, "pen_miss": 5, "pen_miss_iron": 10, "iron_days": 20, "pen_kcal": 5,
    "streak_every": 5, "streak_bonus": 2, "water_goal": 12, "water_every_min": 60,
}
INTS = {"days", "kcal_limit", "kcal_floor", "radius_m", "min_session_min", "pts_gym", "pen_miss", "pen_miss_iron",
        "iron_days", "pen_kcal", "streak_every", "streak_bonus", "water_goal", "water_every_min"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS gym_session (
  day date PRIMARY KEY, in_at timestamptz NOT NULL, in_dist int NOT NULL,
  out_at timestamptz, out_dist int);
CREATE TABLE IF NOT EXISTS photo (
  id serial PRIMARY KEY, day date NOT NULL, kind text NOT NULL,
  taken_at timestamptz NOT NULL DEFAULT now(), img bytea NOT NULL,
  status text NOT NULL, confidence int, reason text);
CREATE TABLE IF NOT EXISTS meal (
  id serial PRIMARY KEY, day date NOT NULL, name text NOT NULL, kcal int NOT NULL,
  at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS weight (day date PRIMARY KEY, kg double precision NOT NULL);
CREATE TABLE IF NOT EXISTS water (day date PRIMARY KEY, glasses int NOT NULL DEFAULT 0, last_at timestamptz);
"""

pool = ConnectionPool(DATABASE_URL, min_size=1, max_size=4, open=False,
                      kwargs={"row_factory": dict_row, "prepare_threshold": None},  # safe with Neon's pooled URL
                      check=ConnectionPool.check_connection)


@asynccontextmanager
async def lifespan(_):
    pool.open(wait=True, timeout=30)
    with pool.connection() as c:
        c.execute(SCHEMA)
    yield
    pool.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def revalidate(request: Request, call_next):
    resp = await call_next(request)
    if not request.url.path.startswith(("/api/photo/", "/fonts/")):
        resp.headers.setdefault("Cache-Control", "no-cache")
    return resp


# ---------- helpers ----------
def settings(c):
    row = c.execute("SELECT v FROM kv WHERE k = 'settings'").fetchone()
    return {**DEFAULTS, **(row["v"] if row else {})}


def today(s):
    return dt.datetime.now(ZoneInfo(s["tz"])).date()


def ready(s):
    return bool(s["start"] and s["start_kg"] and s["kcal_limit"] and s["gym"])


def distance_m(a, b):
    la1, la2 = math.radians(a["lat"]), math.radians(b["lat"])
    h = (math.sin((la2 - la1) / 2) ** 2
         + math.cos(la1) * math.cos(la2) * math.sin(math.radians(b["lng"] - a["lng"]) / 2) ** 2)
    return round(2 * 6_371_000 * math.asin(math.sqrt(h)))


def fmt_m(m):
    return f"{m / 1000:.1f} km" if m >= 1000 else f"{m} m"


def at_gym(s, g):
    if not s["gym"]:
        raise HTTPException(400, "Set your gym location in Setup first.")
    d = distance_m(s["gym"], {"lat": g.lat, "lng": g.lng})
    # forgive up to 100 m of GPS uncertainty (gyms are indoors)
    return d - min(max(g.acc, 0), 100) <= s["radius_m"], d


def open_session(c):
    """A check-in without a check-out from the last 8 hours (handles sessions past midnight)."""
    return c.execute("SELECT * FROM gym_session WHERE out_at IS NULL AND in_at > now() - interval '8 hours' "
                     "ORDER BY in_at DESC LIMIT 1").fetchone()


def photo_ok(c, day):
    return c.execute("SELECT 1 FROM photo WHERE kind = 'daily' AND day = %s AND status <> 'fail'",
                     [day]).fetchone() is not None


def score(s, d_today, sessions, ok_days, kcal, water):
    """Walk every day of the plan and apply the rules. Returns (days, points, streak, best_streak)."""
    if not ready(s):
        return [], 0, 0, 0
    start = dt.date.fromisoformat(s["start"])
    out, total, streak, best = [], 0, 0, 0
    for i in range(s["days"]):
        d = start + dt.timedelta(days=i)
        row = {"n": i + 1, "date": d.isoformat(), "iron": i < s["iron_days"]}
        if d > d_today:
            out.append({**row, "state": "future"})
            continue
        final = d < d_today
        sess = sessions.get(d)
        won = bool(sess and sess["out_at"] and d in ok_days)
        k = kcal.get(d, 0)
        pts, log = 0, []
        if won:
            streak += 1
            best = max(best, streak)
            pts += s["pts_gym"]
            log.append(f"+{s['pts_gym']} gym day")
            if streak % s["streak_every"] == 0:
                pts += s["streak_bonus"]
                log.append(f"+{s['streak_bonus']} for a {streak}-day streak")
        elif final:
            pen = s["pen_miss_iron"] if row["iron"] else s["pen_miss"]
            pts -= pen
            log.append(f"−{pen} missed gym" + (" (Iron day)" if row["iron"] else ""))
            streak = 0
        if k > s["kcal_limit"]:
            pts -= s["pen_kcal"]
            log.append(f"−{s['pen_kcal']} over calories")
        total += pts
        out.append({**row, "state": "won" if won else "lost" if final else "today", "pts": pts, "log": log,
                    "kcal": k, "water": water.get(d, 0),
                    "low": final and 0 < k < s["kcal_floor"], "unlogged": final and k == 0})
    return out, total, streak, best


VERIFY_PROMPT = (
    "You check photos for a gym-attendance challenge. Images labeled REFERENCE show the user's gym. "
    "The image labeled TODAY was just taken. Was TODAY taken inside the same gym as the references? "
    "Different angles, zoom, lighting, other people, and a person in the foreground are all fine: judge the "
    "surroundings (equipment, flooring, walls, mirrors, ceiling, layout, signage). Ignore the yellow stamp bar "
    "at the bottom of TODAY. If too little of the surroundings is visible to judge, answer false. "
    'Reply with JSON only: {"match": true or false, "confidence": 0-100, "reason": "under 12 words"}'
)


def verify(img, refs):
    """Ask Claude whether today's photo was taken in the same gym as the reference photos."""
    if not AI_KEY:
        return "unverified", None, "AI check is off (no ANTHROPIC_API_KEY set)"

    def image(b):
        return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                            "data": base64.b64encode(b).decode()}}

    content = []
    for i, r in enumerate(refs, 1):
        content += [{"type": "text", "text": f"REFERENCE {i}"}, image(r)]
    content += [{"type": "text", "text": "TODAY"}, image(img), {"type": "text", "text": VERIFY_PROMPT}]
    try:
        r = httpx.post("https://api.anthropic.com/v1/messages", timeout=45, headers={
            "x-api-key": AI_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": AI_MODEL, "max_tokens": 150, "messages": [{"role": "user", "content": content}]})
        r.raise_for_status()
        text = "".join(b.get("text", "") for b in r.json()["content"])
        v = json.loads(text[text.index("{"): text.rindex("}") + 1])
        return ("pass" if v.get("match") is True else "fail"), int(v.get("confidence") or 0), \
            str(v.get("reason", ""))[:120]
    except Exception as e:  # network/API trouble must not cost you the day
        return "unverified", None, f"AI check unavailable ({type(e).__name__})"


def decode_jpeg(data):
    if data.startswith("data:"):
        data = data.split(",", 1)[1]
    try:
        img = base64.b64decode(data, validate=True)
    except ValueError:
        raise HTTPException(400, "That photo couldn't be read. Try again.")
    if not img.startswith(b"\xff\xd8"):
        raise HTTPException(400, "Photos must be JPEG.")
    if len(img) > 3_000_000:
        raise HTTPException(413, "Photo is too large (max 3 MB).")
    return img


# ---------- auth ----------
class Login(BaseModel):
    password: str


@app.post("/api/login")
def login(body: Login, request: Request, response: Response):
    if not hmac.compare_digest(body.password.encode(), APP_PASSWORD.encode()):
        time.sleep(1)
        raise HTTPException(401, "Wrong password.")
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(COOKIE, TOKEN, max_age=180 * 86400, httponly=True, samesite="lax", secure=secure)
    return {"ok": True}


@app.post("/api/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}


def auth(request: Request):
    if not hmac.compare_digest(request.cookies.get(COOKIE, ""), TOKEN):
        raise HTTPException(401, "Log in first.")


api = APIRouter(prefix="/api", dependencies=[Depends(auth)])


# ---------- state ----------
@api.get("/state")
def state():
    with pool.connection() as c:
        s = settings(c)
        d = today(s)
        sessions = {r["day"]: r for r in c.execute("SELECT * FROM gym_session")}
        photos = c.execute("SELECT id, day, kind, status, confidence, reason FROM photo ORDER BY id").fetchall()
        kcal = {r["day"]: r["k"] for r in c.execute("SELECT day, SUM(kcal)::int AS k FROM meal GROUP BY day")}
        water = {r["day"]: r for r in c.execute("SELECT * FROM water")}
        meals = c.execute("SELECT id, day, name, kcal, at FROM meal WHERE day >= %s ORDER BY at",
                          [d - dt.timedelta(days=1)]).fetchall()
        recent = c.execute("SELECT name, kcal FROM (SELECT DISTINCT ON (lower(name)) name, kcal, at FROM meal "
                           "ORDER BY lower(name), at DESC) t ORDER BY at DESC LIMIT 8").fetchall()
        weights = c.execute("SELECT day, kg FROM weight ORDER BY day").fetchall()
        cur = open_session(c) or sessions.get(d)

    ok_days = {p["day"] for p in photos if p["kind"] == "daily" and p["status"] != "fail"}
    days, points, streak, best = score(s, d, sessions, ok_days, kcal, {k: v["glasses"] for k, v in water.items()})
    photo, tries = None, 0
    if cur:
        attempts = [p for p in photos if p["kind"] == "daily" and p["day"] == cur["day"]]
        tries = len(attempts)
        good = [p for p in attempts if p["status"] != "fail"]
        photo = (good or attempts or [None])[-1]
    last_sip = max((w["last_at"] for w in water.values() if w["last_at"]), default=None)
    return {
        "settings": s, "ready": ready(s), "today": d, "ai": bool(AI_KEY),
        "day_n": (d - dt.date.fromisoformat(s["start"])).days + 1 if s["start"] else None,
        "days": days, "points": points, "streak": streak, "best_streak": best,
        "session": cur and {k: cur[k] for k in ("day", "in_at", "in_dist", "out_at", "out_dist")},
        "photo": photo, "tries": tries,
        "refs": [p["id"] for p in photos if p["kind"] == "ref"],
        "wall": [p for p in photos if p["kind"] == "daily" and p["status"] != "fail"],
        "meals": meals, "recent": recent, "weights": weights,
        "water": {"glasses": water[d]["glasses"] if d in water else 0, "last_at": last_sip},
        "now": dt.datetime.now(dt.UTC),
    }


@api.post("/settings")
def save_settings(body: dict):
    with pool.connection() as c:
        s = settings(c)
        key = None
        try:
            for key, v in body.items():
                if key not in DEFAULTS:
                    continue
                if key in INTS:
                    v = max(0, int(round(float(v))))
                elif key in ("start_kg", "goal_loss"):
                    v = round(float(v), 1)
                elif key == "start":
                    v = dt.date.fromisoformat(v).isoformat()
                elif key == "tz":
                    ZoneInfo(v)
                elif key == "gym":
                    v = {"lat": float(v["lat"]), "lng": float(v["lng"])}
                elif key == "name":
                    v = str(v).strip()[:16]
                s[key] = v
        except (ValueError, TypeError, KeyError):
            raise HTTPException(400, f"Invalid value for {key}.")
        if s["days"] < 1 or s["streak_every"] < 1:
            raise HTTPException(400, "Plan length and streak size must be at least 1.")
        c.execute("INSERT INTO kv (k, v) VALUES ('settings', %s) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v",
                  [Jsonb(s)])
    return {"ok": True}


# ---------- gym ----------
class Geo(BaseModel):
    lat: float
    lng: float
    acc: float = 0


@api.post("/checkin")
def checkin(g: Geo):
    with pool.connection() as c:
        s = settings(c)
        d = today(s)
        if open_session(c):
            raise HTTPException(409, "You're already checked in.")
        if c.execute("SELECT 1 FROM gym_session WHERE day = %s", [d]).fetchone():
            raise HTTPException(409, "Today's session is already done. Come back tomorrow.")
        ok, dist = at_gym(s, g)
        if not ok:
            raise HTTPException(400, f"You're {fmt_m(dist)} from your gym. Check-in works within {s['radius_m']} m.")
        c.execute("INSERT INTO gym_session (day, in_at, in_dist) VALUES (%s, now(), %s)", [d, dist])
    return {"dist": dist}


@api.post("/checkout")
def checkout(g: Geo):
    with pool.connection() as c:
        s = settings(c)
        sess = open_session(c)
        if not sess:
            raise HTTPException(400, "Check in first.")
        if not photo_ok(c, sess["day"]):
            raise HTTPException(400, "Take your gym photo before you check out.")
        mins = (dt.datetime.now(dt.UTC) - sess["in_at"]).total_seconds() / 60
        if mins < s["min_session_min"]:
            raise HTTPException(400, f"{int(mins)} min in. Check-out opens at {s['min_session_min']} min.")
        ok, dist = at_gym(s, g)
        if not ok:
            raise HTTPException(400, f"You're {fmt_m(dist)} from your gym. Check out before you leave.")
        c.execute("UPDATE gym_session SET out_at = now(), out_dist = %s WHERE day = %s", [dist, sess["day"]])
    return {"dist": dist}


class Photo(BaseModel):
    kind: str
    data: str


@api.post("/photo")
def upload_photo(p: Photo):
    img = decode_jpeg(p.data)
    with pool.connection() as c:
        d = today(settings(c))
        if p.kind == "ref":
            if c.execute("SELECT count(*) AS n FROM photo WHERE kind = 'ref'").fetchone()["n"] >= 6:
                raise HTTPException(400, "You have 6 reference photos. Delete one first.")
            c.execute("INSERT INTO photo (day, kind, img, status) VALUES (%s, 'ref', %s, 'ref')", [d, img])
            return {"status": "ref"}
        sess = open_session(c)
        if not sess:
            raise HTTPException(400, "Check in at the gym first.")
        day = sess["day"]
        if photo_ok(c, day):
            raise HTTPException(409, "Today's photo is already verified.")
        if c.execute("SELECT count(*) AS n FROM photo WHERE kind = 'daily' AND day = %s", [day]).fetchone()["n"] >= 6:
            raise HTTPException(429, "All 6 photo attempts used today.")
        refs = [r["img"] for r in c.execute("SELECT img FROM photo WHERE kind = 'ref' ORDER BY id DESC LIMIT 3")]
    if not refs:
        raise HTTPException(400, "Add a reference photo of your gym first.")
    status, conf, reason = verify(img, refs)  # outside the DB connection: this call takes a few seconds
    with pool.connection() as c:
        c.execute("INSERT INTO photo (day, kind, img, status, confidence, reason) VALUES (%s, 'daily', %s, %s, %s, %s)",
                  [day, img, status, conf, reason])
    return {"status": status, "confidence": conf, "reason": reason}


@api.get("/photo/{pid}")
def get_photo(pid: int):
    with pool.connection() as c:
        r = c.execute("SELECT img FROM photo WHERE id = %s", [pid]).fetchone()
    if not r:
        raise HTTPException(404, "Photo not found.")
    return Response(bytes(r["img"]), media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=31536000, immutable"})


@api.delete("/photo/{pid}")
def delete_ref(pid: int):
    with pool.connection() as c:
        c.execute("DELETE FROM photo WHERE id = %s AND kind = 'ref'", [pid])
    return {"ok": True}


# ---------- food, water, weight ----------
class Meal(BaseModel):
    name: str
    kcal: int
    yesterday: bool = False


@api.post("/meal")
def add_meal(m: Meal):
    name = m.name.strip()[:60]
    if not name or not 0 < m.kcal <= 5000:
        raise HTTPException(400, "Enter a meal name and calories between 1 and 5000.")
    with pool.connection() as c:
        d = today(settings(c)) - dt.timedelta(days=int(m.yesterday))
        c.execute("INSERT INTO meal (day, name, kcal) VALUES (%s, %s, %s)", [d, name, m.kcal])
    return {"ok": True}


@api.delete("/meal/{mid}")
def delete_meal(mid: int):
    with pool.connection() as c:
        d = today(settings(c))
        n = c.execute("DELETE FROM meal WHERE id = %s AND day >= %s", [mid, d - dt.timedelta(days=1)]).rowcount
    if not n:
        raise HTTPException(400, "Only today's and yesterday's meals can be deleted.")
    return {"ok": True}


class Water(BaseModel):
    delta: int


@api.post("/water")
def add_water(w: Water):
    x = 1 if w.delta > 0 else -1
    with pool.connection() as c:
        d = today(settings(c))
        c.execute("""INSERT INTO water (day, glasses, last_at) VALUES (%(d)s, GREATEST(%(x)s, 0),
                         CASE WHEN %(x)s > 0 THEN now() END)
                     ON CONFLICT (day) DO UPDATE SET glasses = GREATEST(water.glasses + %(x)s, 0),
                         last_at = CASE WHEN %(x)s > 0 THEN now() ELSE water.last_at END""", {"d": d, "x": x})
    return {"ok": True}


class Weight(BaseModel):
    kg: float


@api.post("/weight")
def add_weight(w: Weight):
    if not 30 <= w.kg <= 300:
        raise HTTPException(400, "Enter a weight between 30 and 300 kg.")
    with pool.connection() as c:
        d = today(settings(c))
        c.execute("INSERT INTO weight (day, kg) VALUES (%s, %s) ON CONFLICT (day) DO UPDATE SET kg = EXCLUDED.kg",
                  [d, round(w.kg, 1)])
    return {"ok": True}


app.include_router(api)
app.mount("/", StaticFiles(directory=PUBLIC, html=True), name="public")

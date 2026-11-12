#!/usr/bin/env python3
"""광야교회 '말씀' 메뉴 자동 갱신

유튜브 채널을 읽어서 두 파일을 만듭니다. (API 키 필요 없음, 표준 라이브러리만 사용)
  word.json : 재생목록별 영상 (주일설교 / 금요기도회 / 광야캔버스 / 뿌리 깊은 종려나무)
  qt.json   : 커뮤니티 '게시물'에 올라온 매일성경 큐티 (한 번 가져온 글은 계속 보관)
  cali.json : 네이버 카페 [말씀기도캘리] 게시판 글 (그림은 cali/ 폴더에 내려받아 보관)

GitHub Actions(.github/workflows/update-word.yml)가 1시간마다 실행합니다.
"""
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone, timedelta

CHANNEL = "https://www.youtube.com/@midbar-church-smilepastor"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KST = timezone(timedelta(hours=9))

# 메뉴 이름 → 재생목록 제목에 들어 있는 말
CATEGORIES = [
    ("sunday", "주일설교", ["주일설교"]),
    ("friday", "금요기도회", ["금요기도회"]),
    ("canvas", "광야캔버스", ["광야캔버스"]),
    ("palm", "뿌리 깊은 종려나무", ["종려나무"]),
]

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
HEAD = {"User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9",
        "Cookie": "CONSENT=YES+cb; SOCS=CAI"}


def get(url, data=None):
    body = json.dumps(data).encode() if data is not None else None
    h = dict(HEAD)
    if body:
        h["Content-Type"] = "application/json"
    for n in range(3):
        try:
            req = urllib.request.Request(url, data=body, headers=h)
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8")
        except Exception as e:  # 잠깐 끊겼을 때 다시 시도
            if n == 2:
                raise
            time.sleep(3 + n * 3)


def initial_data(html):
    m = re.search(r"var ytInitialData = (\{.*?\});</script>", html, re.S)
    if not m:
        raise RuntimeError("유튜브 페이지 구조를 읽지 못했습니다.")
    return json.loads(m.group(1))


def api_key(html):
    m = re.search(r'"INNERTUBE_API_KEY":"([^"]+)"', html)
    v = re.search(r'"INNERTUBE_CLIENT_VERSION":"([^"]+)"', html)
    return (m.group(1) if m else None), (v.group(1) if v else "2.20241101.00.00")


def walk(o, key, out):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == key:
                out.append(v)
            walk(v, key, out)
    elif isinstance(o, list):
        for v in o:
            walk(v, key, out)
    return out


def text_of(t):
    if not t:
        return ""
    if "simpleText" in t:
        return t["simpleText"]
    return "".join(r.get("text", "") for r in t.get("runs", []))


def browse_more(token, key, ver):
    url = "https://www.youtube.com/youtubei/v1/browse" + ("?key=" + key if key else "")
    data = {"context": {"client": {"clientName": "WEB", "clientVersion": ver, "hl": "ko", "gl": "KR"}},
            "continuation": token}
    return json.loads(get(url, data))


def next_token(d):
    """목록 맨 끝의 '더 보기' 표시에서 다음 쪽 열쇠를 꺼냅니다."""
    for item in walk(d, "continuationItemRenderer", []):
        for c in walk(item, "continuationCommand", []):
            if c.get("token"):
                return c["token"]
    return None


# ---------------- 영상 ----------------
def parse_title(t):
    """예) '감사하며 축복할 때 | 고린도전서 10장 16~17절 | 광야교회 박규성목사 | 2026.11.01 | 주일설교 (추수감사주일)'"""
    parts = [x.strip() for x in str(t).split("|")]
    date = ""
    for x in parts:
        m = re.search(r"(20\d{2})\.\s*(\d{1,2})\.\s*(\d{1,2})", x)
        if m:
            date = "%s-%02d-%02d" % (m.group(1), int(m.group(2)), int(m.group(3)))
            break
    scripture = ""
    if len(parts) > 1 and re.search(r"\d", parts[1]) and not re.match(r"^20\d{2}\.", parts[1]):
        scripture = parts[1].replace("절", "").strip()
    note = ""
    if "광야캔버스" in t:                      # 그림 정보 (작가, 작품, 연도)
        extra = [x for x in parts[1:] if x not in ("광야캔버스", "그림으로 나누는 묵상") and "박규성" not in x]
        note = extra[-1] if extra else ""
    else:
        m = re.search(r"\(([^)]*)\)\s*$", parts[-1]) if len(parts) > 2 else None
        if m and not re.search(r"QT|큐티|\d+[:장]", m.group(1)):
            note = m.group(1)
    return {"title": parts[0], "scripture": scripture, "date": date, "note": note}


def lockup_title(v):
    return (((v.get("metadata") or {}).get("lockupMetadataViewModel") or {}).get("title") or {}).get("content", "")


def lockup_age(v):
    """'2일 전', '4시간 전' 같은 글자"""
    for part in walk(v, "metadataParts", []):
        for x in part:
            c = ((x.get("text") or {}).get("content") or "")
            if c.endswith("전"):
                return c
    return ""


def collect_videos(o):
    got = []
    for v in walk(o, "playlistVideoRenderer", []):        # 예전 형식
        if v.get("videoId") and v.get("isPlayable", True):
            got.append({"id": v["videoId"], "raw": text_of(v.get("title")), "age": ""})
    for v in walk(o, "lockupViewModel", []):              # 새 형식
        if v.get("contentType") == "LOCKUP_CONTENT_TYPE_VIDEO" and v.get("contentId"):
            got.append({"id": v["contentId"], "raw": lockup_title(v), "age": lockup_age(v)})
    return [g for g in got if g["raw"] and g["raw"] not in ("[비공개 동영상]", "[삭제된 동영상]", "[Private video]", "[Deleted video]")]


def page_all(url, limit=10):
    html = get(url)
    d = initial_data(html)
    key, ver = api_key(html)
    items = collect_videos(d)
    tok, n = next_token(d), 0
    while tok and n < limit:
        n += 1
        more = browse_more(tok, key, ver)
        items += collect_videos(more)
        tok = next_token(more)
    return items


def shorts_ids(limit=10):
    """채널 '숏츠' 탭의 영상 번호 (홈페이지 첫 화면 설교란에서 빼기 위해)"""
    html = get(CHANNEL + "/shorts")
    d = initial_data(html)
    key, ver = api_key(html)
    ids = []
    def grab(o):
        for r in walk(o, "reelWatchEndpoint", []):
            if r.get("videoId") and r["videoId"] not in ids:
                ids.append(r["videoId"])
    grab(d)
    tok, n = next_token(d), 0
    while tok and n < limit:
        n += 1
        more = browse_more(tok, key, ver)
        grab(more)
        tok = next_token(more)
    return ids


def playlists():
    d = initial_data(get(CHANNEL + "/playlists"))
    out = []
    for x in walk(d, "lockupViewModel", []):
        pid = x.get("contentId")
        if pid and x.get("contentType") == "LOCKUP_CONTENT_TYPE_PLAYLIST":
            out.append((pid, lockup_title(x)))
    return out


def age_to_date(age, today):
    m = re.match(r"(\d+)\s*(분|시간|일)\s*전", age or "")
    if not m:
        return ""
    n, unit = int(m.group(1)), m.group(2)
    d = today - (timedelta(days=n) if unit == "일" else timedelta(hours=n) if unit == "시간" else timedelta(minutes=n))
    return d.strftime("%Y-%m-%d")


# ---------------- 게시물(큐티) ----------------
QT_HEAD = re.compile(r"^\s*(\d{2})(\d{2})(\d{2})\s*[|｜]\s*(.+)$")


def parse_post(p):
    txt = text_of(p.get("contentText")).replace("\r", "")
    lines = txt.split("\n")
    m = QT_HEAD.match(lines[0]) if lines else None
    if not m:
        return None
    yy, mm, dd, head = m.groups()
    ref = ""
    r = re.search(r"\(([^()]*\d[^()]*)\)\s*$", head)
    if r:
        ref = r.group(1).strip()
        head = head[: r.start()].strip()
    body = "\n".join(lines[1:])
    body = re.sub(r"^\s*_{5,}\s*$", "", body, flags=re.M)          # 밑줄 구분선
    body = re.sub(r"(\n\s*#[^\n]*)+\s*$", "", body.rstrip())         # 끝의 해시태그 줄
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    img = ""
    att = p.get("backstageAttachment") or {}
    th = (((att.get("backstageImageRenderer") or {}).get("image") or {}).get("thumbnails") or [])
    if th:
        img = th[-1].get("url", "")
        img = re.sub(r"=s\d+.*$", "=s1200", img)
    return {"id": p.get("postId"), "date": "20%s-%s-%s" % (yy, mm, dd), "title": head.strip(),
            "ref": ref, "body": body, "image": img}


def qt_posts(known_ids, pages=40):
    html = get(CHANNEL + "/posts")
    d = initial_data(html)
    key, ver = api_key(html)
    posts = walk(d, "backstagePostRenderer", [])
    tok = next_token(d)
    n = 0
    # 이미 받아 둔 글을 만나면 거기서 멈춥니다 (처음 실행 때는 끝까지 받습니다)
    while tok and n < pages and not any(p.get("postId") in known_ids for p in posts):
        n += 1
        more = browse_more(tok, key, ver)
        got = walk(more, "backstagePostRenderer", [])
        if not got:
            break
        posts += got
        tok = next_token(more)
    out = []
    for p in posts:
        q = parse_post(p)
        if q and q["id"]:
            out.append(q)
    return out


def load(name, default):
    try:
        with open(os.path.join(ROOT, name), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save(name, data):
    path = os.path.join(ROOT, name)
    new = json.dumps(data, ensure_ascii=False, indent=1)
    try:
        with open(path, encoding="utf-8") as f:
            old = json.load(f)
        a = dict(old); b = dict(data)
        a.pop("updated", None); b.pop("updated", None)
        if a == b:
            print(name, "바뀐 내용 없음")
            return
    except Exception:
        pass
    with open(path, "w", encoding="utf-8") as f:
        f.write(new + "\n")
    print(name, "저장")


# ---------- 네이버 카페 [말씀기도캘리] ----------
CAFE_ID = 31786576          # cafe.naver.com/midbarchurch
CALI_MENU = 18              # 말씀기도캘리 게시판
NAVER_HEAD = {"User-Agent": UA, "Referer": "https://cafe.naver.com/midbarchurch"}


def nget(url, raw=False):
    for n in range(3):
        try:
            req = urllib.request.Request(url, headers=NAVER_HEAD)
            with urllib.request.urlopen(req, timeout=30) as r:
                b = r.read()
                return b if raw else json.loads(b.decode("utf-8"))
        except Exception:
            if n == 2:
                raise
            time.sleep(3 + n * 3)


def cali_posts(old_by_id):
    url = ("https://apis.naver.com/cafe-web/cafe2/ArticleListV2dot1.json?search.clubid=%d"
           "&search.menuid=%d&search.boardtype=I&search.page=1&search.perPage=50&ad=false" % (CAFE_ID, CALI_MENU))
    arts = nget(url)["message"]["result"]["articleList"]
    os.makedirs(os.path.join(ROOT, "cali"), exist_ok=True)
    out = []
    for a in arts:
        if not a.get("openArticle"):
            continue
        aid = int(a["articleId"])
        title = re.sub(r"^\s*\[[^\]]*\]\s*", "", a.get("subject", "")).strip()
        date = datetime.fromtimestamp(a["writeDateTimestamp"] / 1000, KST).strftime("%Y-%m-%d")
        prev = old_by_id.get(aid)
        if prev and prev.get("images") and all(os.path.exists(os.path.join(ROOT, i)) for i in prev["images"]):
            prev.update({"title": title, "date": date})
            out.append(prev)
            continue
        srcs = []
        try:
            d = nget("https://apis.naver.com/cafe-web/cafe-articleapi/v2.1/cafes/%d/articles/%d?useCafeId=true" % (CAFE_ID, aid))
            html = d["result"]["article"].get("contentHtml", "")
            srcs = [u for u in re.findall(r'src="([^"]+)"', html) if "pstatic.net" in u and "phinf" in u]
        except Exception as e:
            print("카페 글", aid, "본문 실패:", e, file=sys.stderr)
        if not srcs and a.get("representImage"):
            srcs = [a["representImage"]]
        imgs = []
        for n, u in enumerate(srcs[:10]):
            u = u.replace("&amp;", "&").split("?")[0] + "?type=w800"
            name = "cali/%d-%d.jpg" % (aid, n + 1)
            try:
                b = nget(u, raw=True)
                if b[:2] != b"\xff\xd8" and b[:4] != b"\x89PNG":
                    raise RuntimeError("그림이 아님")
                with open(os.path.join(ROOT, name), "wb") as f:
                    f.write(b)
                imgs.append(name)
            except Exception as e:
                print("카페 그림", aid, "실패:", e, file=sys.stderr)
        if imgs:
            out.append({"id": aid, "title": title, "date": date, "images": imgs})
        time.sleep(1)
    return out


def main():
    now = datetime.now(KST).strftime("%Y-%m-%dT%H:%M:%S+09:00")
    ok = True

    # 1) 영상 → word.json
    #    채널 '동영상' 목록 전체를 제목으로 나누고, 재생목록에 넣어 둔 영상도 함께 넣습니다.
    try:
        today = datetime.now(KST)
        prev = {}
        for c in load("word.json", {}).get("categories", []):
            for v in c.get("videos", []):
                prev[v["id"]] = v
        uploads = page_all(CHANNEL + "/videos")
        order = {v["id"]: i for i, v in enumerate(uploads)}
        info = {}
        for v in uploads:
            p = parse_title(v["raw"]); p["id"] = v["id"]; p["raw"] = v["raw"]
            if not p["date"]:
                p["date"] = (prev.get(v["id"]) or {}).get("date") or age_to_date(v["age"], today)
            info[v["id"]] = p
        # 날짜가 아직 없으면 바로 앞(더 오래된) 영상의 날짜를 씁니다
        ups = [info[v["id"]] for v in uploads]
        for i, p in enumerate(ups):
            if not p["date"]:
                older = next((q["date"] for q in ups[i + 1:] if q["date"]), "")
                p["date"] = older
        members = {k: [] for k, _, _ in CATEGORIES}
        try:
            for pid, title in playlists():
                for k, _, words in CATEGORIES:
                    if any(w in title for w in words):
                        for v in page_all("https://www.youtube.com/playlist?list=" + pid):
                            members[k].append(v)
        except Exception as e:
            print("재생목록 읽기 실패(제목으로만 나눕니다):", e, file=sys.stderr)
        cats = []
        for key, name, words in CATEGORIES:
            vids, seen = [], set()
            cand = [info[v["id"]] for v in uploads if any(w in v["raw"] for w in words)]
            for v in members[key]:
                if v["id"] not in info:
                    p = parse_title(v["raw"]); p["id"] = v["id"]
                    p["date"] = p["date"] or (prev.get(v["id"]) or {}).get("date", "")
                    info[v["id"]] = p
                cand.append(info[v["id"]])
            for p in cand:
                if p["id"] not in seen:
                    seen.add(p["id"])
                    vids.append({k2: p[k2] for k2 in ("id", "title", "scripture", "date", "note")})
            vids.sort(key=lambda v: (v["date"] or "0000", -order.get(v["id"], 9999)), reverse=True)
            cats.append({"key": key, "name": name, "videos": vids})
            print(name, len(vids), "개")
        if sum(len(c["videos"]) for c in cats) == 0:
            raise RuntimeError("영상을 하나도 찾지 못했습니다.")
        shorts = list(load("word.json", {}).get("shorts", []))
        try:
            for i in shorts_ids():
                if i not in shorts:
                    shorts.append(i)
        except Exception as e:
            print("숏츠 목록 실패:", e, file=sys.stderr)
        print("숏츠", len(shorts), "개")
        save("word.json", {"updated": now, "categories": cats, "shorts": shorts})
    except Exception as e:
        ok = False
        print("영상 목록 실패:", e, file=sys.stderr)

    # 2) 게시물 → qt.json (예전 글은 지우지 않고 계속 쌓음)
    try:
        old = load("qt.json", {"posts": []})
        by_id = {p["id"]: p for p in old.get("posts", [])}
        for p in qt_posts(set(by_id)):
            by_id[p["id"]] = p
        posts = sorted(by_id.values(), key=lambda p: (p["date"], p["id"]), reverse=True)
        print("큐티", len(posts), "개")
        save("qt.json", {"updated": now, "posts": posts})
    except Exception as e:
        ok = False
        print("게시물 실패:", e, file=sys.stderr)

    # 3) 네이버 카페 [말씀기도캘리] → cali.json (예전 글도 계속 보관)
    try:
        old = load("cali.json", {"posts": []})
        by_id = {int(p["id"]): p for p in old.get("posts", [])}
        for p in cali_posts(by_id):
            by_id[int(p["id"])] = p
        posts = sorted(by_id.values(), key=lambda p: (p["date"], p["id"]), reverse=True)
        print("말씀기도캘리", len(posts), "개")
        save("cali.json", {"updated": now, "posts": posts})
    except Exception as e:
        ok = False
        print("카페 실패:", e, file=sys.stderr)

    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

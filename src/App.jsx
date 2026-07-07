import React, { useEffect, useMemo, useRef, useState } from "react";
import { DATA, groupLabel, groupSymbol } from "./game-data.js";

function randomRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i += 1) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function websocketBase() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

function cleanRoomCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 5);
}

function getIdentity() {
  const key = "quran-memory-player-id";
  let value = window.localStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID();
    window.localStorage.setItem(key, value);
  }
  return value;
}

function roomLink(roomCode) {
  const url = new URL(window.location.href);
  url.searchParams.set("room", roomCode);
  return url.toString();
}

function winnerText(players) {
  if (!players?.length) return "";
  const sorted = [...players].sort((a, b) => b.score - a.score);
  if (sorted.length > 1 && sorted[0].score === sorted[1].score) return "نتیجه مساوی است.";
  return `برنده: ${sorted[0].name}`;
}

export default function App() {
  const wsRef = useRef(null);

  const [name, setName] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [role, setRole] = useState(null);
  const [youId, setYouId] = useState(null);
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [showReview, setShowReview] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");

  const you = useMemo(() => state?.players?.find((player) => player.id === youId) || null, [state, youId]);
  const isHost = state?.hostId === youId;
  const shareUrl = state?.roomCode ? roomLink(state.roomCode) : "";

  useEffect(() => {
    const initialRoom = cleanRoomCode(new URLSearchParams(window.location.search).get("room"));
    if (initialRoom) setRoomInput(initialRoom);
  }, []);

  const currentTurnName = useMemo(() => {
    const player = state?.players?.find((item) => item.id === state.turnPlayerId);
    return player?.name || "بازیکن";
  }, [state]);

  function connect(roomCode) {
    const cleanName = (name.trim() || "بازیکن").slice(0, 24);
    const cleanRoom = cleanRoomCode(roomCode);

    if (!/^[A-Z0-9]{5}$/.test(cleanRoom)) {
      setError("کد اتاق باید ۵ حرف یا عدد انگلیسی باشد.");
      return;
    }

    wsRef.current?.close();
    setConnecting(true);
    setError("");

    const identity = getIdentity();
    const ws = new WebSocket(`${websocketBase()}/ws/${cleanRoom}?name=${encodeURIComponent(cleanName)}&identity=${encodeURIComponent(identity)}`);

    ws.onopen = () => {
      setConnected(true);
      setConnecting(false);
      setError("");
    };

    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === "welcome") {
        setYouId(message.playerId);
        if (message.identity) window.localStorage.setItem("quran-memory-player-id", message.identity);
        setRole(message.role);
        setState(message.state);
        return;
      }

      if (message.type === "state") {
        setState(message.state);
        return;
      }

      if (message.type === "notice") {
        setError(message.message);
      }
    };

    ws.onerror = () => {
      setConnecting(false);
      setError("اتصال برقرار نشد. اگر تازه Deploy کرده‌ای، چند ثانیه صبر کن و دوباره تلاش کن.");
    };

    ws.onclose = () => {
      setConnected(false);
      setConnecting(false);
    };

    wsRef.current = ws;
  }

  function createRoom() {
    const code = randomRoomCode();
    setRoomInput(code);
    window.history.replaceState(null, "", `?room=${code}`);
    connect(code);
  }

  function joinRoom() {
    const code = cleanRoomCode(roomInput);
    if (code) window.history.replaceState(null, "", `?room=${code}`);
    connect(code);
  }

  function send(payload) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify(payload));
  }

  function selectCard(cardId) {
    send({ type: "select", cardId });
  }

  function restart() {
    send({ type: "restart" });
  }

  function setReady(ready) {
    send({ type: "ready", ready });
  }

  function startGame() {
    send({ type: "start" });
  }

  async function copyText(value, label) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage(`${label} کپی شد.`);
    } catch {
      setCopyMessage("کپی خودکار ممکن نشد؛ متن را دستی کپی کن.");
    }
  }

  async function shareRoom() {
    if (navigator.share) {
      await navigator.share({ title: "بازی حافظه قرآنی", text: `به اتاق ${state.roomCode} بیا`, url: shareUrl });
      return;
    }
    await copyText(shareUrl, "لینک اتاق");
  }

  function leaveRoom() {
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
    setConnecting(false);
    setRole(null);
    setYouId(null);
    setState(null);
    setError("");
  }

  if (!connected || !state) {
    return (
      <main className="page" dir="rtl">
        <style>{css}</style>
        <section className="lobby">
          <div className="badge">✦ بازی حافظه قرآنی آنلاین</div>
          <h1>بازی حافظه ۲ نفره آنلاین</h1>
          <p>
            یک نفر اتاق می‌سازد و کد ۵ حرفی را برای نفر دوم می‌فرستد. اگر جفت درست پیدا کنی، امتیاز می‌گیری
            و نوبتت ادامه دارد؛ اگر اشتباه باشد، نوبت عوض می‌شود. لینک‌های دارای ?room=ABCDE مستقیم وارد اتاق می‌شوند.
          </p>

          <label>
            نام بازیکن
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="مثلاً علی" maxLength={24} />
          </label>

          <label>
            کد اتاق
            <input
              value={roomInput}
              onChange={(event) => setRoomInput(cleanRoomCode(event.target.value))}
              placeholder="ABCDE"
              maxLength={5}
              dir="ltr"
              className="roomInput"
            />
          </label>

          {copyMessage ? <div className="success">{copyMessage}</div> : null}
        {error ? <div className="error">{error}</div> : null}

          <div className="lobbyActions">
            <button onClick={createRoom} className="primary" disabled={connecting}>
              ساخت اتاق جدید
            </button>
            <button onClick={joinRoom} className="secondary" disabled={connecting}>
              ورود با کد
            </button>
          </div>

          <button type="button" className="reviewToggle" onClick={() => setShowReview((value) => !value)}>
            {showReview ? "بستن مرور واژه‌ها" : "مرور عربی و فارسی قبل از بازی"}
          </button>

          {showReview ? <ReviewPanel /> : null}
        </section>
      </main>
    );
  }

  const isYourTurn = state.turnPlayerId === youId;
  const finished = state.finished || state.matchedCount === state.totalPairs;

  return (
    <main className="page" dir="rtl">
      <style>{css}</style>

      <div className="shell">
        <header className="top">
          <div>
            <div className="badge">اتاق {state.roomCode} {isHost ? " · میزبان" : ""}</div>
            <h1>بازی حافظه قرآنی آنلاین</h1>
            <p>
              سبز یعنی «خدا دوست دارد». قرمز یعنی «خدا دوست ندارد». جفت درست فقط عربی + فارسیِ همان معناست.
            </p>
          </div>

          <div className="topActions">
            <button className="reviewButton" onClick={() => setShowReview((value) => !value)}>
              {showReview ? "بازگشت به بازی" : "مرور واژه‌ها"}
            </button>
            <button className="secondary" onClick={() => copyText(state.roomCode, "کد اتاق")}>کپی کد</button>
            <button className="secondary" onClick={shareRoom}>اشتراک لینک</button>
            <button className="secondary" onClick={restart} disabled={!isHost}>
              شروع دوباره
            </button>
            <button className="danger" onClick={leaveRoom}>
              خروج
            </button>
          </div>
        </header>

        <section className="scorePanel">
          {state.players.map((player) => (
            <article
              key={player.id}
              className={["player", player.id === youId ? "you" : "", player.id === state.turnPlayerId ? "turn" : ""].join(" ")}
            >
              <div>
                <b>{player.name}</b>
                <span>{player.id === youId ? "تو" : `بازیکن ${player.number}`} {player.id === state.hostId ? " · میزبان" : ""}</span>
                <em className={player.online ? "online" : "offline"}>{player.online ? "آنلاین" : "آفلاین"}</em>
                <em className={player.ready ? "ready" : "notReady"}>{player.ready ? "آماده" : "آماده نیست"}</em>
              </div>
              <strong>{player.score}</strong>
            </article>
          ))}

          {state.players.length < 2 ? (
            <article className="waiting">
              <b>منتظر بازیکن دوم</b>
              <span>کد یا لینک اتاق را بفرست: {state.roomCode}</span>
            </article>
          ) : null}

          {role === "spectator" ? (
            <article className="waiting">
              <b>تماشاچی</b>
              <span>اتاق پر است؛ فقط بازی را می‌بینی.</span>
            </article>
          ) : null}
        </section>

        <section className="status">
          <div>
            <b>{finished ? winnerText(state.players) : isYourTurn ? "نوبت توست" : `نوبت ${currentTurnName}`}</b>
            <span>{state.message}</span>
          </div>

          <div className="miniStats">
            <span>جفت‌ها: {state.matchedCount}/{state.totalPairs}</span>
            <span>حرکت: {state.moves}</span>
            <span>خطا: {state.mistakes}</span>
          </div>
        </section>

        {copyMessage ? <div className="success">{copyMessage}</div> : null}
        {error ? <div className="error">{error}</div> : null}

        {!state.started && role === "player" ? (
          <section className="roomControls">
            <button className={you?.ready ? "secondary" : "primary"} onClick={() => setReady(!you?.ready)}>
              {you?.ready ? "لغو آمادگی" : "من آماده‌ام"}
            </button>
            <button className="primary" onClick={startGame} disabled={!isHost || !state.canStart}>شروع بازی توسط میزبان</button>
            <span>{isHost ? "وقتی هر دو آماده باشند می‌توانی شروع کنی." : "منتظر شروع بازی توسط میزبان باشید."}</span>
          </section>
        ) : null}

        {showReview ? (
          <ReviewPanel />
        ) : (
          <section className="grid">
            {state.cards.map((card) => {
              const isLove = card.group === "love";
              const disabled = role !== "player" || !state.started || !isYourTurn || state.locked || card.matched || finished;

              return (
                <button
                  key={card.cardId}
                  disabled={disabled}
                  onClick={() => selectCard(card.cardId)}
                  className={["card", card.visible ? "face" : isLove ? "back love" : "back dislike", card.matched ? "matched" : ""].join(" ")}
                >
                  {card.visible ? (
                    <>
                      <span className={`tag ${card.side}`}>{card.side === "arabic" ? "عربی" : "فارسی"}</span>
                      <span className={`text ${card.side}`}>{card.text}</span>
                    </>
                  ) : (
                    <>
                      <span className="symbol">{groupSymbol(card.group)}</span>
                      <span className="backText">{groupLabel(card.group)}</span>
                    </>
                  )}
                </button>
              );
            })}
          </section>
        )}
      </div>
    </main>
  );
}

function ReviewPanel() {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");

  const items = useMemo(() => {
    const base =
      filter === "love" ? DATA.filter((item) => item.group === "love") :
      filter === "dislike" ? DATA.filter((item) => item.group === "dislike") :
      DATA;

    const q = query.trim().toLowerCase();
    if (!q) return base;

    return base.filter((item) =>
      item.arabic.toLowerCase().includes(q) ||
      item.persian.toLowerCase().includes(q) ||
      groupLabel(item.group).toLowerCase().includes(q)
    );
  }, [filter, query]);

  return (
    <section className="reviewPanel">
      <div className="reviewHeader">
        <div>
          <h2>مرور واژه‌ها</h2>
          <p>قبل از بازی، عبارت عربی را همراه با معادل فارسی مرور کن.</p>
        </div>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="جستجو..." />
      </div>

      <div className="filters">
        <button className={filter === "all" ? "selected" : ""} onClick={() => setFilter("all")}>همه</button>
        <button className={filter === "love" ? "selected" : ""} onClick={() => setFilter("love")}>خدا دوست دارد</button>
        <button className={filter === "dislike" ? "selected" : ""} onClick={() => setFilter("dislike")}>خدا دوست ندارد</button>
      </div>

      <div className="reviewCount">{items.length} مورد</div>

      <div className="reviewGrid">
        {items.map((item, index) => (
          <article key={item.id} className={`reviewCard ${item.group}`}>
            <div className="reviewTop">
              <span>{index + 1}</span>
              <b>{groupLabel(item.group)}</b>
            </div>
            <div className="reviewArabic" lang="ar">{item.arabic}</div>
            <div className="reviewPersian">{item.persian}</div>
          </article>
        ))}
      </div>
    </section>
  );
}

const css = `
* { box-sizing: border-box; }
body { margin: 0; }
button, input { font-family: inherit; }
button { -webkit-tap-highlight-color: transparent; }
.page {
  min-height: 100vh;
  padding: 16px;
  font-family: Vazirmatn, IRANSans, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: radial-gradient(circle at top, #f0fdf4 0, #f8fafc 42%, #fff1f2 100%);
  color: #0f172a;
}
.lobby {
  width: 100%;
  max-width: 760px;
  margin: 5vh auto;
  background: rgba(255,255,255,.88);
  border: 1px solid rgba(255,255,255,.92);
  border-radius: 32px;
  padding: 24px;
  box-shadow: 0 24px 80px rgba(15,23,42,.14);
}
.badge {
  display: inline-flex;
  background: #0f172a;
  color: #fff;
  border-radius: 999px;
  padding: 7px 12px;
  font-size: 12px;
  font-weight: 950;
  margin-bottom: 12px;
}
h1 { margin: 0; font-size: 34px; line-height: 1.25; font-weight: 950; }
p { color: #475569; line-height: 2; font-weight: 700; }
label { display: grid; gap: 7px; margin-top: 12px; font-weight: 950; }
input {
  width: 100%;
  border: 1px solid #e2e8f0;
  border-radius: 18px;
  padding: 13px 14px;
  font-size: 16px;
  font-weight: 850;
  outline: none;
  background: white;
}
input:focus { border-color: #0f172a; }
.roomInput { text-align: center; letter-spacing: .2em; font-weight: 950; }
.lobbyActions, .topActions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
button {
  border: 0;
  border-radius: 18px;
  padding: 11px 15px;
  cursor: pointer;
  font-weight: 950;
}
button:disabled { cursor: not-allowed; opacity: .55; }
.primary { background: #0f172a; color: white; }
.secondary { background: white; color: #0f172a; border: 1px solid #e2e8f0; }
.danger { background: #fee2e2; color: #991b1b; border: 1px solid #fecaca; }
.reviewButton, .reviewToggle { background: #f59e0b; color: #111827; border: 0; }
.reviewToggle { margin-top: 14px; width: 100%; }
.success {
  margin-top: 12px;
  background: #ecfdf5;
  border: 1px solid #bbf7d0;
  color: #047857;
  border-radius: 18px;
  padding: 11px 13px;
  font-weight: 900;
  line-height: 1.8;
}
.error {
  margin-top: 12px;
  background: #fff1f2;
  border: 1px solid #fecdd3;
  color: #be123c;
  border-radius: 18px;
  padding: 11px 13px;
  font-weight: 900;
  line-height: 1.8;
}
.shell { max-width: 1280px; margin: 0 auto; display: grid; gap: 14px; }
.top {
  background: rgba(255,255,255,.88);
  border: 1px solid rgba(255,255,255,.92);
  border-radius: 30px;
  padding: 20px;
  box-shadow: 0 18px 50px rgba(15,23,42,.1);
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: start;
}
.top p { margin-bottom: 0; }
.scorePanel { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.player, .waiting {
  background: rgba(255,255,255,.9);
  border: 1px solid #e2e8f0;
  border-radius: 24px;
  padding: 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 10px 30px rgba(15,23,42,.07);
}
.player.you { border-color: #93c5fd; }
.player.turn { border-color: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,.18); }
.player div, .waiting { display: grid; gap: 3px; }
.player b, .waiting b { font-weight: 950; }
.player span, .waiting span { color: #64748b; font-size: 13px; font-weight: 800; }
.player em { font-style: normal; width: fit-content; border-radius: 999px; padding: 3px 8px; font-size: 11px; font-weight: 950; }
.online, .ready { background: #dcfce7; color: #166534; }
.offline, .notReady { background: #fee2e2; color: #991b1b; }
.player strong {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  background: #0f172a;
  color: white;
  border-radius: 16px;
  font-size: 20px;
}
.roomControls {
  background: rgba(255,255,255,.92);
  border: 1px solid #e2e8f0;
  border-radius: 24px;
  padding: 14px;
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  font-weight: 900;
  color: #475569;
}
.status {
  background: #020617;
  color: white;
  border-radius: 24px;
  padding: 14px;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}
.status div:first-child { display: grid; gap: 5px; }
.status b { font-size: 18px; }
.status span { color: rgba(255,255,255,.72); font-weight: 800; }
.miniStats { display: flex; gap: 8px; flex-wrap: wrap; }
.miniStats span { background: rgba(255,255,255,.1); border-radius: 999px; padding: 7px 10px; font-size: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(108px, 1fr)); gap: 9px; }
.card {
  min-height: 108px;
  border-radius: 22px;
  padding: 9px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 7px;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 14px rgba(15,23,42,.08);
  transition: transform 160ms ease, box-shadow 160ms ease;
}
.card:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 12px 25px rgba(15,23,42,.12); }
.card.back.love { background: linear-gradient(145deg, #15803d, #22c55e); color: white; border: 1px solid #15803d; }
.card.back.dislike { background: linear-gradient(145deg, #b91c1c, #ef4444); color: white; border: 1px solid #b91c1c; }
.card.face { background: white; color: #0f172a; border: 1px solid #cbd5e1; }
.card.matched { background: #ecfdf5; color: #064e3b; border-color: #a7f3d0; }
.symbol {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: 16px;
  background: rgba(255,255,255,.16);
  font-size: 20px;
  font-weight: 950;
}
.backText { font-size: 13px; line-height: 1.8; font-weight: 950; }
.tag { border-radius: 999px; padding: 4px 8px; font-size: 10px; font-weight: 950; }
.tag.arabic { background: #fef3c7; color: #92400e; }
.tag.persian { background: #e0f2fe; color: #0369a1; }
.text { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; -webkit-line-clamp: 3; font-weight: 950; }
.text.arabic { font-size: 15px; line-height: 1.85; }
.text.persian { font-size: 12px; line-height: 1.75; }
.reviewPanel {
  background: rgba(255,255,255,.9);
  border: 1px solid #e2e8f0;
  border-radius: 28px;
  padding: 16px;
  display: grid;
  gap: 14px;
}
.reviewHeader { display: grid; grid-template-columns: 1fr minmax(180px, 280px); gap: 12px; align-items: end; }
.reviewHeader h2 { margin: 0; font-size: 22px; font-weight: 950; }
.reviewHeader p { margin: 5px 0 0; }
.filters { display: flex; gap: 8px; flex-wrap: wrap; }
.filters button { background: white; border: 1px solid #e2e8f0; color: #334155; border-radius: 999px; padding: 9px 12px; }
.filters button.selected { background: #0f172a; color: white; border-color: #0f172a; }
.reviewCount { color: #64748b; font-size: 13px; font-weight: 900; }
.reviewGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
.reviewCard {
  border-radius: 24px;
  border: 1px solid #e2e8f0;
  background: white;
  padding: 14px;
  box-shadow: 0 8px 22px rgba(15,23,42,.06);
}
.reviewCard.love { border-color: #bbf7d0; background: linear-gradient(180deg, #fff, #f0fdf4); }
.reviewCard.dislike { border-color: #fecaca; background: linear-gradient(180deg, #fff, #fff1f2); }
.reviewTop { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.reviewTop span {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: #f1f5f9;
  color: #64748b;
  font-size: 12px;
  font-weight: 950;
}
.reviewTop b { border-radius: 999px; padding: 5px 9px; font-size: 11px; font-weight: 950; background: #f1f5f9; }
.reviewCard.love .reviewTop b { background: #dcfce7; color: #15803d; }
.reviewCard.dislike .reviewTop b { background: #fee2e2; color: #dc2626; }
.reviewArabic {
  direction: rtl;
  text-align: center;
  font-size: 22px;
  line-height: 2;
  font-weight: 950;
  color: #111827;
  padding: 10px;
  border-radius: 18px;
  background: rgba(255,255,255,.72);
}
.reviewPersian { margin-top: 10px; color: #475569; font-size: 14px; line-height: 1.9; font-weight: 850; text-align: center; }
@media (max-width: 700px) {
  .page { padding: 10px; }
  .top { flex-direction: column; }
  h1 { font-size: 26px; }
  .roomControls {
  background: rgba(255,255,255,.92);
  border: 1px solid #e2e8f0;
  border-radius: 24px;
  padding: 14px;
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
  font-weight: 900;
  color: #475569;
}
.status { flex-direction: column; align-items: stretch; }
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .card { min-height: 96px; border-radius: 18px; }
  .reviewHeader { grid-template-columns: 1fr; }
  .reviewGrid { grid-template-columns: 1fr; }
}
`;

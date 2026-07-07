import React, { useMemo, useRef, useState } from "react";
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

  const you = useMemo(() => state?.players?.find((player) => player.id === youId) || null, [state, youId]);

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

    const ws = new WebSocket(`${websocketBase()}/ws/${cleanRoom}?name=${encodeURIComponent(cleanName)}`);

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
    connect(code);
  }

  function joinRoom() {
    connect(roomInput);
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
          <div className="mihrab" aria-hidden="true">۞</div>
          <div className="badge">بِسْمِ اللهِ الرَّحْمٰنِ الرَّحِيمِ</div>
          <h1>بازی حافظه واژه‌های قرآنی</h1>
          <p className="lead">
            با آرامش یک محفل قرآنی بازی کن؛ یک نفر اتاق می‌سازد و کد ۵ حرفی را برای نفر دوم می‌فرستد.
            جفت عربی و فارسی را پیدا کن و واژه‌هایی را که خدا دوست دارد یا دوست ندارد مرور کن.
          </p>

          <div className="islamicDivider" aria-hidden="true"><span></span><b>✦</b><span></span></div>

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
            <div className="badge">اتاق {state.roomCode} • محفل قرآنی</div>
            <h1>بازی حافظه واژه‌های قرآنی</h1>
            <p className="lead">
              سبز زمردی یعنی «خدا دوست دارد» و سرخ اناری یعنی «خدا دوست ندارد». جفت درست فقط عربی + فارسیِ همان معناست.
            </p>
          </div>

          <div className="topActions">
            <button className="reviewButton" onClick={() => setShowReview((value) => !value)}>
              {showReview ? "بازگشت به بازی" : "مرور واژه‌ها"}
            </button>
            <button className="secondary" onClick={restart} disabled={role !== "player"}>
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
                <span>{player.id === youId ? "تو" : `بازیکن ${player.number}`}</span>
              </div>
              <strong>{player.score}</strong>
            </article>
          ))}

          {state.players.length < 2 ? (
            <article className="waiting">
              <b>منتظر بازیکن دوم</b>
              <span>کد اتاق را بفرست: {state.roomCode}</span>
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
            <span>۞ جفت‌ها: {state.matchedCount}/{state.totalPairs}</span>
            <span>✦ حرکت: {state.moves}</span>
            <span>هلال خطا: {state.mistakes}</span>
          </div>
        </section>

        {error ? <div className="error">{error}</div> : null}

        {showReview ? (
          <ReviewPanel />
        ) : (
          <section className="grid">
            {state.cards.map((card) => {
              const isLove = card.group === "love";
              const disabled = role !== "player" || !isYourTurn || state.locked || card.matched || finished;

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
:root {
  --ink: #17332b;
  --muted: #647067;
  --emerald: #047857;
  --emerald-dark: #064e3b;
  --gold: #c9972b;
  --gold-soft: #f7e7b1;
  --cream: #fff8e7;
  --tile: rgba(255, 252, 239, .9);
  --rose: #9f1239;
}
body { margin: 0; }
button, input { font-family: inherit; }
button { -webkit-tap-highlight-color: transparent; }
.page {
  min-height: 100vh;
  padding: 18px;
  font-family: Vazirmatn, IRANSans, Tahoma, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background:
    radial-gradient(circle at 18% 8%, rgba(247, 231, 177, .75), transparent 24rem),
    radial-gradient(circle at 82% 12%, rgba(4, 120, 87, .22), transparent 22rem),
    linear-gradient(135deg, rgba(255,255,255,.12) 25%, transparent 25%) 0 0 / 34px 34px,
    linear-gradient(225deg, rgba(201,151,43,.10) 25%, transparent 25%) 0 0 / 34px 34px,
    linear-gradient(180deg, #08382f 0%, #0f513f 42%, #f8efd8 42%, #fffaf0 100%);
  color: var(--ink);
}
.page::before {
  content: "";
  position: fixed;
  inset: 12px;
  pointer-events: none;
  border: 1px solid rgba(247, 231, 177, .55);
  border-radius: 34px;
  box-shadow: inset 0 0 0 1px rgba(4, 120, 87, .16);
}
.lobby, .top, .reviewPanel, .player, .waiting, .status {
  backdrop-filter: blur(16px);
}
.lobby {
  position: relative;
  overflow: hidden;
  width: 100%;
  max-width: 800px;
  margin: 5vh auto;
  background: linear-gradient(180deg, rgba(255,252,239,.96), rgba(255,248,231,.88));
  border: 1px solid rgba(201,151,43,.45);
  border-radius: 36px;
  padding: 30px;
  box-shadow: 0 28px 90px rgba(4, 45, 35, .28), inset 0 0 0 6px rgba(255,255,255,.3);
}
.lobby::after, .top::after, .reviewPanel::after {
  content: "";
  position: absolute;
  inset: 10px;
  border: 1px dashed rgba(201,151,43,.35);
  border-radius: 28px;
  pointer-events: none;
}
.mihrab {
  width: 82px;
  height: 106px;
  margin: 0 auto 14px;
  display: grid;
  place-items: center;
  color: var(--gold);
  font-size: 34px;
  background: linear-gradient(180deg, #0b5d49, #08382f);
  border: 2px solid rgba(247,231,177,.85);
  border-radius: 999px 999px 24px 24px;
  box-shadow: 0 12px 34px rgba(8,56,47,.28);
}
.badge {
  display: inline-flex;
  background: linear-gradient(135deg, var(--emerald-dark), var(--emerald));
  color: #fff8e7;
  border: 1px solid rgba(247,231,177,.55);
  border-radius: 999px;
  padding: 8px 14px;
  font-size: 12px;
  font-weight: 950;
  margin-bottom: 12px;
  box-shadow: 0 8px 24px rgba(4,120,87,.22);
}
h1 { margin: 0; font-size: 36px; line-height: 1.3; font-weight: 950; color: var(--emerald-dark); letter-spacing: -.02em; }
p { color: var(--muted); line-height: 2; font-weight: 750; }
.lead { font-size: 16px; }
.islamicDivider { display: flex; align-items: center; gap: 10px; color: var(--gold); margin: 12px 0 18px; }
.islamicDivider span { height: 1px; flex: 1; background: linear-gradient(90deg, transparent, var(--gold), transparent); }
label { display: grid; gap: 8px; margin-top: 13px; font-weight: 950; color: var(--emerald-dark); }
input {
  width: 100%;
  border: 1px solid rgba(201,151,43,.38);
  border-radius: 20px;
  padding: 14px 15px;
  font-size: 16px;
  font-weight: 850;
  outline: none;
  background: rgba(255,255,255,.78);
  color: var(--ink);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.8);
}
input:focus { border-color: var(--gold); box-shadow: 0 0 0 4px rgba(201,151,43,.18); }
.roomInput { text-align: center; letter-spacing: .2em; font-weight: 950; }
.lobbyActions, .topActions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
button { border: 0; border-radius: 18px; padding: 12px 16px; cursor: pointer; font-weight: 950; transition: transform 150ms ease, box-shadow 150ms ease; }
button:hover:not(:disabled) { transform: translateY(-1px); }
button:disabled { cursor: not-allowed; opacity: .55; }
.primary { background: linear-gradient(135deg, var(--emerald-dark), var(--emerald)); color: #fff8e7; box-shadow: 0 12px 25px rgba(4,120,87,.25); }
.secondary { background: rgba(255,252,239,.9); color: var(--emerald-dark); border: 1px solid rgba(201,151,43,.42); }
.danger { background: #fff1f2; color: var(--rose); border: 1px solid #fecdd3; }
.reviewButton, .reviewToggle { background: linear-gradient(135deg, #f7e7b1, var(--gold)); color: #3b2a04; border: 1px solid rgba(120,75,8,.18); }
.reviewToggle { margin-top: 14px; width: 100%; }
.error { margin-top: 12px; background: #fff1f2; border: 1px solid #fecdd3; color: #be123c; border-radius: 18px; padding: 11px 13px; font-weight: 900; line-height: 1.8; }
.shell { max-width: 1280px; margin: 0 auto; display: grid; gap: 14px; }
.top { position: relative; overflow: hidden; background: rgba(255,252,239,.92); border: 1px solid rgba(201,151,43,.42); border-radius: 32px; padding: 22px; box-shadow: 0 18px 55px rgba(4,45,35,.18); display: flex; justify-content: space-between; gap: 16px; align-items: start; }
.top p { margin-bottom: 0; }
.scorePanel { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.player, .waiting { background: rgba(255,252,239,.9); border: 1px solid rgba(201,151,43,.32); border-radius: 24px; padding: 14px; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 10px 30px rgba(4,45,35,.10); }
.player.you { border-color: rgba(4,120,87,.55); }
.player.turn { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(201,151,43,.20), 0 12px 34px rgba(4,45,35,.14); }
.player div, .waiting { display: grid; gap: 3px; }
.player b, .waiting b { font-weight: 950; }
.player span, .waiting span { color: var(--muted); font-size: 13px; font-weight: 800; }
.player strong { width: 44px; height: 44px; display: grid; place-items: center; background: linear-gradient(180deg, var(--emerald), var(--emerald-dark)); color: #fff8e7; border: 1px solid rgba(247,231,177,.45); border-radius: 16px; font-size: 20px; }
.status { background: linear-gradient(135deg, #052e26, #0b5d49); color: #fff8e7; border: 1px solid rgba(247,231,177,.38); border-radius: 24px; padding: 15px; display: flex; justify-content: space-between; gap: 12px; align-items: center; box-shadow: 0 18px 45px rgba(4,45,35,.22); }
.status div:first-child { display: grid; gap: 5px; }
.status b { font-size: 18px; }
.status span { color: rgba(255,248,231,.78); font-weight: 800; }
.miniStats { display: flex; gap: 8px; flex-wrap: wrap; }
.miniStats span { background: rgba(255,248,231,.12); border: 1px solid rgba(247,231,177,.22); border-radius: 999px; padding: 7px 10px; font-size: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 10px; }
.card { min-height: 112px; border-radius: 24px; padding: 10px; text-align: center; display: flex; flex-direction: column; gap: 7px; align-items: center; justify-content: center; box-shadow: 0 6px 18px rgba(4,45,35,.12); transition: transform 160ms ease, box-shadow 160ms ease; position: relative; overflow: hidden; }
.card::before { content: ""; position: absolute; inset: 8px; border: 1px solid rgba(255,248,231,.24); border-radius: 18px; pointer-events: none; }
.card:hover:not(:disabled) { transform: translateY(-3px); box-shadow: 0 14px 30px rgba(4,45,35,.18); }
.card.back.love { background: linear-gradient(145deg, #065f46, #10b981); color: #fff8e7; border: 1px solid rgba(247,231,177,.45); }
.card.back.dislike { background: linear-gradient(145deg, #7f1d1d, #dc2626); color: #fff8e7; border: 1px solid rgba(247,231,177,.32); }
.card.face { background: linear-gradient(180deg, #fffdf5, #fff8e7); color: var(--ink); border: 1px solid rgba(201,151,43,.36); }
.card.matched { background: linear-gradient(180deg, #ecfdf5, #d1fae5); color: #064e3b; border-color: #86efac; }
.symbol { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 999px 999px 12px 12px; background: rgba(255,248,231,.18); font-size: 21px; font-weight: 950; }
.backText { font-size: 13px; line-height: 1.8; font-weight: 950; }
.tag { border-radius: 999px; padding: 4px 9px; font-size: 10px; font-weight: 950; border: 1px solid rgba(201,151,43,.22); }
.tag.arabic { background: #fef3c7; color: #92400e; }
.tag.persian { background: #d1fae5; color: #065f46; }
.text { display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; -webkit-line-clamp: 3; font-weight: 950; }
.text.arabic { font-size: 16px; line-height: 1.9; }
.text.persian { font-size: 12px; line-height: 1.75; }
.reviewPanel { position: relative; overflow: hidden; background: rgba(255,252,239,.92); border: 1px solid rgba(201,151,43,.36); border-radius: 30px; padding: 18px; display: grid; gap: 14px; box-shadow: 0 18px 50px rgba(4,45,35,.12); }
.reviewHeader { display: grid; grid-template-columns: 1fr minmax(180px, 280px); gap: 12px; align-items: end; }
.reviewHeader h2 { margin: 0; font-size: 22px; font-weight: 950; color: var(--emerald-dark); }
.reviewHeader p { margin: 5px 0 0; }
.filters { display: flex; gap: 8px; flex-wrap: wrap; }
.filters button { background: rgba(255,255,255,.75); border: 1px solid rgba(201,151,43,.36); color: var(--emerald-dark); border-radius: 999px; padding: 9px 12px; }
.filters button.selected { background: linear-gradient(135deg, var(--emerald-dark), var(--emerald)); color: #fff8e7; border-color: var(--emerald); }
.reviewCount { color: var(--muted); font-size: 13px; font-weight: 900; }
.reviewGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px; }
.reviewCard { border-radius: 24px; border: 1px solid rgba(201,151,43,.28); background: rgba(255,255,255,.72); padding: 14px; box-shadow: 0 8px 22px rgba(4,45,35,.08); }
.reviewCard.love { border-color: #86efac; background: linear-gradient(180deg, #fffdf5, #ecfdf5); }
.reviewCard.dislike { border-color: #fecaca; background: linear-gradient(180deg, #fffdf5, #fff1f2); }
.reviewTop { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.reviewTop span { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 999px 999px 10px 10px; background: #f7e7b1; color: #6b4b05; font-size: 12px; font-weight: 950; }
.reviewTop b { border-radius: 999px; padding: 5px 9px; font-size: 11px; font-weight: 950; background: #f7e7b1; color: #5c3f05; }
.reviewCard.love .reviewTop b { background: #dcfce7; color: #15803d; }
.reviewCard.dislike .reviewTop b { background: #fee2e2; color: #dc2626; }
.reviewArabic { direction: rtl; text-align: center; font-size: 23px; line-height: 2; font-weight: 950; color: var(--emerald-dark); padding: 10px; border-radius: 18px; background: rgba(255,248,231,.72); border: 1px solid rgba(201,151,43,.18); }
.reviewPersian { margin-top: 10px; color: #475569; font-size: 14px; line-height: 1.9; font-weight: 850; text-align: center; }
@media (max-width: 700px) { .page { padding: 10px; } .top { flex-direction: column; } h1 { font-size: 27px; } .status { flex-direction: column; align-items: stretch; } .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .reviewHeader { grid-template-columns: 1fr; } .reviewGrid { grid-template-columns: 1fr; } .lobby { padding: 22px; } }
`;

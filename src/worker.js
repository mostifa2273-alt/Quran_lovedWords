import { DATA, createCards, isCorrectPair } from "./game-data.js";

const ROOM_CODE_PATTERN = /^[A-Z0-9]{5}$/;
const TURN_DELAY_MS = 950;
const MAX_PLAYERS = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newGame(roomCode) {
  return {
    roomCode,
    cards: createCards(DATA),
    players: [],
    matchedPairs: [],
    flippedCards: [],
    locked: false,
    turnPlayerId: null,
    hostId: null,
    started: false,
    moves: 0,
    mistakes: 0,
    message: "اتاق آماده است. هر دو بازیکن باید آماده شوند تا میزبان بازی را شروع کند.",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function sanitizeName(value) {
  const name = String(value || "").trim().slice(0, 24);
  return name || "بازیکن";
}

function sanitizeIdentity(value) {
  return String(value || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 80) || crypto.randomUUID();
}

function activePlayerIds(sessions) {
  return new Set([...sessions.values()].filter((meta) => meta.role === "player").map((meta) => meta.playerId));
}

function normalizePlayers(game, sessions = new Map()) {
  const onlineIds = activePlayerIds(sessions);
  game.players = game.players.slice(0, MAX_PLAYERS).map((player, index) => ({
    ...player,
    number: index + 1,
    online: onlineIds.has(player.id),
    ready: Boolean(player.ready)
  }));

  if (!game.hostId || !game.players.some((player) => player.id === game.hostId)) {
    game.hostId = game.players[0]?.id || null;
  }

  if (!game.turnPlayerId || !game.players.some((player) => player.id === game.turnPlayerId)) {
    game.turnPlayerId = game.players[0]?.id || null;
  }
}

function allPlayersReady(game) {
  return game.players.length === MAX_PLAYERS && game.players.every((player) => player.ready);
}

function visibleState(game, youId, sessions = new Map()) {
  normalizePlayers(game, sessions);
  const visibleCards = new Set(game.flippedCards);
  const matchedPairs = new Set(game.matchedPairs);

  return {
    roomCode: game.roomCode,
    youId,
    players: game.players,
    hostId: game.hostId,
    turnPlayerId: game.turnPlayerId,
    started: game.started,
    canStart: allPlayersReady(game),
    matchedCount: game.matchedPairs.length,
    totalPairs: DATA.length,
    moves: game.moves,
    mistakes: game.mistakes,
    locked: game.locked,
    message: game.message,
    finished: game.matchedPairs.length === DATA.length,
    cards: game.cards.map((card) => {
      const visible = visibleCards.has(card.cardId) || matchedPairs.has(card.pairId);
      return { cardId: card.cardId, pairId: card.pairId, group: card.group, matched: matchedPairs.has(card.pairId), visible, side: visible ? card.side : null, text: visible ? card.text : null };
    })
  };
}

function nextTurn(players, currentId) {
  const onlinePlayers = players.filter((player) => player.online !== false);
  const pool = onlinePlayers.length >= 2 ? onlinePlayers : players;
  if (pool.length < 2) return currentId;
  const index = pool.findIndex((player) => player.id === currentId);
  if (index < 0) return pool[0]?.id || null;
  return pool[(index + 1) % pool.length]?.id || null;
}

function safeSend(ws, payload) {
  try { ws.send(JSON.stringify(payload)); } catch {}
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true, service: "quran-memory-online" });
    if (url.pathname.startsWith("/ws/")) {
      const roomCode = url.pathname.split("/").filter(Boolean)[1]?.toUpperCase();
      if (!roomCode || !ROOM_CODE_PATTERN.test(roomCode)) return new Response("Invalid room code", { status: 400 });
      return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(roomCode)).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map();
    this.game = null;
    this.ctx.blockConcurrencyWhile(async () => {
      this.game = await this.ctx.storage.get("game");
      for (const ws of this.ctx.getWebSockets()) {
        const meta = ws.deserializeAttachment();
        if (meta?.playerId) this.sessions.set(ws, meta);
      }
      if (this.game) normalizePlayers(this.game, this.sessions);
    });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const url = new URL(request.url);
    const roomCode = url.pathname.split("/").filter(Boolean)[1]?.toUpperCase();
    const name = sanitizeName(url.searchParams.get("name"));
    const requestedId = sanitizeIdentity(url.searchParams.get("identity"));
    if (!roomCode || !ROOM_CODE_PATTERN.test(roomCode)) return new Response("Invalid room code", { status: 400 });

    if (!this.game || this.game.roomCode !== roomCode) this.game = newGame(roomCode);
    normalizePlayers(this.game, this.sessions);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const existingPlayer = this.game.players.find((player) => player.id === requestedId);
    const role = existingPlayer || this.game.players.length < MAX_PLAYERS ? "player" : "spectator";
    const playerId = role === "player" ? requestedId : crypto.randomUUID();
    const meta = { playerId, name, role };
    server.serializeAttachment(meta);
    this.ctx.acceptWebSocket(server);
    this.sessions.set(server, meta);

    if (role === "player") {
      if (existingPlayer) {
        existingPlayer.name = name;
        existingPlayer.online = true;
      } else {
        this.game.players.push({ id: playerId, name, score: 0, number: this.game.players.length + 1, ready: false, online: true });
      }
      normalizePlayers(this.game, this.sessions);
      this.game.message = this.game.players.length === 1 ? "اتاق ساخته شد. لینک یا کد اتاق را برای بازیکن دوم بفرست." : "دو بازیکن در اتاق هستند. آماده شوید تا میزبان شروع کند.";
      await this.save();
    }

    safeSend(server, { type: "welcome", playerId, identity: playerId, role, state: visibleState(this.game, playerId, this.sessions) });
    this.broadcastState();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, rawMessage) {
    let msg;
    try { msg = JSON.parse(rawMessage); } catch { return; }
    const meta = this.sessions.get(ws) || ws.deserializeAttachment();
    if (!meta?.playerId || !this.game) return;

    if (msg.type === "ready") {
      if (meta.role !== "player") return;
      this.game.players = this.game.players.map((p) => p.id === meta.playerId ? { ...p, ready: Boolean(msg.ready) } : p);
      this.game.message = allPlayersReady(this.game) ? "همه آماده‌اند. میزبان می‌تواند بازی را شروع کند." : "منتظر آماده شدن هر دو بازیکن هستیم.";
      await this.saveAndBroadcast();
      return;
    }

    if (msg.type === "start") {
      if (meta.playerId !== this.game.hostId) return;
      if (!allPlayersReady(this.game)) { safeSend(ws, { type: "notice", message: "برای شروع، هر دو بازیکن باید آماده باشند." }); return; }
      this.game.started = true;
      this.game.turnPlayerId = this.game.hostId;
      this.game.message = "بازی شروع شد. میزبان نوبت اول را دارد.";
      await this.saveAndBroadcast();
      return;
    }

    if (msg.type === "restart") {
      if (meta.playerId !== this.game.hostId) return;
      await this.restartGame("بازی از نو آماده شد. دوباره آماده شوید.");
      return;
    }

    if (msg.type !== "select" || meta.role !== "player") return;
    if (!this.game.started) { safeSend(ws, { type: "notice", message: "بازی هنوز شروع نشده است." }); return; }
    if (this.game.locked || this.game.turnPlayerId !== meta.playerId) { safeSend(ws, { type: "notice", message: "الان نوبت تو نیست." }); return; }
    if (this.game.matchedPairs.length === DATA.length) return;

    const card = this.game.cards.find((candidate) => candidate.cardId === msg.cardId);
    if (!card || this.game.matchedPairs.includes(card.pairId) || this.game.flippedCards.includes(card.cardId) || this.game.flippedCards.length >= 2) return;
    this.game.flippedCards.push(card.cardId);
    if (this.game.flippedCards.length === 1) { this.game.message = "کارت دوم را انتخاب کن."; await this.saveAndBroadcast(); return; }

    const [firstId, secondId] = this.game.flippedCards;
    const first = this.game.cards.find((candidate) => candidate.cardId === firstId);
    const second = this.game.cards.find((candidate) => candidate.cardId === secondId);
    const matched = isCorrectPair(first, second);
    this.game.moves += 1;
    this.game.locked = true;

    if (matched) {
      this.game.matchedPairs.push(first.pairId);
      this.game.players = this.game.players.map((player) => player.id === meta.playerId ? { ...player, score: player.score + 1 } : player);
      this.game.flippedCards = [];
      this.game.locked = false;
      this.game.message = "درست بود. همان بازیکن دوباره بازی می‌کند.";
      if (this.game.matchedPairs.length === DATA.length) {
        const [winner, runnerUp] = [...this.game.players].sort((a, b) => b.score - a.score);
        this.game.message = winner && runnerUp && winner.score === runnerUp.score ? "بازی تمام شد. نتیجه مساوی است." : `بازی تمام شد. برنده: ${winner?.name || "بازیکن"}`;
      }
      await this.saveAndBroadcast();
      return;
    }

    this.game.mistakes += 1;
    this.game.message = first?.side === second?.side ? "هر دو کارت از یک زبان بودند. این انتخاب مجاز است اما خطا حساب شد و نوبت عوض می‌شود." : "این دو کارت جفت نبودند. نوبت عوض می‌شود.";
    await this.saveAndBroadcast();
    await sleep(TURN_DELAY_MS);
    if (!this.game.locked) return;
    this.game.flippedCards = [];
    this.game.locked = false;
    normalizePlayers(this.game, this.sessions);
    this.game.turnPlayerId = nextTurn(this.game.players, meta.playerId);
    this.game.message = "نوبت بازیکن بعدی است.";
    await this.saveAndBroadcast();
  }

  async webSocketClose(ws) { await this.removeSession(ws); }
  async webSocketError(ws) { await this.removeSession(ws); }

  async removeSession(ws) {
    const meta = this.sessions.get(ws) || ws.deserializeAttachment();
    this.sessions.delete(ws);
    if (!meta || !this.game || meta.role !== "player") return;
    const stillOnline = [...this.sessions.values()].some((session) => session.role === "player" && session.playerId === meta.playerId);
    if (!stillOnline) {
      this.game.players = this.game.players.map((player) => player.id === meta.playerId ? { ...player, online: false } : player);
      this.game.message = "یک بازیکن آفلاین شد؛ با همان دستگاه می‌تواند دوباره وصل شود.";
      await this.saveAndBroadcast();
    }
  }

  async restartGame(message) {
    const roomCode = this.game?.roomCode || "ROOM1";
    const existingPlayers = this.game?.players || [];
    const hostId = this.game?.hostId || existingPlayers[0]?.id || null;
    this.game = newGame(roomCode);
    this.game.players = existingPlayers.map((player, index) => ({ ...player, score: 0, number: index + 1, ready: false }));
    this.game.hostId = hostId;
    this.game.turnPlayerId = hostId;
    normalizePlayers(this.game, this.sessions);
    this.game.message = message;
    await this.saveAndBroadcast();
  }

  async save() { normalizePlayers(this.game, this.sessions); this.game.updatedAt = Date.now(); await this.ctx.storage.put("game", this.game); }
  async saveAndBroadcast() { await this.save(); this.broadcastState(); }
  broadcastState() { for (const [ws, meta] of this.sessions.entries()) safeSend(ws, { type: "state", state: visibleState(this.game, meta.playerId, this.sessions) }); }
}

export const __test__ = { allPlayersReady, nextTurn, normalizePlayers };

import { DATA, createCards, isCorrectPair } from "./game-data.js";

export const ROOM_CODE_PATTERN = /^[A-Z0-9]{5}$/;
export const TURN_DELAY_MS = 950;
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
    started: false,
    turnPlayerId: null,
    hostId: null,
    moves: 0,
    mistakes: 0,
    message: "اتاق آماده است. هر دو بازیکن باید آماده شوند و میزبان بازی را شروع کند.",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

export function sanitizeName(value) {
  const name = String(value || "").trim().slice(0, 24);
  return name || "بازیکن";
}

export function sanitizeClientId(value) {
  const id = String(value || "").trim();
  return /^[a-zA-Z0-9_-]{12,80}$/.test(id) ? id : crypto.randomUUID();
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    score: player.score,
    number: player.number,
    ready: Boolean(player.ready),
    online: Boolean(player.online),
    host: Boolean(player.host)
  };
}

function visibleState(game, youId) {
  const visibleCards = new Set(game.flippedCards);
  const matchedPairs = new Set(game.matchedPairs);

  return {
    roomCode: game.roomCode,
    youId,
    players: game.players.map(publicPlayer),
    hostId: game.hostId,
    started: Boolean(game.started),
    canStart: game.players.length === MAX_PLAYERS && game.players.every((player) => player.ready),
    turnPlayerId: game.turnPlayerId,
    matchedCount: game.matchedPairs.length,
    totalPairs: DATA.length,
    moves: game.moves,
    mistakes: game.mistakes,
    locked: game.locked,
    message: game.message,
    finished: game.matchedPairs.length === DATA.length,
    cards: game.cards.map((card) => {
      const visible = visibleCards.has(card.cardId) || matchedPairs.has(card.pairId);
      return {
        cardId: card.cardId,
        pairId: card.pairId,
        group: card.group,
        matched: matchedPairs.has(card.pairId),
        visible,
        side: visible ? card.side : null,
        text: visible ? card.text : null
      };
    })
  };
}

function nextTurn(players, currentId) {
  const activePlayers = players.filter((player) => player.online);
  const roster = activePlayers.length >= 2 ? activePlayers : players;
  if (roster.length < 2) return currentId;
  const index = roster.findIndex((player) => player.id === currentId);
  if (index < 0) return roster[0]?.id || null;
  return roster[(index + 1) % roster.length]?.id || null;
}

function safeSend(ws, payload) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Ignore a broken socket.
  }
}

function reseatPlayers(game) {
  game.players = game.players.map((player, index) => ({
    ...player,
    number: index + 1,
    host: index === 0
  }));
  game.hostId = game.players[0]?.id || null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "quran-memory-online" });
    }

    if (url.pathname.startsWith("/ws/")) {
      const roomCode = url.pathname.split("/").filter(Boolean)[1]?.toUpperCase();
      if (!roomCode || !ROOM_CODE_PATTERN.test(roomCode)) {
        return new Response("Invalid room code", { status: 400 });
      }

      const id = env.GAME_ROOM.idFromName(roomCode);
      const room = env.GAME_ROOM.get(id);
      return room.fetch(request);
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
    });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const roomCode = url.pathname.split("/").filter(Boolean)[1]?.toUpperCase();
    const name = sanitizeName(url.searchParams.get("name"));
    const clientId = sanitizeClientId(url.searchParams.get("clientId"));

    if (!roomCode || !ROOM_CODE_PATTERN.test(roomCode)) {
      return new Response("Invalid room code", { status: 400 });
    }

    if (!this.game || this.game.roomCode !== roomCode) {
      this.game = newGame(roomCode);
      await this.ctx.storage.put("game", this.game);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const existing = this.game.players.find((player) => player.clientId === clientId);
    const role = existing ? "player" : this.game.players.length < MAX_PLAYERS ? "player" : "spectator";
    const playerId = existing?.id || clientId;

    const meta = { playerId, clientId, name, role };
    server.serializeAttachment(meta);
    this.ctx.acceptWebSocket(server);
    this.sessions.set(server, meta);

    if (role === "player") {
      if (existing) {
        existing.name = name;
        existing.online = true;
      } else {
        this.game.players.push({
          id: playerId,
          clientId,
          name,
          score: 0,
          number: this.game.players.length + 1,
          ready: false,
          online: true,
          host: this.game.players.length === 0
        });
      }

      reseatPlayers(this.game);
      if (!this.game.turnPlayerId) this.game.turnPlayerId = this.game.players[0]?.id || null;
      this.game.message = existing
        ? `${name} دوباره وصل شد.`
        : this.game.players.length === 1
          ? "اتاق ساخته شد. لینک یا کد اتاق را برای بازیکن دوم بفرست."
          : "دو بازیکن در اتاق هستند. آماده شوید تا میزبان شروع کند.";
      await this.save();
    }

    safeSend(server, {
      type: "welcome",
      playerId,
      role,
      clientId,
      state: visibleState(this.game, playerId)
    });

    this.broadcastState();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, rawMessage) {
    let msg;
    try {
      msg = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const meta = this.sessions.get(ws) || ws.deserializeAttachment();
    if (!meta?.playerId || !this.game) return;
    const player = this.game.players.find((candidate) => candidate.id === meta.playerId);
    const isHost = this.game.hostId === meta.playerId;

    if (msg.type === "ready") {
      if (meta.role !== "player" || !player || this.game.started) return;
      player.ready = Boolean(msg.ready);
      this.game.message = player.ready ? `${player.name} آماده است.` : `${player.name} هنوز آماده نیست.`;
      await this.saveAndBroadcast();
      return;
    }

    if (msg.type === "start") {
      if (!isHost) return;
      if (this.game.players.length < MAX_PLAYERS) {
        safeSend(ws, { type: "notice", message: "برای شروع به دو بازیکن نیاز است." });
        return;
      }
      if (!this.game.players.every((candidate) => candidate.ready)) {
        safeSend(ws, { type: "notice", message: "هر دو بازیکن باید آماده باشند." });
        return;
      }
      this.game.started = true;
      this.game.turnPlayerId = this.game.players[0]?.id || null;
      this.game.message = "بازی شروع شد. بازیکن میزبان شروع می‌کند.";
      await this.saveAndBroadcast();
      return;
    }

    if (msg.type === "restart") {
      if (!isHost) return;
      await this.restartGame("بازی از نو آماده شد. هر دو بازیکن دوباره آماده شوند.");
      return;
    }

    if (msg.type !== "select") return;
    if (meta.role !== "player") return;
    if (!this.game.started) {
      safeSend(ws, { type: "notice", message: "بازی هنوز شروع نشده است." });
      return;
    }

    if (this.game.locked) return;

    if (this.game.turnPlayerId !== meta.playerId) {
      safeSend(ws, { type: "notice", message: "الان نوبت تو نیست." });
      return;
    }

    if (this.game.matchedPairs.length === DATA.length) return;

    const card = this.game.cards.find((candidate) => candidate.cardId === msg.cardId);
    if (!card) return;
    if (this.game.matchedPairs.includes(card.pairId)) return;
    if (this.game.flippedCards.includes(card.cardId)) return;
    if (this.game.flippedCards.length >= 2) return;

    this.game.flippedCards.push(card.cardId);

    if (this.game.flippedCards.length === 1) {
      this.game.message = "کارت دوم را انتخاب کن.";
      await this.saveAndBroadcast();
      return;
    }

    const [firstId, secondId] = this.game.flippedCards;
    const first = this.game.cards.find((candidate) => candidate.cardId === firstId);
    const second = this.game.cards.find((candidate) => candidate.cardId === secondId);
    const matched = isCorrectPair(first, second);

    this.game.moves += 1;
    this.game.locked = true;

    if (matched) {
      this.game.matchedPairs.push(first.pairId);
      this.game.players = this.game.players.map((candidate) =>
        candidate.id === meta.playerId ? { ...candidate, score: candidate.score + 1 } : candidate
      );
      this.game.flippedCards = [];
      this.game.locked = false;
      this.game.message = "درست بود. همان بازیکن دوباره بازی می‌کند.";

      if (this.game.matchedPairs.length === DATA.length) {
        const sorted = [...this.game.players].sort((a, b) => b.score - a.score);
        const winner = sorted[0];
        const runnerUp = sorted[1];
        this.game.message =
          winner && runnerUp && winner.score === runnerUp.score
            ? "بازی تمام شد. نتیجه مساوی است."
            : `بازی تمام شد. برنده: ${winner?.name || "بازیکن"}`;
      }

      await this.saveAndBroadcast();
      return;
    }

    this.game.mistakes += 1;
    this.game.message =
      first?.side === second?.side
        ? "هر دو کارت از یک زبان بودند. این انتخاب مجاز است اما خطا حساب شد و نوبت عوض می‌شود."
        : "این دو کارت جفت نبودند. نوبت عوض می‌شود.";

    await this.saveAndBroadcast();
    await sleep(TURN_DELAY_MS);

    if (!this.game.locked) return;

    this.game.flippedCards = [];
    this.game.locked = false;
    this.game.turnPlayerId = nextTurn(this.game.players, meta.playerId);
    this.game.message = "نوبت بازیکن بعدی است.";
    await this.saveAndBroadcast();
  }

  async webSocketClose(ws) {
    await this.markOffline(ws);
  }

  async webSocketError(ws) {
    await this.markOffline(ws);
  }

  async markOffline(ws) {
    const meta = this.sessions.get(ws) || ws.deserializeAttachment();
    this.sessions.delete(ws);

    if (!meta || !this.game || meta.role !== "player") return;

    const stillConnected = [...this.sessions.values()].some((session) => session.playerId === meta.playerId);
    if (stillConnected) return;

    const player = this.game.players.find((candidate) => candidate.id === meta.playerId);
    if (!player) return;

    player.online = false;
    player.ready = false;
    if (!this.game.started) {
      this.game.message = `${player.name} آفلاین شد. با همان دستگاه می‌تواند دوباره وصل شود.`;
    } else {
      this.game.message = `${player.name} آفلاین شد. منتظر اتصال دوباره بمانید.`;
    }
    await this.saveAndBroadcast();
  }

  async restartGame(message) {
    const roomCode = this.game?.roomCode || "ROOM1";
    const existingPlayers = this.game?.players || [];
    this.game = newGame(roomCode);
    this.game.players = existingPlayers.map((player, index) => ({
      ...player,
      score: 0,
      number: index + 1,
      ready: false,
      host: index === 0
    }));
    this.game.hostId = this.game.players[0]?.id || null;
    this.game.turnPlayerId = this.game.players[0]?.id || null;
    this.game.message = message;
    await this.saveAndBroadcast();
  }

  async save() {
    this.game.updatedAt = Date.now();
    await this.ctx.storage.put("game", this.game);
  }

  async saveAndBroadcast() {
    await this.save();
    this.broadcastState();
  }

  broadcastState() {
    for (const [ws, meta] of this.sessions.entries()) {
      safeSend(ws, {
        type: "state",
        state: visibleState(this.game, meta.playerId)
      });
    }
  }
}

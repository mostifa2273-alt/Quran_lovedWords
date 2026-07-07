import { DATA, createCards, isCorrectPair, normalizeGameOptions, selectGameItems } from "./game-data.js";

const ROOM_CODE_PATTERN = /^[A-Z0-9]{5}$/;
const TURN_DELAY_MS = 950;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newGame(roomCode, options = {}) {
  const settings = normalizeGameOptions(options);
  const items = selectGameItems(settings);

  return {
    roomCode,
    settings,
    itemIds: items.map((item) => item.id),
    cards: createCards(items),
    players: [],
    matchedPairs: [],
    flippedCards: [],
    locked: false,
    turnPlayerId: null,
    moves: 0,
    mistakes: 0,
    message: "بازی آماده است. بازیکن اول شروع می‌کند.",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function sanitizeName(value) {
  const name = String(value || "").trim().slice(0, 24);
  return name || "بازیکن";
}

function publicPlayers(players) {
  return players.map((player) => ({
    id: player.id,
    name: player.name,
    score: player.score,
    number: player.number,
    connected: player.connected !== false
  }));
}

function visibleState(game, youId) {
  const visibleCards = new Set(game.flippedCards);
  const matchedPairs = new Set(game.matchedPairs);

  return {
    roomCode: game.roomCode,
    youId,
    players: publicPlayers(game.players),
    turnPlayerId: game.turnPlayerId,
    matchedCount: game.matchedPairs.length,
    totalPairs: game.itemIds?.length || game.settings?.pairCount || DATA.length,
    moves: game.moves,
    mistakes: game.mistakes,
    locked: game.locked,
    message: game.message,
    finished: game.matchedPairs.length === (game.itemIds?.length || game.settings?.pairCount || DATA.length),
    settings: game.settings || normalizeGameOptions(),
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
  if (players.length < 2) return currentId;
  const index = players.findIndex((player) => player.id === currentId);
  if (index < 0) return players[0]?.id || null;
  return players[(index + 1) % players.length]?.id || null;
}

function safeSend(ws, payload) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // Ignore a broken socket.
  }
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
    const requestedOptions = normalizeGameOptions({
      group: url.searchParams.get("group"),
      pairCount: url.searchParams.get("pairCount")
    });

    if (!roomCode || !ROOM_CODE_PATTERN.test(roomCode)) {
      return new Response("Invalid room code", { status: 400 });
    }

    if (!this.game || this.game.roomCode !== roomCode) {
      this.game = newGame(roomCode, requestedOptions);
      await this.ctx.storage.put("game", this.game);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const disconnectedPlayer = this.game.players.find(
      (player) => player.connected === false && player.name === name
    );
    const playerId = disconnectedPlayer?.id || crypto.randomUUID();
    const openPlayerSlots = Math.max(0, 2 - this.game.players.length);
    const role = disconnectedPlayer || openPlayerSlots > 0 ? "player" : "spectator";
    const playerNumber = disconnectedPlayer?.number || this.game.players.length + 1;

    const meta = { playerId, name, role };
    server.serializeAttachment(meta);
    this.ctx.acceptWebSocket(server);
    this.sessions.set(server, meta);

    if (role === "player") {
      if (disconnectedPlayer) {
        this.game.players = this.game.players.map((player) =>
          player.id === playerId ? { ...player, name, connected: true, lastSeen: Date.now() } : player
        );
      } else {
        this.game.players.push({
          id: playerId,
          name,
          score: 0,
          number: playerNumber,
          connected: true,
          lastSeen: Date.now()
        });
      }

      if (!this.game.turnPlayerId) {
        this.game.turnPlayerId = playerId;
      }

      this.game.message = disconnectedPlayer
        ? `${name} دوباره به اتاق برگشت.`
        : this.game.players.length === 1
          ? "اتاق ساخته شد. کد اتاق را برای بازیکن دوم بفرست."
          : "دو بازیکن وصل شدند. بازی شروع شد.";

      await this.save();
    }

    safeSend(server, {
      type: "welcome",
      playerId,
      role,
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

    if (msg.type === "leave") {
      await this.removeSession(ws, { removePlayer: true });
      try {
        ws.close(1000, "Player left the room");
      } catch {
        // Ignore a broken socket.
      }
      return;
    }

    if (msg.type === "restart") {
      if (meta.role !== "player") return;
      await this.restartGame("بازی از نو شروع شد.");
      return;
    }

    if (msg.type !== "select") return;
    if (meta.role !== "player") return;

    if (this.game.locked) return;

    if (this.game.turnPlayerId !== meta.playerId) {
      safeSend(ws, { type: "notice", message: "الان نوبت تو نیست." });
      return;
    }

    const totalPairs = this.game.itemIds?.length || this.game.settings?.pairCount || DATA.length;
    if (this.game.matchedPairs.length === totalPairs) return;

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
      this.game.players = this.game.players.map((player) =>
        player.id === meta.playerId ? { ...player, score: player.score + 1 } : player
      );
      this.game.flippedCards = [];
      this.game.locked = false;
      this.game.message = "درست بود. همان بازیکن دوباره بازی می‌کند.";

      if (this.game.matchedPairs.length === totalPairs) {
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
        ? "هر دو کارت از یک زبان بودند. نوبت عوض می‌شود."
        : "این دو کارت جفت نبودند. نوبت عوض می‌شود.";

    await this.saveAndBroadcast();
    await sleep(TURN_DELAY_MS);

    // Another event may have restarted the game while we were waiting.
    if (!this.game.locked) return;

    this.game.flippedCards = [];
    this.game.locked = false;
    this.game.turnPlayerId = nextTurn(this.game.players, meta.playerId);
    this.game.message = "نوبت بازیکن بعدی است.";
    await this.saveAndBroadcast();
  }

  async webSocketClose(ws) {
    await this.removeSession(ws);
  }

  async webSocketError(ws) {
    await this.removeSession(ws);
  }

  async removeSession(ws, { removePlayer = false } = {}) {
    const meta = this.sessions.get(ws) || ws.deserializeAttachment();
    this.sessions.delete(ws);

    if (!meta || !this.game) return;

    if (meta.role === "player") {
      const playerStillInRoom = this.game.players.some((player) => player.id === meta.playerId);
      if (!playerStillInRoom) return;

      const hasAnotherSession = [...this.sessions.values()].some(
        (session) => session.role === "player" && session.playerId === meta.playerId
      );
      if (!removePlayer && hasAnotherSession) return;

      if (removePlayer) {
        this.game.players = this.game.players.filter((player) => player.id !== meta.playerId);

        if (this.game.turnPlayerId === meta.playerId) {
          this.game.turnPlayerId = this.game.players[0]?.id || null;
        }

        if (this.game.players.length === 0) {
          // Keep the shuffled board for a while, but reset seats for the next visitors.
          this.game.message = "همه بازیکنان خارج شدند.";
        } else {
          this.game.message = "یک بازیکن خارج شد. بازیکن دیگری می‌تواند با همین کد وارد شود.";
        }
      } else {
        this.game.players = this.game.players.map((player) =>
          player.id === meta.playerId ? { ...player, connected: false, lastSeen: Date.now() } : player
        );
        this.game.message = "اتصال یک بازیکن قطع شد؛ جای او در اتاق حفظ شد و می‌تواند دوباره برگردد.";
      }

      await this.saveAndBroadcast();
    }
  }

  async restartGame(message) {
    const roomCode = this.game?.roomCode || "ROOM1";
    const existingPlayers = this.game?.players || [];
    const settings = this.game?.settings || normalizeGameOptions();
    this.game = newGame(roomCode, settings);
    this.game.players = existingPlayers.map((player, index) => ({
      ...player,
      score: 0,
      number: index + 1,
      connected: player.connected !== false
    }));
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

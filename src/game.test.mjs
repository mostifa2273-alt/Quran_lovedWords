import assert from "node:assert/strict";
import { CARD_COUNT_OPTIONS, DATA, createCards, groupLabel, groupSymbol, isCorrectPair, normalizeGameOptions, selectGameItems } from "./game-data.js";

const ids = new Set(DATA.map((item) => item.id));
const cards = createCards(DATA);

assert.equal(DATA.length, 28, "There must be 28 Arabic-Persian pairs.");
assert.equal(ids.size, DATA.length, "All item IDs must be unique.");
assert.equal(DATA.filter((item) => item.group === "love").length, 14, "There must be 14 loved items.");
assert.equal(DATA.filter((item) => item.group === "dislike").length, 14, "There must be 14 not-loved items.");
assert.equal(cards.length, 56, "All-cards game must create 56 cards.");
assert.equal(cards.filter((card) => card.group === "love").length, 28, "Loved items must create 28 cards.");
assert.equal(cards.filter((card) => card.group === "dislike").length, 28, "Not-loved items must create 28 cards.");
assert.deepEqual(CARD_COUNT_OPTIONS, [6, 10, 14, 20, 28], "Lobby count options should stay predictable.");
assert.equal(normalizeGameOptions({ pairCount: 10, group: "love" }).pairCount, 10);
assert.equal(normalizeGameOptions({ pairCount: 28, group: "love" }).pairCount, 14, "Group-only games cannot exceed available pairs.");
assert.equal(normalizeGameOptions({ pairCount: 0, group: "nope" }).group, "all", "Invalid groups fall back to all.");
assert.equal(selectGameItems({ pairCount: 6, group: "dislike" }).length, 6, "Custom games choose requested pair count.");
assert.ok(selectGameItems({ pairCount: 6, group: "dislike" }).every((item) => item.group === "dislike"), "Group filter should choose one category.");
assert.equal(createCards({ pairCount: 6, group: "love" }).length, 12, "Custom cards include both Arabic and Persian sides.");
assert.ok(cards.every((card) => ids.has(card.pairId)), "Every card pairId must point to an item.");
assert.ok(cards.every((card) => card.side === "arabic" || card.side === "persian"), "Every card must have a valid side.");
assert.equal(groupLabel("love"), "خدا دوست دارد");
assert.equal(groupLabel("dislike"), "خدا دوست ندارد");
assert.equal(groupLabel("all"), "هر دو دسته");
assert.equal(groupSymbol("love"), "♥");
assert.equal(groupSymbol("dislike"), "!");
assert.equal(isCorrectPair({ pairId: "x", side: "arabic" }, { pairId: "x", side: "persian" }), true);
assert.equal(isCorrectPair({ pairId: "x", side: "arabic" }, { pairId: "x", side: "arabic" }), false);
assert.equal(isCorrectPair({ pairId: "x", side: "arabic" }, { pairId: "y", side: "persian" }), false);

console.log("All tests passed.");

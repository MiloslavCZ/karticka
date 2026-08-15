"use strict";

/* =========================================================
   CONFIG
   ========================================================= */
const MATCH_RADIUS_M = 100;         // OSM (Overpass) fallback search radius
const LOCAL_MATCH_RADIUS_M = 55;    // radius for matching against a card's own
                                     // remembered GPS spots — tighter, since it's
                                     // an exact fix rather than a named area
const RECHECK_MIN_DISTANCE_M = 8;   // re-check location after moving this far…
const RECHECK_MIN_INTERVAL_MS = 4000; // …or after this much time (whichever first) —
                                     // only applies while no card is manually open
const MATCH_LOCK_MS = 90000;        // once a match is found, keep showing it for this
                                     // long even if a single recheck comes up empty
                                     // (avoids flicker from a momentary GPS/API blip)
const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const INSTALL_DISMISS_DAYS = 7;

/* =========================================================
   TINY INDEXEDDB WRAPPER (cards store: {id, name, image, createdAt})
   ========================================================= */
const DB_NAME = "karticka-db";
const DB_STORE = "cards";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAddCard(name, imageDataUrl) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).add({
      name,
      image: imageDataUrl,
      createdAt: Date.now(),
      locations: [] // remembered GPS spots where this card was manually confirmed
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAllCards() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).getAll();
    req.onsuccess = () => resolve((req.result || []).map((c) => ({ ...c, locations: c.locations || [] })));
    req.onerror = () => reject(req.error);
  });
}

async function dbDeleteCard(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const MAX_SAVED_SPOTS_PER_CARD = 6;

async function dbAddLocationToCard(id, lat, lon) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const card = getReq.result;
      if (!card) { resolve(); return; }
      const locations = card.locations || [];
      locations.push({ lat, lon, savedAt: Date.now() });
      // keep only the most recent few fixes so old/stale data doesn't pile up
      card.locations = locations.slice(-MAX_SAVED_SPOTS_PER_CARD);
      store.put(card);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClearLocationsForCard(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const card = getReq.result;
      if (!card) { resolve(); return; }
      card.locations = [];
      store.put(card);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* =========================================================
   NAME NORMALIZATION + FUZZY MATCH
   ========================================================= */
function normalizeName(str) {
  return (str || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// true if the card's saved name and a POI's name plausibly refer to the same place
function namesMatch(cardName, poiName) {
  const a = normalizeName(cardName);
  const b = normalizeName(poiName);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 3 && b.includes(a)) return true;
  if (b.length >= 3 && a.includes(b)) return true;
  return false;
}

/* =========================================================
   OVERPASS: FIND NEARBY NAMED PLACES
   ========================================================= */
async function fetchNearbyPlaces(lat, lon) {
  const q = `
    [out:json][timeout:15];
    (
      node(around:${MATCH_RADIUS_M},${lat},${lon})["shop"];
      way(around:${MATCH_RADIUS_M},${lat},${lon})["shop"];
      node(around:${MATCH_RADIUS_M},${lat},${lon})["amenity"="fuel"];
      way(around:${MATCH_RADIUS_M},${lat},${lon})["amenity"="fuel"];
      node(around:${MATCH_RADIUS_M},${lat},${lon})["amenity"="pharmacy"];
      node(around:${MATCH_RADIUS_M},${lat},${lon})["amenity"="cafe"];
      node(around:${MATCH_RADIUS_M},${lat},${lon})["amenity"="restaurant"];
      node(around:${MATCH_RADIUS_M},${lat},${lon})["amenity"="fast_food"];
    );
    out center tags;
  `;

  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    body: "data=" + encodeURIComponent(q)
  });
  if (!res.ok) throw new Error("overpass_http_" + res.status);
  const json = await res.json();

  const places = [];
  const seenNames = new Set();
  for (const el of json.elements || []) {
    const tags = el.tags || {};
    const name = tags.name || tags.brand;
    if (!name) continue;
    const key = normalizeName(name);
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    places.push({ name });
  }
  return places;
}

/* =========================================================
   STATE
   ========================================================= */
const el = (id) => document.getElementById(id);

const els = {
  statusDot: el("statusDot"),
  statusText: el("statusText"),
  emptyState: el("emptyState"),
  matchState: el("matchState"),
  choiceState: el("choiceState"),
  listState: el("listState"),
  viewState: el("viewState"),
  matchName: el("matchName"),
  matchImg: el("matchImg"),
  choiceGrid: el("choiceGrid"),
  cardList: el("cardList"),
  listLabel: el("listLabel"),
  viewName: el("viewName"),
  viewImg: el("viewImg"),
  btnSaveSpot: el("btnSaveSpot"),
  spotHint: el("spotHint"),
  btnClearSpots: el("btnClearSpots"),
  btnLocate: el("btnLocate"),
  btnAdd: el("btnAdd"),
  btnAddFromEmpty: el("btnAddFromEmpty"),
  btnAllFromMatch: el("btnAllFromMatch"),
  btnAllFromChoice: el("btnAllFromChoice"),
  btnBackFromView: el("btnBackFromView"),
  btnDeleteFromView: el("btnDeleteFromView"),
  addModal: el("addModal"),
  btnCloseModal: el("btnCloseModal"),
  storeName: el("storeName"),
  dropZone: el("dropZone"),
  dropZoneEmpty: el("dropZoneEmpty"),
  previewImg: el("previewImg"),
  qrFile: el("qrFile"),
  btnSaveCard: el("btnSaveCard"),
  installBanner: el("installBanner"),
  installTitle: el("installTitle"),
  installSub: el("installSub"),
  btnInstall: el("btnInstall"),
  btnInstallDismiss: el("btnInstallDismiss"),
  iosModal: el("iosModal"),
  btnCloseIos: el("btnCloseIos"),
  btnCloseIos2: el("btnCloseIos2"),
  toast: el("toast"),
};

let allCards = [];
let currentViewCardId = null;
let pendingImageDataUrl = null;
let lastCheckedAt = 0;
let lastCheckedPos = null;

// "lock" state: once we find a match, keep it on screen for MATCH_LOCK_MS even
// if a later recheck briefly comes back empty (flaky GPS / Overpass hiccup).
let lockedMatchIds = [];   // ids of the cards currently locked in as "the match"
let lockedAt = 0;
let userBrowsedAway = false; // true once the user manually opens the full list
let manualViewOpen = false;  // true while a manually-picked card is on screen —
                              // automatic location rechecks must not steal focus

/* =========================================================
   PANEL SWITCHING
   ========================================================= */
function showPanel(name) {
  ["emptyState", "matchState", "choiceState", "listState", "viewState"].forEach((k) => {
    els[k].classList.toggle("hidden", k !== name);
  });
}

function setStatus(text, mood) {
  els.statusText.textContent = text;
  els.statusDot.className = "status-dot" + (mood ? " " + mood : "");
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.add("hidden"), 2200);
}

/* =========================================================
   CUSTOM CARD ORDER (persisted locally, independent of DB insertion order)
   ========================================================= */
const ORDER_KEY = "karticka-card-order";

function loadCardOrder() {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function saveCardOrder(ids) {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  } catch {}
}
function applyCardOrder(cards) {
  const order = loadCardOrder();
  if (!order.length) return cards;
  const pos = new Map(order.map((id, i) => [id, i]));
  return [...cards].sort((a, b) => {
    const ia = pos.has(a.id) ? pos.get(a.id) : Infinity;
    const ib = pos.has(b.id) ? pos.get(b.id) : Infinity;
    if (ia !== ib) return ia - ib;
    return a.createdAt - b.createdAt;
  });
}

/* =========================================================
   LONG-PRESS DRAG-TO-REORDER (Pointer Events — works for touch + mouse)
   ========================================================= */
const LONG_PRESS_MS = 380;
const DRAG_CANCEL_THRESHOLD_PX = 10;

let dragState = null;

function captureRowRects() {
  const map = new Map();
  Array.from(els.cardList.children).forEach((rowEl) => {
    map.set(rowEl.dataset.cardId, rowEl.getBoundingClientRect());
  });
  return map;
}

function animateDisplacedRows(prevRects) {
  Array.from(els.cardList.children).forEach((rowEl) => {
    if (dragState && rowEl === dragState.row) return;
    const oldRect = prevRects.get(rowEl.dataset.cardId);
    if (!oldRect) return;
    const newRect = rowEl.getBoundingClientRect();
    const delta = oldRect.top - newRect.top;
    if (Math.abs(delta) > 0.5) {
      rowEl.style.transition = "none";
      rowEl.style.transform = `translateY(${delta}px)`;
      requestAnimationFrame(() => {
        rowEl.style.transition = "transform 160ms ease";
        rowEl.style.transform = "";
      });
    }
  });
}

function beginDrag(row, clientY) {
  dragState = { row, pointerStartY: clientY };
  row.classList.add("dragging");
  row.style.transition = "none";
  row.style.touchAction = "none";
}

function moveDrag(clientY) {
  if (!dragState) return;
  const { row } = dragState;
  const dy = clientY - dragState.pointerStartY;
  row.style.transform = `translateY(${dy}px)`;

  const draggedRect = row.getBoundingClientRect();
  const draggedMid = draggedRect.top + draggedRect.height / 2;

  // Find the correct slot for the dragged row by comparing against every
  // other row's midpoint (not just the immediate neighbor) — this handles
  // both directions correctly and even lets a fast drag skip several rows
  // at once instead of only being able to swap one step at a time.
  const rows = Array.from(els.cardList.children);
  let insertBeforeNode = null;
  for (const sib of rows) {
    if (sib === row) continue;
    const r = sib.getBoundingClientRect();
    const sibMid = r.top + r.height / 2;
    if (draggedMid < sibMid) {
      insertBeforeNode = sib;
      break;
    }
  }

  const currentSlot = row.nextElementSibling; // null if row is currently last
  const alreadyThere =
    insertBeforeNode === currentSlot || (insertBeforeNode === null && currentSlot === null);
  if (alreadyThere) return;

  const prevRects = captureRowRects();
  const beforeTop = row.getBoundingClientRect().top;
  els.cardList.insertBefore(row, insertBeforeNode); // insertBeforeNode === null appends at the end
  row.style.transform = "none";
  const afterTopNoTransform = row.getBoundingClientRect().top;
  const neededDy = beforeTop - afterTopNoTransform;
  dragState.pointerStartY = clientY - neededDy;
  row.style.transform = `translateY(${neededDy}px)`;
  animateDisplacedRows(prevRects);
}

function endDrag() {
  if (!dragState) return;
  const { row } = dragState;
  row.classList.remove("dragging");
  row.style.transform = "";
  row.style.transition = "";
  row.style.touchAction = "";
  dragState = null;

  const ids = Array.from(els.cardList.children)
    .map((rowEl) => Number(rowEl.dataset.cardId))
    .filter((n) => !Number.isNaN(n));
  saveCardOrder(ids);
}

function attachRowDrag(row) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let longPressFired = false;
  let suppressClick = false;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function onMove(e) {
    if (!longPressFired) {
      if (
        Math.abs(e.clientX - startX) > DRAG_CANCEL_THRESHOLD_PX ||
        Math.abs(e.clientY - startY) > DRAG_CANCEL_THRESHOLD_PX
      ) {
        clearTimer();
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      }
      return;
    }
    e.preventDefault();
    moveDrag(e.clientY);
  }
  function onUp() {
    clearTimer();
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    if (longPressFired) {
      endDrag();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 60);
    }
    longPressFired = false;
  }

  row.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    longPressFired = false;
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    timer = setTimeout(() => {
      longPressFired = true;
      beginDrag(row, e.clientY);
      if (navigator.vibrate) navigator.vibrate(10);
    }, LONG_PRESS_MS);
  });

  // Swallow the click that would otherwise fire right after a drag release.
  row.addEventListener(
    "click",
    (e) => {
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );
}

/* =========================================================
   RENDER: LIST OF ALL CARDS (browse mode / fallback)
   ========================================================= */
function renderCardList(cards, label) {
  els.listLabel.textContent = label || "Vyber kartičku";
  els.cardList.innerHTML = "";
  const ordered = applyCardOrder(cards);
  ordered.forEach((card) => {
    const row = document.createElement("button");
    row.className = "card-row";
    row.dataset.cardId = String(card.id);
    row.innerHTML = `
      <img class="card-row-thumb" src="${card.image}" alt="" draggable="false">
      <span class="card-row-name">${escapeHtml(card.name)}</span>
      <span class="card-row-grip" aria-hidden="true">⠿</span>
    `;
    row.addEventListener("click", () => openCardView(card.id));
    attachRowDrag(row);
    els.cardList.appendChild(row);
  });
  showPanel("listState");
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function refreshSpotHint(card) {
  const n = (card.locations || []).length;
  if (n === 0) {
    els.spotHint.textContent = "Zatím appka nezná žádné tvoje místo pro tuhle kartičku.";
  } else {
    els.spotHint.textContent =
      "Uloženo míst: " + n + " — příště tě appka pozná i bez map, jakmile budeš blízko.";
  }
}

function openCardView(id) {
  const card = allCards.find((c) => c.id === id);
  if (!card) return;
  currentViewCardId = id;
  manualViewOpen = true; // keep this card on screen until the user explicitly leaves
  els.viewName.textContent = card.name;
  els.viewImg.src = card.image;
  refreshSpotHint(card);
  showPanel("viewState");
}

function leaveManualView() {
  manualViewOpen = false;
  userBrowsedAway = true;
  renderCardList(allCards, "Všechny kartičky");
  // Card is closed — immediately check location again instead of waiting for
  // the next background GPS tick, so a fresh match can appear right away.
  startLocating();
}

/* =========================================================
   CORE FLOW: LOCATE -> MATCH -> RENDER
   ========================================================= */
async function refreshCards() {
  allCards = await dbGetAllCards();
}

function renderForNoCards() {
  showPanel("emptyState");
}

function renderForMatches(matchedCards) {
  if (matchedCards.length === 1) {
    const card = matchedCards[0];
    els.matchName.textContent = card.name;
    els.matchImg.src = card.image;
    showPanel("matchState");
  } else {
    els.choiceGrid.innerHTML = "";
    matchedCards.forEach((card) => {
      const btn = document.createElement("button");
      btn.className = "choice-btn";
      btn.textContent = card.name;
      btn.addEventListener("click", () => {
        els.matchName.textContent = card.name;
        els.matchImg.src = card.image;
        showPanel("matchState");
      });
      els.choiceGrid.appendChild(btn);
    });
    showPanel("choiceState");
  }
}

async function evaluateLocation(lat, lon) {
  if (manualViewOpen) {
    // User is actively looking at a card they picked themselves — never
    // switch it out from under them because of a background location update.
    return;
  }

  await refreshCards();
  if (allCards.length === 0) {
    renderForNoCards();
    setStatus("Zatím nemáš žádné kartičky", null);
    return;
  }

  // --- FAST PATH: compare against each card's own remembered GPS spots. ---
  // This needs no network call, so it's instant, and it works even for shops
  // OpenStreetMap doesn't know about at all (e.g. individual stores inside a
  // shopping mall) — as long as you've confirmed you were there once before.
  const here = { lat, lon };
  const localMatches = allCards.filter((card) =>
    (card.locations || []).some((loc) => distanceMeters(here, loc) <= LOCAL_MATCH_RADIUS_M)
  );
  if (localMatches.length > 0) {
    lockedMatchIds = localMatches.map((c) => c.id);
    lockedAt = Date.now();
    userBrowsedAway = false;
    setStatus("Poblíž (podle uložené polohy): " + localMatches.map((c) => c.name).join(", "), "live");
    renderForMatches(localMatches);
    return;
  }

  // --- SLOWER FALLBACK: ask OpenStreetMap what's nearby by name. ---
  setStatus("Zjišťuji, kde právě jsi…", "warn");

  let nearby = [];
  try {
    nearby = await fetchNearbyPlaces(lat, lon);
  } catch (err) {
    // Network hiccup: if we still have a locked match, just keep it on screen
    // instead of bouncing to the fallback list.
    if (lockedMatchIds.length && Date.now() - lockedAt < MATCH_LOCK_MS) {
      setStatus("Poloha se teď nepodařila ověřit, ale zůstáváš u nalezené kartičky", "warn");
      return;
    }
    setStatus("Okolí se nepodařilo zjistit — vyber kartičku ručně", "err");
    renderCardList(allCards, "Nepodařilo se ověřit polohu");
    return;
  }

  const matched = [];
  for (const card of allCards) {
    const hit = nearby.some((p) => namesMatch(card.name, p.name));
    if (hit) matched.push(card);
  }

  if (matched.length > 0) {
    lockedMatchIds = matched.map((c) => c.id);
    lockedAt = Date.now();
    userBrowsedAway = false;
    setStatus("Poblíž: " + matched.map((c) => c.name).join(", "), "live");
    renderForMatches(matched);
    // Remember this spot for next time, so future visits skip the slow OSM
    // lookup entirely and use the instant local match instead.
    matched.forEach((c) => dbAddLocationToCard(c.id, lat, lon));
    return;
  }

  // No match this round — but if we recently had one locked in and the user
  // hasn't manually browsed away, keep showing it rather than flicker to the list.
  const stillLocked = lockedMatchIds.length && Date.now() - lockedAt < MATCH_LOCK_MS;
  if (stillLocked && !userBrowsedAway) {
    const stillCards = allCards.filter((c) => lockedMatchIds.includes(c.id));
    if (stillCards.length) {
      setStatus("Poblíž: " + stillCards.map((c) => c.name).join(", "), "live");
      renderForMatches(stillCards);
      return;
    }
  }

  lockedMatchIds = [];
  setStatus("V okolí nic uloženého — tady jsou všechny kartičky", null);
  renderCardList(allCards, "Nic poblíž nesedí — vyber ručně");
}

/* =========================================================
   GEOLOCATION
   ========================================================= */
function distanceMeters(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180;
  const la2 = b.lat * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function maybeRecheck(lat, lon) {
  if (manualViewOpen) {
    // A card is open on screen — don't burn Overpass calls checking location
    // in the background. We'll do a fresh check the moment the card is closed.
    return;
  }
  const now = Date.now();
  const pos = { lat, lon };
  const moved = lastCheckedPos ? distanceMeters(lastCheckedPos, pos) : Infinity;
  const elapsed = now - lastCheckedAt;
  if (moved < RECHECK_MIN_DISTANCE_M && elapsed < RECHECK_MIN_INTERVAL_MS) return;
  lastCheckedAt = now;
  lastCheckedPos = pos;
  evaluateLocation(lat, lon);
}

let watchStarted = false;
let lastKnownPosition = null; // {lat, lon, accuracy} — used by the "save this spot" button

function startLocating() {
  if (!("geolocation" in navigator)) {
    setStatus("Prohlížeč neumí zjistit polohu", "err");
    refreshCards().then((cards) => {
      if (cards.length === 0 || allCards.length === 0) renderForNoCards();
      else renderCardList(allCards, "Vyber kartičku ručně");
    });
    return;
  }

  setStatus("Zjišťuji, kde právě jsi…", "warn");

  // Force a fresh reading (bypass the debounce) whenever this is called directly,
  // e.g. from a manual tap — important on iOS, which requires geolocation to be
  // triggered by a direct user gesture rather than firing automatically on load.
  navigator.geolocation.getCurrentPosition(
    (p) => {
      lastCheckedAt = Date.now();
      lastCheckedPos = { lat: p.coords.latitude, lon: p.coords.longitude };
      lastKnownPosition = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy };
      evaluateLocation(p.coords.latitude, p.coords.longitude);
    },
    (err) => {
      let msg = "Poloha se nepodařila — vyber kartičku ručně";
      if (err.code === err.PERMISSION_DENIED) {
        msg = "Poloha zakázána — povol ji v nastavení a zkus znovu";
      }
      setStatus(msg, "err");
      refreshCards().then(() => {
        if (allCards.length === 0) renderForNoCards();
        else renderCardList(allCards, "Vyber kartičku ručně");
      });
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );

  // Keep tracking in the background so it re-checks automatically while you walk
  // around — this works fine once the first getCurrentPosition() above has
  // succeeded and permission is granted.
  if (!watchStarted) {
    watchStarted = true;
    navigator.geolocation.watchPosition(
      (p) => {
        lastKnownPosition = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy };
        maybeRecheck(p.coords.latitude, p.coords.longitude);
      },
      () => {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 15000 }
    );
  }
}

/* =========================================================
   ADD-CARD MODAL
   ========================================================= */
function openAddModal() {
  els.storeName.value = "";
  pendingImageDataUrl = null;
  els.previewImg.classList.add("hidden");
  els.dropZoneEmpty.classList.remove("hidden");
  els.btnSaveCard.disabled = true;
  els.addModal.classList.remove("hidden");
  setTimeout(() => els.storeName.focus(), 50);
}
function closeAddModal() {
  els.addModal.classList.add("hidden");
}

function updateSaveEnabled() {
  els.btnSaveCard.disabled = !(pendingImageDataUrl && els.storeName.value.trim().length > 0);
}

els.dropZone.addEventListener("click", () => els.qrFile.click());

els.qrFile.addEventListener("change", () => {
  const file = els.qrFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingImageDataUrl = reader.result;
    els.previewImg.src = pendingImageDataUrl;
    els.previewImg.classList.remove("hidden");
    els.dropZoneEmpty.classList.add("hidden");
    updateSaveEnabled();
  };
  reader.readAsDataURL(file);
});

els.storeName.addEventListener("input", updateSaveEnabled);

els.btnSaveCard.addEventListener("click", async () => {
  const name = els.storeName.value.trim();
  if (!name || !pendingImageDataUrl) return;
  await dbAddCard(name, pendingImageDataUrl);
  closeAddModal();
  toast("Kartička „" + name + "“ uložena");
  await refreshCards();
  if (allCards.length === 1) {
    // first ever card — try to locate again so it can match immediately
    startLocating();
  } else {
    renderCardList(allCards, "Tvoje kartičky");
  }
});

els.btnLocate.addEventListener("click", () => {
  userBrowsedAway = false;
  manualViewOpen = false;
  startLocating();
});

els.btnAdd.addEventListener("click", openAddModal);
els.btnAddFromEmpty.addEventListener("click", openAddModal);
els.btnCloseModal.addEventListener("click", closeAddModal);

/* =========================================================
   NAVIGATION BUTTONS
   ========================================================= */
els.btnAllFromMatch.addEventListener("click", () => {
  userBrowsedAway = true;
  renderCardList(allCards, "Všechny kartičky");
});
els.btnAllFromChoice.addEventListener("click", () => {
  userBrowsedAway = true;
  renderCardList(allCards, "Všechny kartičky");
});
els.btnBackFromView.addEventListener("click", leaveManualView);
els.viewImg.addEventListener("click", leaveManualView);
els.matchImg.addEventListener("click", () => {
  userBrowsedAway = true;
  renderCardList(allCards, "Všechny kartičky");
});

els.btnSaveSpot.addEventListener("click", async () => {
  if (currentViewCardId == null) return;
  if (!lastKnownPosition) {
    toast("Poloha zatím není známá — zkus to za chvíli");
    return;
  }
  await dbAddLocationToCard(currentViewCardId, lastKnownPosition.lat, lastKnownPosition.lon);
  await refreshCards();
  const card = allCards.find((c) => c.id === currentViewCardId);
  if (card) refreshSpotHint(card);
  toast("Poloha uložena ✓");
});

els.btnClearSpots.addEventListener("click", async () => {
  if (currentViewCardId == null) return;
  const card = allCards.find((c) => c.id === currentViewCardId);
  if (!card || !(card.locations || []).length) {
    toast("Žádná uložená místa ke smazání");
    return;
  }
  if (!confirm("Smazat všechna uložená místa pro „" + card.name + "“?")) return;
  await dbClearLocationsForCard(currentViewCardId);
  await refreshCards();
  const updated = allCards.find((c) => c.id === currentViewCardId);
  if (updated) refreshSpotHint(updated);
  toast("Uložená místa smazána");
});

els.btnDeleteFromView.addEventListener("click", async () => {
  if (currentViewCardId == null) return;
  const card = allCards.find((c) => c.id === currentViewCardId);
  if (!card) return;
  if (!confirm('Smazat kartičku „' + card.name + '“?')) return;
  await dbDeleteCard(currentViewCardId);
  manualViewOpen = false;
  userBrowsedAway = true;
  await refreshCards();
  toast("Kartička smazána");
  if (allCards.length === 0) renderForNoCards();
  else renderCardList(allCards, "Všechny kartičky");
});

/* =========================================================
   PWA INSTALL HANDLING
   ========================================================= */
let deferredInstallPrompt = null;

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
function installDismissedRecently() {
  const t = localStorage.getItem("installDismissedAt");
  if (!t) return false;
  const days = (Date.now() - Number(t)) / (1000 * 60 * 60 * 24);
  return days < INSTALL_DISMISS_DAYS;
}
function dismissInstallBanner() {
  localStorage.setItem("installDismissedAt", String(Date.now()));
  els.installBanner.classList.add("hidden");
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!isStandalone() && !installDismissedRecently()) {
    els.installTitle.textContent = "Nainstalovat appku";
    els.installSub.textContent = "Ať máš kartičky vždy jedním klepnutím po ruce.";
    els.installBanner.classList.remove("hidden");
  }
});

els.btnInstall.addEventListener("click", async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    els.installBanner.classList.add("hidden");
  } else if (isIos()) {
    els.iosModal.classList.remove("hidden");
  }
});
els.btnInstallDismiss.addEventListener("click", dismissInstallBanner);
els.btnCloseIos.addEventListener("click", () => els.iosModal.classList.add("hidden"));
els.btnCloseIos2.addEventListener("click", () => els.iosModal.classList.add("hidden"));

window.addEventListener("appinstalled", () => {
  els.installBanner.classList.add("hidden");
  toast("Appka nainstalována 🎉");
});

function maybeShowIosBanner() {
  if (isIos() && !isStandalone() && !installDismissedRecently()) {
    els.installTitle.textContent = "Přidat na plochu";
    els.installSub.textContent = "Sdílet → Přidat na plochu — poběží přes celou obrazovku.";
    els.installBanner.classList.remove("hidden");
  }
}

/* =========================================================
   SERVICE WORKER
   ========================================================= */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

/* =========================================================
   BOOT
   ========================================================= */
(async function boot() {
  await refreshCards();
  if (allCards.length === 0) {
    renderForNoCards();
    setStatus("Zatím nemáš žádné kartičky", null);
  } else {
    setStatus("Klepni na 📍 Najít a zjisti, kde jsi", null);
  }
  // Try automatically too — works fine on Android/desktop. On iOS this first
  // automatic attempt may be silently ignored, so the 📍 Najít button is the
  // reliable fallback there.
  startLocating();
  maybeShowIosBanner();
})();

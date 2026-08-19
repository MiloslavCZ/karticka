"use strict";

/* =========================================================
   CONFIG
   ========================================================= */
const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const CZ_BBOX = "48.5,12.0,51.1,18.9"; // rough bounding box for Czech Republic,
                                        // used only when downloading a brand's
                                        // branches (once in a while, not per-check)

const MATCH_RADIUS_M = 100;          // OSM live-lookup fallback search radius
const AUTO_MATCH_RADIUS_M = 100;     // radius for matching against the local
                                      // brand-POI database
const ACCURACY_MARGIN_CAP_M = 150;   // how much extra radius bad GPS accuracy
                                      // is allowed to buy, at most
const LOCAL_MATCH_RADIUS_M = 55;     // radius for matching against a card's own
                                      // remembered exact GPS spots — tightest,
                                      // since it's an exact fix, not an area

const RECHECK_MIN_DISTANCE_M = 8;    // re-check location after moving this far…
const RECHECK_MIN_INTERVAL_MS = 4000; // …or after this much time (whichever first) —
                                       // only applies while no card is manually open
const MATCH_LOCK_MS = 90000;         // once a match is found, keep showing it for this
                                      // long even if a single recheck comes up empty
                                      // (avoids flicker from a momentary GPS/API blip)

const SYNC_STALE_MS = 1000 * 60 * 60 * 24 * 30; // re-sync a brand's branches
                                                 // after this long (30 days)
const INSTALL_DISMISS_DAYS = 7;
const MAX_SUGGESTIONS = 6;

/* =========================================================
   TINY INDEXEDDB WRAPPER
   Stores:
     cards    { id, brandId, name, image, createdAt, locations:[{lat,lon,savedAt}] }
     pois     { id, brandId, lat, lon }                     — local branch database
     syncMeta { brandId, syncedAt, poiCount }                — per-brand sync bookkeeping
   ========================================================= */
const DB_NAME = "karticka-db";
const DB_VERSION = 2;
const DB_STORE = "cards";
const POI_STORE = "pois";
const SYNC_STORE = "syncMeta";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(POI_STORE)) {
        const poiStore = db.createObjectStore(POI_STORE, { keyPath: "id", autoIncrement: true });
        poiStore.createIndex("brandId", "brandId", { unique: false });
      }
      if (!db.objectStoreNames.contains(SYNC_STORE)) {
        db.createObjectStore(SYNC_STORE, { keyPath: "brandId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---- cards ---- */
async function dbAddCard(name, imageDataUrl, brandId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).add({
      name,
      brandId: brandId != null ? brandId : null,
      image: imageDataUrl,
      createdAt: Date.now(),
      locations: [] // remembered exact GPS spots where this card was confirmed
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
    req.onsuccess = () =>
      resolve(
        (req.result || []).map((c) => ({
          ...c,
          locations: c.locations || [],
          brandId: c.brandId != null ? c.brandId : null
        }))
      );
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

async function dbSetCardBrand(id, brandId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const card = getReq.result;
      if (!card) { resolve(); return; }
      card.brandId = brandId;
      store.put(card);
    };
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

/* ---- local brand POI database ---- */
async function dbReplacePoisForBrand(brandId, points) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(POI_STORE, "readwrite");
    const store = tx.objectStore(POI_STORE);
    const idx = store.index("brandId");
    const cursorReq = idx.openCursor(IDBKeyRange.only(brandId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        points.forEach((p) => store.add({ brandId, lat: p.lat, lon: p.lon }));
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetPoisForBrand(brandId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(POI_STORE, "readonly");
    const idx = tx.objectStore(POI_STORE).index("brandId");
    const req = idx.getAll(IDBKeyRange.only(brandId));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/* ---- per-brand sync bookkeeping ---- */
async function dbSetSyncMeta(brandId, meta) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SYNC_STORE, "readwrite");
    tx.objectStore(SYNC_STORE).put({ brandId, ...meta });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAllSyncMeta() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SYNC_STORE, "readonly");
    const req = tx.objectStore(SYNC_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

let syncMetaCache = new Map(); // brandId -> {brandId, syncedAt, poiCount}
async function loadSyncMetaCache() {
  const all = await dbGetAllSyncMeta();
  syncMetaCache = new Map(all.map((m) => [m.brandId, m]));
}
function brandHasPois(brandId) {
  const meta = syncMetaCache.get(brandId);
  return !!(meta && meta.poiCount > 0);
}

/* =========================================================
   BRAND SYNC — download a brand's branches from OpenStreetMap
   once in a while, store just {brandId, lat, lon} locally.
   ========================================================= */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function syncBrandPois(brandId) {
  const brand = BRANDS.find((b) => b.id === brandId);
  if (!brand) return 0;
  const token = escapeRegex(brand.q || brand.name);
  const query = `
    [out:json][timeout:50];
    (
      node["name"~"^${token}",i](${CZ_BBOX});
      way["name"~"^${token}",i](${CZ_BBOX});
      node["brand"~"^${token}",i](${CZ_BBOX});
      way["brand"~"^${token}",i](${CZ_BBOX});
    );
    out center;
  `;
  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    body: "data=" + encodeURIComponent(query)
  });
  if (!res.ok) throw new Error("overpass_http_" + res.status);
  const json = await res.json();

  const points = [];
  for (const elmt of json.elements || []) {
    const lat = elmt.lat != null ? elmt.lat : elmt.center && elmt.center.lat;
    const lon = elmt.lon != null ? elmt.lon : elmt.center && elmt.center.lon;
    if (lat == null || lon == null) continue;
    points.push({ lat, lon });
  }

  await dbReplacePoisForBrand(brandId, points);
  await dbSetSyncMeta(brandId, { syncedAt: Date.now(), poiCount: points.length });
  syncMetaCache.set(brandId, { brandId, syncedAt: Date.now(), poiCount: points.length });
  return points.length;
}

async function maybeSyncBrand(brandId) {
  const meta = syncMetaCache.get(brandId);
  if (meta && Date.now() - meta.syncedAt < SYNC_STALE_MS) return;
  try {
    toast("Stahuji pobočky…");
    const n = await syncBrandPois(brandId);
    toast("Pobočky staženy (" + n + ")");
  } catch (e) {
    // Silent failure is fine — the live OSM fallback still covers this brand.
  }
}

/* =========================================================
   NAME NORMALIZATION + FUZZY MATCH (used by the legacy/fallback path)
   ========================================================= */
function normalizeName(str) {
  return (str || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
   OVERPASS: live "what's near me right now" lookup (fallback only)
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
  for (const elmt of json.elements || []) {
    const tags = elmt.tags || {};
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
  brandSyncRow: el("brandSyncRow"),
  brandSyncHint: el("brandSyncHint"),
  btnSyncBrand: el("btnSyncBrand"),
  assignBrandRow: el("assignBrandRow"),
  btnShowAssignBrand: el("btnShowAssignBrand"),
  assignBrandWrap: el("assignBrandWrap"),
  assignBrandInput: el("assignBrandInput"),
  assignBrandSuggestions: el("assignBrandSuggestions"),
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
  brandSuggestions: el("brandSuggestions"),
  dropZone: el("dropZone"),
  dropZoneEmpty: el("dropZoneEmpty"),
  previewImg: el("previewImg"),
  qrFile: el("qrFile"),
  qrReadHint: el("qrReadHint"),
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
let selectedBrandId = null; // set by the add-card autocomplete
let lastCheckedAt = 0;
let lastCheckedPos = null;

// "lock" state: once we find a match, keep it on screen for MATCH_LOCK_MS even
// if a later recheck briefly comes back empty (flaky GPS / Overpass hiccup).
let lockedMatchIds = [];
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
   BRAND AUTOCOMPLETE (shared between add-card modal and
   "assign a brand to an old card" flow)
   ========================================================= */
function wireBrandAutocomplete(inputEl, listEl, onPick) {
  function hide() {
    listEl.classList.add("hidden");
    listEl.innerHTML = "";
  }
  inputEl.addEventListener("input", () => {
    const q = normalizeName(inputEl.value);
    if (!q) { hide(); return; }
    const matches = BRANDS.filter((b) => normalizeName(b.name).includes(q)).slice(0, MAX_SUGGESTIONS);
    if (!matches.length) { hide(); return; }
    listEl.innerHTML = "";
    matches.forEach((b) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "brand-suggestion";
      item.textContent = b.name;
      item.addEventListener("click", () => {
        inputEl.value = b.name;
        hide();
        onPick(b);
      });
      listEl.appendChild(item);
    });
    listEl.classList.remove("hidden");
  });
  document.addEventListener("click", (e) => {
    if (e.target !== inputEl && !listEl.contains(e.target)) hide();
  });
  return { hide };
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

  const currentSlot = row.nextElementSibling;
  const alreadyThere =
    insertBeforeNode === currentSlot || (insertBeforeNode === null && currentSlot === null);
  if (alreadyThere) return;

  const prevRects = captureRowRects();
  const beforeTop = row.getBoundingClientRect().top;
  els.cardList.insertBefore(row, insertBeforeNode);
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

/* =========================================================
   CARD DETAIL VIEW
   ========================================================= */
function refreshSpotHint(card) {
  const n = (card.locations || []).length;
  els.spotHint.textContent =
    n === 0
      ? "Zatím appka nezná žádné tvoje místo pro tuhle kartičku."
      : "Uloženo míst: " + n + " — příště tě appka pozná i bez map, jakmile budeš blízko.";
}

function daysAgo(ts) {
  const days = Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "dnes";
  if (days === 1) return "před 1 dnem";
  return "před " + days + " dny";
}

function refreshBrandSyncUI(card) {
  if (card.brandId == null) {
    els.brandSyncRow.classList.add("hidden");
    els.assignBrandRow.classList.remove("hidden");
    els.assignBrandWrap.classList.add("hidden");
    els.assignBrandInput.value = "";
    return;
  }
  els.assignBrandRow.classList.add("hidden");
  els.brandSyncRow.classList.remove("hidden");
  const meta = syncMetaCache.get(card.brandId);
  els.brandSyncHint.textContent = meta
    ? "Pobočky (" + meta.poiCount + ") aktualizovány " + daysAgo(meta.syncedAt) + "."
    : "Pobočky této značky ještě nejsou stažené.";
}

function openCardView(id) {
  const card = allCards.find((c) => c.id === id);
  if (!card) return;
  currentViewCardId = id;
  manualViewOpen = true; // keep this card on screen until the user explicitly leaves
  els.viewName.textContent = card.name;
  els.viewImg.src = card.image;
  refreshSpotHint(card);
  refreshBrandSyncUI(card);
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

function lockMatches(matches) {
  lockedMatchIds = matches.map((c) => c.id);
  lockedAt = Date.now();
  userBrowsedAway = false;
}
function namesOf(cards) {
  return cards.map((c) => c.name).join(", ");
}

// Compare current position against the local brand-POI database, but only
// for brands the user actually owns a card for — never scans everything.
async function findBrandMatches(here, accuracy, cards) {
  const brandCards = cards.filter((c) => c.brandId != null);
  if (!brandCards.length) return [];

  const byBrand = new Map();
  brandCards.forEach((c) => {
    if (!byBrand.has(c.brandId)) byBrand.set(c.brandId, []);
    byBrand.get(c.brandId).push(c);
  });

  const margin = Math.min(accuracy || 0, ACCURACY_MARGIN_CAP_M);
  const effectiveRadius = AUTO_MATCH_RADIUS_M + margin;

  const matches = [];
  for (const [brandId, cardsForBrand] of byBrand) {
    const pois = await dbGetPoisForBrand(brandId);
    if (!pois.length) continue;
    let nearest = Infinity;
    for (const p of pois) {
      const d = distanceMeters(here, p);
      if (d < nearest) nearest = d;
    }
    if (nearest <= effectiveRadius) matches.push(...cardsForBrand);
  }
  return matches;
}

async function evaluateLocation(lat, lon, accuracy) {
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

  const here = { lat, lon };

  // 1) FASTEST: each card's own remembered exact spots. No network, works for
  //    literally any card (branded or not), including shops OSM never mapped.
  const localMatches = allCards.filter((card) =>
    (card.locations || []).some((loc) => distanceMeters(here, loc) <= LOCAL_MATCH_RADIUS_M)
  );
  if (localMatches.length > 0) {
    lockMatches(localMatches);
    setStatus("Poblíž (podle uložené polohy): " + namesOf(localMatches), "live");
    renderForMatches(localMatches);
    return;
  }

  // 2) LOCAL DATABASE: brand branches downloaded ahead of time, filtered to
  //    just the brands you actually have cards for. Also offline, no waiting.
  const brandMatches = await findBrandMatches(here, accuracy, allCards);
  if (brandMatches.length > 0) {
    lockMatches(brandMatches);
    setStatus("Poblíž (podle databáze poboček): " + namesOf(brandMatches), "live");
    renderForMatches(brandMatches);
    // Learn this exact spot so next time is instant even without the DB lookup.
    brandMatches.forEach((c) => dbAddLocationToCard(c.id, lat, lon));
    return;
  }

  // 3) SLOW FALLBACK: ask OpenStreetMap live — only for cards we truly have
  //    no better data for (no brand assigned, or that brand isn't synced yet).
  const fallbackCards = allCards.filter((c) => c.brandId == null || !brandHasPois(c.brandId));
  if (fallbackCards.length > 0) {
    setStatus("Zjišťuji, kde právě jsi…", "warn");
    let nearby = [];
    try {
      nearby = await fetchNearbyPlaces(lat, lon);
    } catch (err) {
      if (lockedMatchIds.length && Date.now() - lockedAt < MATCH_LOCK_MS) {
        setStatus("Poloha se teď nepodařila ověřit, ale zůstáváš u nalezené kartičky", "warn");
        return;
      }
      setStatus("Okolí se nepodařilo zjistit — vyber kartičku ručně", "err");
      renderCardList(allCards, "Nepodařilo se ověřit polohu");
      return;
    }

    const matched = fallbackCards.filter((card) => nearby.some((p) => namesMatch(card.name, p.name)));
    if (matched.length > 0) {
      lockMatches(matched);
      setStatus("Poblíž: " + namesOf(matched), "live");
      renderForMatches(matched);
      matched.forEach((c) => dbAddLocationToCard(c.id, lat, lon));
      return;
    }
  }

  // Nothing matched this round — but if we recently had one locked in and the
  // user hasn't manually browsed away, keep showing it rather than flicker.
  const stillLocked = lockedMatchIds.length && Date.now() - lockedAt < MATCH_LOCK_MS;
  if (stillLocked && !userBrowsedAway) {
    const stillCards = allCards.filter((c) => lockedMatchIds.includes(c.id));
    if (stillCards.length) {
      setStatus("Poblíž: " + namesOf(stillCards), "live");
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

function maybeRecheck(lat, lon, accuracy) {
  if (manualViewOpen) {
    return;
  }
  const now = Date.now();
  const pos = { lat, lon };
  const moved = lastCheckedPos ? distanceMeters(lastCheckedPos, pos) : Infinity;
  const elapsed = now - lastCheckedAt;
  if (moved < RECHECK_MIN_DISTANCE_M && elapsed < RECHECK_MIN_INTERVAL_MS) return;
  lastCheckedAt = now;
  lastCheckedPos = pos;
  evaluateLocation(lat, lon, accuracy);
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

  navigator.geolocation.getCurrentPosition(
    (p) => {
      lastCheckedAt = Date.now();
      lastCheckedPos = { lat: p.coords.latitude, lon: p.coords.longitude };
      lastKnownPosition = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy };
      evaluateLocation(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
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

  if (!watchStarted) {
    watchStarted = true;
    navigator.geolocation.watchPosition(
      (p) => {
        lastKnownPosition = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy };
        maybeRecheck(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
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
  selectedBrandId = null;
  pendingImageDataUrl = null;
  els.previewImg.classList.add("hidden");
  els.dropZoneEmpty.classList.remove("hidden");
  els.qrReadHint.textContent = "";
  els.qrReadHint.className = "qr-read-hint";
  els.btnSaveCard.disabled = true;
  els.brandSuggestions.classList.add("hidden");
  els.addModal.classList.remove("hidden");
  setTimeout(() => els.storeName.focus(), 50);
}
function closeAddModal() {
  els.addModal.classList.add("hidden");
}

function updateSaveEnabled() {
  els.btnSaveCard.disabled = !(pendingImageDataUrl && els.storeName.value.trim().length > 0);
}

wireBrandAutocomplete(els.storeName, els.brandSuggestions, (brand) => {
  selectedBrandId = brand.id;
  updateSaveEnabled();
});

els.dropZone.addEventListener("click", () => els.qrFile.click());

els.qrFile.addEventListener("change", () => {
  const file = els.qrFile.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => processSelectedQrImage(reader.result);
  reader.readAsDataURL(file);
});

/* =========================================================
   QR PHOTO -> READ IT -> DRAW OUR OWN CLEAN QR CODE
   Instead of storing the raw screenshot (with app chrome, phone
   frame, etc. around it), we decode whatever QR code is in the
   photo and immediately redraw a crisp, minimal QR of our own
   from the same data. If decoding fails (blurry photo, no QR
   found...), we fall back to just saving the original photo.
   ========================================================= */
const QR_DECODE_MAX_DIM = 1000; // downscale large photos before decoding, for speed

function decodeQrFromImage(img) {
  const canvas = document.createElement("canvas");
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (Math.max(w, h) > QR_DECODE_MAX_DIM) {
    const scale = QR_DECODE_MAX_DIM / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const result = jsQR(imageData.data, w, h);
  return result ? result.data : null;
}

function renderCleanQrDataUrl(text) {
  const qr = qrcode(0, "M"); // type 0 = auto-detect smallest size that fits
  qr.addData(text);
  qr.make();
  return qr.createDataURL(10, 8); // 10px per module, 8-module quiet-zone margin
}

function showAddModalPreview(dataUrl) {
  els.previewImg.src = dataUrl;
  els.previewImg.classList.remove("hidden");
  els.dropZoneEmpty.classList.add("hidden");
}

function processSelectedQrImage(dataUrl) {
  els.qrReadHint.className = "qr-read-hint";
  els.qrReadHint.textContent = "Čtu QR kód z fotky…";

  const img = new Image();
  img.onload = () => {
    let decodedText = null;
    try {
      decodedText = decodeQrFromImage(img);
    } catch (e) {
      decodedText = null;
    }

    if (decodedText) {
      let cleanDataUrl = null;
      try {
        cleanDataUrl = renderCleanQrDataUrl(decodedText);
      } catch (e) {
        cleanDataUrl = null;
      }
      if (cleanDataUrl) {
        pendingImageDataUrl = cleanDataUrl;
        showAddModalPreview(cleanDataUrl);
        els.qrReadHint.textContent = "QR kód přečten a vykreslen nanovo ✓";
        els.qrReadHint.className = "qr-read-hint ok";
        updateSaveEnabled();
        return;
      }
    }

    // Fallback: couldn't decode (or couldn't redraw) — just use the original photo.
    pendingImageDataUrl = dataUrl;
    showAddModalPreview(dataUrl);
    els.qrReadHint.textContent = "Nepodařilo se přečíst QR kód — uložena původní fotka.";
    els.qrReadHint.className = "qr-read-hint fail";
    updateSaveEnabled();
  };
  img.onerror = () => {
    els.qrReadHint.textContent = "Fotku se nepodařilo načíst, zkus to prosím znovu.";
    els.qrReadHint.className = "qr-read-hint fail";
  };
  img.src = dataUrl;
}


els.storeName.addEventListener("input", () => {
  selectedBrandId = null; // typing invalidates a previously picked suggestion
  updateSaveEnabled();
});

els.btnSaveCard.addEventListener("click", async () => {
  const name = els.storeName.value.trim();
  if (!name || !pendingImageDataUrl) return;
  const brandIdToSave = selectedBrandId;
  await dbAddCard(name, pendingImageDataUrl, brandIdToSave);
  closeAddModal();
  toast("Kartička „" + name + "“ uložena");
  await refreshCards();
  if (brandIdToSave != null) {
    maybeSyncBrand(brandIdToSave); // background — doesn't block the UI
  }
  if (allCards.length === 1) {
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
   ASSIGN A BRAND TO AN OLD (LEGACY) CARD
   ========================================================= */
els.btnShowAssignBrand.addEventListener("click", () => {
  els.assignBrandWrap.classList.toggle("hidden");
  if (!els.assignBrandWrap.classList.contains("hidden")) {
    els.assignBrandInput.focus();
  }
});

wireBrandAutocomplete(els.assignBrandInput, els.assignBrandSuggestions, async (brand) => {
  if (currentViewCardId == null) return;
  await dbSetCardBrand(currentViewCardId, brand.id);
  await refreshCards();
  const card = allCards.find((c) => c.id === currentViewCardId);
  if (card) {
    els.viewName.textContent = card.name;
    refreshBrandSyncUI(card);
  }
  toast("Značka přiřazena ✓");
  maybeSyncBrand(brand.id);
});

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

els.btnSyncBrand.addEventListener("click", async () => {
  if (currentViewCardId == null) return;
  const card = allCards.find((c) => c.id === currentViewCardId);
  if (!card || card.brandId == null) return;
  toast("Stahuji pobočky…");
  try {
    const n = await syncBrandPois(card.brandId);
    await loadSyncMetaCache();
    refreshBrandSyncUI(card);
    toast("Pobočky aktualizovány (" + n + ")");
  } catch (e) {
    toast("Nepodařilo se stáhnout pobočky — zkus to později");
  }
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
  await loadSyncMetaCache();
  await refreshCards();
  if (allCards.length === 0) {
    renderForNoCards();
    setStatus("Zatím nemáš žádné kartičky", null);
  } else {
    setStatus("Klepni na 📍 Najít a zjisti, kde jsi", null);
  }
  startLocating();
  maybeShowIosBanner();
})();

// Shelf Watch — tracks upcoming release dates for books on a Goodreads "To-Read" shelf.
//
// How syncing works:
// Goodreads has no public API anymore. Every shelf (including private ones) has an
// RSS feed URL containing a secret token, found at the bottom of the shelf page on
// goodreads.com behind the small "RSS" link. That URL acts like a saved credential —
// paste it once in Settings and this app can keep re-fetching it through a CORS proxy
// (plain browser JS can't call goodreads.com directly due to CORS).
//
// Release dates: Goodreads RSS often only has the original publish year, not a
// future edition's release date, so each book is looked up via the Hardcover API
// by ISBN (falling back to title/author) using your own free Hardcover API key.

const STORAGE_KEYS = {
  settings: "shelfwatch_settings",
  books: "shelfwatch_books",
  lastSync: "shelfwatch_last_sync",
};

// Public CORS proxies are unreliable — free tiers expire, rate limits get hit,
// services disappear. If the user hasn't set their own proxy (see proxy-worker.js
// for a permanent free one), we try a few public fallbacks in turn.
const FALLBACK_PROXIES = [
  (url) => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url),
  (url) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(url),
  (url) => "https://proxy.corsfix.com/?" + url, // gives new domains a limited free trial, then requires a paid plan
];
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
// Hardcover's API allows 60 requests/min; pace lookups a bit under that so one
// sync can resolve an entire shelf without tripping the limit.
const LOOKUP_DELAY_MS = 1100;
const MAX_CONSECUTIVE_LOOKUP_FAILURES = 5; // stop early if the lookup API is down/rejecting us, rather than failing on every remaining book

let state = {
  settings: loadSettings(),
  books: loadBooks(),
  viewDate: new Date(),
};

// ---------- Persistence ----------

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.settings)) || {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
}

function loadBooks() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.books)) || [];
  } catch {
    return [];
  }
}

function saveBooks(books) {
  localStorage.setItem(STORAGE_KEYS.books, JSON.stringify(books));
}

// ---------- Settings panel ----------

const settingsPanel = document.getElementById("settings-panel");
const settingsOverlay = document.getElementById("settings-overlay");

function openSettings() {
  const s = state.settings;
  document.getElementById("rss-url").value = s.rssUrl || "";
  document.getElementById("proxy-url").value = s.proxyUrl || "";
  document.getElementById("hardcover-token").value = s.hardcoverToken || "";
  settingsPanel.classList.remove("hidden");
  settingsOverlay.classList.remove("hidden");
}

function closeSettings() {
  settingsPanel.classList.add("hidden");
  settingsOverlay.classList.add("hidden");
}

document.getElementById("settings-btn").addEventListener("click", openSettings);
document.getElementById("close-settings").addEventListener("click", closeSettings);
settingsOverlay.addEventListener("click", closeSettings);

document.getElementById("save-settings").addEventListener("click", () => {
  const settings = {
    rssUrl: document.getElementById("rss-url").value.trim(),
    proxyUrl: document.getElementById("proxy-url").value.trim(),
    hardcoverToken: document.getElementById("hardcover-token").value.trim(),
  };
  state.settings = settings;
  saveSettings(settings);

  const confirm = document.getElementById("save-confirm");
  confirm.classList.remove("hidden");
  setTimeout(() => confirm.classList.add("hidden"), 2000);
});

// ---------- Syncing from Goodreads RSS ----------

const syncBtn = document.getElementById("sync-btn");
const syncStatus = document.getElementById("sync-status");

syncBtn.addEventListener("click", () => sync(true));

async function sync(manual) {
  const s = state.settings;
  if (!s.rssUrl) {
    if (manual) openSettings();
    syncStatus.textContent = "Add your shelf RSS URL in Settings";
    return;
  }

  syncStatus.textContent = "Syncing…";
  syncBtn.disabled = true;

  try {
    const text = await fetchShelfRss(s.rssUrl, s.proxyUrl);
    const items = parseGoodreadsRss(text);

    if (items.length === 0) {
      throw new Error("No books found — check the RSS URL is your To-Read shelf.");
    }

    const existing = new Map(state.books.map((b) => [b.id, b]));
    const merged = [];
    for (const item of items) {
      const prior = existing.get(item.id);
      merged.push({
        ...item,
        releaseDate: prior?.releaseDate !== undefined ? prior.releaseDate : undefined,
        genres: item.genres?.length ? item.genres : prior?.genres || [],
      });
    }

    // Look up Hardcover metadata for every book still missing release dates or
    // genre data, paced to stay under Hardcover's rate limit so one sync can
    // finish the whole shelf instead of requiring repeated manual syncs.
    const batch = state.settings.hardcoverToken
      ? merged.filter((b) => b.releaseDate === undefined || !(b.genres || []).length)
      : [];
    let consecutiveFailures = 0;
    let backoffMs = 1000;

    // Save books (and the current partial lookup progress) up front, so closing
    // the tab mid-sync on a big shelf doesn't lose what's already been resolved.
    state.books = merged;
    saveBooks(merged);

    for (let i = 0; i < batch.length; i++) {
      const book = batch[i];
      syncStatus.textContent = `Looking up book details… ${i + 1}/${batch.length}`;
      let result = await lookupBookMetadata(book);

      // Back off and retry a couple of times on rate limiting before giving up on this book.
      let retries = 0;
      while (result === undefined && retries < 2) {
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 8000);
        result = await lookupBookMetadata(book);
        retries++;
      }

      if (result === undefined) {
        consecutiveFailures++;
      } else {
        consecutiveFailures = 0;
        backoffMs = 1000;
        if (result.releaseDate !== undefined) book.releaseDate = result.releaseDate;
        if (result.genres?.length) book.genres = result.genres;
      }
      saveBooks(merged);
      if (consecutiveFailures >= MAX_CONSECUTIVE_LOOKUP_FAILURES) break;
      await sleep(LOOKUP_DELAY_MS);
    }

    localStorage.setItem(STORAGE_KEYS.lastSync, Date.now().toString());

    render();
    const remaining = merged.filter((b) => b.releaseDate === undefined).length;
    const missingGenres = merged.filter((b) => !(b.genres || []).length).length;
    const syncedNote = !state.settings.hardcoverToken
      ? " (add a Hardcover API key in Settings to fetch release dates and genres)"
      : remaining || missingGenres ? ` (${Math.max(remaining, missingGenres)} couldn't be looked up — will retry next sync)` : "";
    syncStatus.textContent = "Synced " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + syncedNote;
  } catch (err) {
    console.error(err);
    syncStatus.textContent = "Sync failed: " + err.message;
  } finally {
    syncBtn.disabled = false;
  }
}

// Tries the user's own proxy first (if set), then falls back through a list of
// public proxies, since any single free proxy can be rate-limited, paywalled,
// or offline on a given day. Returns the raw RSS text from whichever succeeds.
async function fetchShelfRss(rssUrl, customProxy) {
  const attempts = customProxy
    ? [(url) => customProxy + encodeURIComponent(url), ...FALLBACK_PROXIES]
    : FALLBACK_PROXIES;

  const errors = [];
  for (let i = 0; i < attempts.length; i++) {
    syncStatus.textContent = attempts.length > 1 ? `Syncing… (trying proxy ${i + 1}/${attempts.length})` : "Syncing…";
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10000); // don't let one dead proxy stall the whole sync
    try {
      const res = await fetch(attempts[i](rssUrl), { signal: ctrl.signal });
      if (!res.ok) {
        errors.push(`(${res.status})`);
        continue;
      }
      const text = await res.text();
      if (!text.includes("<rss")) {
        errors.push("(bad response)");
        continue;
      }
      return text;
    } catch {
      errors.push("(unreachable or timed out)");
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("All proxies failed " + errors.join(" "));
}

function parseGoodreadsRss(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");
  const items = [...doc.querySelectorAll("item")];
  return items.map((item) => {
    const get = (tag) => item.querySelector(tag)?.textContent?.trim() || "";
    const bookId = get("book_id");
    const isbn = get("isbn") || get("isbn13");
    const author = get("author_name");
    const title = get("title");
    const cover = get("book_large_image_url") || get("book_medium_image_url") || get("book_image_url");
    const genres = normalizeGenres([
      ...getAll(item, "genre"),
      ...getAll(item, "category"),
      ...getAll(item, "shelf"),
      ...splitShelfLabels(get("user_shelves")),
      ...splitShelfLabels(get("bookshelf")),
    ]);
    // The feed's own <link> points to the user's private review page (requires
    // login). The public book page is reconstructed from book_id instead.
    const link = bookId ? `https://www.goodreads.com/book/show/${bookId}` : get("link");
    return {
      id: bookId || get("guid") || title + "|" + author,
      title,
      author,
      isbn,
      cover,
      genres,
      link,
    };
  });
}

function getAll(parent, tag) {
  return [...parent.querySelectorAll(tag)].map((node) => node.textContent?.trim()).filter(Boolean);
}

function splitShelfLabels(value) {
  return (value || "")
    .split(/[,|;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeGenres(values) {
  const ignored = new Set(["to-read", "currently-reading", "read", "owned", "default"]);
  const seen = new Set();
  const genres = [];

  for (const raw of values) {
    const genre = raw.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    const key = genre.toLowerCase();
    if (!genre || ignored.has(key) || seen.has(key)) continue;
    seen.add(key);
    genres.push(toTitleCase(genre));
  }

  return genres;
}

function toTitleCase(value) {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Book detail lookup (Hardcover) ----------

const HARDCOVER_ENDPOINT = "https://api.hardcover.app/v1/graphql";

// Returns book metadata if the lookup succeeds, or undefined if the lookup
// failed/was rate-limited and should be retried later.
async function lookupBookMetadata(book) {
  const token = state.settings.hardcoverToken;
  if (!token) return undefined;

  try {
    if (book.isbn) {
      const byIsbn = await hardcoverQuery(token, `
        query LookupByIsbn($isbn: String!) {
          editions(where: {_or: [{isbn_13: {_eq: $isbn}}, {isbn_10: {_eq: $isbn}}]}, limit: 1) {
            release_date
            book {
              id
              release_date
              cached_tags(path: "$.Genre")
            }
          }
        }
      `, { isbn: book.isbn });
      const edition = byIsbn?.editions?.[0];
      if (edition) {
        return {
          releaseDate: edition.release_date || edition.book?.release_date || null,
          genres: normalizeHardcoverGenres(edition.book?.cached_tags),
        };
      }
    }

    if (book.title) {
      // Hardcover disallows filtering books/editions with _ilike, so title/author
      // matching goes through its dedicated search endpoint instead, which returns
      // release_date directly on each hit's document. Genre tags live on the book
      // row, so we follow up by id when the search result includes one.
      const q = [book.title, book.author].filter(Boolean).join(" ");
      const searchResult = await hardcoverQuery(token, `
        query Search($q: String!) {
          search(query: $q, query_type: "books", per_page: 1, page: 1) {
            results
          }
        }
      `, { q });
      const document = searchResult?.search?.results?.hits?.[0]?.document;
      const id = Number(document?.id);
      const details = id ? await lookupHardcoverBookDetails(token, id) : {};
      return {
        releaseDate: document?.release_date || details.releaseDate || null,
        genres: details.genres || [],
      };
    }

    return { releaseDate: null, genres: [] }; // queried successfully, genuinely no metadata on record
  } catch {
    return undefined;
  }
}

async function lookupHardcoverBookDetails(token, id) {
  const data = await hardcoverQuery(token, `
    query BookDetails($id: Int!) {
      books_by_pk(id: $id) {
        release_date
        cached_tags(path: "$.Genre")
      }
    }
  `, { id });
  const book = data?.books_by_pk;
  return {
    releaseDate: book?.release_date || null,
    genres: normalizeHardcoverGenres(book?.cached_tags),
  };
}

function normalizeHardcoverGenres(value) {
  const names = Array.isArray(value)
    ? value.map((entry) => typeof entry === "string" ? entry : entry?.tag || entry?.name || entry?.slug)
    : [];
  return normalizeGenres(names).slice(0, 8);
}

async function hardcoverQuery(token, query, variables) {
  const auth = token.trim().startsWith("Bearer ") ? token.trim() : `Bearer ${token.trim()}`;
  const res = await fetch(HARDCOVER_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ query, variables }),
  });
  // Any non-OK response (bad/expired token, rate limit, server error) should be
  // retried later, not cached as "no release date found" — only a successful
  // query with no matching rows means that.
  if (!res.ok) throw new Error("Hardcover API request failed (" + res.status + ")");
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message || "Hardcover API error");
  return json.data;
}

// ---------- Calendar rendering ----------

const monthLabel = document.getElementById("month-label");
const calendarDays = document.getElementById("calendar-days");
const upcomingList = document.getElementById("upcoming-list");
const genreFilter = document.getElementById("genre-filter");
const randomizeBtn = document.getElementById("randomize-btn");
const randomizerResult = document.getElementById("randomizer-result");

document.getElementById("prev-month").addEventListener("click", () => {
  state.viewDate.setMonth(state.viewDate.getMonth() - 1);
  renderCalendar();
});
document.getElementById("next-month").addEventListener("click", () => {
  state.viewDate.setMonth(state.viewDate.getMonth() + 1);
  renderCalendar();
});
document.getElementById("today-btn").addEventListener("click", () => {
  state.viewDate = new Date();
  renderCalendar();
});
randomizeBtn.addEventListener("click", randomizeNextRead);
genreFilter.addEventListener("change", renderRandomizerPlaceholder);

function render() {
  renderCalendar();
  renderRandomizer();
  renderList();
}

function renderCalendar() {
  const year = state.viewDate.getFullYear();
  const month = state.viewDate.getMonth();
  monthLabel.textContent = state.viewDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const booksByDate = groupBooksByDate();
  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = new Date().toISOString().slice(0, 10);

  calendarDays.innerHTML = "";

  for (let i = 0; i < startOffset; i++) {
    const empty = document.createElement("div");
    empty.className = "day-cell empty";
    calendarDays.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const cell = document.createElement("div");
    cell.className = "day-cell" + (dateKey === todayKey ? " today" : "");

    const num = document.createElement("div");
    num.className = "day-number";
    num.textContent = day;
    cell.appendChild(num);

    const booksToday = booksByDate.get(dateKey) || [];
    if (booksToday.length) {
      const row = document.createElement("div");
      row.className = "day-books";
      booksToday.forEach((b) => {
        if (b.cover) {
          const img = document.createElement("img");
          img.src = b.cover;
          img.alt = b.title;
          img.title = `${b.title} — ${b.author}`;
          img.className = "mini-cover" + (dateKey < todayKey ? " released" : "");
          row.appendChild(linkWrap(img, b.link));
        }
      });
      cell.appendChild(row);
    }

    calendarDays.appendChild(cell);
  }
}

function groupBooksByDate() {
  const map = new Map();
  for (const book of state.books) {
    if (!book.releaseDate) continue;
    if (!map.has(book.releaseDate)) map.set(book.releaseDate, []);
    map.get(book.releaseDate).push(book);
  }
  return map;
}

function renderRandomizer() {
  const previous = genreFilter.value || "any";
  const genres = getAvailableGenres();

  genreFilter.innerHTML = '<option value="any">Any</option>';
  for (const genre of genres) {
    const option = document.createElement("option");
    option.value = genre;
    option.textContent = genre;
    genreFilter.appendChild(option);
  }

  genreFilter.value = previous === "any" || genres.includes(previous) ? previous : "any";
  renderRandomizerPlaceholder();
}

function getAvailableGenres() {
  return [...new Set(state.books.flatMap((book) => book.genres || []))]
    .sort((a, b) => a.localeCompare(b));
}

function renderRandomizerPlaceholder() {
  if (state.books.length === 0) {
    randomizerResult.innerHTML = '<p class="empty-state">Sync your Goodreads To-Read shelf, then roll for your next book.</p>';
    randomizeBtn.disabled = true;
    return;
  }

  randomizeBtn.disabled = false;
  const selectedGenre = genreFilter.value;
  const count = getRandomizerPool().length;
  const genreCopy = selectedGenre === "any" ? "your whole shelf" : selectedGenre;
  const missingGenreCount = state.books.filter((book) => !(book.genres || []).length).length;
  const genreHint = missingGenreCount && selectedGenre === "any"
    ? ` <span class="randomizer-hint">${missingGenreCount} book${missingGenreCount === 1 ? "" : "s"} still need Hardcover genres.</span>`
    : "";

  randomizerResult.innerHTML = count
    ? `<p class="empty-state">Ready to pick from ${count} book${count === 1 ? "" : "s"} in ${escapeHtml(genreCopy)}.${genreHint}</p>`
    : '<p class="empty-state">No books match that genre yet. Try Any.</p>';
}

function randomizeNextRead() {
  const pool = getRandomizerPool();
  if (!pool.length) {
    renderRandomizerPlaceholder();
    return;
  }

  const book = pool[Math.floor(Math.random() * pool.length)];
  renderRandomizerResult(book);
}

function getRandomizerPool() {
  const selectedGenre = genreFilter.value;
  if (selectedGenre === "any") return state.books;
  return state.books.filter((book) => (book.genres || []).includes(selectedGenre));
}

function renderRandomizerResult(book) {
  const genres = book.genres?.length
    ? `<div class="randomizer-genres">${book.genres.map(escapeHtml).join(" · ")}</div>`
    : "";
  const releaseDate = book.releaseDate
    ? `<div class="randomizer-date">${formatReleaseDate(book.releaseDate)}</div>`
    : "";

  randomizerResult.innerHTML = "";

  const result = document.createElement("div");
  result.className = "randomizer-book";

  const cover = createCover(book, "randomizer-cover");

  const info = document.createElement("div");
  info.className = "randomizer-info";
  info.innerHTML = `
    <div class="randomizer-kicker">Your next read</div>
    <div class="randomizer-title">${escapeHtml(book.title)}</div>
    <div class="randomizer-author">${escapeHtml(book.author)}</div>
    ${genres}
    ${releaseDate}
  `;

  result.appendChild(linkWrap(cover, book.link));
  result.appendChild(info);
  randomizerResult.appendChild(result);
}

function renderList() {
  const todayKey = new Date().toISOString().slice(0, 10);
  const upcoming = state.books
    .filter((b) => b.releaseDate && b.releaseDate >= todayKey)
    .sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));

  if (upcoming.length === 0) {
    upcomingList.innerHTML = state.books.length
      ? '<p class="empty-state">No upcoming release dates found yet.</p>'
      : '<p class="empty-state">No data yet. Open Settings to connect your Goodreads To-Read shelf.</p>';
    return;
  }

  upcomingList.innerHTML = "";
  for (const book of upcoming) {
    const row = document.createElement("div");
    row.className = "book-row";

    const cover = createCover(book, "book-cover");

    const info = document.createElement("div");
    info.className = "book-info";
    info.innerHTML = `<div class="book-title">${escapeHtml(book.title)}</div><div class="book-author">${escapeHtml(book.author)}</div>`;

    const date = document.createElement("div");
    date.className = "book-date" + (book.releaseDate === todayKey ? " today" : "");
    date.textContent = book.releaseDate === todayKey
      ? "Out today"
      : formatReleaseDate(book.releaseDate);

    row.appendChild(linkWrap(cover, book.link));
    row.appendChild(info);
    row.appendChild(date);
    upcomingList.appendChild(row);
  }
}

function formatReleaseDate(date) {
  return new Date(date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Wraps a cover <img> in a link to its Goodreads page, when we have one.
function linkWrap(content, link) {
  if (!link) return content;
  const a = document.createElement("a");
  a.href = link;
  a.target = "_blank";
  a.rel = "noopener";
  a.appendChild(content);
  return a;
}

function createCover(book, className) {
  if (book.cover) {
    const img = document.createElement("img");
    img.src = book.cover;
    img.alt = book.title;
    img.className = className;
    return img;
  }

  const fallback = document.createElement("div");
  fallback.className = `${className} cover-placeholder`;
  fallback.setAttribute("aria-label", book.title);
  fallback.textContent = "No cover";
  return fallback;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

// ---------- Init ----------

function init() {
  render();

  const lastSync = Number(localStorage.getItem(STORAGE_KEYS.lastSync) || 0);
  const dueForAutoSync = Date.now() - lastSync > SYNC_INTERVAL_MS;

  if (state.settings.rssUrl && dueForAutoSync) {
    sync(false);
  } else if (!state.settings.rssUrl) {
    syncStatus.textContent = "Add your shelf RSS URL in Settings";
  } else {
    syncStatus.textContent = lastSync ? "Synced " + new Date(lastSync).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Not synced yet";
  }
}

init();

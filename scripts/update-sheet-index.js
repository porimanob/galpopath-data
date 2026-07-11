const fs = require('fs/promises');
const path = require('path');

const SHEET_API_URL = process.env.SHEET_API_URL;

if (!SHEET_API_URL) {
  throw new Error('SHEET_API_URL secret is missing');
}

function buildUrl(sheetName) {
  const url = new URL(SHEET_API_URL);
  url.searchParams.set('sheet', sheetName);
  url.searchParams.set('all', '1');
  return url.toString();
}

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function normalizeList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.rows)) return data.rows;
  return [];
}

function getItemId(item) {
  return String(
    item.id ||
    item.author_id ||
    item.book_id ||
    item.slug ||
    item.key ||
    ''
  ).trim();
}

function buildById(items) {
  return items.reduce((map, item) => {
    const id = getItemId(item);
    if (id) {
      map[id] = item;
    }
    return map;
  }, {});
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function main() {
  const generatedAt = new Date().toISOString();

  const authorsRaw = await fetchJson(buildUrl('Authors'));
  const booksRaw = await fetchJson(buildUrl('Books'));

  const authors = normalizeList(authorsRaw);
  const books = normalizeList(booksRaw);

  const outputDir = path.join(process.cwd(), 'data', 'sheets');

  await writeJson(path.join(outputDir, 'authors.json'), {
    generatedAt,
    total: authors.length,
    items: authors
  });

  await writeJson(path.join(outputDir, 'authors-by-id.json'), {
    generatedAt,
    total: authors.length,
    items: buildById(authors)
  });

  await writeJson(path.join(outputDir, 'books.json'), {
    generatedAt,
    total: books.length,
    items: books
  });

  await writeJson(path.join(outputDir, 'books-by-id.json'), {
    generatedAt,
    total: books.length,
    items: buildById(books)
  });

  console.log(`Authors: ${authors.length}`);
  console.log(`Books: ${books.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

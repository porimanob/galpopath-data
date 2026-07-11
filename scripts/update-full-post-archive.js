import { mkdir, writeFile } from 'node:fs/promises';

const BLOGGER_API_KEY = process.env.BLOGGER_API_KEY;
const BLOGGER_BLOG_ID = process.env.BLOGGER_BLOG_ID;
const PAGE_SIZE = 100;
const OUTPUT_PATH = 'data/post-archive-full.json';

if (!BLOGGER_API_KEY || !BLOGGER_BLOG_ID) {
  throw new Error('Missing BLOGGER_API_KEY or BLOGGER_BLOG_ID environment variable.');
}

function buildBloggerUrl(pageToken = '') {
  const params = new URLSearchParams({
    key: BLOGGER_API_KEY,
    fetchBodies: 'true',
    maxResults: String(PAGE_SIZE)
  });

  if (pageToken) {
    params.set('pageToken', pageToken);
  }

  return `https://www.googleapis.com/blogger/v3/blogs/${encodeURIComponent(BLOGGER_BLOG_ID)}/posts?${params}`;
}

async function fetchAllFullPosts() {
  const posts = [];
  const seenPageTokens = new Set();
  let pageToken = '';
  let page = 0;

  do {
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) {
        throw new Error('Blogger API returned a repeated page token.');
      }

      seenPageTokens.add(pageToken);
    }

    page += 1;
    const response = await fetch(buildBloggerUrl(pageToken));

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Blogger API error ${response.status}: ${detail.slice(0, 500)}`);
    }

    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];
    posts.push(...items);
    pageToken = data.nextPageToken || '';

    console.log(`Fetched full page ${page}, total posts ${posts.length}`);
  } while (pageToken);

  return posts.sort((first, second) => {
    return new Date(second.published || 0).getTime() - new Date(first.published || 0).getTime();
  });
}

async function main() {
  const posts = await fetchAllFullPosts();
  const payload = {
    generatedAt: new Date().toISOString(),
    total: posts.length,
    pageSize: PAGE_SIZE,
    includesBodies: true,
    posts
  };

  await mkdir('data', { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(payload)}\n`, 'utf8');
  console.log(`Wrote ${OUTPUT_PATH} with ${posts.length} full posts.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { mkdir, rm, writeFile } from 'node:fs/promises';

const BLOGGER_API_KEY = process.env.BLOGGER_API_KEY;
const BLOGGER_BLOG_ID = process.env.BLOGGER_BLOG_ID;
const PAGE_SIZE = 100;
const CHUNK_SIZE = 250;
const OUTPUT_DIR = 'data/full-posts';
const MANIFEST_PATH = `${OUTPUT_DIR}/manifest.json`;

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
  const generatedAt = new Date().toISOString();
  const chunks = [];

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  for (let index = 0; index < posts.length; index += CHUNK_SIZE) {
    const chunkPosts = posts.slice(index, index + CHUNK_SIZE);
    const chunkIndex = Math.floor(index / CHUNK_SIZE) + 1;
    const fileName = `posts-${String(chunkIndex).padStart(4, '0')}.json`;
    const filePath = `${OUTPUT_DIR}/${fileName}`;

    await writeFile(
      filePath,
      `${JSON.stringify({
        generatedAt,
        chunkIndex,
        totalChunks: Math.ceil(posts.length / CHUNK_SIZE),
        count: chunkPosts.length,
        posts: chunkPosts
      })}\n`,
      'utf8'
    );

    chunks.push({
      file: fileName,
      path: filePath,
      count: chunkPosts.length,
      firstPublished: chunkPosts[0]?.published || '',
      lastPublished: chunkPosts[chunkPosts.length - 1]?.published || ''
    });

    console.log(`Wrote ${filePath} with ${chunkPosts.length} full posts.`);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    total: posts.length,
    pageSize: PAGE_SIZE,
    chunkSize: CHUNK_SIZE,
    totalChunks: chunks.length,
    includesBodies: true,
    chunks
  };

  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest)}\n`, 'utf8');
  console.log(`Wrote ${MANIFEST_PATH} with ${posts.length} full posts in ${chunks.length} chunks.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

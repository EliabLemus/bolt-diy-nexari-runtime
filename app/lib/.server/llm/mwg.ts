import { execFile } from 'child_process';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('modern-web-guidance');

export interface MwgUseCase {
  id: string;
  description: string;
}

const cache = new Map<string, MwgUseCase[]>();

/**
 * Query the GoogleChrome/modern-web-guidance CLI (Apache-2.0) for use cases
 * relevant to the user's request. Disabled with MODERN_WEB_GUIDANCE=off.
 * ponytail: per-query CLI call cached in-process; swap for bundled JSON if startup cost matters.
 */
export async function getModernWebGuidance(userMessage: string): Promise<string> {
  if (process.env.MODERN_WEB_GUIDANCE === 'off') {
    return '';
  }

  const query = userMessage.split(/\s+/).slice(0, 20).join(' ').trim();

  if (!query) {
    return '';
  }

  let results = cache.get(query);

  if (!results) {
    try {
      results = await new Promise<MwgUseCase[]>((resolve, reject) => {
        execFile('npx', ['modern-web-guidance', 'search', query], { timeout: 10_000 }, (err, stdout) =>
          err ? reject(err) : resolve(JSON.parse(stdout)),
        );
      });
      cache.set(query, results);
    } catch (error) {
      logger.warn(`modern-web-guidance search failed (continuing without guidance): ${error}`);
      return '';
    }
  }

  const top = results.slice(0, 5);

  if (top.length === 0) {
    return '';
  }

  const listing = top.map((u) => `- ${u.id}: ${u.description}`).join('\n');

  return `\n
MODERN WEB GUIDANCE (source: GoogleChrome/modern-web-guidance, Apache-2.0):
When implementing this request, apply these modern web platform best practices where relevant:
${listing}
`;
}

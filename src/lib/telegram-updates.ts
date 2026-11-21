import { CapacitorHttp } from '@capacitor/core';

const CHANNEL = 'posflowapp';
const CHANNEL_URL = 'https://t.me/' + CHANNEL;

interface TelegramRelease {
  version: string;
  url: string;
}

function versionParts(version: string) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/i.exec(version.trim());
  return match?.slice(1).map(Number);
}

export function compareReleaseVersions(first: string, second: string): number {
  const a = versionParts(first);
  const b = versionParts(second);
  if (!a || !b) throw new Error('Invalid release version');
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function readTelegramRelease(html: string): TelegramRelease | undefined {
  const document = new DOMParser().parseFromString(html, 'text/html');
  let latest: TelegramRelease | undefined;

  for (const post of document.querySelectorAll('[data-post]')) {
    const postNumber = new RegExp('^' + CHANNEL + '/([1-9]\\d*)$', 'i').exec(post.getAttribute('data-post') ?? '')?.[1];
    if (!postNumber) continue;
    const fileName = post.querySelector('.tgme_widget_message_document_title')?.textContent?.trim();
    const version = /^PosFlow[-_ ]v?(\d+\.\d+\.\d+)\.apk$/i.exec(fileName ?? '')?.[1];
    const caption = post.querySelector('.tgme_widget_message_text')?.textContent ?? '';
    const captionVersion = /تحديث جديد\s*[|｜]\s*POS Flow App[\s\S]{0,100}?الإصدار\s*[:：]\s*v?(\d+\.\d+\.\d+)/i.exec(caption)?.[1];
    const releaseVersion = version ?? captionVersion;
    if (!releaseVersion || (latest && compareReleaseVersions(releaseVersion, latest.version) <= 0)) continue;
    latest = { version: releaseVersion, url: CHANNEL_URL + '/' + postNumber };
  }
  return latest;
}

export async function checkTelegramRelease(): Promise<TelegramRelease> {
  const response = await CapacitorHttp.get({
    url: 'https://t.me/s/' + CHANNEL,
    responseType: 'text',
    connectTimeout: 6000,
    readTimeout: 6000,
    webFetchExtra: { signal: AbortSignal.timeout(10000) },
  });
  if (response.status !== 200 || typeof response.data !== 'string') throw new Error('Channel unavailable');
  const latest = readTelegramRelease(response.data);
  if (!latest) throw new Error('Published release unavailable');
  return latest;
}

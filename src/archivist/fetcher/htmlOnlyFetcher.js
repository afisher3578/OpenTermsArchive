import AbortController from 'abort-controller';
import HttpProxyAgent from 'http-proxy-agent';
import HttpsProxyAgent from 'https-proxy-agent';
import nodeFetch, { AbortError } from 'node-fetch';

import { FetchDocumentError } from './errors.js';

const LANGUAGE = 'en';
const TIMEOUT = 45 * 1000; // 45 seconds in ms

export default async function fetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);

  const options = {
    signal: controller.signal,
    credentials: 'include',
    headers: { 'Accept-Language': LANGUAGE },
  };

  if (url.startsWith('https:') && process.env.HTTPS_PROXY) {
    options.agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
  } else if (url.startsWith('http:') && process.env.HTTP_PROXY) {
    options.agent = new HttpProxyAgent(process.env.HTTP_PROXY);
  }

  let response;

  try {
    response = await nodeFetch(url, options);

    if (!response.ok) {
      throw new FetchDocumentError(`Received HTTP code ${response.status} when trying to fetch '${url}'`);
    }

    const mimeType = response.headers.get('content-type');

    return {
      mimeType,
      content: await (mimeType.startsWith('text/') ? response.text() : response.buffer()),
    };
  } catch (error) {
    if (error instanceof AbortError) {
      throw new FetchDocumentError(`The request timed out after ${TIMEOUT / 1000} seconds.`);
    }

    throw new FetchDocumentError(error.message);
  } finally {
    clearTimeout(timeout);
  }
}